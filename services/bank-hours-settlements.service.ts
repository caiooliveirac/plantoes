import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { adminExtraShifts, bankHoursSettlements } from "@/db/schema";
import { isPremiumRateDate } from "@/modules/operational/holidays";

/** Cada acerto move o saldo do banco de horas em exatamente 12h (720 min). */
export const BANK_HOURS_SETTLEMENT_MINUTES = 12 * 60;
/** Gatilho: o botão só aparece quando o saldo chega a ±12h. */
export const BANK_HOURS_SETTLEMENT_THRESHOLD_MINUTES = BANK_HOURS_SETTLEMENT_MINUTES;

export type BankHoursSettlementKind = "bonus" | "penalty";

export interface BankHoursSettlementRow {
    id: string;
    doctorId: string;
    monthKey: string;
    deltaMinutes: number;
    kind: BankHoursSettlementKind;
    adminExtraShiftId: string | null;
    operationalDate: string | null;
    notes: string;
    createdAt: string;
}

function normalizeKind(value: string): BankHoursSettlementKind {
    return value === "penalty" ? "penalty" : "bonus";
}

/** Acertos lançados num mês, agrupados por médico (para mostrar "feito neste mês"). */
export async function loadBankHoursSettlementsForMonth(
    monthKey: string,
): Promise<Map<string, BankHoursSettlementRow[]>> {
    const db = getDb();
    const rows = await db
        .select({
            id: bankHoursSettlements.id,
            doctorId: bankHoursSettlements.doctorId,
            monthKey: bankHoursSettlements.monthKey,
            deltaMinutes: bankHoursSettlements.deltaMinutes,
            kind: bankHoursSettlements.kind,
            adminExtraShiftId: bankHoursSettlements.adminExtraShiftId,
            operationalDate: adminExtraShifts.operationalDate,
            notes: bankHoursSettlements.notes,
            createdAt: bankHoursSettlements.createdAt,
        })
        .from(bankHoursSettlements)
        .leftJoin(adminExtraShifts, eq(adminExtraShifts.id, bankHoursSettlements.adminExtraShiftId))
        .where(eq(bankHoursSettlements.monthKey, monthKey));

    const map = new Map<string, BankHoursSettlementRow[]>();
    for (const row of rows) {
        const entry: BankHoursSettlementRow = {
            id: row.id,
            doctorId: row.doctorId,
            monthKey: row.monthKey,
            deltaMinutes: row.deltaMinutes,
            kind: normalizeKind(row.kind),
            adminExtraShiftId: row.adminExtraShiftId,
            operationalDate: row.operationalDate ?? null,
            notes: row.notes,
            createdAt: row.createdAt.toISOString(),
        };
        const bucket = map.get(row.doctorId) ?? [];
        bucket.push(entry);
        map.set(row.doctorId, bucket);
    }
    return map;
}

/**
 * Soma de todos os acertos (de todo o histórico) por médico, em minutos. É o
 * ajuste que se soma ao saldo bruto do banco de horas para chegar ao saldo
 * efetivo mostrado no fechamento.
 */
export async function loadBankHoursSettlementDeltaByDoctor(): Promise<Map<string, number>> {
    const db = getDb();
    const rows = await db
        .select({
            doctorId: bankHoursSettlements.doctorId,
            deltaMinutes: bankHoursSettlements.deltaMinutes,
        })
        .from(bankHoursSettlements);

    const map = new Map<string, number>();
    for (const row of rows) {
        map.set(row.doctorId, (map.get(row.doctorId) ?? 0) + row.deltaMinutes);
    }
    return map;
}

export interface BankHoursSettlementSummary {
    id: string;
    monthKey: string;
    kind: BankHoursSettlementKind;
    deltaMinutes: number;
    operationalDate: string | null;
    notes: string;
    createdAt: string;
}

