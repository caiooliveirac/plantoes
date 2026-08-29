import assert from "node:assert/strict";
import test from "node:test";
import { toAuditSnapshot } from "@/modules/operational/corrections";

/**
 * O rastro da correção é o que o /desfazer restaura.
 *
 * Antes, só as rotas web escreviam `*_occupancy.corrected`. Uma correção pelo
 * Telegram não deixava before/after em lugar nenhum — foi por isso que os quatro
 * casos de agosto não se reconstruíram, e por isso `/desfazer` não alcançava o
 * `/corrigir`. O log passou a nascer dentro da própria correção; este teste
 * trava o formato que undo.ts lê.
 */

const base = {
    doctorId: "11111111-1111-1111-1111-111111111111",
    startedAt: new Date("2026-08-03T07:00:00-03:00"),
    boardStartedAt: new Date("2026-08-03T07:00:00-03:00"),
    endedAt: null,
    actualEndedAt: null,
    scheduledStartAt: new Date("2026-08-03T07:00:00-03:00"),
    scheduledEndAt: new Date("2026-08-03T19:15:00-03:00"),
    shiftLabel: "SD" as string | null,
    roleLabel: null as string | null,
    notes: "chegada" as string | null,
    continuityGroupId: "22222222-2222-2222-2222-222222222222",
};

test("o snapshot traz todos os campos que undo.ts restaura", () => {
    const snap = toAuditSnapshot({ ...base, postId: 7, ramalLabel: "2262" });
    for (const campo of [
        "doctorId", "startedAt", "boardStartedAt", "endedAt", "actualEndedAt",
        "scheduledStartAt", "scheduledEndAt", "shiftLabel", "roleLabel",
        "ramalLabel", "notes", "continuityGroupId",
    ]) {
        assert.ok(campo in snap, `faltou ${campo} no snapshot`);
    }
});

test("datas viram ISO — o details é jsonb, não guarda Date", () => {
    const snap = toAuditSnapshot({ ...base, postId: 7 });
    assert.equal(typeof snap.startedAt, "string");
    assert.equal(snap.startedAt, base.startedAt.toISOString());
    assert.equal(snap.scheduledEndAt, base.scheduledEndAt!.toISOString());
});

test("nulos sobrevivem como null, não viram undefined", () => {
    const snap = toAuditSnapshot({ ...base, postId: 7 });
    assert.equal(snap.endedAt, null);
    assert.equal(snap.actualEndedAt, null);
    assert.equal(snap.roleLabel, null);
});

test("regulação leva postId; intervenção leva baseId", () => {
    const reg = toAuditSnapshot({ ...base, postId: 7 });
    assert.equal((reg as Record<string, unknown>).postId, 7);
    assert.equal("baseId" in reg, false);

    const intv = toAuditSnapshot({ ...base, baseId: 9 });
    assert.equal((intv as Record<string, unknown>).baseId, 9);
    assert.equal("postId" in intv, false);
});
