/**
 * Plantão extra de CHEFIA — deliberadamente separado do banco de horas.
 *
 * Quem já deu plantão na 2031 (ou está na allowlist nominal) trabalha turnos de
 * chefia que são pagos como plantão extra, mas que NÃO são acerto de banco de
 * horas: não nascem de um settlement, não descontam ±12h, não aparecem nas
 * telas de banco de horas. Por isso este arquivo não importa nada de
 * bank-hours-settlements: o único ponto de contato possível seria aqui, e ele
 * não existe.
 *
 * Persistência: uma linha em admin_extra_shifts com kind 'chief' (plantão
 * inteiro) ou 'chief_half' (meio plantão, 0,5 unidade pagável) e unit +1 — a
 * fração de pagamento vem do kind, porque unit é coluna integer.
 */
import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { adminExtraShifts, doctors } from "@/db/schema";
import {
    CHIEF_EXTRA_HALF_SHIFT_KIND,
    CHIEF_EXTRA_SHIFT_KIND,
    CHIEF_EXTRA_SHIFT_LABEL,
} from "@/modules/reporting/payable-shifts";

/** Inteiro ('full') paga 1 unidade; meio ('half') paga 0,5 — metade do valor. */
export type ChiefExtraShiftCoverage = "full" | "half";

const CHIEF_EXTRA_KINDS = [CHIEF_EXTRA_SHIFT_KIND, CHIEF_EXTRA_HALF_SHIFT_KIND];

function coverageFromKind(kind: string | null | undefined): ChiefExtraShiftCoverage {
    return kind === CHIEF_EXTRA_HALF_SHIFT_KIND ? "half" : "full";
}

function kindFromCoverage(coverage: ChiefExtraShiftCoverage): string {
    return coverage === "half" ? CHIEF_EXTRA_HALF_SHIFT_KIND : CHIEF_EXTRA_SHIFT_KIND;
}

export interface ChiefExtraShiftRow {
    id: string;
    operationalDate: string;
    shiftLabel: "SD" | "SN";
    coverage: ChiefExtraShiftCoverage;
    createdAt: string;
}

function monthRange(monthKey: string): { start: string; end: string } {
    const [year, month] = monthKey.split("-").map(Number);
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return { start: `${monthKey}-01`, end: `${monthKey}-${String(lastDay).padStart(2, "0")}` };
}

function normalizeShift(value: string | null | undefined): "SD" | "SN" {
    return value === "SN" ? "SN" : "SD";
}

/**
 * Quem pode declarar plantão de chefia: quem já ocupou o ramal 2031 alguma vez,
 * mais a allowlist nominal da coordenação (uma linha por pessoa).
 */
export const CHIEF_EXTRA_ALLOWLIST = [
    "MARIA ELISA DOS REIS GARRIDO",
];

export async function canDeclareChiefExtraShift(doctorId: string): Promise<boolean> {
    const result = await getDb().execute(sql`
        select 1
        from operations_v2.doctors d
        where d.id = ${doctorId}
          and (
            d.normalized_name in (${sql.join(CHIEF_EXTRA_ALLOWLIST.map((name) => sql`${name}`), sql`, `)})
            or exists (
                select 1
                from operations_v2.regulation_occupancies ro
                join operations_v2.regulation_posts rp on rp.id = ro.post_id
                where ro.doctor_id = d.id and rp.code = '2031'
            )
          )
        limit 1
    `);
    return (result as unknown as unknown[]).length > 0;
}

/** Os plantões de chefia que o médico declarou no mês. */
export async function loadChiefExtraShifts(
    doctorId: string,
    monthKey: string,
): Promise<ChiefExtraShiftRow[]> {
    const { start, end } = monthRange(monthKey);
    const rows = await getDb()
        .select({
            id: adminExtraShifts.id,
            operationalDate: adminExtraShifts.operationalDate,
            shiftLabel: adminExtraShifts.shiftLabel,
            kind: adminExtraShifts.kind,
            createdAt: adminExtraShifts.createdAt,
        })
        .from(adminExtraShifts)
        .where(and(
            eq(adminExtraShifts.doctorId, doctorId),
            inArray(adminExtraShifts.kind, CHIEF_EXTRA_KINDS),
            gte(adminExtraShifts.operationalDate, start),
            lte(adminExtraShifts.operationalDate, end),
        ))
        .orderBy(asc(adminExtraShifts.operationalDate));

    return rows.map((row) => ({
        id: row.id,
        operationalDate: row.operationalDate,
        shiftLabel: normalizeShift(row.shiftLabel),
        coverage: coverageFromKind(row.kind),
        createdAt: row.createdAt.toISOString(),
    }));
}

