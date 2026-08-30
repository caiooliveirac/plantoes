import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
    buildChecklistKeyHint,
    buildChecklistKeyUnavailableHint,
    CHECKLIST_BOT_URL,
    checklistHintForConfirmation,
    fetchChecklistKeyHint,
} from "@/modules/telegram/checklist-key";

function withChecklistEnv(apiUrl: string | null, token: string | null) {
    const prevUrl = process.env.CHECKLIST_API_URL;
    const prevToken = process.env.CHECKLIST_INTERNAL_TOKEN;
    if (apiUrl === null) delete process.env.CHECKLIST_API_URL;
    else process.env.CHECKLIST_API_URL = apiUrl;
    if (token === null) delete process.env.CHECKLIST_INTERNAL_TOKEN;
    else process.env.CHECKLIST_INTERNAL_TOKEN = token;
    return () => {
        if (prevUrl !== undefined) process.env.CHECKLIST_API_URL = prevUrl;
        else delete process.env.CHECKLIST_API_URL;
        if (prevToken !== undefined) process.env.CHECKLIST_INTERNAL_TOKEN = prevToken;
        else delete process.env.CHECKLIST_INTERNAL_TOKEN;
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

test("buildChecklistKeyHint: chegada monta bloco com base, chave e privado do bot", () => {
    const hint = buildChecklistKeyHint("SM01", "1234");
    assert.match(hint, /Checklist \*SM01\*/);
    assert.match(hint, /chave de hoje \*1234\*/);
    assert.match(hint, /checklist\.mnrs\.com\.br\/b\/SM01/);
    assert.match(hint, /chave no privado/, "enfatiza que o privado do bot entrega a chave");
    assert.ok(hint.includes(`(${CHECKLIST_BOT_URL})`), "o link do bot viaja como url de [link](...)");
    assert.ok(hint.startsWith("\n\n"), "separa da confirmação com linha em branco");
    // Chegada da USA vinha com bloco maior que a própria confirmação: 2 linhas.
    assert.equal(hint.trim().split("\n").length, 2, "bloco de chegada cabe em 2 linhas");
    // Em Markdown v1 os `_` do username soltos no texto viram itálico e quebram
    // a menção — o username só pode aparecer dentro da url do [link](...).
    assert.ok(!hint.includes("@samu_checklists_bot"), "sem menção crua com underscore");
});

test("buildChecklistKeyHint: remanejamento nomeia a base de DESTINO e enfatiza o privado", () => {
    const hint = buildChecklistKeyHint("SM01", "1234", { reassignment: true });
    assert.match(hint, /Checklist da nova base \*SM01\*/, "diz que a chave é da base de destino");
    assert.match(hint, /chave de hoje \*1234\*/);
    assert.match(hint, /checklist\.mnrs\.com\.br\/b\/SM01/);
    assert.match(hint, /sempre pode consultar a chave no privado/i, "ênfase pedida pela chefia");
    assert.ok(hint.includes(`(${CHECKLIST_BOT_URL})`));
    assert.equal(hint.trim().split("\n").length, 3, "remanejamento ganha a linha extra de ênfase");
});

test("buildChecklistKeyHint: formato plain sai sem markup e com url crua", () => {
    const hint = buildChecklistKeyHint("SM01", "1234", { format: "plain" });
    assert.ok(!hint.includes("*"), "sem negrito em mensagens sem parse_mode");
    assert.ok(!hint.includes("["), "sem [link](url) em mensagens sem parse_mode");
    assert.match(hint, /Checklist SM01 · chave de hoje 1234/);
    assert.ok(hint.includes(CHECKLIST_BOT_URL), "url crua auto-linkada pelo Telegram");
});

test("buildChecklistKeyHint: vazio sem base ou sem chave", () => {
    assert.equal(buildChecklistKeyHint("", "1234"), "");
    assert.equal(buildChecklistKeyHint("SM01", ""), "");
});

test("buildChecklistKeyUnavailableHint: sem a chave ainda aponta o privado do bot", () => {
    const hint = buildChecklistKeyUnavailableHint("SM01");
    assert.match(hint, /Checklist \*SM01\*/);
    assert.match(hint, /não consegui buscar a chave/);
    assert.match(hint, /Pegue a chave no privado/);
    assert.ok(hint.includes(`(${CHECKLIST_BOT_URL})`));
    assert.match(hint, /checklist\.mnrs\.com\.br\/b\/SM01/);

    const reassignment = buildChecklistKeyUnavailableHint("SM01", { reassignment: true });
    assert.match(reassignment, /Checklist da nova base \*SM01\*/);

    assert.equal(buildChecklistKeyUnavailableHint(""), "");
});

test("fetchChecklistKeyHint: sem configuração devolve vazio (fail-soft)", async () => {
    const restore = withChecklistEnv(null, null);
    try {
        assert.equal(await fetchChecklistKeyHint("SM01"), "");
    } finally {
        restore();
    }
});

test("fetchChecklistKeyHint: serviço fora do ar devolve o bloco SEM chave apontando o privado", async () => {
    const restore = withChecklistEnv("http://127.0.0.1:59999", "token-de-teste");
    try {
        const hint = await fetchChecklistKeyHint("SM01");
        assert.match(hint, /não consegui buscar a chave/);
        assert.ok(hint.includes(`(${CHECKLIST_BOT_URL})`));
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
        const restore = withChecklistEnv(baseUrl, "token-de-teste");
        try {
            const hint = await fetchChecklistKeyHint("SM01", { reassignment: true });
            assert.match(hint, /Checklist da nova base \*SM01\* · chave de hoje \*4321\*/);
        } finally {
            restore();
        }
    });
});

test("fetchChecklistKeyHint: 404 e ok:false são resposta deliberada — silêncio; 5xx aponta o privado", async () => {
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
        const restore = withChecklistEnv(baseUrl, "token-de-teste");
        try {
            assert.equal(await fetchChecklistKeyHint("SEM01"), "", "404 = base sem checklist, sem ruído");
            assert.equal(await fetchChecklistKeyHint("SB02"), "", "ok:false = sem chave de propósito");
            assert.match(await fetchChecklistKeyHint("SM01"), /não consegui buscar a chave/, "5xx = serviço tropeçou");
        } finally {
            restore();
        }
    });
});

test("checklistHintForConfirmation: só chegada em intervenção recebe a chave", async () => {
    const restore = withChecklistEnv(null, null); // fetch devolve "" — aqui testamos só o gating
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
        const restore = withChecklistEnv(baseUrl, "token-de-teste");
        try {
            const hint = await checklistHintForConfirmation(
                { sector: "INTERVENTION", baseCode: "SM01" },
                "reassignment_recorded",
            );
            assert.match(hint, /Checklist da nova base \*SM01\* · chave de hoje \*7788\*/);
            assert.match(hint, /sempre pode consultar a chave no privado/i);

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
