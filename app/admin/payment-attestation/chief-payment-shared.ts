import type {
    ChiefPayableBankHoursSettlement,
    PayableShift,
} from "@/modules/reporting/payable-shifts";
import { isPremiumRateDate, isSamuHolidayDate, isWeekendDate as isStrictWeekendDate } from "@/modules/operational/holidays";

export type PaymentStatusFilter = "all" | "ready" | "review";
export type ShiftFilter = "all" | "SD" | "SN";
export type DomainFilter = "all" | "regulation" | "intervention";
export type CoverageFilter = "all" | "half" | "full";
export type SortMode = "name" | "total" | "pending" | "weekday" | "weekend";
export type DoctorProfile = "generalist" | "specialist" | "psychiatry";
export type DoctorEmploymentType = "pj" | "estatutario";
export type EmploymentTypeFilter = "all" | DoctorEmploymentType;

/** Linha da matriz já com filtros, overrides e totais aplicados — o que a UI renderiza. */
export interface MatrixRowModel {
    doctorId: string;
    doctorName: string;
    displayName: string | null;
    paymentProfile: DoctorProfile;
    employmentType: DoctorEmploymentType;
    paymentStatus: "ready_for_payment" | "needs_review";
    attested: boolean;
    /** Pronto para o lote: sem pendência E atestado (semântica do redesign). */
    isReady: boolean;
    pendingCount: number;
    totalSD: number;
    totalSN: number;
    total: number;
    weekdayShiftCount: number;
    weekendShiftCount: number;
    weekdayDue: number;
    weekendDue: number;
    totalDue: number;
    invoiceNumber: string | null;
    paymentProcessNumber: string | null;
    contractCeilingBrl: number | null;
    contractSeedMonth: string | null;
    contractBalanceBrl: number | null;
    bankHoursMinutes: number | null;
    bankHoursSettlement: ChiefPayableBankHoursSettlement | null;
    /** Alinhado 1:1 com board.days; shifts já sem os removidos otimisticamente. */
    cells: Array<{ day: string; shifts: PayableShift[] }>;
}

export const MONEY_FORMATTER = new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
});

export function formatCurrency(value: number | null | undefined) {
    const safeValue = Number.isFinite(value) ? Number(value) : 0;
    return MONEY_FORMATTER.format(safeValue);
}

/** Minutos → "1 h 30" / "-45 min". Espelha formatMinutesForHumans do servidor. */
export function formatMinutesAsHours(minutes: number | null | undefined) {
    if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) {
        return "--";
    }
    const sign = minutes < 0 ? "-" : "";
    const absolute = Math.abs(minutes);
    const hours = Math.floor(absolute / 60);
    const remainder = absolute % 60;
    if (hours === 0) {
        return `${sign}${remainder} min`;
    }
    if (remainder === 0) {
        return `${sign}${hours} h`;
    }
    return `${sign}${hours} h ${String(remainder).padStart(2, "0")}`;
}

/** Gatilho do acerto de banco de horas: ±12h em minutos. */
export const BANK_HOURS_THRESHOLD_MINUTES = 12 * 60;

export function paymentProfileLabel(profile: string | null | undefined) {
    if (profile === "psychiatry") {
        return "Psiquiatria";
    }
    if (profile === "specialist") {
        return "Especialista";
    }
    return "Generalista";
}

export const PROFILE_RATES: Record<DoctorProfile, { weekday: number; weekend: number }> = {
    generalist: { weekday: 1244.87, weekend: 1381.10 },
    specialist: { weekday: 1329.66, weekend: 1457.15 },
    psychiatry: { weekday: 1299.82, weekend: 1411.47 },
};

export const PROFILE_RATE_CENTS: Record<DoctorProfile, { weekday: number; weekend: number }> = {
    generalist: { weekday: 124487, weekend: 138110 },
    specialist: { weekday: 132966, weekend: 145715 },
    psychiatry: { weekday: 129982, weekend: 141147 },
};

export function isPremiumDate(operationalDate: string) {
    return isPremiumRateDate(operationalDate);
}

export function resolveShiftAmount(shift: { operationalDate: string; paymentUnit: number }, profile: DoctorProfile, employmentType: DoctorEmploymentType = "pj") {
    return resolveShiftAmountCents(shift, profile, employmentType) / 100;
}

export function resolveShiftAmountCents(shift: { operationalDate: string; paymentUnit: number }, profile: DoctorProfile, employmentType: DoctorEmploymentType = "pj") {
    if (employmentType === "estatutario") {
        return 0;
    }
    const rateCents = isPremiumRateDate(shift.operationalDate) ? PROFILE_RATE_CENTS[profile].weekend : PROFILE_RATE_CENTS[profile].weekday;
    const unitMilli = Math.round(shift.paymentUnit * 1000);
    return Math.round((rateCents * unitMilli) / 1000);
}

