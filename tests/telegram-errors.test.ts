import assert from "node:assert/strict";
import test from "node:test";

import {
    formatTelegramErrorForUser,
    isTelegramTechnicalErrorMessage,
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
    const business = "Ramal de destino nao encontrado.";
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

// Levantamento de 90 dias em prod (18/09/2026): cada erro real que caía no genérico
// (ou saía sem acento / com vocabulário do site) ganha texto próprio com ação.
test("erros reais de prod ganham texto proprio; so o tecnico aciona o admin", () => {
    const negocio = [
        "Medico nao tem ocupacao ativa para remanejar. Registre a chegada normalmente.",
        "Continuacao caiu numa janela de turno ja encerrada — registro nao efetivado, avise a regulacao.",
        "Medico ja esta em 1366. Nao e necessario remanejar.",
        "O destino IT30 ja esta ocupado. Escolha se a chefia vai retirar ou remanejar quem esta la.",
        "A base BR05 esta desativada e nao pode receber remanejamento agora.",
        "Base ja rendida por outro medico apos a sua saida — continuidade nao registrada. Se for engano, procure a chefia.",
        "Telegram API sendMessage: Too Many Requests: retry after 27",
    ];
    for (const raw of negocio) {
        const text = formatTelegramErrorForUser(raw);
        assert.notEqual(text, TELEGRAM_GENERIC_ERROR_TEXT, raw);
        assert.notEqual(text, raw, raw);
        assert.equal(isTelegramTechnicalErrorMessage(raw), false, raw);
    }
    assert.match(formatTelegramErrorForUser("Medico ja esta em 1366. Nao e necessario remanejar."), /já está em 1366/);
    assert.match(formatTelegramErrorForUser("A base BR05 esta desativada e nao pode receber remanejamento agora."), /\/ativar BR05/);

    for (const raw of ["db_update_failed", "Failed query: update x\nparams: 1", "Cannot read properties of undefined"]) {
        assert.equal(isTelegramTechnicalErrorMessage(raw), true, raw);
        assert.ok(!formatTelegramErrorForUser(raw).includes(raw.slice(0, 12)), "cru não vaza");
    }
    assert.match(formatTelegramErrorForUser("db_update_failed"), /banco recusou/);
});
