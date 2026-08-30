import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
    buildChecklistKeyHint,
    buildChecklistKeyUnavailableHint,
    checklistHintForConfirmation,
    fetchChecklistKey,
    fetchChecklistKeyHint,
    resolveChecklistKeyDeepLink,
} from "@/modules/telegram/checklist-key";

const BOT_URL = "https://t.me/bot_de_teste?start=chave";

function withEnv(patch: Record<string, string | null>) {
    const previous = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(patch)) {
        previous.set(key, process.env[key]);
        if (value === null) delete process.env[key];
        else process.env[key] = value;
    }
    return () => {
        for (const [key, value] of previous) {
            if (value !== undefined) process.env[key] = value;
            else delete process.env[key];
        }
    };
}

async function withChecklistServer(
    handler: Parameters<typeof createServer>[1],
    run: (baseUrl: string) => Promise<void>,
) {
    const server: Server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
        await run(`http://127.0.0.1:${port}`);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}

test("buildChecklistKeyHint: chegada monta bloco com base, chave e /chave no privado", () => {
    const hint = buildChecklistKeyHint("SM01", "1234", { botUrl: BOT_URL });
    assert.match(hint, /Checklist \*SM01\*/);
    assert.match(hint, /chave de hoje \*1234\*/);
    assert.match(hint, /checklist\.mnrs\.com\.br\/b\/SM01/);
    assert.match(hint, /\/chave/, "ensina ONDE pedir a chave de novo");
    assert.ok(hint.includes(`(${BOT_URL})`), "o deep link viaja como url de [link](...)");
    assert.ok(hint.startsWith("\n\n"), "separa da confirmação com linha em branco");
    // Chegada da USA vinha com bloco maior que a própria confirmação: 2 linhas.
    assert.equal(hint.trim().split("\n").length, 2, "bloco de chegada cabe em 2 linhas");
    // Em Markdown v1 um username com `_` solto no texto vira itálico e quebra a
    // menção — username/link só podem aparecer dentro da url do [link](...).
    assert.ok(!hint.includes("@samu_checklists_bot"), "sem menção crua com underscore");
});

test("buildChecklistKeyHint: remanejamento nomeia a base de DESTINO e enfatiza o privado", () => {
    const hint = buildChecklistKeyHint("SM01", "1234", { reassignment: true, botUrl: BOT_URL });
    assert.match(hint, /Checklist da nova base \*SM01\*/, "diz que a chave é da base de destino");
    assert.match(hint, /chave de hoje \*1234\*/);
    assert.match(hint, /checklist\.mnrs\.com\.br\/b\/SM01/);
    assert.match(hint, /sempre pode pedir a chave/i, "ênfase pedida pela coordenação");
    assert.ok(hint.includes(`(${BOT_URL})`));
    assert.equal(hint.trim().split("\n").length, 3, "remanejamento ganha a linha extra de ênfase");
});

test("buildChecklistKeyHint: sem deep link ainda ensina o /chave (texto puro)", () => {
    const hint = buildChecklistKeyHint("SM01", "1234", { reassignment: true, botUrl: null });
    assert.match(hint, /manda \/chave/, "instrução sobrevive sem o link");
    assert.ok(!hint.includes("["), "sem [link](url) quebrado quando não há url");
});

test("buildChecklistKeyHint: formato plain sai sem markup", () => {
    const hint = buildChecklistKeyHint("SM01", "1234", { format: "plain", botUrl: BOT_URL });
    assert.ok(!hint.includes("*"), "sem negrito em mensagens sem parse_mode");
    assert.ok(!hint.includes("["), "sem [link](url) em mensagens sem parse_mode");
    assert.match(hint, /Checklist SM01 · chave de hoje 1234/);
    assert.ok(hint.includes(BOT_URL), "url crua auto-linkada pelo Telegram");
});

test("buildChecklistKeyHint: vazio sem base ou sem chave", () => {
    assert.equal(buildChecklistKeyHint("", "1234"), "");
    assert.equal(buildChecklistKeyHint("SM01", ""), "");
});

test("buildChecklistKeyUnavailableHint: sem a chave ainda aponta o /chave no privado", () => {
    const hint = buildChecklistKeyUnavailableHint("SM01", { botUrl: BOT_URL });
    assert.match(hint, /Checklist \*SM01\*/);
    assert.match(hint, /não consegui buscar a chave/);
    assert.match(hint, /\/chave/);
    assert.ok(hint.includes(`(${BOT_URL})`));
    assert.match(hint, /checklist\.mnrs\.com\.br\/b\/SM01/);

    const reassignment = buildChecklistKeyUnavailableHint("SM01", { reassignment: true, botUrl: BOT_URL });
    assert.match(reassignment, /Checklist da nova base \*SM01\*/);

    assert.equal(buildChecklistKeyUnavailableHint(""), "");
});

test("resolveChecklistKeyDeepLink: usa TELEGRAM_BOT_USERNAME sem rede; sem nada devolve null", async () => {
    const restore = withEnv({ TELEGRAM_BOT_USERNAME: "bot_de_teste", TELEGRAM_BOT_TOKEN: null });
    try {
        assert.equal(await resolveChecklistKeyDeepLink(), "https://t.me/bot_de_teste?start=chave");
    } finally {
        restore();
    }

    const restoreEmpty = withEnv({ TELEGRAM_BOT_USERNAME: null, TELEGRAM_BOT_TOKEN: null });
    try {
        assert.equal(await resolveChecklistKeyDeepLink(), null, "sem username e sem token: fail-soft");
    } finally {
        restoreEmpty();
    }
});

