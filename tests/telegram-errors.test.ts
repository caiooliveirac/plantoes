import assert from "node:assert/strict";
import test from "node:test";

import {
    formatTelegramErrorForUser,
    isTelegramUserFacingError,
    resolveTelegramErrorText,
    TELEGRAM_GENERIC_ERROR_TEXT,
    TelegramUserFacingError,
    translateTelegramErrorMessage,
} from "@/modules/telegram/errors";

// ── Tabela de tradução (auditoria §3.1#11) ─────────────────────────────────────────

test("translateTelegramErrorMessage traduz mensagens técnicas conhecidas para pt-BR com ação", () => {
    assert.match(translateTelegramErrorMessage("Regulation post not found.")!, /Não encontrei esse ramal/);
    assert.match(translateTelegramErrorMessage("Intervention base not found.")!, /Não encontrei essa base/);
    assert.match(translateTelegramErrorMessage("Actual end cannot be before the recorded arrival.")!, /antes da chegada registrada/);
    assert.match(translateTelegramErrorMessage("No active regulation occupancy found for this doctor/post.")!, /plantão ativo/);
    assert.match(translateTelegramErrorMessage("Only active intervention occupancies can be continued.")!, /já foi encerrado/);
});

test("translateTelegramErrorMessage devolve null para mensagens fora da tabela", () => {
    assert.equal(translateTelegramErrorMessage("weird internal failure"), null);
    assert.equal(translateTelegramErrorMessage(""), null);
    assert.equal(translateTelegramErrorMessage(null), null);
    assert.equal(translateTelegramErrorMessage(undefined), null);
});

// ── formatTelegramErrorForUser: tradução → allowlist → genérico ────────────────────

test("formatTelegramErrorForUser: técnico conhecido é traduzido", () => {
    assert.match(formatTelegramErrorForUser("Regulation post not found."), /Não encontrei esse ramal/);
});

test("formatTelegramErrorForUser: erro de negócio pt da allowlist passa direto", () => {
    const business = "Medico nao tem ocupacao ativa para remanejar. Registre a chegada normalmente.";
    assert.equal(formatTelegramErrorForUser(business), business);
    const activation = "Este ramal ja esta desativado.";
    assert.equal(formatTelegramErrorForUser(activation), activation);
});

test("formatTelegramErrorForUser: prefixo curado (mensagem com interpolação) passa direto", () => {
    const withName = "Ja existe outro medico ativo com o nome Maria Silva.";
    assert.equal(formatTelegramErrorForUser(withName), withName);
    const noShift = "Nao encontrei um plantao SN encerrado para revisar o banco.";
    assert.equal(formatTelegramErrorForUser(noShift), noShift);
});

test("formatTelegramErrorForUser: desconhecido vira mensagem curta fixa (cru só no log)", () => {
    assert.equal(
        formatTelegramErrorForUser('duplicate key value violates unique constraint "occ_board_idx"'),
        TELEGRAM_GENERIC_ERROR_TEXT,
    );
    assert.equal(formatTelegramErrorForUser("fetch failed"), TELEGRAM_GENERIC_ERROR_TEXT);
    assert.equal(formatTelegramErrorForUser(""), TELEGRAM_GENERIC_ERROR_TEXT);
    assert.equal(formatTelegramErrorForUser(null), TELEGRAM_GENERIC_ERROR_TEXT);
});

// ── TelegramUserFacingError: instância passa direto (auditoria §3.4#6) ─────────────

test("resolveTelegramErrorText: TelegramUserFacingError passa direto, Error cru não", () => {
    const userFacing = new TelegramUserFacingError("Esse plantão já fechou — chame a chefia para reabrir.");
    assert.equal(resolveTelegramErrorText(userFacing), "Esse plantão já fechou — chame a chefia para reabrir.");
    assert.ok(isTelegramUserFacingError(userFacing));

    const raw = new Error("connect ECONNREFUSED 127.0.0.1:5432");
    assert.ok(!isTelegramUserFacingError(raw));
    assert.equal(resolveTelegramErrorText(raw), TELEGRAM_GENERIC_ERROR_TEXT);

    // Error cru técnico conhecido ainda ganha a tradução.
    assert.match(resolveTelegramErrorText(new Error("Intervention base not found.")), /Não encontrei essa base/);

    // Não-Error (throw de string/objeto) também degrada para a mensagem fixa.
    assert.equal(resolveTelegramErrorText("boom"), TELEGRAM_GENERIC_ERROR_TEXT);
    assert.equal(resolveTelegramErrorText(undefined), TELEGRAM_GENERIC_ERROR_TEXT);
});
