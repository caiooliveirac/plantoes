import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * O quadro operacional é fechado: só quem tem sessão sabe quem está em cada
 * ramal/base (lib/auth/portao.ts). Até 2026-09-27 `/` e /api/board eram públicos.
 *
 * Regra: toda rota que entrega o quadro confere a sessão no servidor, em cada
 * handler exportado (GET, POST…), e a página `/` manda quem não tem sessão para
 * destinoSemSessao(). A barreira NÃO mora no proxy.ts — ele só renova o cookie,
 * não consulta o banco (conta inativa ou sem papel passaria) e não pode virar
 * o portão (AUTH_PLAN.md).
 */

const root = process.cwd();
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

const GUARDED_ROUTES = [
    "app/api/board/route.ts",
    "app/api/board/stream/route.ts",
    "app/api/board/occurrence-handoff/route.ts",
];

const GUARD = /\b(requireAuthenticatedSession|requireSessionForRead)\s*\(/;

/** Corpo de uma função top-level: do cabeçalho até a próxima declaração top-level. */
function topLevelBody(source: string, header: RegExp) {
    const match = header.exec(source);
    if (!match) return null;
    const rest = source.slice(match.index + match[0].length);
    const next = rest.search(/\n(export |async function |function |const |let )/);
    return next === -1 ? rest : rest.slice(0, next);
}

/** O handler chama o guard direto ou por uma função local que o chama. */
function callsGuard(source: string, body: string) {
    if (GUARD.test(body)) return true;
    for (const [, name] of source.matchAll(/\n(?:async )?function (\w+)\s*\(/g)) {
        const helper = topLevelBody(source, new RegExp(`\\n(?:async )?function ${name}\\s*\\(`));
        if (helper && GUARD.test(helper) && new RegExp(`\\b${name}\\s*\\(`).test(body)) return true;
    }
    return false;
}

for (const rel of GUARDED_ROUTES) {
    test(`quadro fechado: ${rel} confere a sessão em todo handler`, () => {
        const source = read(rel);
        const handlers = [...source.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1]);
        assert.ok(handlers.length > 0, `${rel} sem handler exportado`);
        for (const method of handlers) {
            const body = topLevelBody(source, new RegExp(`export async function ${method}\\b`));
            assert.ok(body && callsGuard(source, body), `${rel} ${method} não chama o guard de sessão`);
        }
    });
}

test("quadro fechado: / manda quem não tem sessão para destinoSemSessao()", () => {
    const source = read("app/page.tsx");
    assert.match(source, /readAuthenticatedSession\s*\(/);
    assert.match(source, /redirect\(\s*destinoSemSessao\(\)\s*\)/);
});

test("quadro fechado: a barreira não migra para o proxy.ts", () => {
    const source = read("proxy.ts");
    assert.doesNotMatch(source, /destinoSemSessao|portao/);
    assert.doesNotMatch(source, /NextResponse\.redirect|redirect\(/);
});