/** Cria o plantão de chefia. Um por dia+turno (inteiro OU meio) — duplo clique cai no erro. */
export async function createChiefExtraShift(params: {
    doctorId: string;
    operationalDate: string;
    shiftLabel: "SD" | "SN";
    coverage: ChiefExtraShiftCoverage;
    actorUserId: string | null;
}): Promise<ChiefExtraShiftRow> {
    const db = getDb();
    const [doctor] = await db
        .select({ id: doctors.id })
        .from(doctors)
        .where(eq(doctors.id, params.doctorId))
        .limit(1);
    if (!doctor) {
        throw new Error("Médico não encontrado.");
    }

    return db.transaction(async (tx) => {
        const [duplicate] = await tx
            .select({ id: adminExtraShifts.id })
            .from(adminExtraShifts)
            .where(and(
                eq(adminExtraShifts.doctorId, params.doctorId),
                inArray(adminExtraShifts.kind, CHIEF_EXTRA_KINDS),
                eq(adminExtraShifts.operationalDate, params.operationalDate),
                eq(adminExtraShifts.shiftLabel, params.shiftLabel),
            ))
            .limit(1);
        if (duplicate) {
            throw new Error("Este dia e turno já têm um plantão de chefia.");
        }

        const [row] = await tx
            .insert(adminExtraShifts)
            .values({
                doctorId: params.doctorId,
                operationalDate: params.operationalDate,
                shiftLabel: params.shiftLabel,
                label: CHIEF_EXTRA_SHIFT_LABEL,
                kind: kindFromCoverage(params.coverage),
                unit: 1,
                createdByUserId: params.actorUserId,
            })
            .returning({ id: adminExtraShifts.id, createdAt: adminExtraShifts.createdAt });

        return {
            id: row.id,
            operationalDate: params.operationalDate,
            shiftLabel: params.shiftLabel,
            coverage: params.coverage,
            createdAt: row.createdAt.toISOString(),
        };
    });
}

/**
 * Guard do que o próprio médico mexe: só plantão de chefia dele, dentro do mês
 * corrente. Qualquer outro extra continua sendo do coordenador.
 */
function ownChiefExtraCondition(params: { id: string; doctorId: string; monthKey: string }) {
    const { start, end } = monthRange(params.monthKey);
    return and(
        eq(adminExtraShifts.id, params.id),
        eq(adminExtraShifts.doctorId, params.doctorId),
        inArray(adminExtraShifts.kind, CHIEF_EXTRA_KINDS),
        gte(adminExtraShifts.operationalDate, start),
        lte(adminExtraShifts.operationalDate, end),
    );
}

/** Troca dia/turno (e inteiro/meio, quando informado) de um plantão de chefia
 *  declarado no mês corrente. Retorna como o registro ficou. */
export async function updateChiefExtraShift(params: {
    id: string;
    doctorId: string;
    monthKey: string;
    operationalDate: string;
    shiftLabel: "SD" | "SN";
    /** Omitido = mantém o inteiro/meio que já estava gravado. */
    coverage?: ChiefExtraShiftCoverage;
}): Promise<{ coverage: ChiefExtraShiftCoverage }> {
    const updated = await getDb()
        .update(adminExtraShifts)
        .set({
            operationalDate: params.operationalDate,
            shiftLabel: params.shiftLabel,
            ...(params.coverage ? { kind: kindFromCoverage(params.coverage) } : {}),
        })
        .where(ownChiefExtraCondition(params))
        .returning({ id: adminExtraShifts.id, kind: adminExtraShifts.kind });
    if (updated.length === 0) {
        throw new Error("Este plantão de chefia não pode mais ser alterado por aqui.");
    }
    return { coverage: coverageFromKind(updated[0].kind) };
}

/** Tira um plantão de chefia declarado no mês corrente. */
export async function deleteChiefExtraShift(params: {
    id: string;
    doctorId: string;
    monthKey: string;
}): Promise<ChiefExtraShiftRow> {
    const [removed] = await getDb()
        .delete(adminExtraShifts)
        .where(ownChiefExtraCondition(params))
        .returning({
            id: adminExtraShifts.id,
            operationalDate: adminExtraShifts.operationalDate,
            shiftLabel: adminExtraShifts.shiftLabel,
            kind: adminExtraShifts.kind,
            createdAt: adminExtraShifts.createdAt,
        });
    if (!removed) {
        throw new Error("Este plantão de chefia não pode mais ser removido por aqui.");
    }
    return {
        id: removed.id,
        operationalDate: removed.operationalDate,
        shiftLabel: normalizeShift(removed.shiftLabel),
        coverage: coverageFromKind(removed.kind),
        createdAt: removed.createdAt.toISOString(),
    };
}
