/**
 * Remanejo a partir do NUCLEO (docs/remanejamento-nucleo-banco-horas.md).
 *
 * O NUCLEO abre às 08:00 no SD. Quem chegou lá 07:50 e foi remanejado para a
 * CRU (ou para uma ambulância) não passa a dever 50 min: a hora prevista de
 * chegada é do posto onde o médico CHEGOU. Estes testes caracterizam, contra o
 * banco, os caminhos que reescreviam a janela pelo posto de destino.
 *
 * Roda só com DATABASE_URL de teste (mesmo contrato dos demais testes de banco).
 */
import assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";
import { eq, inArray } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import {
    auditLogs,
    bankHoursEntries,
    doctors,
    interventionBases,
    interventionOccupancies,
    regulationOccupancies,
    regulationPosts,
} from "@/db/schema";
import { endInterventionOccupancy } from "@/modules/intervention/service";
import {
    correctInterventionOccupancy,
    correctOccupancyShiftAndDeparture,
    correctRegulationOccupancy,
    removeRegulationOccupancyRecord,
    transferOperationalOccupancy,
} from "@/modules/operational/corrections";
import { endRegulationOccupancy, startRegulationOccupancy } from "@/modules/regulation/service";

const skip = !process.env.DATABASE_URL || !process.env.DATABASE_URL.includes("test");

function sp(iso: string) {
    return new Date(`${iso}-03:00`);
}

