/* Sessão única via Kairós — o cliente da introspecção (lib/auth/kairos.ts).

   O que estes testes protegem: as quatro regras de quem consome a
   introspecção (recusa em `ativa:false`, recusa em troca pendente, recusa
   quando o Kairós está fora do ar — nunca liberação) e a régua de higiene:
   o cookie viaja no CORPO do POST, jamais na URL. */

import assert from "node:assert/strict";
import test from "node:test";
import {
    KAIROS_SESSION_COOKIE,
    introspectKairosSession,
    isKairosIntegrationConfigured,
} from "@/lib/auth/kairos";

const AMBIENTE = {
    KAIROS_URL: "https://kairos.exemplo.test",
    KAIROS_SERVICO_TOKEN: "token-de-servico-de-teste",
};

async function comAmbiente<T>(
    valores: Record<string, string | undefined>,
    corpo: () => Promise<T>,
): Promise<T> {
    const anteriores = new Map<string, string | undefined>();
    for (const [chave, valor] of Object.entries(valores)) {
        anteriores.set(chave, process.env[chave]);
        if (valor === undefined) delete process.env[chave];
        else process.env[chave] = valor;
    }
    try {
        return await corpo();
    } finally {
        for (const [chave, valor] of anteriores) {
            if (valor === undefined) delete process.env[chave];
            else process.env[chave] = valor;
        }
    }
}

type ChamadaFetch = { url: string; init: RequestInit | undefined };

async function comFetch<T>(
    resposta: () => Promise<Response>,
    corpo: (chamadas: ChamadaFetch[]) => Promise<T>,
): Promise<T> {
    const original = globalThis.fetch;
    const chamadas: ChamadaFetch[] = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        chamadas.push({ url: String(url), init });
        return resposta();
    }) as typeof fetch;
    try {
        return await corpo(chamadas);
    } finally {
        globalThis.fetch = original;
    }
}

function respostaJson(status: number, corpo: unknown): Response {
    return new Response(JSON.stringify(corpo), {
        status,
        headers: { "content-type": "application/json" },
    });
}

test("sem KAIROS_URL/KAIROS_SERVICO_TOKEN a integração fica desligada e nada é buscado", async () => {
    await comAmbiente({ KAIROS_URL: undefined, KAIROS_SERVICO_TOKEN: undefined }, async () => {
        assert.equal(isKairosIntegrationConfigured(), false);
        await comFetch(
            async () => {
                throw new Error("não deveria buscar nada");
            },
            async (chamadas) => {
                const resultado = await introspectKairosSession("cookie-qualquer");
                assert.deepEqual(resultado, { ok: false, reason: "desligado" });
                assert.equal(chamadas.length, 0);
            },
        );
    });
});

test("sessão ativa vira identidade; o cookie vai no corpo do POST, nunca na URL", async () => {
    await comAmbiente(AMBIENTE, async () => {
        await comFetch(
            async () =>
                respostaJson(200, {
                    ativa: true,
                    pessoa: {
                        id: "p-1",
                        nome: "Ana Teste",
                        email: "ana@exemplo.test",
                        clienteId: "c-1",
                    },
                    permissoes: ["plantao.ver", 42],
                    trocaDeSenhaPendente: false,
                }),
            async (chamadas) => {
                const resultado = await introspectKairosSession("segredo-do-cookie");
                assert.ok(resultado.ok);
                assert.equal(resultado.person.id, "p-1");
                assert.equal(resultado.person.email, "ana@exemplo.test");
                // Permissão que não é string é descartada, não estoura.
                assert.deepEqual(resultado.permissions, ["plantao.ver"]);

                assert.equal(chamadas.length, 1);
                const chamada = chamadas[0]!;
                assert.equal(chamada.url, "https://kairos.exemplo.test/api/sessao/introspeccao");
                assert.doesNotMatch(chamada.url, /segredo-do-cookie/);
                assert.equal(chamada.init?.method, "POST");
                const headers = chamada.init?.headers as Record<string, string>;
                assert.equal(headers.authorization, "Bearer token-de-servico-de-teste");
                assert.match(String(chamada.init?.body), /segredo-do-cookie/);
            },
        );
    });
});

test("barra final na KAIROS_URL não duplica o caminho", async () => {
    await comAmbiente({ ...AMBIENTE, KAIROS_URL: "https://kairos.exemplo.test/" }, async () => {
        await comFetch(
            async () => respostaJson(200, { ativa: false }),
            async (chamadas) => {
                await introspectKairosSession("c");
                assert.equal(chamadas[0]?.url, "https://kairos.exemplo.test/api/sessao/introspeccao");
            },
        );
    });
});

test("ativa:false é recusa", async () => {
    await comAmbiente(AMBIENTE, async () => {
        await comFetch(
            async () => respostaJson(200, { ativa: false }),
            async () => {
                assert.deepEqual(await introspectKairosSession("c"), {
                    ok: false,
                    reason: "inativa",
                });
            },
        );
    });
});

test("troca de senha pendente é recusa — a trava do Kairós não se desfaz aqui", async () => {
    await comAmbiente(AMBIENTE, async () => {
        await comFetch(
            async () =>
                respostaJson(200, {
                    ativa: true,
                    trocaDeSenhaPendente: true,
                    pessoa: { id: "p", nome: "N", email: null, clienteId: "c" },
                    permissoes: [],
                }),
            async () => {
                assert.deepEqual(await introspectKairosSession("c"), {
                    ok: false,
                    reason: "troca_pendente",
                });
            },
        );
    });
});

test("Kairós fora do ar é recusa, não liberação", async () => {
    await comAmbiente(AMBIENTE, async () => {
        await comFetch(
            async () => {
                throw new Error("ECONNREFUSED");
            },
            async () => {
                assert.deepEqual(await introspectKairosSession("c"), {
                    ok: false,
                    reason: "indisponivel",
                });
            },
        );
    });
});

test("401 é token de serviço errado, não cookie — recusa como indisponível", async () => {
    await comAmbiente(AMBIENTE, async () => {
        await comFetch(
            async () => respostaJson(401, { erro: "servico_nao_autenticado" }),
            async () => {
                assert.deepEqual(await introspectKairosSession("c"), {
                    ok: false,
                    reason: "indisponivel",
                });
            },
        );
    });
});

test("resposta sem formato é recusa", async () => {
    await comAmbiente(AMBIENTE, async () => {
        for (const corpo of [{}, { ativa: true }, { ativa: true, pessoa: { id: 1 } }]) {
            await comFetch(
                async () => respostaJson(200, corpo),
                async () => {
                    assert.deepEqual(await introspectKairosSession("c"), {
                        ok: false,
                        reason: "indisponivel",
                    });
                },
            );
        }
    });
});

test("pessoa sem e-mail atravessa como email nulo — quem decide o que fazer é o chamador", async () => {
    await comAmbiente(AMBIENTE, async () => {
        await comFetch(
            async () =>
                respostaJson(200, {
                    ativa: true,
                    trocaDeSenhaPendente: false,
                    pessoa: { id: "p", nome: "Sem Email", clienteId: "c" },
                    permissoes: [],
                }),
            async () => {
                const resultado = await introspectKairosSession("c");
                assert.ok(resultado.ok);
                assert.equal(resultado.person.email, null);
            },
        );
    });
});

test("o nome do cookie esperado é o que o Kairós emite", () => {
    assert.equal(KAIROS_SESSION_COOKIE, "kairos_sessao");
});
