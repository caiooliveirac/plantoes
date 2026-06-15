import assert from "node:assert/strict";
import test from "node:test";

import { parseMessage } from "@/modules/telegram/parser";
import {
    buildDestinationSelectionKeyboard,
    buildUnknownDestinationReplyText,
    parseDestinationSelectionCallbackData,
    replaceUnknownTargetToken,
    suggestNearestTargetCodes,
} from "@/modules/telegram/pending-buttons";
import { isCallbackButton } from "@/modules/telegram/api";

const LOG_ID = "0d9e4f6a-1b2c-4d3e-8f90-a1b2c3d4e5f6";

// ── Parser expõe o token de destino rejeitado (auditoria §3.1#9, campo aditivo) ────

test("parseMessage expõe unknownTargetToken para ramal de 4 dígitos desconhecido", () => {
    // 2378 não existe na RAMAIS_REGULACAO (2376/2377 viraram ramais reais no PR #80).
    const parsed = parseMessage("Luan Sampaio 2378 SD 07:00");
    assert.equal(parsed.baseCode, null);
    assert.equal(parsed.unknownTargetToken, "2378");
    assert.equal(parsed.shiftType, "SD");
    assert.deepEqual(parsed.extractedNames, ["Luan Sampaio"]);
});

test("parseMessage expõe unknownTargetToken para base XX99 desconhecida (com ou sem espaço)", () => {
    assert.equal(parseMessage("Chegada Ana Souza PM14 SD 07:00").unknownTargetToken, "PM14");
    assert.equal(parseMessage("Ana Souza PM 14 SD").unknownTargetToken, "PM14");
});

test("parseMessage NÃO marca token quando um destino real foi resolvido", () => {
    const parsed = parseMessage("Luan Sampaio 2035 SD 07:00");
    assert.equal(parsed.baseCode, "2035");
    assert.equal(parsed.unknownTargetToken ?? null, null);
});

test("parseMessage não confunde o horário nem palavras comuns com destino desconhecido", () => {
    // "0700" é só o horário sem dois-pontos já extraído como 07:00.
    const timeOnly = parseMessage("Ana Souza chegando as 07:00");
    assert.equal(timeOnly.unknownTargetToken ?? null, null);
    // "SD 07" casa com o shape XX99 mas SD é stopword de turno.
    const shiftNoise = parseMessage("Ana Souza SD 07:00");
    assert.equal(shiftNoise.unknownTargetToken ?? null, null);
});

// ── Sugestão por distância de edição contra códigos reais ──────────────────────────

const ACTIVE_CODES = ["2031", "2035", "2377", "2151", "PM04", "PM40", "IT30", "CC70"];

test("suggestNearestTargetCodes sugere códigos a distância ≤2, mais próximos primeiro (cap 3)", () => {
    assert.deepEqual(suggestNearestTargetCodes("2376", ACTIVE_CODES), ["2377"]);
    assert.deepEqual(suggestNearestTargetCodes("PM14", ACTIVE_CODES), ["PM04", "PM40"]);
    // Cap de 3 sugestões mesmo com muitos vizinhos a distância ≤2.
    assert.deepEqual(
        suggestNearestTargetCodes("2032", ["2031", "2033", "2034", "2035", "2036"]),
        ["2031", "2033", "2034"],
    );
});

test("suggestNearestTargetCodes: sem vizinho próximo, lista vazia; código exato não sugere a si mesmo", () => {
    assert.deepEqual(suggestNearestTargetCodes("9999", ACTIVE_CODES), []);
    assert.ok(!suggestNearestTargetCodes("2035", ACTIVE_CODES).includes("2035"));
    assert.deepEqual(suggestNearestTargetCodes("", ACTIVE_CODES), []);
});

// ── Reconstrução do texto com o código escolhido ───────────────────────────────────

test("replaceUnknownTargetToken troca o token pelo código escolhido, tolerando grafia", () => {
    assert.equal(
        replaceUnknownTargetToken("Luan Sampaio 2376 SD 07:00", "2376", "2377"),
        "Luan Sampaio 2377 SD 07:00",
    );
    assert.equal(
        replaceUnknownTargetToken("Ana Souza pm 14 SD 07:00", "PM14", "PM04"),
        "Ana Souza PM04 SD 07:00",
    );
    // Token ausente do texto → null (não dá para reconstruir com segurança).
    assert.equal(replaceUnknownTargetToken("Ana Souza 2035 SD", "2376", "2377"), null);
});

// ── Copy e teclado ─────────────────────────────────────────────────────────────────

test("buildUnknownDestinationReplyText nomeia o token, sugere códigos e orienta a ação", () => {
    const interactive = buildUnknownDestinationReplyText({
        token: "2376",
        suggestions: ["2377", "2035"],
        interactive: true,
    });
    assert.match(interactive, /⛔ Não conheço \*2376\*/);
    assert.match(interactive, /Parecidos: \*2377\*, \*2035\*/);
    assert.match(interactive, /Toque no código certo abaixo/);

    const textOnly = buildUnknownDestinationReplyText({
        token: "GOA1",
        suggestions: [],
        interactive: false,
    });
    assert.match(textOnly, /⛔ Não conheço \*GOA1\*/);
    assert.ok(!textOnly.includes("Parecidos"));
    assert.match(textOnly, /Confira o número e reenvie/);
});

test("teclado de destino oferece as sugestões em uma linha com callback_data dst:<code>:<logId>", () => {
    const keyboard = buildDestinationSelectionKeyboard(["2377", "2035", "2151", "2031"], LOG_ID);
    const [row] = keyboard.inline_keyboard;
    assert.deepEqual(row.map((button) => button.text), ["2377", "2035", "2151"]);
    for (const button of row) {
        assert.ok(isCallbackButton(button));
        const parsed = parseDestinationSelectionCallbackData(button.callback_data);
        assert.ok(parsed);
        assert.equal(parsed!.logId, LOG_ID);
    }
});

test("parseDestinationSelectionCallbackData valida prefixo, código e logId", () => {
    assert.deepEqual(parseDestinationSelectionCallbackData(`dst:2377:${LOG_ID}`), { code: "2377", logId: LOG_ID });
    assert.deepEqual(parseDestinationSelectionCallbackData(`dst:PM04:${LOG_ID}`), { code: "PM04", logId: LOG_ID });
    assert.equal(parseDestinationSelectionCallbackData(`dst::${LOG_ID}`), null);
    assert.equal(parseDestinationSelectionCallbackData(`dst:código!:${LOG_ID}`), null);
    assert.equal(parseDestinationSelectionCallbackData(`f6:SD:${LOG_ID}`), null);
    assert.equal(parseDestinationSelectionCallbackData("dst:2377:"), null);
    assert.equal(parseDestinationSelectionCallbackData(null), null);
});
