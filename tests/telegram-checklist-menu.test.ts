import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
    buildChecklistMaterialsKeyboard,
    buildChecklistMenuForbiddenReply,
    buildChecklistMenuKeyboard,
    buildChecklistMenuUnavailableReply,
    buildChecklistSumidosKeyboard,
    buildChecklistUnitsKeyboard,
    clampChecklistMenuText,
    encodeChecklistMenuCallback,
    fetchChecklistMenuMaterials,
    fetchChecklistMenuSumidos,
    fetchChecklistMenuText,
    fetchChecklistMenuUnits,
    parseChecklistMenuCallbackData,
    parseChecklistMenuCommand,
} from "@/modules/telegram/checklist-menu";

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

async function withMenuServer(
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

test("parseChecklistMenuCommand: menu, subcomandos, unidade e desconhecido", () => {
    assert.deepEqual(parseChecklistMenuCommand("/checklist"), { view: "menu" });
    assert.deepEqual(parseChecklistMenuCommand("/checklist pendentes"), { view: "pendentes" });
    assert.deepEqual(parseChecklistMenuCommand("/checklist@PlantoesBot faltas"), { view: "faltas" });
    assert.deepEqual(parseChecklistMenuCommand("/checklist observações"), { view: "obs" });
    assert.deepEqual(parseChecklistMenuCommand("/checklist hoje"), { view: "status" });
    assert.deepEqual(parseChecklistMenuCommand("/checklist material"), { view: "material" });
    assert.deepEqual(parseChecklistMenuCommand("/checklist sumidos"), { view: "sumidos" });
    assert.deepEqual(parseChecklistMenuCommand("/checklist SM01"), { view: "unit", baseCode: "SM01" });
    assert.deepEqual(parseChecklistMenuCommand("/checklist xyz"), { view: "menu", unknown: "xyz" });
    assert.equal(parseChecklistMenuCommand("/chave SM01"), null, "não confunde com /chave");
    assert.equal(parseChecklistMenuCommand("checklist"), null, "sem barra não é comando");
});

test("callback codec: roundtrip de todas as ações e orçamento de 64 bytes", () => {
    const actions = [
        { kind: "root" },
        { kind: "view", view: "status" },
        { kind: "view", view: "pendentes" },
        { kind: "view", view: "faltas" },
        { kind: "view", view: "obs" },
        { kind: "units", flow: "unit" },
        { kind: "units", flow: "material" },
        { kind: "units", flow: "sumidos" },
        { kind: "unit", code: "SM01" },
        { kind: "materials", code: "GOA" },
        { kind: "material", code: "SM01", key: "g5.1i12" },
        { kind: "sumidos", code: "CC70" },
    ] as const;
    for (const action of actions) {
        const encoded = encodeChecklistMenuCallback(action);
        assert.ok(Buffer.byteLength(encoded, "utf8") <= 64, `${encoded} cabe em 64 bytes`);
        assert.deepEqual(parseChecklistMenuCallbackData(encoded), action);
    }
    assert.equal(parseChecklistMenuCallbackData("f6:SD"), null, "prefixo alheio não é do menu");
    assert.equal(parseChecklistMenuCallbackData("clm:zz:AA"), null, "forma desconhecida é rejeitada");
    assert.equal(parseChecklistMenuCallbackData(undefined), null);
});

test("teclados: menu raiz completo, grades com volta ao menu", () => {
    const root = buildChecklistMenuKeyboard();
    const rootLabels = root.flat().map((b) => b.text).join(" | ");
    for (const label of ["Status", "Pendentes", "Faltas", "Observações", "unidade", "material", "recentes"]) {
        assert.ok(rootLabels.includes(label), `menu raiz tem "${label}"`);
    }

    const units = buildChecklistUnitsKeyboard(
        [{ code: "SM01", done: true }, { code: "CB02", done: false }, { code: "PR03", done: true }, { code: "PM04", done: false }],
        "material",
    );
    assert.equal(units[0].length, 3, "3 unidades por linha");
    assert.equal(units[0][0].text, "✅ SM01");
    assert.equal(units[0][1].text, "⚠️ CB02");
    assert.equal(units[0][0].callback_data, "clm:mu:SM01", "fluxo material roteia para a grade de materiais");
    assert.equal(units.at(-1)?.[0].text, "« Menu");

    const materials = buildChecklistMaterialsKeyboard([{ key: "g1i1", label: "Laringoscópio" }], "SM01");
    assert.equal(materials[0][0].callback_data, "clm:mh:SM01:g1i1");

    const sumidos = buildChecklistSumidosKeyboard([{ key: "g2i3", label: "Ambu adulto" }], "PM04");
    assert.equal(sumidos[0][0].text, "🚫 Ambu adulto");
    assert.equal(sumidos[0][0].callback_data, "clm:mh:PM04:g2i3", "item sumido abre o histórico do material");
});

test("replies didáticas e clamp de tamanho", () => {
    assert.match(buildChecklistMenuUnavailableReply(), /endpoints desta migração ainda não publicados/);
    assert.match(buildChecklistMenuForbiddenReply(), /\/chave/, "médico comum é apontado para o que é dele");
    const long = "x".repeat(5000);
    const clamped = clampChecklistMenuText(long);
    assert.ok(clamped.length < 4096, "nunca estoura o teto do Telegram");
    assert.ok(clamped.endsWith("…"));
    assert.equal(clampChecklistMenuText("curto"), "curto");
});

test("cliente: sem configuração devolve unconfigured (fail-soft)", async () => {
    const restore = withChecklistEnv(null, null);
    try {
        assert.deepEqual(await fetchChecklistMenuText("status"), { status: "unconfigured" });
        assert.deepEqual(await fetchChecklistMenuUnits(), { status: "unconfigured" });
    } finally {
        restore();
    }
});

test("cliente: ok/404/500 mapeiam para ok/not_found/unavailable; listas são validadas", async () => {
    await withMenuServer((req, res) => {
        assert.equal(req.headers["x-internal-token"], "token-de-teste");
        if (req.url === "/api/internal/menu/status") {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: true, text: "📋 <b>Checklist USA</b> — tudo certo" }));
            return;
        }
        if (req.url === "/api/internal/menu/unit/XX99") {
            res.statusCode = 404;
            res.end();
            return;
        }
        if (req.url === "/api/internal/menu/units") {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: true, day: "2026-08-30", units: [{ code: "SM01", done: true }, { code: "CB02", done: false }] }));
            return;
        }
        if (req.url === "/api/internal/menu/materials") {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: true, materials: [{ key: "g1i1", label: "Laringoscópio" }] }));
            return;
        }
        if (req.url === "/api/internal/menu/sumidos/PM04") {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: true, text: "📉 faltas recentes", missing: [{ key: "g2i3", label: "Ambu" }] }));
            return;
        }
        res.statusCode = 500;
        res.end();
    }, async (baseUrl) => {
        const restore = withChecklistEnv(baseUrl, "token-de-teste");
        try {
            assert.deepEqual(await fetchChecklistMenuText("status"), { status: "ok", text: "📋 <b>Checklist USA</b> — tudo certo" });
            assert.deepEqual(await fetchChecklistMenuText("unit/XX99"), { status: "not_found" });
            assert.deepEqual(await fetchChecklistMenuText("faltas"), { status: "unavailable" }, "5xx = fora do ar");

            const units = await fetchChecklistMenuUnits();
            assert.equal(units.status, "ok");
            assert.deepEqual(units.status === "ok" ? units.units : [], [{ code: "SM01", done: true }, { code: "CB02", done: false }]);

            const materials = await fetchChecklistMenuMaterials();
            assert.equal(materials.status, "ok");

            const sumidos = await fetchChecklistMenuSumidos("PM04");
            assert.equal(sumidos.status, "ok");
            assert.deepEqual(sumidos.status === "ok" ? sumidos.missing : [], [{ key: "g2i3", label: "Ambu" }]);
        } finally {
            restore();
        }
    });
});

test("cliente: serviço fora do ar devolve unavailable (fail-soft)", async () => {
    const restore = withChecklistEnv("http://127.0.0.1:59999", "token-de-teste");
    try {
        assert.deepEqual(await fetchChecklistMenuText("status"), { status: "unavailable" });
    } finally {
        restore();
    }
});
