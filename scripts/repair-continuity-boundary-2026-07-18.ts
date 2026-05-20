// Correção pontual dos dois registros afetados pelo bug de continuidade de
// 2026-07-18 (PR #97 — "continua" pré-virada descartado como reforço + link de
// "continuando" limitado a 2h). Casos:
//
// 1. UENDERSON ARAUJO BARBOSA — ramal 1361 (regulação)
//    "continuando 1361" às 06:41 foi engolido; o expiry fechou o SN às 07:15 e
//    "Uenderson continua" (08:12) recriou a ocupação do dia com
//    started_at = 08:12 (hora da mensagem, não chegada). Correção:
//    started_at → 07:00 (início do turno corrente, como o código corrigido
//    passa a fazer) e scheduled_end_at → 19:15 de hoje (um bloco após a virada
//    referenciada — evita fantasma noturno pagável se ele sair sem avisar).
//
// 2. LUIZ AUGUSTO FERREIRA ALVAREZ — BR05 → CB02 (intervenção)
//    SN na BR05 rendido às 07:20; "continuando na cb02" às 10:15 ficou fora da
//    janela de 2h → ocupação nova SEM vínculo (grupo novo, board = 10:15).
//    Correção: religa ao grupo da BR05, board_started_at → chegada de ontem
//    (âncora do painel/prioridade), started_at → 07:00 (declaração aceita
//    "na cb02 desde 7h", msg das 10:18) e scheduled_end_at → 19:00 de hoje.
//
// Payment closing: a alocação por slot usa started_at dentro da janela de 12h —
// ambos seguem contando exatamente SN (véspera) + SD (hoje). O banco de horas é
// por cadeia de continuidade e só lança quando ela fecha: o resync abaixo deixa
// cada cadeia no estado que o fluxo nativo teria produzido (a entrada isolada da
// BR05 é absorvida pela cadeia unificada e recalculada no fechamento de hoje).
//
// Uso (aponte DATABASE_URL para o banco de produção via túnel):
//   npx tsx scripts/repair-continuity-boundary-2026-07-18.ts           # preview
//   npx tsx scripts/repair-continuity-boundary-2026-07-18.ts --apply   # executa
//
// Idempotente: cada correção é pulada se o estado atual já não bater com o
// esperado (asserts) ou se a nota de saneamento já estiver presente.

import { eq } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { interventionOccupancies, regulationOccupancies, shiftEvents } from "@/db/schema";
import { syncBankHoursByContinuityGroup } from "@/modules/bank-hours/service";

const REPAIR_TAG = "[saneamento-continuidade-2026-07-18]";

const UENDERSON_DAY_OCC = "2f46dc22-39e6-4279-b0a9-e85f7514244d";
const UENDERSON_GROUP = "d5fa93f5-c946-45fc-a4bd-b1175240f006";
const LUIZ_NIGHT_OCC = "e539ae21-e0b8-4903-8805-a7de1ea767fe";
const LUIZ_DAY_OCC = "43993d00-c623-4fc4-bc18-743307d5faab";
const LUIZ_NIGHT_GROUP = "8e69d77c-0ece-4e6a-abe1-1a9bb9d4a60c";
const LUIZ_ORPHAN_GROUP = "e67a7add-5d31-4b65-b53c-e8607e8c4409";

// Horários em UTC (São Paulo = UTC-3).
const SP_0700_TODAY = new Date("2026-07-18T10:00:00.000Z");
const SP_1900_TODAY = new Date("2026-07-18T22:00:00.000Z");
const SP_1915_TODAY = new Date("2026-07-18T22:15:00.000Z");

function hasFlag(flag: string) {
    return process.argv.includes(flag);
}

function appendRepairNote(existing: string | null, detail: string) {
    const line = `${REPAIR_TAG} ${detail}`;
    if (!existing) return line;
    if (existing.includes(REPAIR_TAG)) return existing;
    return `${existing}\n${line}`;
}

async function repairUenderson(apply: boolean) {
    const db = getDb();
    const occupancy = await db.query.regulationOccupancies.findFirst({
        where: eq(regulationOccupancies.id, UENDERSON_DAY_OCC),
    });

    if (!occupancy) {
        return { case: "uenderson", status: "skip", reason: "ocupação não encontrada" };
    }
    if (occupancy.notes?.includes(REPAIR_TAG)) {
        return { case: "uenderson", status: "skip", reason: "já saneado" };
    }
    if (occupancy.endedAt) {
        return { case: "uenderson", status: "skip", reason: "ocupação já fechada — revisar manualmente" };
    }
    if (occupancy.continuityGroupId !== UENDERSON_GROUP) {
        return { case: "uenderson", status: "skip", reason: `grupo inesperado ${occupancy.continuityGroupId}` };
    }
    if (occupancy.startedAt.toISOString() !== "2026-07-18T11:12:21.000Z") {
        return { case: "uenderson", status: "skip", reason: `started_at inesperado ${occupancy.startedAt.toISOString()}` };
    }

    const plan = {
        case: "uenderson",
        status: apply ? "applied" : "planned",
        occupancyId: UENDERSON_DAY_OCC,
        startedAt: { from: occupancy.startedAt.toISOString(), to: SP_0700_TODAY.toISOString() },
        scheduledEndAt: { from: occupancy.scheduledEndAt?.toISOString() ?? null, to: SP_1915_TODAY.toISOString() },
    };

    if (!apply) {
        return plan;
    }

    await db.transaction(async (tx) => {
        await tx.update(regulationOccupancies)
            .set({
                startedAt: SP_0700_TODAY,
                scheduledEndAt: SP_1915_TODAY,
                notes: appendRepairNote(occupancy.notes, `started_at antigo ${occupancy.startedAt.toISOString()}; scheduled_end antigo ${occupancy.scheduledEndAt?.toISOString() ?? "null"}`),
                updatedAt: new Date(),
            })
            .where(eq(regulationOccupancies.id, UENDERSON_DAY_OCC));

        await tx.insert(shiftEvents).values({
            domain: "regulation",
            entityId: UENDERSON_DAY_OCC,
            entityType: "regulation_occupancy",
            eventType: "continuity_boundary_repaired",
            actorLabel: "scripts/repair-continuity-boundary-2026-07-18",
            occurredAt: new Date(),
            payload: {
                ...plan,
                note: "Continuação recriada pós-expiry com started_at = hora da mensagem; ancorado no início do turno e cobertura limitada ao bloco anunciado.",
            },
        });

        await syncBankHoursByContinuityGroup(tx, UENDERSON_GROUP);
    });

    return plan;
}

