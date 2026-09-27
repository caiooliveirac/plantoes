import assert from "node:assert/strict";
import test from "node:test";

import { decideTelegramEditedMessage, TELEGRAM_EDIT_ALREADY_REGISTERED_REPLY } from "@/modules/telegram/service";

// D8 (docs/chegada.md): quem corrige a digitação editando a mensagem não era ouvido.
const SENT_AT = new Date("2026-09-20T07:02:00-03:00");
const EDITED_AT = new Date("2026-09-20T07:03:30-03:00");

function decide(original: Parameters<typeof decideTelegramEditedMessage>[0]["original"], overrides: Partial<Parameters<typeof decideTelegramEditedMessage>[0]> = {}) {
    return decideTelegramEditedMessage({
        original,
        updateId: 500,
        editedText: "2153 Livia SD",
        sentAt: SENT_AT,
        editedAt: EDITED_AT,
        ...overrides,
    });
}

test("edição de aviso que falhou/foi ignorado é reprocessada", () => {
    assert.equal(decide({ status: "ignored", relatedOccupancyId: null, errorMessage: "no_operational_match", resolutionData: {} }), "reprocess");
    assert.equal(decide({ status: "error", relatedOccupancyId: null, errorMessage: "doctor_not_found", resolutionData: {} }), "reprocess");
});

test("edição de aviso que já registrou ocupação não reprocessa: avisa uma vez", () => {
    const registered = { status: "accepted", relatedOccupancyId: "occ-1", errorMessage: null, resolutionData: {} };
    assert.equal(decide(registered), "notify_already_registered");
    assert.match(TELEGRAM_EDIT_ALREADY_REGISTERED_REPLY, /não altera/);
    assert.match(TELEGRAM_EDIT_ALREADY_REGISTERED_REPLY, /nova mensagem/);
});

test("edição repetida: aviso não se repete e retry do mesmo update é ignorado", () => {
    const noticed = { status: "accepted", relatedOccupancyId: "occ-1", errorMessage: null, resolutionData: { editNoticeSentAt: "2026-09-20T10:03:30.000Z", lastEditUpdateId: 500 } };
    assert.equal(decide(noticed, { updateId: 501 }), "ignore");
    // 1ª edição reprocessou e ainda falhou: a 2ª edição (update novo) reprocessa de novo…
    const failedAgain = { status: "error", relatedOccupancyId: null, errorMessage: "doctor_not_found", resolutionData: { lastEditUpdateId: 500 } };
    assert.equal(decide(failedAgain, { updateId: 501 }), "reprocess");
    // …mas o retry do Telegram do MESMO update não.
    assert.equal(decide(failedAgain, { updateId: 500 }), "ignore");
    // 1ª edição reprocessou e registrou: a 2ª edição cai no aviso, não reprocessa.
    const acceptedByEdit = { status: "accepted", relatedOccupancyId: "occ-2", errorMessage: null, resolutionData: { lastEditUpdateId: 500 } };
    assert.equal(decide(acceptedByEdit, { updateId: 501 }), "notify_already_registered");
});

test("edição ignorada: original desconhecida, pendência aberta, comando, chat fora da lista, tardia", () => {
    assert.equal(decide(null), "ignore");
    assert.equal(decide({ status: "pending_takeover_confirmation", relatedOccupancyId: null, errorMessage: null, resolutionData: {} }), "ignore");
    assert.equal(decide({ status: "pending_name_selection", relatedOccupancyId: null, errorMessage: null, resolutionData: {} }), "ignore");
    assert.equal(decide({ status: "accepted", relatedOccupancyId: null, errorMessage: null, resolutionData: {} }), "ignore");
    assert.equal(decide({ status: "ignored", relatedOccupancyId: null, errorMessage: null, resolutionData: {} }, { editedText: "/almoco" }), "ignore");
    assert.equal(decide({ status: "ignored", relatedOccupancyId: null, errorMessage: "chat_not_allowed", resolutionData: {} }), "ignore");
    assert.equal(decide(
        { status: "error", relatedOccupancyId: null, errorMessage: "doctor_not_found", resolutionData: {} },
        { editedAt: new Date(SENT_AT.getTime() + 2 * 60 * 60 * 1000 + 1000) },
    ), "ignore");
});
