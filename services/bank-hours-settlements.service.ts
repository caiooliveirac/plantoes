import { eq, like } from "drizzle-orm";
import { getDb } from "@/db";
import { adminExtraShifts, bankHoursSettlements, users } from "@/db/schema";
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
    createdByEmail: string | null;
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
            createdByEmail: users.email,
        })
        .from(bankHoursSettlements)
        .leftJoin(adminExtraShifts, eq(adminExtraShifts.id, bankHoursSettlements.adminExtraShiftId))
        .leftJoin(users, eq(users.id, bankHoursSettlements.createdByUserId))
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
            createdByEmail: row.createdByEmail ?? null,
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

/** Prefixo que marca (nas notes) o acerto que estorna outro. */
export const BANK_HOURS_REVERSAL_NOTE_PREFIX = "reversal:";

export function isReversalSettlementNote(notes: string) {
    return notes.startsWith(BANK_HOURS_REVERSAL_NOTE_PREFIX);
}

/**
 * Estorno formal de um acerto: nada é apagado. Cria o par compensatório —
 * settlement com delta oposto + plantão de sinal oposto no MESMO dia — e marca
 * o vínculo em notes (`reversal:<id> — motivo`). O saldo e o pagamento voltam
 * ao estado anterior pela própria soma do razão.
 *
 * Idempotente: um acerto só pode ser estornado uma vez (guard dentro da mesma
 * transação, com lock na linha original — duplo clique/abas concorrentes caem
 * no erro, não em estorno dobrado).
 */
export async function reverseBankHoursSettlement(params: {
    settlementId: string;
    actorUserId: string;
    reason: string;
}): Promise<SettleBankHoursResult & { reversedSettlementId: string }> {
    const reason = params.reason.trim();
    if (!reason) {
        throw new Error("O estorno exige uma justificativa.");
    }

    const db = getDb();
    return db.transaction(async (tx) => {
        const [original] = await tx
            .select()
            .from(bankHoursSettlements)
            .where(eq(bankHoursSettlements.id, params.settlementId))
            .for("update");
        if (!original) {
            throw new Error("Acerto de banco de horas não encontrado.");
        }
        if (isReversalSettlementNote(original.notes)) {
            throw new Error("Este lançamento já é um estorno — não pode ser estornado.");
        }
        const [existingReversal] = await tx
            .select({ id: bankHoursSettlements.id })
            .from(bankHoursSettlements)
            .where(like(bankHoursSettlements.notes, `${BANK_HOURS_REVERSAL_NOTE_PREFIX}${original.id}%`))
            .limit(1);
        if (existingReversal) {
            throw new Error("Este acerto já foi estornado.");
        }

        const originalKind = normalizeKind(original.kind);
        const reversalKind: BankHoursSettlementKind = originalKind === "bonus" ? "penalty" : "bonus";
        const unit = reversalKind === "bonus" ? 1 : -1;
        // Mesmo dia do plantão original: o par verde/vermelho se anula no dia.
        const [originalExtra] = original.adminExtraShiftId
            ? await tx
                .select({ operationalDate: adminExtraShifts.operationalDate })
                .from(adminExtraShifts)
                .where(eq(adminExtraShifts.id, original.adminExtraShiftId))
            : [];
        const operationalDate = originalExtra?.operationalDate ?? pickRandomWeekday(original.monthKey);
        const label = `Estorno banco de horas`.slice(0, 40);

        const [extra] = await tx
            .insert(adminExtraShifts)
            .values({
                doctorId: original.doctorId,
                operationalDate,
                shiftLabel: "SD",
                label,
                kind: reversalKind,
                unit,
                createdByUserId: params.actorUserId,
            })
            .returning({ id: adminExtraShifts.id });

        const [settlement] = await tx
            .insert(bankHoursSettlements)
            .values({
                doctorId: original.doctorId,
                monthKey: original.monthKey,
                deltaMinutes: -original.deltaMinutes,
                kind: reversalKind,
                adminExtraShiftId: extra.id,
                notes: `${BANK_HOURS_REVERSAL_NOTE_PREFIX}${original.id} — ${reason}`,
                createdByUserId: params.actorUserId,
            })
            .returning({ id: bankHoursSettlements.id });

        return {
            settlementId: settlement.id,
            reversedSettlementId: original.id,
            adminExtraShiftId: extra.id,
            doctorId: original.doctorId,
            monthKey: original.monthKey,
            kind: reversalKind,
            deltaMinutes: -original.deltaMinutes,
            operationalDate,
            shiftUnit: unit,
            label,
        };
    });
}
