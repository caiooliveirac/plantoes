import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Toda rota de API confere a sessão no servidor — ou está na lista de rotas
 * públicas abaixo, com o motivo. O proxy.ts deixa /api/* passar (só renova o
 * cookie), então a barreira é o handler. Até 2026-09-27 /api/doctors/import
 * não conferia nada e devolvia o cadastro de médicos a quem pedisse.
 *
 * Rota nova sem sessão: ou chama o guard, ou entra aqui com o portão dela
 * explicado. Teste estático (lê o fonte), sem subir servidor.
 */

const root = process.cwd();

// Guards de sessão (lib/auth/server.ts; autorizarPainelDoMedico em lib/medico/painel-acesso.ts).
const GUARD = /\b(requireAuthenticatedSession|requireSessionForRead|requireMesaSession|requireMesaEscrita|requireMesaSessionForRead|abrirVigiaDaMesa|readAuthenticatedSession|autorizarPainelDoMedico)\s*\(/;

/** Rotas sem sessão de propósito. Cada uma tem outro portão (ou não expõe nada). */
const PUBLIC_ROUTES: Record<string, string> = {
    // Portas de entrada: quem chama ainda não tem sessão.
    "app/api/auth/login/route.ts": "login por e-mail+senha (bcrypt).",
    "app/api/auth/logout/route.ts": "só apaga o cookie da sessão.",
    "app/api/auth/sso/route.ts": "handoff assinado de 60 s do app irmão (lerTokenHandoff).",
    "app/api/auth/signup/start/route.ts": "cadastro do médico: envia código por e-mail, com rate limit.",
    "app/api/auth/signup/complete/route.ts": "cadastro do médico: confere o código, com rate limit.",
    "app/api/auth/password-reset/route.ts": "pedido de redefinição de senha por e-mail.",
    "app/api/auth/password-reset/[token]/route.ts": "redefinição de senha pelo token do e-mail.",
    // Servidor↔servidor, token no header comparado em tempo constante; sem a variável, 503.
    "app/api/auth/verificar-escala/route.ts": "x-escala-token (ESCALA_SSO_TOKEN).",
    "app/api/medicos/nomes/route.ts": "x-escala-token (ESCALA_SSO_TOKEN).",
    "app/api/briefing/route.ts": "x-briefing-token (BRIEFING_TOKEN, guardBriefingRequest).",
    "app/api/briefing/historico/route.ts": "x-briefing-token (BRIEFING_TOKEN, guardBriefingRequest).",
    "app/api/telegram/webhook/route.ts": "x-telegram-bot-api-secret-token (TELEGRAM_WEBHOOK_SECRET).",
    "app/api/servicos/contas-portal/route.ts": "x-portal-token (PORTAL_CONTAS_TOKEN); cria só conta com papel portal, nunca altera conta existente.",
    "app/api/servicos/contas-escala/route.ts": "x-escala-token (ESCALA_SSO_TOKEN); só dá papéis de operador da Central (tarm, radio_operador), nunca troca senha de conta existente.",
    "app/api/servicos/portal/acesso/route.ts": "x-escala-token (ESCALA_SSO_TOKEN); o porteiro confere a sessão do portal e reporta o uso (monitor de acessos).",
    "app/api/servicos/quadro/plantao/route.ts": "x-escala-token (ESCALA_SSO_TOKEN); o quadro da Central lê turno, enfermeiro(a), chefe e bases (só nomes, sem e-mail).",
    "app/api/servicos/relatorio/turno/route.ts": "x-escala-token (ESCALA_SSO_TOKEN); o relatório da chefia lê as ocupações do turno (nomes e horários, sem e-mail).",
    "app/api/servicos/relatorio/conta/route.ts": "x-escala-token (ESCALA_SSO_TOKEN); o relatório da chefia confere papéis e passagens pela 2031 de quem o porteiro já autenticou.",
    // Sonda de saúde: não lê dado de ninguém.
    "app/api/health/route.ts": "health check (identidade do runtime).",
    "app/healthz/route.ts": "health check.",
};

function listRoutes(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) return listRoutes(full);
        return entry.name === "route.ts" ? [relative(root, full)] : [];
    });
}

const routes = listRoutes(join(root, "app")).sort();

test("rotas: a varredura acha as rotas de app/", () => {
    assert.ok(routes.length > 50, `só ${routes.length} rotas encontradas`);
    assert.ok(routes.includes("app/api/doctors/import/route.ts"));
});

test("rotas: toda entrada da lista pública existe (lista sem lixo)", () => {
    for (const rel of Object.keys(PUBLIC_ROUTES)) {
        assert.ok(existsSync(join(root, rel)), `${rel} está na lista pública mas não existe`);
    }
});

for (const rel of routes) {
    if (rel in PUBLIC_ROUTES) continue;
    test(`rotas: ${rel} confere a sessão`, () => {
        assert.match(
            readFileSync(join(root, rel), "utf8"),
            GUARD,
            `${rel} não chama guard de sessão. Chame requireAuthenticatedSession (lib/auth/server.ts) ou, se for pública de propósito, ponha em PUBLIC_ROUTES com o motivo.`,
        );
    });
}

test("rotas: /api/doctors/import é só de admin", () => {
    const source = readFileSync(join(root, "app/api/doctors/import/route.ts"), "utf8");
    assert.match(source, /requireAuthenticatedSession\(\s*\[\s*"admin"\s*\]\s*\)/);
});

// Área do médico: sessão de qualquer papel entra no guard, mas a rota só age
// pelo PRÓPRIO médico (medicoDaSessao exige papel doctor + ficha vinculada).
for (const rel of [
    "app/api/medico/chegada/route.ts",
    "app/api/medico/saida/route.ts",
    "app/api/medico/estado/route.ts",
    "app/api/medico/continuar/route.ts",
    "app/api/medico/remanejar/route.ts",
]) {
    test(`rotas: ${rel} exige sessão e identifica o médico da sessão`, () => {
        const source = readFileSync(join(root, rel), "utf8");
        assert.match(source, /requireAuthenticatedSession\(\s*\)/);
        assert.match(source, /medicoDaSessao\(/);
    });
}

test("rotas: pedidos do médico na Mesa são de admin/chief (leitura na Mesa, decisão com escrita)", () => {
    const lista = readFileSync(join(root, "app/api/mesa/pedidos-do-medico/route.ts"), "utf8");
    assert.match(lista, /requireMesaSession\(\s*\[\s*"admin",\s*"chief"\s*\]\s*\)/);
    const decide = readFileSync(join(root, "app/api/mesa/pedidos-do-medico/[id]/decidir/route.ts"), "utf8");
    assert.match(decide, /requireMesaEscrita\(\s*\[\s*"admin",\s*"chief"\s*\]\s*\)/);
});
