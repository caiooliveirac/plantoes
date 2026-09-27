/* ==========================================================================
   Verificação de credencial para o Escalas & Trocas (app irmão).

   O médico já tem conta AQUI. Em vez de criar uma segunda conta e uma segunda
   senha lá, o escala manda o par e-mail/senha para esta rota e, com o "sim"
   daqui, emite a sessão DELE. Nenhuma senha é copiada entre os dois sistemas:
   o hash continua morando só neste banco, e esta rota nunca devolve hash.

   Portão: ESCALA_SSO_TOKEN, no header x-escala-token, comparado em tempo
   constante. FALHA FECHADA — sem a variável no ambiente a rota responde 503 e
   não verifica nada. Esquecer de definir derruba o login do escala (barulhento,
   conserta-se em um minuto) em vez de abrir um oráculo de senha para a internet.

   Servidor↔servidor: quem chama é o processo do escala, não o navegador do
   médico. Por isso não há cookie nem CORS aqui, e o token nunca passa pelo
   cliente.

   Limite de tentativa: o escala já conta 5 falhas por e-mail em 15 min antes de
   chegar aqui (lib/auth/store.ts de lá). Este teto por e-mail é o segundo, para
   o caso de o token vazar e alguém falar direto com esta rota.

   Quem chama hoje é também o porteiro do mnrs.com.br (login único do portal).
   Por isso o escopo aqui é "portal": o papel `portal` (conta que só entra no
   portal, sem acesso ao app Plantões) vale nesta rota e em nenhum outro lugar.

   Monitor de acessos (docs/monitor-acessos.md): cada senha conferida aqui —
   certa ou errada — vira evento `senha_portal_*` da conta, com o IP/aparelho/
   localização que o porteiro repassar (cf-connecting-ip, user-agent e os
   cf-ip* do visitante; x-forwarded-for se só vier ele). O sucesso devolve
   também `sessionVersion`: o porteiro guarda no cookie do portal e manda no
   handoff, e o /api/auth/sso recusa o login de portal de antes de uma troca de
   senha ou de "encerrar sessões".

   Motivo da recusa (401 invalid_credentials): além do `error`, a resposta diz
   `conta: "inexistente" | "existente"` e, se existe, `senhaAlteradaEm` (ISO ou
   null). TROCA CONSCIENTE (decisão do Caio, 09/2026): isto deixa quem tem o
   token saber se um e-mail tem conta aqui — enumeração de contas. Aceita
   porque a rota só responde a servidor com o token (x-escala-token), tem o teto
   de falhas por e-mail abaixo, e sem a distinção a pessoa fica presa no portal
   sem saber se precisa pedir conta ou redefinir a senha. `status` e `error`
   continuam idênticos aos de antes: porteiro antigo ignora os campos novos.
   ========================================================================== */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, hasDatabaseUrl } from "@/db";
import { doctors, users } from "@/db/schema";
import { lerContextoRequisicao } from "@/lib/acessos/contexto";
import { depoisDaResposta } from "@/lib/acessos/depois";
import { registrarTentativaDeSenha } from "@/services/acessos.service";
import { authenticateWithPassword, consultarSituacaoConta, type SituacaoConta } from "@/services/auth.service";

const schema = z.object({
    email: z.string().email(),
    password: z.string().min(1),
});

const MAX_FALHAS = 10;
const JANELA_MS = 15 * 60 * 1000;
const falhas = new Map<string, { contagem: number; ate: number }>();

function bloqueado(email: string, agora: number): boolean {
    for (const [chave, v] of falhas) if (v.ate <= agora) falhas.delete(chave);
    const atual = falhas.get(email);
    return Boolean(atual && atual.contagem >= MAX_FALHAS && atual.ate > agora);
}

