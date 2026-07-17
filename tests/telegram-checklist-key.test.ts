import assert from "node:assert/strict";
import test from "node:test";
import { buildChecklistKeyHint, fetchChecklistKeyHint } from "@/modules/telegram/checklist-key";

test("buildChecklistKeyHint: monta bloco com base, chave e link", () => {
    const hint = buildChecklistKeyHint("SM01", "1234");
    assert.match(hint, /Checklist da \*SM01\*/);
    assert.match(hint, /chave de hoje: \*1234\*/);
    assert.match(hint, /checklist\.mnrs\.com\.br\/b\/SM01/);
    assert.ok(hint.startsWith("\n\n"), "separa da confirmação com linha em branco");
});

test("buildChecklistKeyHint: vazio sem base ou sem chave", () => {
    assert.equal(buildChecklistKeyHint("", "1234"), "");
    assert.equal(buildChecklistKeyHint("SM01", ""), "");
});

test("fetchChecklistKeyHint: sem configuração devolve vazio (fail-soft)", async () => {
    const prevUrl = process.env.CHECKLIST_API_URL;
    const prevToken = process.env.CHECKLIST_INTERNAL_TOKEN;
    delete process.env.CHECKLIST_API_URL;
    delete process.env.CHECKLIST_INTERNAL_TOKEN;
    try {
        assert.equal(await fetchChecklistKeyHint("SM01"), "");
    } finally {
        if (prevUrl !== undefined) process.env.CHECKLIST_API_URL = prevUrl;
        if (prevToken !== undefined) process.env.CHECKLIST_INTERNAL_TOKEN = prevToken;
    }
});

test("fetchChecklistKeyHint: serviço fora do ar devolve vazio (fail-soft)", async () => {
    const prevUrl = process.env.CHECKLIST_API_URL;
    const prevToken = process.env.CHECKLIST_INTERNAL_TOKEN;
    process.env.CHECKLIST_API_URL = "http://127.0.0.1:59999";
    process.env.CHECKLIST_INTERNAL_TOKEN = "token-de-teste";
    try {
        assert.equal(await fetchChecklistKeyHint("SM01"), "");
    } finally {
        if (prevUrl !== undefined) process.env.CHECKLIST_API_URL = prevUrl;
        else delete process.env.CHECKLIST_API_URL;
        if (prevToken !== undefined) process.env.CHECKLIST_INTERNAL_TOKEN = prevToken;
        else delete process.env.CHECKLIST_INTERNAL_TOKEN;
    }
});
