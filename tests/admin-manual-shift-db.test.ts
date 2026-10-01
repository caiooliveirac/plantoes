/**
 * Lançar plantão passado (services/admin-manual-shift.service.ts), contra o banco:
 * sombra na base chegando 07:00 e saindo 21:20 grava 280 min no banco de horas,
 * fica fora do quadro e não deixa ocupação aberta. Roda só com DATABASE_URL de teste.
 */
import assert from "node:assert/strict";
import { after, afterEach, describe, test } from "node:test";
import { eq, inArray } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { auditLogs, bankHoursEntries, doctors, interventionBases, interventionOccupancies, regulationOccupancies, regulationPosts } from "@/db/schema";
import { createManualShift } from "@/services/admin-manual-shift.service";

const skip = !process.env.DATABASE_URL || !process.env.DATABASE_URL.includes("test");

describe("lançar plantão passado", { skip }, () => {
    const doctorIds: string[] = [];

    afterEach(async () => {
        if (doctorIds.length === 0) return;
        const db = getDb();
        const ids = (await db.select({ id: interventionOccupancies.id }).from(interventionOccupancies)
            .where(inArray(interventionOccupancies.doctorId, doctorIds))).map((r) => r.id);
        if (ids.length > 0) await db.delete(auditLogs).where(inArray(auditLogs.entityId, ids));
        const regIds = (await db.select({ id: regulationOccupancies.id }).from(regulationOccupancies)
            .where(inArray(regulationOccupancies.doctorId, doctorIds))).map((r) => r.id);
        if (regIds.length > 0) await db.delete(auditLogs).where(inArray(auditLogs.entityId, regIds));
        await db.delete(bankHoursEntries).where(inArray(bankHoursEntries.doctorId, doctorIds));
        await db.delete(regulationOccupancies).where(inArray(regulationOccupancies.doctorId, doctorIds));
        await db.delete(interventionOccupancies).where(inArray(interventionOccupancies.doctorId, doctorIds));
        await db.delete(doctors).where(inArray(doctors.id, doctorIds));
        doctorIds.length = 0;
    });

    after(async () => { await closeDb(); });

    test("sombra SD 07:00–21:20 na base: banco +280 e plantão fechado, fora do quadro", async () => {
        const db = getDb();
        const base = await db.query.interventionBases.findFirst({ where: eq(interventionBases.code, "CC70") });
        assert.ok(base, "seed de bases ausente");
        const name = `Teste Manual ${Math.random().toString(36).slice(2, 8)}`;
        const [doctor] = await db.insert(doctors).values({ fullName: name, normalizedName: name.toLowerCase() }).returning({ id: doctors.id });
        doctorIds.push(doctor.id);

        const result = await createManualShift({
            doctorId: doctor.id, domain: "intervention", targetId: base.id, operationalDate: "2026-09-30",
            shiftLabel: "SD", arrivalTime: "07:00", departureTime: "21:20", isShadow: true,
            reason: "ficou em ocorrencia 1027",
        }, null as unknown as string);

        assert.equal(result.bankEntry?.balanceMinutes, 280);
        const occ = await db.query.interventionOccupancies.findFirst({ where: eq(interventionOccupancies.id, result.occupancyId) });
        assert.ok(occ?.endedAt && occ.actualEndedAt && occ.departureConfirmedAt, "plantão precisa nascer fechado e confirmado");
        assert.equal(occ.actualEndedAt.toISOString(), new Date("2026-09-30T21:20:00-03:00").toISOString());
        assert.equal(occ.boardStartedAt, null, "sombra fica fora do quadro");
        assert.match(occ.notes ?? "", /sombra/i);

        await assert.rejects(() => createManualShift({
            doctorId: doctor.id, domain: "intervention", targetId: base.id, operationalDate: "2026-09-30",
            shiftLabel: "SD", arrivalTime: "07:00", departureTime: "21:20", isShadow: true, reason: "repetido de novo",
        }, null as unknown as string), /ja esta registrado/);
    });

    test("sombra SD completo no ramal da CRU: fecha, fora do quadro, banco zerado", async () => {
        const db = getDb();
        const post = await db.query.regulationPosts.findFirst({ where: eq(regulationPosts.code, "2151") });
        assert.ok(post, "seed de ramais ausente");
        const name = `Teste Manual ${Math.random().toString(36).slice(2, 8)}`;
        const [doctor] = await db.insert(doctors).values({ fullName: name, normalizedName: name.toLowerCase() }).returning({ id: doctors.id });
        doctorIds.push(doctor.id);

        const result = await createManualShift({
            doctorId: doctor.id, domain: "regulation", targetId: post.id, operationalDate: "2026-09-28",
            shiftLabel: "SD", arrivalTime: "07:00", departureTime: "19:00", isShadow: true, reason: "sombra sem lancamento",
        }, null as unknown as string);

        const occ = await db.query.regulationOccupancies.findFirst({ where: eq(regulationOccupancies.id, result.occupancyId) });
        assert.ok(occ?.endedAt && occ.departureConfirmedAt);
        assert.equal(occ.boardStartedAt, null);
        assert.ok((result.bankEntry?.balanceMinutes ?? 0) === 0);
    });
});