describe("remanejo a partir do NUCLEO preserva a chegada das 08:00", { skip }, () => {
    const createdDoctorIds: string[] = [];
    let nucleoPostId = 0;
    let cruPostId = 0;
    let baseId = 0;

    before(async () => {
        const db = getDb();
        const nucleo = await db.query.regulationPosts.findFirst({ where: eq(regulationPosts.code, "NUCLEO"), columns: { id: true } });
        const cru = await db.query.regulationPosts.findFirst({ where: eq(regulationPosts.code, "2151"), columns: { id: true } });
        const base = await db.query.interventionBases.findFirst({ where: eq(interventionBases.code, "CC70"), columns: { id: true } });
        assert.ok(nucleo && cru && base, "seed de postos/bases (migration 0002) ausente no banco de teste");
        nucleoPostId = nucleo.id;
        cruPostId = cru.id;
        baseId = base.id;
    });

    afterEach(async () => {
        if (createdDoctorIds.length === 0) return;
        const db = getDb();
        const regIds = (await db.select({ id: regulationOccupancies.id }).from(regulationOccupancies)
            .where(inArray(regulationOccupancies.doctorId, createdDoctorIds))).map((row) => row.id);
        const intIds = (await db.select({ id: interventionOccupancies.id }).from(interventionOccupancies)
            .where(inArray(interventionOccupancies.doctorId, createdDoctorIds))).map((row) => row.id);
        const occIds = [...regIds, ...intIds];
        if (occIds.length > 0) {
            await db.delete(auditLogs).where(inArray(auditLogs.entityId, occIds));
        }
        await db.delete(bankHoursEntries).where(inArray(bankHoursEntries.doctorId, createdDoctorIds));
        await db.delete(regulationOccupancies).where(inArray(regulationOccupancies.doctorId, createdDoctorIds));
        await db.delete(interventionOccupancies).where(inArray(interventionOccupancies.doctorId, createdDoctorIds));
        await db.delete(doctors).where(inArray(doctors.id, createdDoctorIds));
        createdDoctorIds.length = 0;
    });

    after(async () => {
        await closeDb();
    });

    async function createDoctor(label: string) {
        const fullName = `Teste Nucleo ${label} ${Math.random().toString(36).slice(2, 8)}`;
        const [row] = await getDb().insert(doctors).values({ fullName, normalizedName: fullName.toLowerCase() }).returning({ id: doctors.id });
        createdDoctorIds.push(row.id);
        return row.id;
    }

    async function regulationOccupancy(id: string) {
        const row = await getDb().query.regulationOccupancies.findFirst({ where: eq(regulationOccupancies.id, id) });
        assert.ok(row);
        return row;
    }

    async function bankEntryFor(doctorId: string) {
        const rows = await getDb().query.bankHoursEntries.findMany({ where: eq(bankHoursEntries.doctorId, doctorId) });
        assert.equal(rows.length, 1, "esperava exatamente um lançamento de banco para o turno");
        return rows[0]!;
    }

    test("correção de turno+saída no ramal de destino não reescreve a chegada para 07:00", async () => {
        const doctorId = await createDoctor("C1");
        const nucleo = await startRegulationOccupancy({ doctorId, postId: nucleoPostId, startedAt: sp("2026-09-10T07:50:00"), shiftLabel: "SD", source: "telegram" });
        assert.equal(nucleo.scheduledStartAt?.toISOString(), sp("2026-09-10T08:00:00").toISOString());

        const transfer = await transferOperationalOccupancy(nucleo.id, {
            sourceDomain: "regulation",
            destination: { domain: "regulation", targetId: cruPostId },
            notes: "cobrir furo na CRU",
            transferredAt: sp("2026-09-10T10:00:00"),
        }, null);
        // O clone herda a janela da origem.
        assert.equal((await regulationOccupancy(transfer.movedOccupancyId)).scheduledStartAt?.toISOString(), sp("2026-09-10T08:00:00").toISOString());

        await correctOccupancyShiftAndDeparture({
            domain: "regulation",
            occupancyId: transfer.movedOccupancyId,
            shiftLabel: "SD",
            departureAt: sp("2026-09-10T19:45:00"),
            reason: "ajuste da saida pelo admin",
            actorUserId: null,
            now: sp("2026-09-11T10:00:00"),
        });
        const destination = await regulationOccupancy(transfer.movedOccupancyId);
        assert.equal(destination.scheduledStartAt?.toISOString(), sp("2026-09-10T08:00:00").toISOString(), "a correcao reinferia 07:00 pelo ramal de destino");

        // Correção só de horário do remanejo também preserva.
        await correctRegulationOccupancy(transfer.movedOccupancyId, {
            startedAt: sp("2026-09-10T10:05:00"),
            boardStartedAt: sp("2026-09-10T10:05:00"),
            notes: "ajuste da hora do remanejo",
        }, null);
        assert.equal((await regulationOccupancy(transfer.movedOccupancyId)).scheduledStartAt?.toISOString(), sp("2026-09-10T08:00:00").toISOString());

        const entry = await bankEntryFor(doctorId);
        assert.equal(entry.scheduledStartAt.toISOString(), sp("2026-09-10T08:00:00").toISOString());
        assert.equal(entry.arrivalDelayMinutes, 0);
        assert.equal(entry.overtimeMultiplier, 2, "chegou no horario do NUCLEO: excedente em dobro");
        assert.equal(entry.balanceMinutes, 90);
    });

    test("origem NUCLEO apagada: o destino com a chegada original ainda mede contra 08:00 (nota de remanejo)", async () => {
        const doctorId = await createDoctor("C3");
        const nucleo = await startRegulationOccupancy({ doctorId, postId: nucleoPostId, startedAt: sp("2026-09-12T07:50:00"), shiftLabel: "SD", source: "telegram" });
        const transfer = await transferOperationalOccupancy(nucleo.id, {
            sourceDomain: "regulation",
            destination: { domain: "regulation", targetId: cruPostId },
            notes: "cobrir furo na CRU",
            transferredAt: sp("2026-09-12T10:00:00"),
        }, null);
        await removeRegulationOccupancyRecord(nucleo.id, null);
        // Chefia devolve a chegada real ao único registro que sobrou.
        await correctRegulationOccupancy(transfer.movedOccupancyId, { startedAt: sp("2026-09-12T07:50:00"), notes: "chegada real" }, null);
        await endRegulationOccupancy(transfer.movedOccupancyId, { endedAt: sp("2026-09-12T19:40:00"), chiefConfirmed: true }, null);

        const destination = await regulationOccupancy(transfer.movedOccupancyId);
        assert.equal(destination.scheduledStartAt?.toISOString(), sp("2026-09-12T08:00:00").toISOString());
        const entry = await bankEntryFor(doctorId);
        assert.equal(entry.arrivalDelayMinutes, 0);
        assert.equal(entry.balanceMinutes, 80, "antes: atraso de 50 min e saldo -10");
    });

    test("NUCLEO fechado e chegada nova na CRU no mesmo turno (ADR-007 R1) grava a janela do posto de chegada", async () => {
        const doctorId = await createDoctor("C2");
        const nucleo = await startRegulationOccupancy({ doctorId, postId: nucleoPostId, startedAt: sp("2026-09-11T07:50:00"), shiftLabel: "SD", source: "telegram" });
        await endRegulationOccupancy(nucleo.id, { endedAt: sp("2026-09-11T10:00:00"), handoffClosure: true }, null);
        const cru = await startRegulationOccupancy({ doctorId, postId: cruPostId, startedAt: sp("2026-09-11T10:00:00"), shiftLabel: "SD", source: "telegram" });
        assert.equal(cru.continuityGroupId, nucleo.continuityGroupId, "R1: mesma cadeia");
        assert.equal(cru.scheduledStartAt?.toISOString(), sp("2026-09-11T08:00:00").toISOString());
        assert.equal(cru.scheduledEndAt?.toISOString(), sp("2026-09-11T19:15:00").toISOString());
    });

    test("NUCLEO → ambulância: a correção na base mantém 08:00 e o fim da base (19:00)", async () => {
        const doctorId = await createDoctor("XD");
        const nucleo = await startRegulationOccupancy({ doctorId, postId: nucleoPostId, startedAt: sp("2026-09-14T07:50:00"), shiftLabel: "SD", source: "telegram" });
        const transfer = await transferOperationalOccupancy(nucleo.id, {
            sourceDomain: "regulation",
            destination: { domain: "intervention", targetId: baseId },
            notes: "cobrir furo na base",
            transferredAt: sp("2026-09-14T09:00:00"),
        }, null);
        assert.equal(transfer.movedDomain, "intervention");
        await correctInterventionOccupancy(transfer.movedOccupancyId, {
            shiftLabel: "SD",
            endedAt: sp("2026-09-14T19:30:00"),
            actualEndedAt: sp("2026-09-14T19:30:00"),
            chiefConfirmed: true,
            auditReason: "saida confirmada pela chefia",
        }, null);
        const leg = await getDb().query.interventionOccupancies.findFirst({ where: eq(interventionOccupancies.id, transfer.movedOccupancyId) });
        assert.ok(leg);
        assert.equal(leg.scheduledStartAt?.toISOString(), sp("2026-09-14T08:00:00").toISOString());
        assert.equal(leg.scheduledEndAt?.toISOString(), sp("2026-09-14T19:00:00").toISOString());

        const entry = await bankEntryFor(doctorId);
        assert.equal(entry.arrivalDelayMinutes, 0);
        assert.equal(entry.overtimeMultiplier, 2);
        // endInterventionOccupancy não foi chamado: a correção já fechou; garantimos que o import fica usado
        assert.equal(typeof endInterventionOccupancy, "function");
    });
});