/** Todos os acertos, agrupados por médico (para a página de banco de horas). */
export async function loadAllBankHoursSettlements(): Promise<Map<string, BankHoursSettlementSummary[]>> {
    const db = getDb();
    const rows = await db
        .select({
            id: bankHoursSettlements.id,
            doctorId: bankHoursSettlements.doctorId,
            monthKey: bankHoursSettlements.monthKey,
            deltaMinutes: bankHoursSettlements.deltaMinutes,
            kind: bankHoursSettlements.kind,
            operationalDate: adminExtraShifts.operationalDate,
            notes: bankHoursSettlements.notes,
            createdAt: bankHoursSettlements.createdAt,
        })
        .from(bankHoursSettlements)
        .leftJoin(adminExtraShifts, eq(adminExtraShifts.id, bankHoursSettlements.adminExtraShiftId));

    const map = new Map<string, BankHoursSettlementSummary[]>();
    for (const row of rows) {
        const bucket = map.get(row.doctorId) ?? [];
        bucket.push({
            id: row.id,
            monthKey: row.monthKey,
            kind: normalizeKind(row.kind),
            deltaMinutes: row.deltaMinutes,
            operationalDate: row.operationalDate ?? null,
            notes: row.notes,
            createdAt: row.createdAt.toISOString(),
        });
        map.set(row.doctorId, bucket);
    }
    return map;
}

function daysInMonth(monthKey: string): number {
    const [year, month] = monthKey.split("-").map(Number);
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Escolhe um dia útil (não fim de semana / feriado) aleatório do mês para pendurar
 * o plantão verde do bônus. Se o mês não tiver nenhum dia útil reconhecido, cai no
 * dia 15 como último recurso.
 */
function pickRandomWeekday(monthKey: string): string {
    const total = daysInMonth(monthKey);
    const weekdays: string[] = [];
    for (let day = 1; day <= total; day += 1) {
        const operationalDate = `${monthKey}-${String(day).padStart(2, "0")}`;
        if (!isPremiumRateDate(operationalDate)) {
            weekdays.push(operationalDate);
        }
    }
    if (weekdays.length === 0) {
        return `${monthKey}-15`;
    }
    return weekdays[Math.floor(Math.random() * weekdays.length)];
}

export interface SettleBankHoursResult {
    settlementId: string;
    adminExtraShiftId: string;
    doctorId: string;
    monthKey: string;
    kind: BankHoursSettlementKind;
    deltaMinutes: number;
    operationalDate: string;
    shiftUnit: number;
    label: string;
}

/**
 * Lança o acerto do banco de horas: cria o plantão verde (bônus, +1) ou vermelho
 * (punição, -1) no mês e registra o settlement que debita 12h do saldo. As duas
 * gravações são atômicas e ficam casadas para auditoria.
 *
 * `operationalDate` é opcional — sem ele, sorteia um dia útil do mês.
 */
export async function settleBankHours(params: {
    doctorId: string;
    monthKey: string;
    kind: BankHoursSettlementKind;
    actorUserId: string;
    note?: string | null;
    operationalDate?: string;
}): Promise<SettleBankHoursResult> {
    const kind = params.kind;
    const isBonus = kind === "bonus";
    // Bônus paga o crédito (+12h) → reduz o saldo (delta negativo). Punição cobra
    // o débito (-12h) → empurra o saldo de volta a zero (delta positivo).
    const deltaMinutes = isBonus ? -BANK_HOURS_SETTLEMENT_MINUTES : BANK_HOURS_SETTLEMENT_MINUTES;
    const unit = isBonus ? 1 : -1;
    const operationalDate = params.operationalDate ?? pickRandomWeekday(params.monthKey);
    const baseLabel = isBonus ? "Banco de horas +12h" : "Banco de horas -12h";
    const label = baseLabel.slice(0, 40);
    const note = params.note?.trim()
        ? `${baseLabel} — ${params.note.trim()}`
        : `${baseLabel} (acerto automático de banco de horas)`;

    const db = getDb();
    return db.transaction(async (tx) => {
        const [extra] = await tx
            .insert(adminExtraShifts)
            .values({
                doctorId: params.doctorId,
                operationalDate,
                shiftLabel: "SD",
                label,
                kind,
                unit,
                createdByUserId: params.actorUserId,
            })
            .returning({ id: adminExtraShifts.id });

        const [settlement] = await tx
            .insert(bankHoursSettlements)
            .values({
                doctorId: params.doctorId,
                monthKey: params.monthKey,
                deltaMinutes,
                kind,
                adminExtraShiftId: extra.id,
                notes: note,
                createdByUserId: params.actorUserId,
            })
            .returning({ id: bankHoursSettlements.id });

        return {
            settlementId: settlement.id,
            adminExtraShiftId: extra.id,
            doctorId: params.doctorId,
            monthKey: params.monthKey,
            kind,
            deltaMinutes,
            operationalDate,
            shiftUnit: unit,
            label,
        } satisfies SettleBankHoursResult;
    });
}