test("fetchChecklistKey: sem configuração devolve unconfigured (fail-soft)", async () => {
    const restore = withEnv({ CHECKLIST_API_URL: null, CHECKLIST_INTERNAL_TOKEN: null });
    try {
        assert.deepEqual(await fetchChecklistKey("SM01"), { status: "unconfigured" });
        assert.equal(await fetchChecklistKeyHint("SM01"), "");
    } finally {
        restore();
    }
});

test("fetchChecklistKeyHint: serviço fora do ar devolve o bloco SEM chave apontando o /chave", async () => {
    const restore = withEnv({
        CHECKLIST_API_URL: "http://127.0.0.1:59999",
        CHECKLIST_INTERNAL_TOKEN: "token-de-teste",
        TELEGRAM_BOT_USERNAME: "bot_de_teste",
        TELEGRAM_BOT_TOKEN: null,
    });
    try {
        assert.deepEqual(await fetchChecklistKey("SM01"), { status: "unavailable" });
        const hint = await fetchChecklistKeyHint("SM01");
        assert.match(hint, /não consegui buscar a chave/);
        assert.ok(hint.includes("(https://t.me/bot_de_teste?start=chave)"));
    } finally {
        restore();
    }
});

test("fetchChecklistKeyHint: resposta ok monta o hint com a chave (e propaga a variante)", async () => {
    await withChecklistServer((req, res) => {
        assert.equal(req.headers["x-internal-token"], "token-de-teste");
        assert.equal(req.url, "/api/internal/keys/SM01");
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, baseCode: "SM01", key: "4321" }));
    }, async (baseUrl) => {
        const restore = withEnv({
            CHECKLIST_API_URL: baseUrl,
            CHECKLIST_INTERNAL_TOKEN: "token-de-teste",
            TELEGRAM_BOT_USERNAME: "bot_de_teste",
        });
        try {
            const hint = await fetchChecklistKeyHint("SM01", { reassignment: true });
            assert.match(hint, /Checklist da nova base \*SM01\* · chave de hoje \*4321\*/);
        } finally {
            restore();
        }
    });
});

test("fetchChecklistKey: 404 e ok:false são resposta deliberada (no_key, sem ruído); 5xx é unavailable", async () => {
    await withChecklistServer((req, res) => {
        if (req.url?.endsWith("/SEM01")) {
            res.statusCode = 404;
            res.end();
            return;
        }
        if (req.url?.endsWith("/SB02")) {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: false }));
            return;
        }
        res.statusCode = 500;
        res.end();
    }, async (baseUrl) => {
        const restore = withEnv({
            CHECKLIST_API_URL: baseUrl,
            CHECKLIST_INTERNAL_TOKEN: "token-de-teste",
            TELEGRAM_BOT_USERNAME: "bot_de_teste",
        });
        try {
            assert.deepEqual(await fetchChecklistKey("SEM01"), { status: "no_key" });
            assert.equal(await fetchChecklistKeyHint("SEM01"), "", "404 = base sem checklist, sem ruído na confirmação");
            assert.deepEqual(await fetchChecklistKey("SB02"), { status: "no_key" });
            assert.deepEqual(await fetchChecklistKey("SM01"), { status: "unavailable" });
            assert.match(await fetchChecklistKeyHint("SM01"), /não consegui buscar a chave/, "5xx = serviço tropeçou");
        } finally {
            restore();
        }
    });
});

test("checklistHintForConfirmation: só chegada em intervenção recebe a chave", async () => {
    const restore = withEnv({ CHECKLIST_API_URL: null, CHECKLIST_INTERNAL_TOKEN: null }); // fetch devolve "" — aqui testamos só o gating
    try {
        // regulação, saída e replies não-chegada nunca buscam chave
        assert.equal(await checklistHintForConfirmation({ sector: "REGULATION", baseCode: "1363" }, "arrival_recorded"), "");
        assert.equal(await checklistHintForConfirmation({ sector: "INTERVENTION", isDeparture: true, baseCode: "SM01" }, "arrival_recorded"), "");
        assert.equal(await checklistHintForConfirmation({ sector: "INTERVENTION", baseCode: "SM01" }, "departure_recorded"), "");
        // chegada em intervenção passa pelo gate (fetch sem env devolve "")
        assert.equal(await checklistHintForConfirmation({ sector: "INTERVENTION", baseCode: "SM01" }, "arrival_recorded"), "");
    } finally {
        restore();
    }
});

test("checklistHintForConfirmation: remanejamento entrega a chave da base de destino", async () => {
    await withChecklistServer((req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, baseCode: "SM01", key: "7788" }));
    }, async (baseUrl) => {
        const restore = withEnv({
            CHECKLIST_API_URL: baseUrl,
            CHECKLIST_INTERNAL_TOKEN: "token-de-teste",
            TELEGRAM_BOT_USERNAME: "bot_de_teste",
        });
        try {
            const hint = await checklistHintForConfirmation(
                { sector: "INTERVENTION", baseCode: "SM01" },
                "reassignment_recorded",
            );
            assert.match(hint, /Checklist da nova base \*SM01\* · chave de hoje \*7788\*/);
            assert.match(hint, /sempre pode pedir a chave/i);

            const arrival = await checklistHintForConfirmation(
                { sector: "INTERVENTION", baseCode: "SM01" },
                "arrival_recorded",
            );
            assert.match(arrival, /Checklist \*SM01\*/);
            assert.ok(!arrival.includes("nova base"), "chegada comum mantém o bloco enxuto");
        } finally {
            restore();
        }
    });
});
