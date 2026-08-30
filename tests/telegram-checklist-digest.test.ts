import assert from "node:assert/strict";
import test from "node:test";
import {
    checklistDigestNoticeKey,
    isChecklistDigestEnabled,
    resolveChecklistDigestSlot,
    sendChecklistDigestCycle,
} from "@/modules/telegram/checklist-digest";

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

test("isChecklistDigestEnabled: só '1'/'true' ligam a flag", () => {
    assert.equal(isChecklistDigestEnabled({ CHECKLIST_DIGEST_ENABLED: "1" }), true);
    assert.equal(isChecklistDigestEnabled({ CHECKLIST_DIGEST_ENABLED: "true" }), true);
    assert.equal(isChecklistDigestEnabled({ CHECKLIST_DIGEST_ENABLED: "0" }), false);
    assert.equal(isChecklistDigestEnabled({}), false, "desligada por padrão — não duplica o croner do checklist");
});

test("resolveChecklistDigestSlot: janelas de 10min às 11h e 13h locais", () => {
    assert.equal(resolveChecklistDigestSlot(new Date("2026-08-30T11:00:30-03:00")), "11h");
    assert.equal(resolveChecklistDigestSlot(new Date("2026-08-30T11:09:59-03:00")), "11h");
    assert.equal(resolveChecklistDigestSlot(new Date("2026-08-30T11:10:00-03:00")), null, "fora da janela não reenvia");
    assert.equal(resolveChecklistDigestSlot(new Date("2026-08-30T13:04:00-03:00")), "13h");
    assert.equal(resolveChecklistDigestSlot(new Date("2026-08-30T10:59:00-03:00")), null);
    assert.equal(resolveChecklistDigestSlot(new Date("2026-08-30T12:05:00-03:00")), null, "12h é do payment-digest, não deste");
});

test("checklistDigestNoticeKey: um por dia e slot", () => {
    const at = new Date("2026-08-30T11:02:00-03:00");
    assert.equal(checklistDigestNoticeKey(at, "11h"), "checklist-digest:2026-08-30:11h");
});

test("sendChecklistDigestCycle: curto-circuitos seguros (sem flag, sem token, fora do slot, sem config)", async () => {
    // Flag desligada: nem olha o relógio.
    const restoreOff = withEnv({ CHECKLIST_DIGEST_ENABLED: null, TELEGRAM_BOT_TOKEN: "t" });
    try {
        assert.deepEqual(await sendChecklistDigestCycle(new Date("2026-08-30T11:01:00-03:00")), { sent: 0, evaluated: 0 });
    } finally {
        restoreOff();
    }

    // Ligada mas sem token do bot: nada a fazer.
    const restoreNoToken = withEnv({ CHECKLIST_DIGEST_ENABLED: "1", TELEGRAM_BOT_TOKEN: null });
    try {
        assert.deepEqual(await sendChecklistDigestCycle(new Date("2026-08-30T11:01:00-03:00")), { sent: 0, evaluated: 0 });
    } finally {
        restoreNoToken();
    }

    // Fora da janela dos slots: silêncio.
    const restoreOutside = withEnv({ CHECKLIST_DIGEST_ENABLED: "1", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_ADMIN_IDS: "111" });
    try {
        assert.deepEqual(await sendChecklistDigestCycle(new Date("2026-08-30T15:00:00-03:00")), { sent: 0, evaluated: 0 });
    } finally {
        restoreOutside();
    }

    // No slot, com admin, mas sem CHECKLIST_API_URL: avalia e não envia (fail-soft,
    // sem reservar o slot — quando a integração ligar, o próximo tick entrega).
    const restoreUnconfigured = withEnv({
        CHECKLIST_DIGEST_ENABLED: "1",
        TELEGRAM_BOT_TOKEN: "t",
        TELEGRAM_ADMIN_IDS: "111,222",
        CHECKLIST_API_URL: null,
        CHECKLIST_INTERNAL_TOKEN: null,
    });
    try {
        assert.deepEqual(await sendChecklistDigestCycle(new Date("2026-08-30T13:01:00-03:00")), { sent: 0, evaluated: 2 });
    } finally {
        restoreUnconfigured();
    }
});
