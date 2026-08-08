import { and, eq, like, sql } from "drizzle-orm";
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
    shiftLabel: string | null;
    notes: string;
    createdAt: string;
    createdByEmail: string | null;
}

/** Marcador (em notes) da retirada de um plantão real da folha pelo autoatendimento. */
export const BANK_HOURS_FOLHA_RETIRADA_MARKER = "retirada da folha";

/** Marcador (em notes) de tudo que o próprio médico lançou pelo painel dele. */
export const BANK_HOURS_SELF_SERVICE_MARKER = "autoatendimento";

/**
 * Tag que o extra declarado pelo médico carrega no board do coordenador — é o
 * `label` do plantão verde, que vira o código exibido no chip do payment-closing.
 */
export const SELF_DECLARED_EXTRA_LABEL = "EXTRA DECLARADO";

export function isSelfServiceSettlementNote(notes: string) {
    return notes.includes(BANK_HOURS_SELF_SERVICE_MARKER);
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
            shiftLabel: adminExtraShifts.shiftLabel,
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
            shiftLabel: row.shiftLabel ?? null,
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
    /** null = autoatendimento via link assinado do bot (médico sem conta). */
    actorUserId: string | null;
    note?: string | null;
    operationalDate?: string;
    /** Turno do plantão verde/vermelho (default SD). A retirada de um plantão
     * real precisa casar o turno para o pagamento e a folha netarem no dia certo. */
    shiftLabel?: "SD" | "SN";
    /** Tag do plantão no board do coordenador (default "Banco de horas ±12h"). */
    label?: string;
}): Promise<SettleBankHoursResult> {
    const kind = params.kind;
    const isBonus = kind === "bonus";
    // Bônus paga o crédito (+12h) → reduz o saldo (delta negativo). Punição cobra
    // o débito (-12h) → empurra o saldo de volta a zero (delta positivo).
    const deltaMinutes = isBonus ? -BANK_HOURS_SETTLEMENT_MINUTES : BANK_HOURS_SETTLEMENT_MINUTES;
    const unit = isBonus ? 1 : -1;
    const operationalDate = params.operationalDate ?? pickRandomWeekday(params.monthKey);
    const baseLabel = isBonus ? "Banco de horas +12h" : "Banco de horas -12h";
    const label = (params.label?.trim() || baseLabel).slice(0, 40);
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
                shiftLabel: params.shiftLabel ?? "SD",
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

/**
 * Nomes normalizados liberados a declarar o próprio plantão extra mesmo sem
 * histórico na 2031 — liberação nominal da coordenação, uma linha por pessoa.
 */
export const SELF_DECLARED_EXTRA_ALLOWLIST = [
    "MARIA ELISA DOS REIS GARRIDO",
];

/**
 * O médico pode declarar o próprio plantão extra sem o gate de +12h? Vale para
 * quem já deu plantão no ramal 2031 (chefia de plantão) e para quem está na
 * allowlist nominal. O saldo desconta igual e o coordenador revisa depois.
 */
export async function canSelfDeclareExtraShift(doctorId: string): Promise<boolean> {
    const result = await getDb().execute(sql`
        select 1
        from operations_v2.doctors d
        where d.id = ${doctorId}
          and (
            d.normalized_name in (${sql.join(SELF_DECLARED_EXTRA_ALLOWLIST.map((name) => sql`${name}`), sql`, `)})
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

export interface SelfDeclaredExtraRow {
    settlementId: string;
    adminExtraShiftId: string;
    operationalDate: string;
    shiftLabel: "SD" | "SN";
    createdAt: string;
}

/** Os plantões extra declarados pelos próprios médicos no mês. */
export async function loadSelfDeclaredExtrasForMonth(
    monthKey: string,
    doctorId?: string,
): Promise<Array<SelfDeclaredExtraRow & { doctorId: string }>> {
    const rows = await getDb()
        .select({
            settlementId: bankHoursSettlements.id,
            doctorId: bankHoursSettlements.doctorId,
            adminExtraShiftId: adminExtraShifts.id,
            operationalDate: adminExtraShifts.operationalDate,
            shiftLabel: adminExtraShifts.shiftLabel,
            notes: bankHoursSettlements.notes,
            createdAt: bankHoursSettlements.createdAt,
        })
        .from(bankHoursSettlements)
        .innerJoin(adminExtraShifts, eq(adminExtraShifts.id, bankHoursSettlements.adminExtraShiftId))
        .where(and(
            eq(bankHoursSettlements.monthKey, monthKey),
            eq(bankHoursSettlements.kind, "bonus"),
            ...(doctorId ? [eq(bankHoursSettlements.doctorId, doctorId)] : []),
        ));

    return rows
        .filter((row) => isSelfServiceSettlementNote(row.notes))
        .map((row) => ({
            settlementId: row.settlementId,
            doctorId: row.doctorId,
            adminExtraShiftId: row.adminExtraShiftId,
            operationalDate: row.operationalDate,
            shiftLabel: (row.shiftLabel === "SN" ? "SN" : "SD") as "SD" | "SN",
            createdAt: row.createdAt.toISOString(),
        }))
        .sort((a, b) => a.operationalDate.localeCompare(b.operationalDate));
}

/** Os plantões extra que o próprio médico declarou no mês (para ele revisar). */
export async function loadSelfDeclaredExtras(
    doctorId: string,
    monthKey: string,
): Promise<SelfDeclaredExtraRow[]> {
    return loadSelfDeclaredExtrasForMonth(monthKey, doctorId);
}

/**
 * Remarca o plantão extra (usado pelo remanejo automático, que não passa pelo
 * guard do médico — quem dispara é a varredura, não a pessoa).
 */
export async function moveSelfDeclaredExtra(params: {
    adminExtraShiftId: string;
    operationalDate: string;
    shiftLabel: "SD" | "SN";
}): Promise<void> {
    await getDb()
        .update(adminExtraShifts)
        .set({ operationalDate: params.operationalDate, shiftLabel: params.shiftLabel })
        .where(eq(adminExtraShifts.id, params.adminExtraShiftId));
}

/**
 * Guard do que o médico pode mexer sozinho: só o extra que ELE declarou, no mês
 * corrente. Estorno de qualquer outro acerto continua sendo do coordenador.
 */
export function canDoctorManageSettlement(
    settlement: { doctorId: string; monthKey: string; kind: string; notes: string },
    context: { doctorId: string; currentMonthKey: string },
): boolean {
    return settlement.doctorId === context.doctorId
        && settlement.monthKey === context.currentMonthKey
        && normalizeKind(settlement.kind) === "bonus"
        && isSelfServiceSettlementNote(settlement.notes)
        && !isReversalSettlementNote(settlement.notes);
}

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

async function loadManageableSettlement(tx: Tx, params: {
    settlementId: string;
    doctorId: string;
    currentMonthKey: string;
}) {
    const [row] = await tx
        .select()
        .from(bankHoursSettlements)
        .where(eq(bankHoursSettlements.id, params.settlementId))
        .for("update");
    if (!row || !canDoctorManageSettlement(row, params) || !row.adminExtraShiftId) {
        throw new Error("Este lançamento não pode mais ser alterado por aqui.");
    }
    return row;
}

/** Troca dia/turno de um extra declarado pelo próprio médico. */
export async function updateSelfDeclaredExtra(params: {
    settlementId: string;
    doctorId: string;
    currentMonthKey: string;
    operationalDate: string;
    shiftLabel: "SD" | "SN";
}): Promise<void> {
    await getDb().transaction(async (tx) => {
        const settlement = await loadManageableSettlement(tx, params);
        await tx
            .update(adminExtraShifts)
            .set({ operationalDate: params.operationalDate, shiftLabel: params.shiftLabel })
            .where(eq(adminExtraShifts.id, settlement.adminExtraShiftId!));
    });
}

/**
 * Apaga o extra declarado pelo próprio médico (o par plantão verde + acerto).
 * É apagar mesmo, não estornar: enquanto o coordenador não revisou, um par
 * verde/vermelho no mesmo dia só confundiria o fechamento. O rastro fica no
 * audit_logs de quem apagou.
 */
export async function deleteSelfDeclaredExtra(params: {
    settlementId: string;
    doctorId: string;
    currentMonthKey: string;
}): Promise<{ operationalDate: string; shiftLabel: string }> {
    return getDb().transaction(async (tx) => {
        const settlement = await loadManageableSettlement(tx, params);
        await tx.delete(bankHoursSettlements).where(eq(bankHoursSettlements.id, settlement.id));
        const [extra] = await tx
            .delete(adminExtraShifts)
            .where(eq(adminExtraShifts.id, settlement.adminExtraShiftId!))
            .returning({
                operationalDate: adminExtraShifts.operationalDate,
                shiftLabel: adminExtraShifts.shiftLabel,
            });
        return { operationalDate: extra?.operationalDate ?? "", shiftLabel: extra?.shiftLabel ?? "SD" };
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
