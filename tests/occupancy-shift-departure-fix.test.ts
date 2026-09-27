import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { and, eq } from "drizzle-orm";
import { closeDb, getDb, hasDatabaseUrl } from "@/db";
import { auditLogs, doctors, interventionBases, interventionOccupancies, users } from "@/db/schema";
import { correctOccupancyShiftAndDeparture, OCCUPANCY_FIX_AUDIT_SOURCE } from "@/modules/operational/corrections";

/**
 * Correção de turno e saída pela alocação de pagamento — contra o banco.
 *
 * É o reparo que mais virou script (repair-bruna-pp20, repair-murilo-pr03): o
 * plantão ficou SD quando era P (ou o "NÃO SAIU" reabriu quem só mudou de posto)
 * e a saída precisa ser regravada. O caso do Murilo é a fixture: chegou 06:59 de
 * 21/08 para um P, o botão "Foi só este dia (SD)" encolheu a janela, ele saiu às
 * 08:27 de 22/08 por ocorrência.
 */

const skip = !hasDatabaseUrl() && "DATABASE_URL não configurada";
const suffix = randomUUID().slice(0, 8);
let doctorId = "";
let adminUserId = "";
let baseSeq = 0;

// Uma base por plantão: o índice único só admite um titular ativo por base.
async function createSdOccupancy() {
    baseSeq += 1;
    const [base] = await getDb().insert(interventionBases).values({
        code: `T${suffix}${baseSeq}`,
        label: `Base teste ${suffix} ${baseSeq}`,
    }).returning();
    const baseId = base.id;
    const [row] = await getDb().insert(interventionOccupancies).values({
        doctorId,
        continuityGroupId: randomUUID(),
        baseId,
        startedAt: new Date("2026-08-21T06:59:00-03:00"),
        boardStartedAt: new Date("2026-08-21T06:59:00-03:00"),
        scheduledStartAt: new Date("2026-08-21T07:00:00-03:00"),
        scheduledEndAt: new Date("2026-08-21T19:00:00-03:00"),
        endedAt: null,
        actualEndedAt: null,
        shiftLabel: "SD",
        source: "telegram",
        notes: "[telegram] chegada",
    }).returning();
    return row;
}

async function auditRowsFor(occupancyId: string) {
    return getDb().select().from(auditLogs).where(and(
        eq(auditLogs.entityType, "intervention_occupancy"),
        eq(auditLogs.entityId, occupancyId),
    ));
}

before(async () => {
    if (skip) return;
    const db = getDb();
    const [doctor] = await db.insert(doctors).values({
        fullName: `Médico Teste Correção ${suffix}`,
        normalizedName: `medico teste correcao ${suffix}`,
    }).returning();
    doctorId = doctor.id;
    const [user] = await db.insert(users).values({
        email: `admin-correcao-${suffix}@example.test`,
        passwordHash: "x",
    }).returning();
    adminUserId = user.id;
});

after(async () => {
    if (skip) return;
    await closeDb();
});

test("SD vira P com a saída declarada, janela refeita, saída validada e motivo na nota", { skip }, async () => {
    const occupancy = await createSdOccupancy();
    const departureAt = new Date("2026-08-22T08:27:24-03:00");

    const updated = await correctOccupancyShiftAndDeparture({
        domain: "intervention",
        occupancyId: occupancy.id,
        shiftLabel: "P",
        departureAt,
        reason: "botão SD tocado por engano; coordenador confirmou P",
        actorUserId: adminUserId,
    });

    assert.equal(updated.shiftLabel, "P");
    assert.equal(updated.endedAt?.toISOString(), departureAt.toISOString());
    assert.equal(updated.actualEndedAt?.toISOString(), departureAt.toISOString());
    // P cobre 24h: a janela vai até as 07:00 do dia seguinte, não mais 19:00.
    assert.equal(updated.scheduledEndAt?.toISOString(), new Date("2026-08-22T07:00:00-03:00").toISOString());
    assert.ok(updated.departureConfirmedAt, "saída corrigida pelo admin entra validada");
    assert.equal(updated.departureConfirmedByUserId, adminUserId);
    // Nota anterior preservada, motivo anexado.
    assert.match(updated.notes ?? "", /\[telegram\] chegada/);
    assert.match(updated.notes ?? "", /\[correcao admin\] botão SD tocado por engano/);
    assert.equal(updated.updatedByUserId, adminUserId);
});

test("auditoria grava quem, fonte, motivo e antes/depois", { skip }, async () => {
    const occupancy = await createSdOccupancy();
    const departureAt = new Date("2026-08-21T19:13:58-03:00");

    await correctOccupancyShiftAndDeparture({
        domain: "intervention",
        occupancyId: occupancy.id,
        shiftLabel: "SD",
        departureAt,
        reason: "NÃO SAIU reabriu por engano; saiu no remanejamento",
        actorUserId: adminUserId,
    });

    const rows = await auditRowsFor(occupancy.id);
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.equal(row.action, "intervention_occupancy.corrected");
    assert.equal(row.actorUserId, adminUserId);
    assert.ok(row.createdAt instanceof Date);
    const details = row.details as Record<string, Record<string, unknown> | string>;
    assert.equal(details.source, OCCUPANCY_FIX_AUDIT_SOURCE);
    assert.equal(details.reason, "NÃO SAIU reabriu por engano; saiu no remanejamento");
    const beforeSnap = details.beforeSnapshot as Record<string, unknown>;
    const afterSnap = details.afterSnapshot as Record<string, unknown>;
    assert.equal(beforeSnap.endedAt, null);
    assert.equal(afterSnap.endedAt, departureAt.toISOString());
    assert.equal(afterSnap.shiftLabel, "SD");
});

test("saída antes da chegada é recusada e nada muda (transação)", { skip }, async () => {
    const occupancy = await createSdOccupancy();

    await assert.rejects(
        correctOccupancyShiftAndDeparture({
            domain: "intervention",
            occupancyId: occupancy.id,
            shiftLabel: "P",
            departureAt: new Date("2026-08-21T05:00:00-03:00"),
            reason: "motivo suficientemente longo",
            actorUserId: adminUserId,
        }),
        /cannot be before/,
    );

    const reloaded = await getDb().query.interventionOccupancies.findFirst({
        where: eq(interventionOccupancies.id, occupancy.id),
    });
    assert.equal(reloaded?.shiftLabel, "SD");
    assert.equal(reloaded?.endedAt, null);
    assert.equal((await auditRowsFor(occupancy.id)).length, 0);
});

test("motivo curto, saída no futuro e turno inválido são recusados antes de tocar o banco", { skip }, async () => {
    const occupancy = await createSdOccupancy();
    const base = {
        domain: "intervention" as const,
        occupancyId: occupancy.id,
        shiftLabel: "P" as const,
        departureAt: new Date("2026-08-22T08:27:00-03:00"),
        reason: "motivo suficientemente longo",
        actorUserId: adminUserId,
    };

    await assert.rejects(correctOccupancyShiftAndDeparture({ ...base, reason: "  curto " }), /Motivo obrigatorio/);
    await assert.rejects(
        correctOccupancyShiftAndDeparture({ ...base, now: new Date("2026-08-22T08:00:00-03:00") }),
        /futuro/,
    );
    await assert.rejects(
        correctOccupancyShiftAndDeparture({ ...base, shiftLabel: "MT" as unknown as "P" }),
        /Turno invalido/,
    );
    assert.equal((await auditRowsFor(occupancy.id)).length, 0);
});