async function repairLuiz(apply: boolean) {
    const db = getDb();
    const dayOccupancy = await db.query.interventionOccupancies.findFirst({
        where: eq(interventionOccupancies.id, LUIZ_DAY_OCC),
    });
    const nightOccupancy = await db.query.interventionOccupancies.findFirst({
        where: eq(interventionOccupancies.id, LUIZ_NIGHT_OCC),
    });

    if (!dayOccupancy || !nightOccupancy) {
        return { case: "luiz", status: "skip", reason: "ocupação não encontrada" };
    }
    if (dayOccupancy.notes?.includes(REPAIR_TAG)) {
        return { case: "luiz", status: "skip", reason: "já saneado" };
    }
    if (dayOccupancy.endedAt) {
        return { case: "luiz", status: "skip", reason: "ocupação já fechada — revisar manualmente" };
    }
    if (dayOccupancy.continuityGroupId !== LUIZ_ORPHAN_GROUP) {
        return { case: "luiz", status: "skip", reason: `grupo inesperado ${dayOccupancy.continuityGroupId}` };
    }
    if (nightOccupancy.continuityGroupId !== LUIZ_NIGHT_GROUP) {
        return { case: "luiz", status: "skip", reason: `grupo da BR05 inesperado ${nightOccupancy.continuityGroupId}` };
    }

    const plan = {
        case: "luiz",
        status: apply ? "applied" : "planned",
        occupancyId: LUIZ_DAY_OCC,
        continuityGroupId: { from: LUIZ_ORPHAN_GROUP, to: LUIZ_NIGHT_GROUP },
        boardStartedAt: { from: dayOccupancy.boardStartedAt?.toISOString() ?? null, to: nightOccupancy.startedAt.toISOString() },
        startedAt: { from: dayOccupancy.startedAt.toISOString(), to: SP_0700_TODAY.toISOString() },
        scheduledEndAt: { from: dayOccupancy.scheduledEndAt?.toISOString() ?? null, to: SP_1900_TODAY.toISOString() },
    };

    if (!apply) {
        return plan;
    }

    await db.transaction(async (tx) => {
        await tx.update(interventionOccupancies)
            .set({
                continuityGroupId: LUIZ_NIGHT_GROUP,
                boardStartedAt: nightOccupancy.startedAt,
                startedAt: SP_0700_TODAY,
                scheduledEndAt: SP_1900_TODAY,
                notes: appendRepairNote(dayOccupancy.notes, `grupo antigo ${LUIZ_ORPHAN_GROUP}; started_at antigo ${dayOccupancy.startedAt.toISOString()}; board antigo ${dayOccupancy.boardStartedAt?.toISOString() ?? "null"}`),
                updatedAt: new Date(),
            })
            .where(eq(interventionOccupancies.id, LUIZ_DAY_OCC));

        await tx.insert(shiftEvents).values({
            domain: "intervention",
            entityId: LUIZ_DAY_OCC,
            entityType: "intervention_occupancy",
            eventType: "continuity_boundary_repaired",
            actorLabel: "scripts/repair-continuity-boundary-2026-07-18",
            occurredAt: new Date(),
            payload: {
                ...plan,
                note: "'Continuando na cb02' fora da janela de link ficou sem vínculo; religado ao grupo da BR05 com âncora da véspera e chegada conforme declaração aceita ('desde 7h').",
            },
        });

        // Cadeia unificada: recalcula (a entrada isolada da BR05 é absorvida e o
        // lançamento definitivo sai no fechamento da cadeia). O grupo órfão fica
        // vazio — o sync apenas garante que não sobre lançamento pendurado nele.
        await syncBankHoursByContinuityGroup(tx, LUIZ_NIGHT_GROUP);
        await syncBankHoursByContinuityGroup(tx, LUIZ_ORPHAN_GROUP);
    });

    return plan;
}

async function main() {
    const apply = hasFlag("--apply");
    const results = [await repairUenderson(apply), await repairLuiz(apply)];
    console.log(JSON.stringify({ mode: apply ? "apply" : "preview", results }, null, 2));
    await closeDb();
}

main().catch(async (error) => {
    console.error(error);
    await closeDb().catch(() => undefined);
    process.exitCode = 1;
});