export function resolveAmountCentsByDayKind(params: { profile: DoctorProfile; isWeekend: boolean; paymentUnit: number; employmentType?: DoctorEmploymentType }) {
    if (params.employmentType === "estatutario") {
        return 0;
    }
    const rateCents = params.isWeekend ? PROFILE_RATE_CENTS[params.profile].weekend : PROFILE_RATE_CENTS[params.profile].weekday;
    const unitMilli = Math.round(params.paymentUnit * 1000);
    return Math.round((rateCents * unitMilli) / 1000);
}

export function employmentTypeLabel(employmentType: string | null | undefined) {
    return employmentType === "estatutario" ? "Estatutário" : "PJ";
}

const TARGET_PRIORITY_NUMBERS = [1, 2, 3, 4, 5, 10, 20] as const;

function parseTargetPriority(code: string) {
    const match = code.match(/(\d{1,2})(?!.*\d)/);
    if (!match) {
        return Number.POSITIVE_INFINITY;
    }
    const value = Number(match[1]);
    if (!Number.isFinite(value)) {
        return Number.POSITIVE_INFINITY;
    }
    return value;
}

function targetCodeRank(code: string) {
    const numeric = parseTargetPriority(code);
    const priorityIndex = TARGET_PRIORITY_NUMBERS.findIndex((entry) => entry === numeric);
    return {
        priorityIndex: priorityIndex === -1 ? Number.POSITIVE_INFINITY : priorityIndex,
        numeric,
    };
}

export function targetComparator(
    left: { targetCode: string; targetLabel: string },
    right: { targetCode: string; targetLabel: string },
) {
    const leftRank = targetCodeRank(left.targetCode);
    const rightRank = targetCodeRank(right.targetCode);
    if (leftRank.priorityIndex !== rightRank.priorityIndex) {
        return leftRank.priorityIndex - rightRank.priorityIndex;
    }
    if (leftRank.numeric !== rightRank.numeric) {
        return leftRank.numeric - rightRank.numeric;
    }
    return left.targetCode.localeCompare(right.targetCode, "pt-BR") || left.targetLabel.localeCompare(right.targetLabel, "pt-BR");
}

export function normalize(value: string) {
    return value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .trim();
}

export function formatUnits(value: number | null | undefined) {
    const safeValue = Number.isFinite(value) ? Number(value) : 0;
    return Number.isInteger(safeValue) ? String(safeValue) : safeValue.toFixed(1).replace(".", ",");
}

export function cellAuditLink(monthKey: string, day: string, shift: "SD" | "SN") {
    return `/admin/payment-attestation/audit?date=${monthKey}-${day}&shift=${shift}`;
}

export const WEEKDAY_LABELS_PT = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"] as const;

export function formatOperationalDate(operationalDate: string) {
    const [year, month, day] = operationalDate.split("-");
    const reference = new Date(`${operationalDate}T12:00:00-03:00`);
    const weekday = WEEKDAY_LABELS_PT[reference.getUTCDay()];
    return { dayMonth: `${day}/${month}/${year.slice(2)}`, weekday };
}

export function weekdayShortLabel(operationalDate: string) {
    const reference = new Date(`${operationalDate}T12:00:00-03:00`);
    return WEEKDAY_LABELS_PT[reference.getUTCDay()];
}

export function resolveOperationalDateFromIso(iso: string) {
    const local = new Date(new Date(iso).getTime() + (-180 * 60000));
    const year = local.getUTCFullYear();
    const month = String(local.getUTCMonth() + 1).padStart(2, "0");
    const day = String(local.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

export function resolveSegmentShiftLabel(segment: { shiftLabel: "SD" | "SN" | "P" | null; startedAt: string }): "SD" | "SN" {
    if (segment.shiftLabel === "SD" || segment.shiftLabel === "SN") {
        return segment.shiftLabel;
    }
    const local = new Date(new Date(segment.startedAt).getTime() + (-180 * 60000));
    const hour = local.getUTCHours();
    return hour >= 19 || hour < 7 ? "SN" : "SD";
}

export function dayKindLabel(operationalDate: string) {
    if (isSamuHolidayDate(operationalDate)) return "Feriado";
    if (isStrictWeekendDate(operationalDate)) return "Fim de semana";
    return "Dia útil";
}

/** "2026-06" → "2026-05" / "2026-07". */
export function shiftMonthKey(monthKey: string, delta: number) {
    const [year, month] = monthKey.split("-").map(Number);
    const anchor = new Date(Date.UTC(year, (month - 1) + delta, 1));
    return `${anchor.getUTCFullYear()}-${String(anchor.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** "junho de 2026" → "Junho 2026" (rótulo curto da toolbar). */
export function compactMonthLabel(monthLabel: string) {
    const cleaned = monthLabel.replace(/\sde\s/, " ");
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}