function registrarFalha(email: string, agora: number): void {
    const atual = falhas.get(email);
    if (!atual || atual.ate <= agora) {
        // teto de e-mails rastreados: a rota é chamada por servidor conhecido,
        // mas um token vazado não pode virar consumo de memória sem limite
        if (!atual && falhas.size >= 5_000) return;
        falhas.set(email, { contagem: 1, ate: agora + JANELA_MS });
        return;
    }
    atual.contagem += 1;
}

function tokenConfere(recebido: string | null, esperado: string): boolean {
    if (!recebido) return false;
    const a = Buffer.from(recebido, "utf8");
    const b = Buffer.from(esperado, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: NextRequest) {
    const esperado = process.env.ESCALA_SSO_TOKEN;
    if (!esperado) {
        console.error(
            "[verificar-escala] ESCALA_SSO_TOKEN ausente no ambiente — rota desligada. " +
                "Defina a variável nos DOIS lados (aqui e no escala).",
        );
        return NextResponse.json({ error: "integration_not_configured" }, { status: 503 });
    }
    if (!tokenConfere(request.headers.get("x-escala-token"), esperado)) {
        return NextResponse.json({ error: "invalid_token" }, { status: 401 });
    }
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }

    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: "email and password are required." }, { status: 400 });
    }

    const email = parsed.data.email.trim().toLowerCase();
    const agora = Date.now();
    if (bloqueado(email, agora)) {
        return NextResponse.json({ error: "too_many_attempts" }, { status: 429 });
    }

    const result = await authenticateWithPassword(email, parsed.data.password, { escopo: "portal" });
    const contexto = lerContextoRequisicao(request.headers);
    const userIdDaSenha = result.status === "success" ? result.user.id : null;
    const motivoDaRecusa = result.status === "success" ? undefined : result.status;
    depoisDaResposta(() => registrarTentativaDeSenha({ email, ok: userIdDaSenha !== null, via: "portal", contexto, userId: userIdDaSenha, motivo: motivoDaRecusa }));
    if (result.status !== "success") {
        registrarFalha(email, agora);
        let situacao: SituacaoConta | null = null;
        if (result.status === "invalid_credentials") {
            situacao = await consultarSituacaoConta(email);
        }
        console.log(
            `[verificar-escala] ${new Date().toISOString()} recusado ${JSON.stringify({
                email,
                motivo: result.status,
                ...(situacao ? { conta: situacao.conta } : {}),
            })}`,
        );
        return NextResponse.json({ error: result.status, ...(situacao ?? {}) }, { status: 401 });
    }
    falhas.delete(email);

    /* `normalizedName` é a chave de junção com o cadastro do escala — lá o
       profissional é `m-<slug do nome>`. É a mesma regra de nome que o
       backfill de contrato já usa entre os dois lados (SPEC §9.5). Sem médico
       vinculado (chefe/admin que não é médico) o campo vai nulo e o escala
       decide o que fazer — aqui não se inventa vínculo. */
    let nome: string | null = null;
    let normalizedName: string | null = null;
    if (result.user.doctorId) {
        const [medico] = await getDb()
            .select({ fullName: doctors.fullName, normalizedName: doctors.normalizedName, isActive: doctors.isActive })
            .from(doctors)
            .where(eq(doctors.id, result.user.doctorId))
            .limit(1);
        if (medico?.isActive) {
            nome = medico.fullName;
            normalizedName = medico.normalizedName;
        }
    }

    const [versao] = await getDb()
        .select({ sessionVersion: users.sessionVersion })
        .from(users)
        .where(eq(users.id, result.user.id))
        .limit(1);

    console.log(`[verificar-escala] ${new Date().toISOString()} ok ${JSON.stringify({ email, vinculado: Boolean(normalizedName) })}`);
    return NextResponse.json({
        ok: true,
        userId: result.user.id,
        email: result.user.email,
        doctorId: result.user.doctorId,
        nome,
        normalizedName,
        roles: result.user.roles,
        mustChangePassword: result.user.mustChangePassword,
        sessionVersion: versao?.sessionVersion ?? 0,
    });
}
