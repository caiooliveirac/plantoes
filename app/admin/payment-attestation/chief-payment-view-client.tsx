"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { AdminBarNavMenu } from "@/components/admin-bar-nav-menu";
import type { ChiefPayableBoardModel } from "@/modules/reporting/payable-shifts";
import { resolveBankHoursSettlementBalance } from "@/modules/reporting/bank-hours-settlement-rule";
import { isPremiumRateDate, isSamuHolidayDate, isWeekendDate as isStrictWeekendDate } from "@/modules/operational/holidays";

interface Props {
    board: ChiefPayableBoardModel;
    canManageClosing?: boolean;
    /** Encaminhamento da aba banco de horas: abre o modal deste médico no load. */
    initialDoctorId?: string | null;
}

interface FlashRecord {
    kind: "assign" | "disable";
    monthKey: string;
    day: string;
    shiftLabel: "SD" | "SN";
    domain: "regulation" | "intervention";
    targetCode: string;
    targetLabel: string;
    doctorName?: string;
    reason?: string;
    ts: number;
}

const FLASH_STORAGE_KEY = "payment-closing.lastApplied.v1";
const FLASH_TTL_MS = 10 * 60 * 1000;
const FILTERS_OPEN_STORAGE_KEY = "payment-closing.filtersOpen.v1";

type PaymentStatusFilter = "all" | "ready_for_payment" | "needs_review";
type ShiftFilter = "all" | "SD" | "SN";
type DomainFilter = "all" | "regulation" | "intervention";
type CoverageFilter = "all" | "half" | "full";
type SortMode = "name" | "total" | "pending" | "weekday" | "weekend";
type DoctorProfile = "generalist" | "specialist" | "psychiatry";
type DoctorEmploymentType = "pj" | "estatutario";
type EmploymentTypeFilter = "all" | DoctorEmploymentType;

const MONEY_FORMATTER = new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
});

function formatCurrency(value: number | null | undefined) {
    const safeValue = Number.isFinite(value) ? Number(value) : 0;
    return MONEY_FORMATTER.format(safeValue);
}

/** Minutos → "1 h 30" / "-45 min". Espelha formatMinutesForHumans do servidor. */
function formatMinutesAsHours(minutes: number | null | undefined) {
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
const BANK_HOURS_THRESHOLD_MINUTES = 12 * 60;

/** Como formatMinutesAsHours, mas com "+" explícito no saldo positivo. */
function formatSignedMinutesAsHours(minutes: number) {
    const formatted = formatMinutesAsHours(minutes);
    return minutes > 0 ? `+${formatted}` : formatted;
}

function paymentProfileLabel(profile: string | null | undefined) {
    if (profile === "psychiatry") {
        return "Psiquiatria";
    }

    if (profile === "specialist") {
        return "Especialista";
    }

    return "Generalista";
}

function paymentProfileBadge(profile: DoctorProfile) {
    if (profile === "specialist") {
        return "ESP";
    }

    if (profile === "psychiatry") {
        return "PSIQ";
    }

    return null;
}

const TARGET_PRIORITY_NUMBERS = [1, 2, 3, 4, 5, 10, 20] as const;

const PROFILE_RATES: Record<DoctorProfile, { weekday: number; weekend: number }> = {
    generalist: { weekday: 1244.87, weekend: 1381.10 },
    specialist: { weekday: 1329.66, weekend: 1457.15 },
    psychiatry: { weekday: 1299.82, weekend: 1411.47 },
};

const PROFILE_RATE_CENTS: Record<DoctorProfile, { weekday: number; weekend: number }> = {
    generalist: { weekday: 124487, weekend: 138110 },
    specialist: { weekday: 132966, weekend: 145715 },
    psychiatry: { weekday: 129982, weekend: 141147 },
};

function isWeekendDate(operationalDate: string) {
    return isPremiumRateDate(operationalDate);
}

function resolveShiftAmount(shift: { operationalDate: string; paymentUnit: number }, profile: DoctorProfile, employmentType: DoctorEmploymentType = "pj") {
    return resolveShiftAmountCents(shift, profile, employmentType) / 100;
}

function resolveShiftAmountCents(shift: { operationalDate: string; paymentUnit: number }, profile: DoctorProfile, employmentType: DoctorEmploymentType = "pj") {
    if (employmentType === "estatutario") {
        return 0;
    }
    const rateCents = isWeekendDate(shift.operationalDate) ? PROFILE_RATE_CENTS[profile].weekend : PROFILE_RATE_CENTS[profile].weekday;
    const unitMilli = Math.round(shift.paymentUnit * 1000);
    return Math.round((rateCents * unitMilli) / 1000);
}

function resolveAmountCentsByDayKind(params: { profile: DoctorProfile; isWeekend: boolean; paymentUnit: number; employmentType?: DoctorEmploymentType }) {
    if (params.employmentType === "estatutario") {
        return 0;
    }
    const rateCents = params.isWeekend ? PROFILE_RATE_CENTS[params.profile].weekend : PROFILE_RATE_CENTS[params.profile].weekday;
    const unitMilli = Math.round(params.paymentUnit * 1000);
    return Math.round((rateCents * unitMilli) / 1000);
}

function employmentTypeLabel(employmentType: string | null | undefined) {
    return employmentType === "estatutario" ? "Estatutário" : "PJ";
}

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

function targetComparator(
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

function normalize(value: string) {
    return value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .trim();
}

function formatUnits(value: number | null | undefined) {
    const safeValue = Number.isFinite(value) ? Number(value) : 0;
    return Number.isInteger(safeValue) ? String(safeValue) : safeValue.toFixed(1).replace(".", ",");
}

function cellAuditLink(monthKey: string, day: string, shift: "SD" | "SN") {
    return `/admin/payment-attestation/audit?date=${monthKey}-${day}&shift=${shift}`;
}

const WEEKDAY_LABELS_PT = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"] as const;

function formatOperationalDate(operationalDate: string) {
    const [year, month, day] = operationalDate.split("-");
    const reference = new Date(`${operationalDate}T12:00:00-03:00`);
    const weekday = WEEKDAY_LABELS_PT[reference.getUTCDay()];
    return { dayMonth: `${day}/${month}/${year.slice(2)}`, weekday };
}

function resolveOperationalDateFromIso(iso: string) {
    const local = new Date(new Date(iso).getTime() + (-180 * 60000));
    const year = local.getUTCFullYear();
    const month = String(local.getUTCMonth() + 1).padStart(2, "0");
    const day = String(local.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function resolveSegmentShiftLabel(segment: { shiftLabel: "SD" | "SN" | "P" | null; startedAt: string }): "SD" | "SN" {
    if (segment.shiftLabel === "SD" || segment.shiftLabel === "SN") {
        return segment.shiftLabel;
    }

    const local = new Date(new Date(segment.startedAt).getTime() + (-180 * 60000));
    const hour = local.getUTCHours();
    return hour >= 19 || hour < 7 ? "SN" : "SD";
}

function dayKindLabel(operationalDate: string) {
    if (isSamuHolidayDate(operationalDate)) return "Feriado";
    if (isStrictWeekendDate(operationalDate)) return "Fim de semana";
    return "Dia útil";
}

function dayKindClassName(operationalDate: string) {
    if (isSamuHolidayDate(operationalDate)) return "holiday";
    if (isStrictWeekendDate(operationalDate)) return "weekend";
    return "weekday";
}

export function ChiefPaymentViewClient({ board, canManageClosing = true, initialDoctorId = null }: Props) {
    const router = useRouter();
    const [, startRefreshTransition] = useTransition();
    const requestRouterRefresh = useCallback(() => {
        startRefreshTransition(() => { router.refresh(); });
    }, [router]);
    const [search, setSearch] = useState("");
    const [targetSearch, setTargetSearch] = useState("");
    const [status, setStatus] = useState<PaymentStatusFilter>("all");
    const [employmentTypeFilter, setEmploymentTypeFilter] = useState<EmploymentTypeFilter>("all");
    const [shiftFilter, setShiftFilter] = useState<ShiftFilter>("all");
    const [domainFilter, setDomainFilter] = useState<DomainFilter>("all");
    const [coverageFilter, setCoverageFilter] = useState<CoverageFilter>("all");
    const [targetFilter, setTargetFilter] = useState("all");
    const [sortMode, setSortMode] = useState<SortMode>("name");
    const [flash, setFlash] = useState<FlashRecord | null>(null);
    const [highlightKey, setHighlightKey] = useState<string | null>(null);
    const tableShellRef = useRef<HTMLDivElement | null>(null);
    // Gaveta de filtros da faixa de comando (design 2A): fechada por padrão,
    // lembra a última escolha do admin neste navegador.
    const [filtersOpen, setFiltersOpen] = useState(false);
    useEffect(() => {
        try {
            if (window.localStorage.getItem(FILTERS_OPEN_STORAGE_KEY) === "1") {
                setFiltersOpen(true);
            }
        } catch {}
    }, []);
    const toggleFiltersOpen = useCallback(() => {
        setFiltersOpen((prev) => {
            const next = !prev;
            try {
                window.localStorage.setItem(FILTERS_OPEN_STORAGE_KEY, next ? "1" : "0");
            } catch {}
            return next;
        });
    }, []);
    // Alvo do botão "sem médico" da faixa: rola até a linha correspondente da tabela.
    const uncoveredRowRef = useRef<HTMLTableRowElement | null>(null);
    // Painel por dia das linhas Desativadas / Sem médico: os chips individuais
    // saíram das células (alargavam todas as colunas) e viraram esta lista.
    const [dayTargetsPanel, setDayTargetsPanel] = useState<{ day: string; kind: "disabled" | "uncovered" } | null>(null);
    const [manualDraft, setManualDraft] = useState<{
        domain: "regulation" | "intervention";
        targetCode: string;
        targetLabel: string;
        day: string;
        shiftLabel: "SD" | "SN";
        sourceType: "disabled" | "uncovered";
        reason: string | null;
    } | null>(null);
    const [manualDoctorName, setManualDoctorName] = useState("");
    const [manualDisableReason, setManualDisableReason] = useState("");
    const [manualMode, setManualMode] = useState<"assign" | "disable">("assign");
    const [manualBusy, setManualBusy] = useState(false);
    const [manualError, setManualError] = useState<string | null>(null);
    const [manualFeedback, setManualFeedback] = useState<string | null>(null);
    const [profileBusyDoctorId, setProfileBusyDoctorId] = useState<string | null>(null);
    const [doctorProfileOverrides, setDoctorProfileOverrides] = useState<Record<string, DoctorProfile>>({});
    const [employmentTypeBusyDoctorId, setEmploymentTypeBusyDoctorId] = useState<string | null>(null);
    const [doctorEmploymentTypeOverrides, setDoctorEmploymentTypeOverrides] = useState<Record<string, DoctorEmploymentType>>({});
    // Última NF/processo confirmados pelo servidor por médico — evita depender só do
    // router.refresh() (assíncrono) para o modal mostrar o valor recém-salvo ao reabrir.
    const [doctorMetaOverrides, setDoctorMetaOverrides] = useState<Record<string, { invoiceNumber: string | null; paymentProcessNumber: string | null }>>({});
    const [selectedDoctorId, setSelectedDoctorId] = useState<string | null>(initialDoctorId);
    // Encaminhamento vindo do banco de horas: garante que o filtro não esconda o
    // médico alvo quando o modal abre por deep-link (?doctor=...).
    useEffect(() => {
        if (initialDoctorId) {
            setStatus("all");
            setSelectedDoctorId(initialDoctorId);
        }
    }, [initialDoctorId]);
    // Espelha selectedDoctorId para leitura em callbacks assíncronos (ex.: resposta de
    // save chegando depois que o admin já trocou/fechou o modal do médico).
    const selectedDoctorIdRef = useRef<string | null>(null);
    useEffect(() => {
        selectedDoctorIdRef.current = selectedDoctorId;
    }, [selectedDoctorId]);
    const [shiftActionDraft, setShiftActionDraft] = useState<{
        payableShiftId: string;
        occupancyId: string;
        domain: "regulation" | "intervention";
        targetCode: string;
        targetLabel: string;
        day: string;
        shiftLabel: "SD" | "SN";
        doctorName: string;
        source: string | null;
    } | null>(null);
    const [pendingRemovals, setPendingRemovals] = useState<Set<string>>(new Set());
    const [shiftActionBusy, setShiftActionBusy] = useState(false);
    const [shiftActionError, setShiftActionError] = useState<string | null>(null);
    // Formulário "adicionar plantão extra" dentro do modal do médico.
    const [extraDay, setExtraDay] = useState("");
    const [extraShift, setExtraShift] = useState<"SD" | "SN">("SD");
    const [extraCoverage, setExtraCoverage] = useState<"full" | "half">("full");
    const [extraLabel, setExtraLabel] = useState("");
    const [extraBusy, setExtraBusy] = useState(false);
    const [extraError, setExtraError] = useState<string | null>(null);
    const [extraFeedback, setExtraFeedback] = useState<string | null>(null);
    // Acompanhamento financeiro do modal: nota fiscal, processo, contrato, banco.
    const [invoiceDraft, setInvoiceDraft] = useState("");
    const [processDraft, setProcessDraft] = useState("");
    const [metaBusy, setMetaBusy] = useState(false);
    const [metaError, setMetaError] = useState<string | null>(null);
    const [metaFeedback, setMetaFeedback] = useState<string | null>(null);
    const [contractDraft, setContractDraft] = useState("");
    const [contractBusy, setContractBusy] = useState(false);
    const [contractError, setContractError] = useState<string | null>(null);
    const [bankBusy, setBankBusy] = useState(false);
    const [bankError, setBankError] = useState<string | null>(null);
    // Limpa o formulário de plantão extra ao trocar de médico / fechar o modal.
    useEffect(() => {
        setExtraDay("");
        setExtraShift("SD");
        setExtraCoverage("full");
        setExtraLabel("");
        setExtraError(null);
        setExtraFeedback(null);
        setAttestError(null);
        // Semeia NF/processo a partir do que já está gravado para este médico. Prioriza
        // o override confirmado pelo servidor (última resposta de save) sobre o prop
        // `board`, que pode estar desatualizado se o router.refresh() ainda não voltou.
        const baseDoctor = board.doctors.find((doctor) => doctor.doctorId === selectedDoctorId);
        const metaOverride = selectedDoctorId ? doctorMetaOverrides[selectedDoctorId] : undefined;
        setInvoiceDraft(metaOverride?.invoiceNumber ?? baseDoctor?.invoiceNumber ?? "");
        setProcessDraft(metaOverride?.paymentProcessNumber ?? baseDoctor?.paymentProcessNumber ?? "");
        setContractDraft("");
        setMetaError(null);
        setMetaFeedback(null);
        setContractError(null);
        setBankError(null);
        // Semeado só ao (re)abrir o modal de um médico — não a cada refresh do board,
        // para não apagar o feedback de "salvos" nem o que o admin está digitando.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedDoctorId]);
    // Atestação: "já conferi e assinei a produtividade deste médico no mês".
    const [attestationOverrides, setAttestationOverrides] = useState<Record<string, boolean>>({});
    const [attestBusyDoctorId, setAttestBusyDoctorId] = useState<string | null>(null);
    const [attestError, setAttestError] = useState<string | null>(null);
    // Quando o board chega atualizado, descarta os estados otimistas de atestação.
    useEffect(() => {
        setAttestationOverrides({});
    }, [board]);
    const normalized = normalize(search);
    const normalizedTarget = normalize(targetSearch);
    // Quantos filtros diferem do padrão — badge do botão "Filtros" da faixa.
    const activeFilterCount = [
        status !== "all",
        employmentTypeFilter !== "all",
        shiftFilter !== "all",
        domainFilter !== "all",
        coverageFilter !== "all",
        targetFilter !== "all",
        normalizedTarget.length > 0,
    ].filter(Boolean).length;

    const targetPills = useMemo(() => {
        const filtered = board.targetOptions.filter((target) => {
            if (domainFilter !== "all" && target.domain !== domainFilter) {
                return false;
            }

            if (!normalizedTarget) {
                return true;
            }

            const haystack = normalize([target.targetCode, target.targetLabel].join(" "));
            return haystack.includes(normalizedTarget);
        });

        return filtered;
    }, [board.targetOptions, domainFilter, normalizedTarget]);

    const targetSectors = useMemo(() => {
        const base = targetPills
            .map((target) => ({
                ...target,
                isUsa: normalize(`${target.targetCode} ${target.targetLabel}`).includes("usa"),
            }))
            .sort(targetComparator);

        const usa = base.filter((target) => target.isUsa);
        const regulation = base.filter((target) => target.domain === "regulation" && !target.isUsa);
        const intervention = base.filter((target) => target.domain === "intervention" && !target.isUsa);

        return [
            { key: "usa", title: "USA", tone: "usa", targets: usa },
            { key: "regulation", title: "Regulação", tone: "regulation", targets: regulation },
            { key: "intervention", title: "Intervenção", tone: "intervention", targets: intervention },
        ].filter((sector) => sector.targets.length > 0);
    }, [targetPills]);

    const filterSummary = useMemo(() => {
        const visiblePayableShifts = board.payableShifts.filter((shift) => !pendingRemovals.has(shift.payableShiftId));
        const readyDoctors = board.doctors.filter((doctor) => doctor.paymentStatus === "ready_for_payment").length;
        const reviewDoctors = board.doctors.length - readyDoctors;
        const sdCount = visiblePayableShifts
            .filter((shift) => shift.shiftLabel === "SD")
            .reduce((sum, shift) => sum + shift.paymentUnit, 0);
        const snCount = visiblePayableShifts
            .filter((shift) => shift.shiftLabel === "SN")
            .reduce((sum, shift) => sum + shift.paymentUnit, 0);
        const regulationCount = visiblePayableShifts.filter((shift) => shift.domain === "regulation").length;
        const interventionCount = visiblePayableShifts.filter((shift) => shift.domain === "intervention").length;
        const halfCount = visiblePayableShifts.filter((shift) => Boolean(shift.paymentTag)).length;
        const fullCount = visiblePayableShifts.length - halfCount;

        return {
            readyDoctors,
            reviewDoctors,
            sdCount,
            snCount,
            regulationCount,
            interventionCount,
            halfCount,
            fullCount,
        };
    }, [board.doctors, board.payableShifts, pendingRemovals]);

    const dayLoad = useMemo(() => {
        const counts = new Map<string, number>();
        for (const shift of board.payableShifts) {
            if (pendingRemovals.has(shift.payableShiftId)) {
                continue;
            }
            const day = shift.operationalDate.slice(8, 10);
            counts.set(day, (counts.get(day) ?? 0) + 1);
        }

        return board.days.map((day) => ({ day, count: counts.get(day) ?? 0 }));
    }, [board.days, board.payableShifts, pendingRemovals]);

    const dueAmountByEmploymentType = useMemo(() => {
        const totalsCents: Record<DoctorEmploymentType, number> = { pj: 0, estatutario: 0 };
        const doctorCounts: Record<DoctorEmploymentType, number> = { pj: 0, estatutario: 0 };

        for (const doctor of board.doctors) {
            const paymentProfile = doctorProfileOverrides[doctor.doctorId] ?? (doctor.paymentProfile ?? "generalist") as DoctorProfile;
            const employmentType = doctorEmploymentTypeOverrides[doctor.doctorId] ?? (doctor.employmentType ?? "pj") as DoctorEmploymentType;
            const doctorShifts = doctor.cells
                .flatMap((cell) => cell.shifts)
                .filter((shift) => !pendingRemovals.has(shift.payableShiftId));

            if (doctorShifts.length === 0) {
                continue;
            }

            doctorCounts[employmentType] += 1;

            const weekdayUnits = doctorShifts
                .filter((shift) => !isWeekendDate(shift.operationalDate))
                .reduce((doctorSum, shift) => doctorSum + shift.paymentUnit, 0);
            const weekendUnits = doctorShifts
                .filter((shift) => isWeekendDate(shift.operationalDate))
                .reduce((doctorSum, shift) => doctorSum + shift.paymentUnit, 0);
            const doctorDue = resolveAmountCentsByDayKind({
                profile: paymentProfile,
                isWeekend: false,
                paymentUnit: weekdayUnits,
                employmentType,
            }) + resolveAmountCentsByDayKind({
                profile: paymentProfile,
                isWeekend: true,
                paymentUnit: weekendUnits,
                employmentType,
            });
            totalsCents[employmentType] += doctorDue;
        }

        return {
            pj: { totalDue: totalsCents.pj / 100, doctorCount: doctorCounts.pj },
            estatutario: { totalDue: totalsCents.estatutario / 100, doctorCount: doctorCounts.estatutario },
        };
    }, [board.doctors, doctorProfileOverrides, doctorEmploymentTypeOverrides, pendingRemovals]);

    const visibleDisabledTargets = useMemo(() => board.disabledTargets.filter((item) => {
        if (shiftFilter !== "all" && item.shiftLabel !== shiftFilter) {
            return false;
        }

        if (domainFilter !== "all" && item.domain !== domainFilter) {
            return false;
        }

        if (targetFilter !== "all") {
            const [targetDomain, targetCode] = targetFilter.split("|");
            if (item.domain !== targetDomain || item.targetCode !== targetCode) {
                return false;
            }
        }

        if (!normalizedTarget) {
            return true;
        }

        const haystack = normalize([item.targetCode, item.targetLabel, item.disabledReason ?? ""].join(" "));
        return haystack.includes(normalizedTarget);
    }), [board.disabledTargets, domainFilter, normalizedTarget, shiftFilter, targetFilter]);

    const disabledByDay = useMemo(() => {
        const map = new Map<string, typeof visibleDisabledTargets>();
        for (const item of visibleDisabledTargets) {
            const key = item.day;
            const bucket = map.get(key) ?? [];
            bucket.push(item);
            map.set(key, bucket);
        }

        return map;
    }, [visibleDisabledTargets]);

    const visibleUncoveredTargets = useMemo(() => board.uncoveredTargets.filter((item) => {
        if (shiftFilter !== "all" && item.shiftLabel !== shiftFilter) {
            return false;
        }

        if (domainFilter !== "all" && item.domain !== domainFilter) {
            return false;
        }

        if (targetFilter !== "all") {
            const [targetDomain, targetCode] = targetFilter.split("|");
            if (item.domain !== targetDomain || item.targetCode !== targetCode) {
                return false;
            }
        }

        if (!normalizedTarget) {
            return true;
        }

        const haystack = normalize([item.targetCode, item.targetLabel, item.reason ?? ""].join(" "));
        return haystack.includes(normalizedTarget);
    }), [board.uncoveredTargets, domainFilter, normalizedTarget, shiftFilter, targetFilter]);

    const uncoveredByDay = useMemo(() => {
        const map = new Map<string, typeof visibleUncoveredTargets>();
        for (const item of visibleUncoveredTargets) {
            const key = item.day;
            const bucket = map.get(key) ?? [];
            bucket.push(item);
            map.set(key, bucket);
        }

        return map;
    }, [visibleUncoveredTargets]);

    const peakDay = useMemo(() => {
        if (dayLoad.length === 0) {
            return null;
        }

        return [...dayLoad].sort((left, right) => right.count - left.count)[0] ?? null;
    }, [dayLoad]);

    const maxDayLoad = useMemo(() => Math.max(...dayLoad.map((entry) => entry.count), 1), [dayLoad]);

    const filteredDoctors = useMemo(() => {
        const doctors = board.doctors
            .map((doctor) => {
                const nextCells = doctor.cells.map((cell) => ({
                    ...cell,
                    shifts: cell.shifts.filter((shift) => {
                        if (shiftFilter !== "all" && shift.shiftLabel !== shiftFilter) {
                            return false;
                        }

                        if (domainFilter !== "all" && shift.domain !== domainFilter) {
                            return false;
                        }

                        if (coverageFilter === "half" && !shift.paymentTag) {
                            return false;
                        }

                        if (coverageFilter === "full" && shift.paymentTag) {
                            return false;
                        }

                        if (targetFilter !== "all") {
                            const [targetDomain, targetCode] = targetFilter.split("|");
                            if (shift.domain !== targetDomain || shift.targetCode !== targetCode) {
                                return false;
                            }
                        }

                        if (!normalizedTarget) {
                            return true;
                        }

                        const targetHaystack = normalize([shift.targetCode, shift.targetLabel, shift.tagCode, shift.paymentTag ?? ""].join(" "));
                        return targetHaystack.includes(normalizedTarget);
                    }),
                }));

                const visibleShifts = nextCells.flatMap((cell) => cell.shifts);
                const effectiveVisibleShifts = visibleShifts.filter((shift) => !pendingRemovals.has(shift.payableShiftId));
                const totalSD = Number(visibleShifts
                    .filter((shift) => !pendingRemovals.has(shift.payableShiftId) && shift.shiftLabel === "SD")
                    .reduce((sum, shift) => sum + shift.paymentUnit, 0)
                    .toFixed(2));
                const totalSN = Number(visibleShifts
                    .filter((shift) => !pendingRemovals.has(shift.payableShiftId) && shift.shiftLabel === "SN")
                    .reduce((sum, shift) => sum + shift.paymentUnit, 0)
                    .toFixed(2));
                const total = Number(effectiveVisibleShifts.reduce((sum, shift) => sum + shift.paymentUnit, 0).toFixed(2));
                const paymentProfile = doctorProfileOverrides[doctor.doctorId] ?? (doctor.paymentProfile ?? "generalist") as DoctorProfile;
                const employmentType = doctorEmploymentTypeOverrides[doctor.doctorId] ?? (doctor.employmentType ?? "pj") as DoctorEmploymentType;
                const totalSDDueCents = effectiveVisibleShifts
                    .filter((shift) => shift.shiftLabel === "SD")
                    .reduce((sum, shift) => sum + resolveShiftAmountCents(shift, paymentProfile, employmentType), 0);
                const totalSNDueCents = effectiveVisibleShifts
                    .filter((shift) => shift.shiftLabel === "SN")
                    .reduce((sum, shift) => sum + resolveShiftAmountCents(shift, paymentProfile, employmentType), 0);
                // Conta em UNIDADES de plantão: meio plantão vale 0,5 (não 1).
                const weekdayShiftCount = Number(effectiveVisibleShifts
                    .filter((shift) => !isWeekendDate(shift.operationalDate))
                    .reduce((sum, shift) => sum + shift.paymentUnit, 0)
                    .toFixed(2));
                const weekendShiftCount = Number(effectiveVisibleShifts
                    .filter((shift) => isWeekendDate(shift.operationalDate))
                    .reduce((sum, shift) => sum + shift.paymentUnit, 0)
                    .toFixed(2));
                const weekdayDueCents = resolveAmountCentsByDayKind({
                    profile: paymentProfile,
                    isWeekend: false,
                    paymentUnit: weekdayShiftCount,
                    employmentType,
                });
                const weekendDueCents = resolveAmountCentsByDayKind({
                    profile: paymentProfile,
                    isWeekend: true,
                    paymentUnit: weekendShiftCount,
                    employmentType,
                });
                const totalDueCents = weekdayDueCents + weekendDueCents;
                const pendingCount = effectiveVisibleShifts.filter((shift) => shift.paymentStatus === "needs_review").length;
                const metaOverride = doctorMetaOverrides[doctor.doctorId];

                return {
                    ...doctor,
                    cells: nextCells,
                    employmentType,
                    totalSD,
                    totalSN,
                    total,
                    totalSDDue: totalSDDueCents / 100,
                    totalSNDue: totalSNDueCents / 100,
                    totalDue: totalDueCents / 100,
                    weekdayShiftCount,
                    weekendShiftCount,
                    weekdayDue: weekdayDueCents / 100,
                    weekendDue: weekendDueCents / 100,
                    pendingCount,
                    invoiceNumber: metaOverride?.invoiceNumber ?? doctor.invoiceNumber,
                    paymentProcessNumber: metaOverride?.paymentProcessNumber ?? doctor.paymentProcessNumber,
                };
            })
            .filter((doctor) => {
                if (status !== "all" && doctor.paymentStatus !== status) {
                    return false;
                }

                if (employmentTypeFilter !== "all" && doctor.employmentType !== employmentTypeFilter) {
                    return false;
                }

                if (normalized) {
                    const haystack = normalize([doctor.doctorName, doctor.displayName ?? ""].join(" "));
                    if (!haystack.includes(normalized)) {
                        return false;
                    }
                }

                return doctor.total > 0;
            });

        const sorted = [...doctors].sort((left, right) => {
            if (sortMode === "name") {
                return left.doctorName.localeCompare(right.doctorName, "pt-BR");
            }

            if (sortMode === "total") {
                return right.total - left.total || left.doctorName.localeCompare(right.doctorName, "pt-BR");
            }

            if (sortMode === "weekday") {
                return right.weekdayShiftCount - left.weekdayShiftCount || left.doctorName.localeCompare(right.doctorName, "pt-BR");
            }

            if (sortMode === "weekend") {
                return right.weekendShiftCount - left.weekendShiftCount || left.doctorName.localeCompare(right.doctorName, "pt-BR");
            }

            return right.pendingCount - left.pendingCount || right.total - left.total || left.doctorName.localeCompare(right.doctorName, "pt-BR");
        });

        return sorted;
    }, [board.doctors, coverageFilter, doctorProfileOverrides, doctorEmploymentTypeOverrides, doctorMetaOverrides, domainFilter, employmentTypeFilter, normalized, normalizedTarget, pendingRemovals, shiftFilter, sortMode, status, targetFilter]);

    useEffect(() => {
        // Reconcile optimistic removals with server truth: if a payableShiftId
        // is no longer present in the refreshed board, drop it from the set.
        setPendingRemovals((prev) => {
            if (prev.size === 0) return prev;
            const present = new Set<string>();
            for (const doctor of board.doctors) {
                for (const cell of doctor.cells) {
                    for (const shift of cell.shifts) {
                        present.add(shift.payableShiftId);
                    }
                }
            }
            const next = new Set<string>();
            for (const id of prev) {
                if (present.has(id)) next.add(id);
            }
            return next.size === prev.size ? prev : next;
        });
    }, [board]);

    useEffect(() => {
        if (typeof window === "undefined") return;
        try {
            const raw = window.sessionStorage.getItem(FLASH_STORAGE_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw) as FlashRecord;
            if (Date.now() - parsed.ts > FLASH_TTL_MS) {
                window.sessionStorage.removeItem(FLASH_STORAGE_KEY);
                return;
            }
            if (parsed.monthKey !== board.monthKey) return;
            setFlash(parsed);
        } catch {
            window.sessionStorage.removeItem(FLASH_STORAGE_KEY);
        }
    }, [board.monthKey]);

    const persistFlash = useCallback((record: FlashRecord) => {
        if (typeof window === "undefined") return;
        try {
            window.sessionStorage.setItem(FLASH_STORAGE_KEY, JSON.stringify(record));
        } catch {}
        setFlash(record);
    }, []);

    const dismissFlash = useCallback(() => {
        if (typeof window !== "undefined") {
            window.sessionStorage.removeItem(FLASH_STORAGE_KEY);
        }
        setFlash(null);
        setHighlightKey(null);
    }, []);

    const locateFlashCell = useCallback(() => {
        if (!flash) return false;
        setStatus("all");
        setShiftFilter("all");
        setDomainFilter("all");
        setCoverageFilter("all");
        setTargetFilter("all");
        setSearch("");
        setTargetSearch("");
        // Chips de desativação agora vivem no painel do dia — abre ele para o
        // flash ter onde pousar (o chip com data-flash-key renderiza lá dentro).
        if (flash.kind === "disable") {
            setDayTargetsPanel({ day: flash.day, kind: "disabled" });
        }

        const selector = `[data-flash-key="${flash.kind}|${flash.domain}|${flash.targetCode}|${flash.day}|${flash.shiftLabel}"]`;
        let attempts = 0;
        const tryLocate = () => {
            const root = flash.kind === "disable" ? document : (tableShellRef.current ?? document);
            const el = root.querySelector<HTMLElement>(selector);
            if (el) {
                el.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
                setHighlightKey(`${flash.domain}|${flash.targetCode}|${flash.day}|${flash.shiftLabel}|${flash.kind}`);
                window.setTimeout(() => setHighlightKey(null), 4500);
                return true;
            }
            return false;
        };
        const schedule = () => {
            if (tryLocate()) return;
            attempts += 1;
            if (attempts < 8) {
                window.setTimeout(schedule, 120);
            }
        };
        requestAnimationFrame(schedule);
        return true;
    }, [flash]);

    const autoLocatedFlashRef = useRef<string | null>(null);
    useEffect(() => {
        if (!flash) {
            autoLocatedFlashRef.current = null;
            return;
        }
        const flashId = `${flash.ts}|${flash.kind}|${flash.domain}|${flash.targetCode}|${flash.day}|${flash.shiftLabel}`;
        if (autoLocatedFlashRef.current === flashId) return;
        if (Date.now() - flash.ts > 8000) return;
        autoLocatedFlashRef.current = flashId;
        const timer = window.setTimeout(() => locateFlashCell(), 160);
        return () => window.clearTimeout(timer);
    }, [flash, locateFlashCell]);

    async function submitManualCorrection() {
        if (!manualDraft) {
            return;
        }

        const trimmedDoctor = manualDoctorName.trim();
        if (trimmedDoctor.length < 3) {
            setManualError("Informe ao menos 3 caracteres no nome do médico.");
            return;
        }

        const selectedDoctor = board.allDoctorNames.find((name) => normalize(name) === normalize(trimmedDoctor));
        if (!selectedDoctor) {
            setManualError("Selecione um médico válido na lista de sugestões.");
            return;
        }

        setManualBusy(true);
        setManualError(null);
        setManualFeedback(null);

        try {
            const date = `${board.monthKey}-${manualDraft.day}`;
            const response = await fetch("/api/admin/payment-attestation/slot", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    action: "manual_assign",
                    date,
                    shift: manualDraft.shiftLabel,
                    domain: manualDraft.domain,
                    targetCode: manualDraft.targetCode,
                    doctorName: selectedDoctor,
                }),
            });

            const body = await response.json().catch(() => null) as { error?: string } | null;
            if (!response.ok) {
                throw new Error(body?.error ?? "Não foi possível aplicar a correção manual.");
            }

            persistFlash({
                kind: "assign",
                monthKey: board.monthKey,
                day: manualDraft.day,
                shiftLabel: manualDraft.shiftLabel,
                domain: manualDraft.domain,
                targetCode: manualDraft.targetCode,
                targetLabel: manualDraft.targetLabel,
                doctorName: selectedDoctor,
                ts: Date.now(),
            });
            setManualFeedback(`Salvo: ${manualDraft.targetCode} ${manualDraft.shiftLabel} dia ${manualDraft.day} → ${selectedDoctor}.`);
            setManualDraft(null);
            setManualDoctorName("");
            // O novo plantao vira "ready_for_payment". Se o usuario filtrou por
            // "Pendencias", a linha do medico atribuido seria invisivel apos o
            // refresh — impossivel de confirmar visualmente. Resetamos o filtro
            // de status para "all" para garantir que a atribuicao apareca.
            if (status === "needs_review") {
                setStatus("all");
            }
            requestRouterRefresh();
        } catch (error) {
            setManualError(error instanceof Error ? error.message : "Falha ao salvar correção manual.");
        } finally {
            setManualBusy(false);
        }
    }

    async function submitManualDisable() {
        if (!manualDraft) {
            return;
        }

        const trimmedReason = manualDisableReason.trim();
        if (trimmedReason.length < 3) {
            setManualError("Informe o motivo da desativação (mínimo 3 caracteres).");
            return;
        }

        setManualBusy(true);
        setManualError(null);
        setManualFeedback(null);

        try {
            const date = `${board.monthKey}-${manualDraft.day}`;
            const response = await fetch("/api/admin/payment-attestation/slot", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    action: "manual_disable",
                    date,
                    shift: manualDraft.shiftLabel,
                    domain: manualDraft.domain,
                    targetCode: manualDraft.targetCode,
                    disabledReason: trimmedReason,
                }),
            });

            const body = await response.json().catch(() => null) as { error?: string } | null;
            if (!response.ok) {
                throw new Error(body?.error ?? "Não foi possível aplicar a desativação manual.");
            }

            persistFlash({
                kind: "disable",
                monthKey: board.monthKey,
                day: manualDraft.day,
                shiftLabel: manualDraft.shiftLabel,
                domain: manualDraft.domain,
                targetCode: manualDraft.targetCode,
                targetLabel: manualDraft.targetLabel,
                reason: trimmedReason,
                ts: Date.now(),
            });
            setManualFeedback(`Desativada: ${manualDraft.targetCode} ${manualDraft.shiftLabel} dia ${manualDraft.day}.`);
            setManualDraft(null);
            setManualDisableReason("");
            requestRouterRefresh();
        } catch (error) {
            setManualError(error instanceof Error ? error.message : "Falha ao salvar desativação manual.");
        } finally {
            setManualBusy(false);
        }
    }

    async function submitShiftRemoval() {
        if (!shiftActionDraft) return;
        const draft = shiftActionDraft;
        setShiftActionBusy(true);
        setShiftActionError(null);

        // Optimistic: hide the cell immediately
        const relatedPayableShiftIds = new Set<string>([draft.payableShiftId]);
        if (!draft.occupancyId.startsWith("extra:")) {
            for (const doctor of board.doctors) {
                for (const cell of doctor.cells) {
                    for (const shift of cell.shifts) {
                        if (shift.occupancyId === draft.occupancyId) {
                            relatedPayableShiftIds.add(shift.payableShiftId);
                        }
                    }
                }
            }
        }
        setPendingRemovals((prev) => {
            const next = new Set(prev);
            for (const id of relatedPayableShiftIds) {
                next.add(id);
            }
            return next;
        });

        const isExtra = draft.source === "admin_extra";

        try {
            const response = isExtra
                ? await fetch("/api/admin/payment-closing/extra-shift", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        action: "remove",
                        id: draft.occupancyId.replace(/^extra:/, ""),
                    }),
                })
                : await fetch("/api/admin/payment-attestation/slot", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        action: "manual_remove",
                        date: `${board.monthKey}-${draft.day}`,
                        shift: draft.shiftLabel,
                        domain: draft.domain,
                        targetCode: draft.targetCode,
                        occupancyId: draft.occupancyId,
                    }),
                });
            const body = await response.json().catch(() => null) as { error?: string } | null;
            if (!response.ok) {
                throw new Error(body?.error ?? "Não foi possível remover o plantão.");
            }

            if (isExtra) {
                setManualFeedback(`Plantão extra removido: dia ${draft.day} ${draft.shiftLabel} (${draft.doctorName}).`);
                setShiftActionDraft(null);
                requestRouterRefresh();
                return;
            }

            persistFlash({
                kind: "disable",
                monthKey: board.monthKey,
                day: draft.day,
                shiftLabel: draft.shiftLabel,
                domain: draft.domain,
                targetCode: draft.targetCode,
                targetLabel: draft.targetLabel,
                reason: `Plantão de ${draft.doctorName} removido`,
                ts: Date.now(),
            });
            setManualFeedback(`Removido: ${draft.targetCode} ${draft.shiftLabel} dia ${draft.day} (${draft.doctorName}).`);
            setShiftActionDraft(null);
            requestRouterRefresh();
        } catch (error) {
            // Rollback optimistic
            setPendingRemovals((prev) => {
                const next = new Set(prev);
                for (const id of relatedPayableShiftIds) {
                    next.delete(id);
                }
                return next;
            });
            setShiftActionError(error instanceof Error ? error.message : "Falha ao remover plantão.");
        } finally {
            setShiftActionBusy(false);
        }
    }

    async function submitAddExtraShift(doctorId: string, doctorName: string) {
        const day = extraDay.trim();
        if (!/^\d{2}$/.test(day)) {
            setExtraError("Selecione o dia do plantão extra.");
            return;
        }

        const label = extraLabel.trim();
        if (label.length < 2) {
            setExtraError("Descreva o plantão extra com pelo menos 2 caracteres (assim você não perde o controle).");
            return;
        }

        setExtraBusy(true);
        setExtraError(null);
        setExtraFeedback(null);

        try {
            const response = await fetch("/api/admin/payment-closing/extra-shift", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    action: "add",
                    doctorId,
                    date: `${board.monthKey}-${day}`,
                    shift: extraShift,
                    coverage: extraCoverage,
                    label,
                }),
            });
            const body = await response.json().catch(() => null) as { error?: string } | null;
            if (!response.ok) {
                throw new Error(body?.error ?? "Não foi possível adicionar o plantão extra.");
            }

            const coverageLabel = extraCoverage === "half" ? "meio plantão" : "plantão inteiro";
            setExtraFeedback(`Plantão extra adicionado: dia ${day} ${extraShift} (${coverageLabel}) → ${doctorName}.`);
            setExtraLabel("");
            // Se o filtro de status esconderia a linha, garante visibilidade.
            if (status === "needs_review") {
                setStatus("all");
            }
            requestRouterRefresh();
        } catch (error) {
            setExtraError(error instanceof Error ? error.message : "Falha ao adicionar plantão extra.");
        } finally {
            setExtraBusy(false);
        }
    }

    // NF/processo digitados diferem do que está gravado? (evita salvar à toa)
    function isMetaDirty(doctor: { invoiceNumber?: string | null; paymentProcessNumber?: string | null } | null) {
        if (!doctor) {
            return false;
        }
        return invoiceDraft.trim() !== (doctor.invoiceNumber ?? "")
            || processDraft.trim() !== (doctor.paymentProcessNumber ?? "");
    }

    // Auto-salva NF/processo ao sair do campo (blur) — inclui fechar o modal, pois
    // o blur dispara antes do clique de fechar. Assim o valor não se perde.
    function autoSavePaymentMeta(doctor: { doctorId: string; invoiceNumber?: string | null; paymentProcessNumber?: string | null }) {
        if (!metaBusy && isMetaDirty(doctor)) {
            void submitPaymentMeta(doctor.doctorId);
        }
    }

    async function submitPaymentMeta(doctorId: string) {
        setMetaBusy(true);
        setMetaError(null);
        setMetaFeedback(null);
        try {
            const response = await fetch("/api/admin/payment-closing/meta", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    doctorId,
                    monthKey: board.monthKey,
                    invoiceNumber: invoiceDraft.trim() || null,
                    paymentProcessNumber: processDraft.trim() || null,
                }),
            });
            const body = await response.json().catch(() => null) as {
                error?: string;
                meta?: { invoiceNumber: string | null; paymentProcessNumber: string | null };
            } | null;
            if (!response.ok) {
                throw new Error(body?.error ?? "Não foi possível salvar a nota fiscal / processo.");
            }
            // Fonte da verdade passa a ser a resposta do servidor, não o router.refresh()
            // (assíncrono) — evita o campo "voltar" ao valor antigo se o médico reabrir
            // o modal antes do refresh do board terminar.
            if (body?.meta) {
                setDoctorMetaOverrides((prev) => ({
                    ...prev,
                    [doctorId]: { invoiceNumber: body.meta!.invoiceNumber, paymentProcessNumber: body.meta!.paymentProcessNumber },
                }));
                // Só escreve nos campos visíveis se o modal ainda for deste médico —
                // senão uma resposta atrasada pisa no que já foi digitado para outro.
                if (selectedDoctorIdRef.current === doctorId) {
                    setInvoiceDraft(body.meta.invoiceNumber ?? "");
                    setProcessDraft(body.meta.paymentProcessNumber ?? "");
                    setMetaFeedback("Nota fiscal / processo salvos.");
                }
            }
            requestRouterRefresh();
        } catch (error) {
            setMetaError(error instanceof Error ? error.message : "Falha ao salvar.");
        } finally {
            setMetaBusy(false);
        }
    }

    async function submitContractSeed(doctorId: string) {
        const ceiling = Number(contractDraft);
        if (!Number.isFinite(ceiling) || ceiling <= 0) {
            setContractError("Informe um teto de contrato em reais maior que zero.");
            return;
        }
        setContractBusy(true);
        setContractError(null);
        try {
            const response = await fetch("/api/admin/payment-closing/contract", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ doctorId, ceilingBrl: ceiling, seedMonth: board.monthKey }),
            });
            const body = await response.json().catch(() => null) as { error?: string } | null;
            if (!response.ok) {
                throw new Error(body?.error ?? "Não foi possível salvar o contrato.");
            }
            requestRouterRefresh();
        } catch (error) {
            setContractError(error instanceof Error ? error.message : "Falha ao salvar o contrato.");
        } finally {
            setContractBusy(false);
        }
    }

    async function submitBankHoursSettlement(doctorId: string, kind: "bonus" | "penalty") {
        setBankBusy(true);
        setBankError(null);
        try {
            const response = await fetch("/api/admin/payment-closing/bank-hours-settlement", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ doctorId, monthKey: board.monthKey, kind }),
            });
            const body = await response.json().catch(() => null) as { error?: string } | null;
            if (!response.ok) {
                throw new Error(body?.error ?? "Não foi possível lançar o acerto do banco de horas.");
            }
            // O plantão verde/vermelho pode estar fora do filtro atual — garante visibilidade.
            if (status === "needs_review") {
                setStatus("all");
            }
            requestRouterRefresh();
        } catch (error) {
            setBankError(error instanceof Error ? error.message : "Falha ao lançar o acerto.");
        } finally {
            setBankBusy(false);
        }
    }

    function isDoctorAttested(target: { doctorId: string; attestedAt: string | null }) {
        const override = attestationOverrides[target.doctorId];
        return override !== undefined ? override : Boolean(target.attestedAt);
    }

    async function toggleDoctorAttestation(doctorId: string, attested: boolean) {
        setAttestBusyDoctorId(doctorId);
        setAttestError(null);
        setAttestationOverrides((prev) => ({ ...prev, [doctorId]: attested }));
        try {
            const response = await fetch("/api/admin/payment-closing/attestation", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ doctorId, monthKey: board.monthKey, attested }),
            });
            const body = await response.json().catch(() => null) as { error?: string } | null;
            if (!response.ok) {
                throw new Error(body?.error ?? "Não foi possível salvar a atestação.");
            }
            requestRouterRefresh();
        } catch (error) {
            setAttestationOverrides((prev) => ({ ...prev, [doctorId]: !attested }));
            setAttestError(error instanceof Error ? error.message : "Falha ao salvar atestação.");
        } finally {
            setAttestBusyDoctorId(null);
        }
    }

    async function toggleDoctorSpecialistProfile(doctorId: string, isSpecialist: boolean) {
        const baseDoctor = board.doctors.find((doctor) => doctor.doctorId === doctorId);
        const previousProfile = doctorProfileOverrides[doctorId] ?? ((baseDoctor?.paymentProfile ?? "generalist") as DoctorProfile);
        const nextProfile: DoctorProfile = isSpecialist ? "specialist" : "generalist";

        setProfileBusyDoctorId(doctorId);
        setManualError(null);
        setManualFeedback(null);
        setDoctorProfileOverrides((current) => ({
            ...current,
            [doctorId]: nextProfile,
        }));

        try {
            const response = await fetch("/api/admin/payment-attestation/slot", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    action: "set_doctor_payment_profile",
                    doctorId,
                    isSpecialist,
                }),
            });

            const body = await response.json().catch(() => null) as { error?: string } | null;
            if (!response.ok) {
                throw new Error(body?.error ?? "Não foi possível atualizar o perfil de pagamento do médico.");
            }

            setManualFeedback("Perfil de pagamento atualizado.");
        } catch (error) {
            setDoctorProfileOverrides((current) => ({
                ...current,
                [doctorId]: previousProfile,
            }));
            setManualError(error instanceof Error ? error.message : "Falha ao atualizar perfil de pagamento.");
        } finally {
            setProfileBusyDoctorId(null);
        }
    }

    async function toggleDoctorEmploymentType(doctorId: string, employmentType: DoctorEmploymentType) {
        const baseDoctor = board.doctors.find((doctor) => doctor.doctorId === doctorId);
        const previousType = doctorEmploymentTypeOverrides[doctorId] ?? ((baseDoctor?.employmentType ?? "pj") as DoctorEmploymentType);

        setEmploymentTypeBusyDoctorId(doctorId);
        setManualError(null);
        setManualFeedback(null);
        setDoctorEmploymentTypeOverrides((current) => ({
            ...current,
            [doctorId]: employmentType,
        }));

        try {
            const response = await fetch("/api/admin/payment-attestation/slot", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    action: "set_doctor_employment_type",
                    doctorId,
                    employmentType,
                }),
            });

            const body = await response.json().catch(() => null) as { error?: string } | null;
            if (!response.ok) {
                throw new Error(body?.error ?? "Não foi possível atualizar o vínculo do médico.");
            }

            setManualFeedback("Vínculo atualizado.");
        } catch (error) {
            setDoctorEmploymentTypeOverrides((current) => ({
                ...current,
                [doctorId]: previousType,
            }));
            setManualError(error instanceof Error ? error.message : "Falha ao atualizar vínculo.");
        } finally {
            setEmploymentTypeBusyDoctorId(null);
        }
    }

    const selectedDoctor = useMemo(
        () => filteredDoctors.find((doctor) => doctor.doctorId === selectedDoctorId) ?? null,
        [filteredDoctors, selectedDoctorId],
    );

    const allocationConflictShifts = useMemo(() => {
        const uniqueBySlot = new Map<string, typeof board.payableShifts[number]>();

        for (const shift of board.payableShifts
            .filter((shift) => shift.issues.some((issue) => issue === "Mais de um medico candidato no mesmo alvo/turno"))
            .slice()) {
            const key = [shift.operationalDate, shift.shiftLabel, shift.domain, shift.targetCode].join("|");
            if (!uniqueBySlot.has(key)) {
                uniqueBySlot.set(key, shift);
            }
        }

        return Array.from(uniqueBySlot.values())
            .sort((left, right) => {
                const byDate = left.operationalDate.localeCompare(right.operationalDate);
                if (byDate !== 0) return byDate;
                if (left.shiftLabel !== right.shiftLabel) return left.shiftLabel === "SD" ? -1 : 1;
                return left.targetCode.localeCompare(right.targetCode, "pt-BR");
            });
    }, [board.payableShifts]);

    const selectedDoctorDisplacedConflictSegments = useMemo(() => {
        if (!selectedDoctor) {
            return [] as Array<{
                segmentId: string;
                operationalDate: string;
                shiftLabel: "SD" | "SN";
                domain: "regulation" | "intervention";
                targetCode: string;
                targetLabel: string;
                chosenDoctorName: string;
            }>;
        }

        const conflictBySlot = new Map<string, typeof allocationConflictShifts[number]>();
        for (const shift of allocationConflictShifts) {
            const key = [shift.operationalDate, shift.shiftLabel, shift.domain, shift.targetCode].join("|");
            conflictBySlot.set(key, shift);
        }

        const matches = board.attestationSegments
            .filter((segment) => segment.doctorId === selectedDoctor.doctorId)
            .filter((segment) => segment.discardReason === "not_selected_for_payment")
            .map((segment) => {
                const operationalDate = resolveOperationalDateFromIso(segment.startedAt);
                const shiftLabel = resolveSegmentShiftLabel(segment);
                const key = [operationalDate, shiftLabel, segment.domain, segment.targetCode].join("|");
                const chosen = conflictBySlot.get(key);
                if (!chosen) {
                    return null;
                }

                return {
                    segmentId: segment.segmentId,
                    operationalDate,
                    shiftLabel,
                    domain: segment.domain,
                    targetCode: segment.targetCode,
                    targetLabel: segment.targetLabel,
                    chosenDoctorName: chosen.doctorName,
                };
            })
            .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

        const unique = new Map<string, (typeof matches)[number]>();
        for (const entry of matches) {
            const key = [entry.operationalDate, entry.shiftLabel, entry.domain, entry.targetCode].join("|");
            if (!unique.has(key)) {
                unique.set(key, entry);
            }
        }

        return Array.from(unique.values()).sort((left, right) => {
            const byDate = left.operationalDate.localeCompare(right.operationalDate);
            if (byDate !== 0) return byDate;
            if (left.shiftLabel !== right.shiftLabel) return left.shiftLabel === "SD" ? -1 : 1;
            if (left.domain !== right.domain) return left.domain === "regulation" ? -1 : 1;
            return left.targetCode.localeCompare(right.targetCode, "pt-BR");
        });
    }, [allocationConflictShifts, board.attestationSegments, selectedDoctor]);

    const selectedDoctorConflictCount = selectedDoctorDisplacedConflictSegments.length;

    return (
        <main className="chief-payable-shell">
            {/* Design 2A: faixa de comando única + gaveta de filtros + tabela num só container. */}
            <section className="admin-bar-frame">
            <header className="admin-bar">
                <select
                    className="admin-bar-month"
                    value={board.monthKey}
                    onChange={(event) => router.push(`/admin/payment-closing?month=${event.target.value}`)}
                    aria-label="Mês do fechamento"
                >
                    {board.presetMonths.map((preset) => (
                        <option key={preset.key} value={preset.key}>{preset.label}</option>
                    ))}
                </select>

                <input
                    type="search"
                    className="admin-bar-search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Filtrar médico"
                    aria-label="Filtrar médico"
                />

                <span className="admin-bar-divider" aria-hidden="true" />

                <div className="admin-bar-kpis">
                    <div className="admin-bar-kpi">
                        <strong>{formatUnits(board.summary.payableUnitCount)}</strong>
                        <span>unidades</span>
                    </div>
                    <div className="admin-bar-kpi">
                        <strong>{board.summary.readyCount}</strong>
                        <span>prontas</span>
                    </div>
                    <div className="admin-bar-kpi">
                        <strong>{board.summary.doctorCount}</strong>
                        <span>médicos</span>
                    </div>
                    <div
                        className="admin-bar-kpi"
                        title={`PJ · ${dueAmountByEmploymentType.pj.doctorCount} médicos. Estatutário (${dueAmountByEmploymentType.estatutario.doctorCount} médicos) não gera pagamento aqui.`}
                    >
                        <strong>{formatCurrency(dueAmountByEmploymentType.pj.totalDue)}</strong>
                        <span>devido pj</span>
                    </div>
                    <div className="admin-bar-kpi">
                        <strong>{visibleDisabledTargets.length}</strong>
                        <span>desativadas</span>
                    </div>
                    <button
                        type="button"
                        className={`admin-bar-kpi-button pending ${status === "needs_review" ? "active" : ""}`.trim()}
                        onClick={() => setStatus(status === "needs_review" ? "all" : "needs_review")}
                        title={status === "needs_review" ? "Filtro de pendências ativo — clique para limpar" : "Mostrar só médicos com pendências"}
                    >
                        <strong>{board.summary.needsReviewCount}</strong>
                        <span>pendências</span>
                        {status === "needs_review" ? <i aria-hidden="true">×</i> : null}
                    </button>
                    <button
                        type="button"
                        className="admin-bar-kpi-button uncovered"
                        onClick={() => uncoveredRowRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })}
                        title="Rolar até a linha Sem médico"
                    >
                        <strong>{visibleUncoveredTargets.length}</strong>
                        <span>sem médico</span>
                    </button>
                </div>

                <div className="admin-bar-actions">
                    {!canManageClosing ? (
                        <span
                            className="admin-bar-restricted"
                            title="Perfil restrito: você pode visualizar todo o fechamento e salvar somente NF/processo."
                        >
                            Perfil restrito
                        </span>
                    ) : null}
                    <button
                        type="button"
                        className={`admin-bar-filters-toggle ${filtersOpen ? "open" : ""}`.trim()}
                        onClick={toggleFiltersOpen}
                        aria-expanded={filtersOpen}
                    >
                        Filtros
                        {activeFilterCount > 0 ? <i className="admin-bar-filter-count">{activeFilterCount}</i> : null}
                        <span aria-hidden="true">{filtersOpen ? "▴" : "▾"}</span>
                    </button>
                    {canManageClosing ? (
                        <a className="reports-primary-link" href={`/api/admin/reports/export?month=${board.monthKey}`}>
                            Exportar XLSX
                        </a>
                    ) : null}
                    <AdminBarNavMenu current="payment-closing">
                        {canManageClosing ? (
                            <a className="admin-nav-menu-link" href="/admin/payment-attestation/audit" role="menuitem">
                                Abrir auditoria técnica
                            </a>
                        ) : null}
                    </AdminBarNavMenu>
                </div>
            </header>

            <AnimatePresence initial={false}>
                {filtersOpen ? (
                    <motion.div
                        key="filters-drawer"
                        className="admin-bar-drawer"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2, ease: "easeOut" }}
                    >
                        <div className="admin-bar-drawer-inner">
                            <div className="admin-bar-drawer-grid">
                                <div className="admin-bar-drawer-group">
                                    <span>Turno e domínio</span>
                                    <div className="chief-payable-chip-row">
                                        <button type="button" className={`chief-payable-chip ${shiftFilter === "all" ? "active" : ""}`.trim()} onClick={() => setShiftFilter("all")}>
                                            SD + SN ({board.summary.payableShiftCount})
                                        </button>
                                        <button type="button" className={`chief-payable-chip day ${shiftFilter === "SD" ? "active" : ""}`.trim()} onClick={() => setShiftFilter("SD")}>
                                            SD ({formatUnits(filterSummary.sdCount)})
                                        </button>
                                        <button type="button" className={`chief-payable-chip night ${shiftFilter === "SN" ? "active" : ""}`.trim()} onClick={() => setShiftFilter("SN")}>
                                            SN ({formatUnits(filterSummary.snCount)})
                                        </button>
                                        <button type="button" className={`chief-payable-chip ${domainFilter === "all" ? "active" : ""}`.trim()} onClick={() => setDomainFilter("all")}>
                                            Regulação + Intervenção
                                        </button>
                                        <button type="button" className={`chief-payable-chip ${domainFilter === "regulation" ? "active" : ""}`.trim()} onClick={() => setDomainFilter("regulation")}>
                                            Regulação ({filterSummary.regulationCount})
                                        </button>
                                        <button type="button" className={`chief-payable-chip ${domainFilter === "intervention" ? "active" : ""}`.trim()} onClick={() => setDomainFilter("intervention")}>
                                            Intervenção ({filterSummary.interventionCount})
                                        </button>
                                    </div>
                                </div>

                                <div className="admin-bar-drawer-group">
                                    <span>Cobertura</span>
                                    <div className="chief-payable-chip-row">
                                        <button type="button" className={`chief-payable-chip ${coverageFilter === "all" ? "active" : ""}`.trim()} onClick={() => setCoverageFilter("all")}>
                                            Completa + meio
                                        </button>
                                        <button type="button" className={`chief-payable-chip warning ${coverageFilter === "half" ? "active" : ""}`.trim()} onClick={() => setCoverageFilter("half")}>
                                            Somente MEIO ({filterSummary.halfCount})
                                        </button>
                                        <button type="button" className={`chief-payable-chip ${coverageFilter === "full" ? "active" : ""}`.trim()} onClick={() => setCoverageFilter("full")}>
                                            Sem MEIO ({filterSummary.fullCount})
                                        </button>
                                    </div>
                                </div>

                                <div className="admin-bar-drawer-group">
                                    <span>Status e vínculo</span>
                                    <div className="chief-payable-chip-row">
                                        <button type="button" className={`chief-payable-chip ${status === "all" ? "active" : ""}`.trim()} onClick={() => setStatus("all")}>
                                            Todos ({board.summary.doctorCount})
                                        </button>
                                        <button type="button" className={`chief-payable-chip ${status === "ready_for_payment" ? "active" : ""}`.trim()} onClick={() => setStatus("ready_for_payment")}>
                                            Prontos ({filterSummary.readyDoctors})
                                        </button>
                                        <button type="button" className={`chief-payable-chip warning ${status === "needs_review" ? "active" : ""}`.trim()} onClick={() => setStatus("needs_review")}>
                                            Pendências ({filterSummary.reviewDoctors})
                                        </button>
                                        <button type="button" className={`chief-payable-chip ${employmentTypeFilter === "all" ? "active" : ""}`.trim()} onClick={() => setEmploymentTypeFilter("all")}>
                                            PJ + Estatutário
                                        </button>
                                        <button type="button" className={`chief-payable-chip ${employmentTypeFilter === "pj" ? "active" : ""}`.trim()} onClick={() => setEmploymentTypeFilter("pj")}>
                                            PJ ({dueAmountByEmploymentType.pj.doctorCount})
                                        </button>
                                        <button type="button" className={`chief-payable-chip ${employmentTypeFilter === "estatutario" ? "active" : ""}`.trim()} onClick={() => setEmploymentTypeFilter("estatutario")}>
                                            Estatutário ({dueAmountByEmploymentType.estatutario.doctorCount})
                                        </button>
                                    </div>
                                </div>

                                <div className="admin-bar-drawer-group">
                                    <span>Ordenar e alvo</span>
                                    <select value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)} aria-label="Ordenar por">
                                        <option value="pending">Ordenar: pendências</option>
                                        <option value="total">Ordenar: total</option>
                                        <option value="weekday">Ordenar: dia útil</option>
                                        <option value="weekend">Ordenar: fim de semana / feriado</option>
                                        <option value="name">Ordenar: nome</option>
                                    </select>
                                    <input
                                        type="search"
                                        value={targetSearch}
                                        onChange={(event) => setTargetSearch(event.target.value)}
                                        placeholder="Filtrar alvo — ex.: BR60, PM04, CRU"
                                        aria-label="Filtrar alvo"
                                    />
                                    <select value={targetFilter} onChange={(event) => setTargetFilter(event.target.value)} aria-label="Base/Ramal">
                                        <option value="all">Base/Ramal: todos</option>
                                        {board.targetOptions.map((target) => (
                                            <option key={`${target.domain}|${target.targetCode}`} value={`${target.domain}|${target.targetCode}`}>
                                                {target.targetCode} · {target.domain === "regulation" ? "Regulação" : "Intervenção"}
                                            </option>
                                        ))}
                                    </select>
                                </div>

                                <div className="admin-bar-drawer-group">
                                    <span>Ritmo do mês{peakDay ? ` · pico dia ${peakDay.day}` : ""}</span>
                                    <div
                                        className="admin-bar-rhythm"
                                        aria-label="Ritmo mensal de unidades pagáveis"
                                        title={peakDay ? `Unidades pagáveis por dia · pico dia ${peakDay.day} (${peakDay.count})` : "Unidades pagáveis por dia"}
                                    >
                                        {dayLoad.map((entry) => {
                                            const ratio = Math.max(entry.count / maxDayLoad, 0.12);
                                            return (
                                                <i
                                                    key={entry.day}
                                                    title={`Dia ${entry.day}: ${entry.count} unidades`}
                                                    style={{ transform: `scaleY(${ratio.toFixed(4)})` }}
                                                />
                                            );
                                        })}
                                    </div>
                                </div>
                            </div>

                            <div className="admin-bar-drawer-group">
                                <span>Base / ramal</span>
                                <div className="chief-payable-chip-row">
                                    <button type="button" className={`chief-payable-chip ${targetFilter === "all" ? "active" : ""}`.trim()} onClick={() => setTargetFilter("all")}>
                                        Todas as bases/ramais ({targetPills.length})
                                    </button>
                                    <button
                                        type="button"
                                        className={`chief-payable-chip ${normalizedTarget === "usa" ? "active" : ""}`.trim()}
                                        onClick={() => setTargetSearch(normalizedTarget === "usa" ? "" : "USA")}
                                    >
                                        USA ({board.targetOptions.filter((target) => normalize([target.targetCode, target.targetLabel].join(" ")).includes("usa")).length})
                                    </button>
                                </div>

                                <div className="chief-payable-order-legend" aria-label="Ordem operacional prioritária">
                                    <span>Ordem rápida</span>
                                    <strong>01 · 02 · 03 · 04 · 05 · 10 · 20</strong>
                                </div>

                                <div className="chief-payable-target-sectors">
                                    {targetSectors.map((sector) => (
                                        <section key={sector.key} className={`chief-payable-target-sector ${sector.tone}`.trim()}>
                                            <header>
                                                <h4>{sector.title}</h4>
                                                <small>{sector.targets.length} unidades</small>
                                            </header>

                                            <div className="chief-payable-chip-row chief-payable-target-pills">
                                                {sector.targets.map((target) => {
                                                    const value = `${target.domain}|${target.targetCode}`;
                                                    return (
                                                        <button
                                                            type="button"
                                                            key={value}
                                                            className={`chief-payable-chip ${targetFilter === value ? "active" : ""}`.trim()}
                                                            onClick={() => setTargetFilter(value)}
                                                            title={`${target.targetCode} · ${target.targetLabel}`}
                                                        >
                                                            {target.targetCode}
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        </section>
                                    ))}
                                </div>
                            </div>
                        </div>
                    </motion.div>
                ) : null}
            </AnimatePresence>

            <div className="admin-bar-inserts">
            {(manualError || manualFeedback) ? (
                <section className={`payment-inline-banner ${manualError ? "danger" : "ok"}`.trim()}>
                    <strong>{manualError ? "Falha na correção" : "Correção manual"}</strong>
                    <span>{manualError ?? manualFeedback}</span>
                </section>
            ) : null}

            {flash ? (
                <section className="payment-flash-banner" role="status" aria-live="polite">
                    <div className="payment-flash-banner-main">
                        <span className="payment-flash-banner-icon" aria-hidden="true">✓</span>
                        <div className="payment-flash-banner-text">
                            <strong>
                                {flash.kind === "assign" ? "Médico alocado" : "Unidade desativada"}
                            </strong>
                            <span>
                                {flash.targetCode} {flash.shiftLabel} · dia {flash.day}/{flash.monthKey.slice(5, 7)}/{flash.monthKey.slice(0, 4)}
                                {flash.kind === "assign" && flash.doctorName ? ` → ${flash.doctorName}` : ""}
                                {flash.kind === "disable" && flash.reason ? ` · ${flash.reason}` : ""}
                            </span>
                        </div>
                    </div>
                    <div className="payment-flash-banner-actions">
                        <button type="button" className="payment-button" onClick={() => locateFlashCell()}>
                            Localizar na tabela
                        </button>
                        <button type="button" className="payment-button" onClick={dismissFlash} aria-label="Fechar aviso">
                            ✕
                        </button>
                    </div>
                </section>
            ) : null}

            {canManageClosing && manualDraft ? (
                <section className="payment-detail-card">
                    <div className="payment-detail-card-header">
                        <div>
                            <span className="payment-eyebrow">Correção manual de pagamento</span>
                            <strong>{manualDraft.targetCode} · {manualDraft.targetLabel} · {board.monthKey}-{manualDraft.day} · {manualDraft.shiftLabel}</strong>
                            <p>
                                Origem: {manualDraft.sourceType === "disabled" ? "Desativada" : "Sem médico"}
                                {manualDraft.reason ? ` · ${manualDraft.reason}` : ""}
                            </p>
                        </div>
                        <button
                            type="button"
                            className="payment-button"
                            onClick={() => {
                                setManualDraft(null);
                                setManualDoctorName("");
                                setManualDisableReason("");
                                setManualError(null);
                            }}
                            disabled={manualBusy}
                        >
                            ✕
                        </button>
                    </div>

                    <p className="payment-correction-note">
                        ✅ Esta ação cria uma ocupação real no banco de dados, calcula banco de horas automaticamente e registra o pagamento. Use para médicos que trabalharam mas não foram capturados pelo bot.
                    </p>

                    <div className="payment-correction-tabs">
                        <button
                            type="button"
                            className={`payment-correction-tab ${manualMode === "assign" ? "active" : ""}`.trim()}
                            onClick={() => setManualMode("assign")}
                            disabled={manualBusy}
                        >
                            Atribuir médico
                        </button>
                        {manualDraft.sourceType === "uncovered" && (
                            <button
                                type="button"
                                className={`payment-correction-tab ${manualMode === "disable" ? "active" : ""}`.trim()}
                                onClick={() => setManualMode("disable")}
                                disabled={manualBusy}
                            >
                                Marcar como desativada
                            </button>
                        )}
                    </div>

                    {manualMode === "assign" ? (
                        <div className="chief-payable-filter-bar" style={{ marginTop: "0.5rem" }}>
                            <label className="chief-payable-filter-field chief-payable-search" style={{ minWidth: "320px" }}>
                                <span>Médico para pagamento</span>
                                <input
                                    type="text"
                                    list="chief-payment-doctor-names"
                                    value={manualDoctorName}
                                    onChange={(event) => setManualDoctorName(event.target.value)}
                                    placeholder="Digite o nome do médico"
                                    autoFocus
                                />
                            </label>
                            <datalist id="chief-payment-doctor-names">
                                {board.allDoctorNames.map((name) => (
                                    <option key={name} value={name} />
                                ))}
                            </datalist>
                            <div className="payment-filter-actions">
                                <button type="button" className="payment-button primary" onClick={() => void submitManualCorrection()} disabled={manualBusy}>
                                    {manualBusy ? "Salvando..." : "Salvar correção"}
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div className="chief-payable-filter-bar" style={{ marginTop: "0.5rem" }}>
                            <label className="chief-payable-filter-field" style={{ minWidth: "320px" }}>
                                <span>Motivo da desativação</span>
                                <input
                                    type="text"
                                    value={manualDisableReason}
                                    onChange={(event) => setManualDisableReason(event.target.value)}
                                    placeholder="Ex.: Sem demanda, veículo indisponível, escala reduzida"
                                    autoFocus
                                />
                            </label>
                            <div className="payment-filter-actions">
                                <button type="button" className="payment-button warning" onClick={() => void submitManualDisable()} disabled={manualBusy}>
                                    {manualBusy ? "Salvando..." : "Confirmar desativação"}
                                </button>
                            </div>
                        </div>
                    )}
                </section>
            ) : null}
            </div>

            <section className="chief-payable-table-shell" ref={tableShellRef}>
                <div className="chief-payable-table-scroll">
                    <table className="chief-payable-table">
                        <thead>
                            <tr>
                                <th className="sticky-col doctor">Médico</th>
                                {board.days.map((day) => <th key={day}>{day}</th>)}
                                <th>Dia útil</th>
                                <th>Fim de semana / feriado</th>
                                <th>Total</th>
                                <th>Valor semana</th>
                                <th>Valor fim de semana / feriado</th>
                                <th>Valor final</th>
                            </tr>
                        </thead>

                        <tbody>
                            <AnimatePresence mode="popLayout">
                                <motion.tr
                                    key="disabled-row"
                                    layout
                                    initial={{ opacity: 0, y: 6 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, y: -6 }}
                                    transition={{ duration: 0.16 }}
                                    className="chief-payable-disabled-row"
                                >
                                    <td className="sticky-col doctor">
                                        <strong>Desativadas</strong>
                                        <span>Fontes sem médico por desativação do turno</span>
                                    </td>

                                    {board.days.map((day) => {
                                        // Contador compacto no lugar dos chips: não alarga a coluna;
                                        // o detalhe (e a correção manual) vive no painel do dia.
                                        const dayItems = disabledByDay.get(day) ?? [];
                                        return (
                                            <td key={`disabled-${day}`}>
                                                {dayItems.length > 0 ? (
                                                    <button
                                                        type="button"
                                                        className="chief-payable-day-count disabled"
                                                        onClick={() => setDayTargetsPanel({ day, kind: "disabled" })}
                                                        title={`${dayItems.length} desativação(ões) no dia ${day} — clique para listar`}
                                                    >
                                                        {dayItems.length}
                                                    </button>
                                                ) : null}
                                            </td>
                                        );
                                    })}

                                    <td>-</td>
                                    <td>-</td>
                                    <td>{visibleDisabledTargets.length}</td>
                                    <td>-</td>
                                    <td>-</td>
                                    <td>-</td>
                                    <td>-</td>
                                </motion.tr>

                                <motion.tr
                                    key="uncovered-row"
                                    ref={uncoveredRowRef}
                                    layout
                                    initial={{ opacity: 0, y: 6 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, y: -6 }}
                                    transition={{ duration: 0.16 }}
                                    className="chief-payable-uncovered-row"
                                >
                                    <td className="sticky-col doctor">
                                        <strong>Sem médico</strong>
                                        <span>Sem cobertura e sem desativação no turno</span>
                                    </td>

                                    {board.days.map((day) => {
                                        const dayItems = uncoveredByDay.get(day) ?? [];
                                        return (
                                            <td key={`uncovered-${day}`}>
                                                {dayItems.length > 0 ? (
                                                    <button
                                                        type="button"
                                                        className="chief-payable-day-count uncovered"
                                                        onClick={() => setDayTargetsPanel({ day, kind: "uncovered" })}
                                                        title={`${dayItems.length} turno(s) sem médico no dia ${day} — clique para listar`}
                                                    >
                                                        {dayItems.length}
                                                    </button>
                                                ) : null}
                                            </td>
                                        );
                                    })}

                                    <td>-</td>
                                    <td>-</td>
                                    <td>{visibleUncoveredTargets.length}</td>
                                    <td>-</td>
                                    <td>-</td>
                                    <td>-</td>
                                    <td>-</td>
                                </motion.tr>

                                {filteredDoctors.map((doctor, index) => {
                                    const doctorProfile = (doctor.paymentProfile ?? "generalist") as DoctorProfile;
                                    const profileBadge = paymentProfileBadge(doctorProfile);
                                    const doctorEmploymentType = (doctor.employmentType ?? "pj") as DoctorEmploymentType;
                                    // Só desempenhou uma das duas funções (USA xor CRU) no mês.
                                    const singleFunction = (doctor.usaShiftCount > 0) !== (doctor.cruShiftCount > 0);

                                    return (
                                    <motion.tr
                                        key={doctor.doctorId}
                                        layout
                                        initial={{ opacity: 0, y: 6 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        exit={{ opacity: 0, y: -6 }}
                                        transition={{ duration: 0.2, delay: Math.min(index * 0.018, 0.18) }}
                                        className={[
                                            isDoctorAttested(doctor) ? "chief-payable-row-attested" : "",
                                            singleFunction ? "chief-payable-row-single-function" : "",
                                        ].filter(Boolean).join(" ") || undefined}
                                    >
                                        <td className="sticky-col doctor">
                                            <div className="chief-payable-doctor-cell">
                                                <div className="chief-payable-doctor-main">
                                                    <button
                                                        type="button"
                                                        className="chief-payable-doctor-button"
                                                        onClick={() => setSelectedDoctorId(doctor.doctorId)}
                                                    >
                                                        <strong>{doctor.doctorName}</strong>
                                                    </button>
                                                    {profileBadge ? (
                                                        <span className={`chief-payable-profile-badge ${doctorProfile}`.trim()}>{profileBadge}</span>
                                                    ) : null}
                                                    <span className={`chief-payable-profile-badge ${doctorEmploymentType}`.trim()} title="Vínculo com a prefeitura">
                                                        {employmentTypeLabel(doctorEmploymentType)}
                                                    </span>
                                                    {singleFunction ? (
                                                        <span
                                                            className="chief-payable-single-function-badge"
                                                            title={`Não desempenhou as duas funções neste mês · USA: ${doctor.usaShiftCount} · CRU: ${doctor.cruShiftCount}`}
                                                        >
                                                            só {doctor.usaShiftCount > 0 ? "USA" : "CRU"}
                                                        </span>
                                                    ) : null}
                                                </div>

                                                {/* Toggles Estatutário/ESP moveram para o modal do médico —
                                                    a linha fica só com assinar + banco de horas (coluna estreita). */}
                                                <label className={`chief-payable-attest-toggle ${isDoctorAttested(doctor) ? "on" : ""}`.trim()} title="Conferido e assinado">
                                                    <input
                                                        type="checkbox"
                                                        checked={isDoctorAttested(doctor)}
                                                        onChange={(event) => {
                                                            void toggleDoctorAttestation(doctor.doctorId, event.target.checked);
                                                        }}
                                                        disabled={!canManageClosing || attestBusyDoctorId === doctor.doctorId}
                                                    />
                                                    <span>{isDoctorAttested(doctor) ? "✓ assinado" : "assinar"}</span>
                                                </label>

                                                {doctor.bankHoursMinutes != null || doctor.bankHoursSettlement ? (() => {
                                                    // Saldo do banco de horas na linha, pela régua de elegibilidade:
                                                    // só horas desde mai/2025 pagam/punem, e dívida anterior a
                                                    // mai/2025 é amortizada antes de qualquer bônus. Mostrar o bruto
                                                    // aqui faria o chefe remunerar horas antigas ou devedores.
                                                    const bank = resolveBankHoursSettlementBalance({
                                                        oldMinutes: doctor.bankHoursOldMinutes ?? 0,
                                                        recentMinutes: doctor.bankHoursRecentMinutes ?? (doctor.bankHoursMinutes ?? 0),
                                                    });
                                                    const atPositive = bank.bonusEligibleMinutes >= BANK_HOURS_THRESHOLD_MINUTES;
                                                    const atNegative = bank.penaltyEligibleMinutes <= -BANK_HOURS_THRESHOLD_MINUTES;
                                                    const amortizing = !atPositive && bank.oldMinutes < 0 && bank.recentMinutes > 0;
                                                    const tone = atPositive ? "threshold-positive" : atNegative ? "threshold-negative" : amortizing ? "debt" : "";
                                                    const composition = `Desde mai/2025: ${formatSignedMinutesAsHours(bank.recentMinutes)} · antes de mai/2025: ${formatSignedMinutesAsHours(bank.oldMinutes)} · bruto: ${formatSignedMinutesAsHours(bank.totalMinutes)}`;
                                                    const title = atPositive
                                                        ? `Elegível para bônus: ${formatSignedMinutesAsHours(bank.bonusEligibleMinutes)} (horas desde mai/2025, dívida antiga já descontada). Bonifique com 1 plantão verde antes de ele assinar. ${composition}`
                                                        : atNegative
                                                            ? `Saldo desde mai/2025 atingiu -12h: debite 1 plantão vermelho antes de ele assinar. ${composition}`
                                                            : amortizing
                                                                ? `As horas formadas desde mai/2025 estão amortizando a dívida anterior a mai/2025 — sem bônus até quitar. ${composition}`
                                                                : `Saldo elegível para acerto (±1 plantão a partir de ±12h). ${composition}`;
                                                    const shown = atPositive
                                                        ? bank.bonusEligibleMinutes
                                                        : atNegative
                                                            ? bank.penaltyEligibleMinutes
                                                            : bank.recentMinutes;
                                                    return (
                                                        <button
                                                            type="button"
                                                            className={`chief-payable-bank-chip ${tone}`.trim()}
                                                            onClick={() => setSelectedDoctorId(doctor.doctorId)}
                                                            title={title}
                                                        >
                                                            <strong>{formatSignedMinutesAsHours(shown)}</strong>
                                                            <span>
                                                                {atPositive
                                                                    ? "acerto +1 plantão"
                                                                    : atNegative
                                                                        ? "acerto −1 plantão"
                                                                        : amortizing
                                                                            ? "amortiza dívida antiga"
                                                                            : "banco"}
                                                            </span>
                                                            {doctor.bankHoursSettlement ? (
                                                                <em title="Acerto de 12h já lançado neste mês">✓ acerto no mês</em>
                                                            ) : null}
                                                        </button>
                                                    );
                                                })() : null}
                                            </div>
                                        </td>

                                        {doctor.cells.map((cell) => (
                                            <td key={`${doctor.doctorId}-${cell.day}`}>
                                                <div className="chief-payable-cell-tags">
                                                    {cell.shifts.map((shift) => {
                                                        if (pendingRemovals.has(shift.payableShiftId)) return null;
                                                        const isFlashTarget = highlightKey === `${shift.domain}|${shift.targetCode}|${cell.day}|${shift.shiftLabel}|assign`;
                                                        return (
                                                        <motion.button
                                                            key={shift.payableShiftId}
                                                            type="button"
                                                            data-flash-key={`assign|${shift.domain}|${shift.targetCode}|${cell.day}|${shift.shiftLabel}`}
                                                            className={`chief-payable-tag ${shift.shiftLabel === "SD" ? "sd" : "sn"} ${shift.source === "admin_extra" ? (shift.paymentUnit < 0 ? "admin-penalty" : "admin-extra") : ""} ${shift.paymentTag ? "half" : ""} ${isFlashTarget ? "flash" : ""}`.trim()}
                                                            title={shift.source === "admin_extra"
                                                                ? `${shift.paymentUnit < 0 ? "Punição banco de horas" : "Plantão extra (admin)"} · ${shift.shiftLabel} · ${shift.doctorName}`
                                                                : `${shift.targetCode}${shift.shiftLabel} · ${shift.doctorName}${shift.paymentTag ? " · Meio Plantao" : ""}`}
                                                            initial={{ opacity: 0, scale: 0.92 }}
                                                            animate={{ opacity: 1, scale: 1 }}
                                                            transition={{ duration: 0.15 }}
                                                            onClick={() => {
                                                                setShiftActionError(null);
                                                                setShiftActionDraft({
                                                                    payableShiftId: shift.payableShiftId,
                                                                    occupancyId: shift.occupancyId,
                                                                    domain: shift.domain,
                                                                    targetCode: shift.targetCode,
                                                                    targetLabel: shift.targetLabel,
                                                                    day: cell.day,
                                                                    shiftLabel: shift.shiftLabel,
                                                                    doctorName: doctor.doctorName,
                                                                    source: shift.source,
                                                                });
                                                            }}
                                                        >
                                                            {shift.paymentTag ? `${shift.paymentTag} ${shift.tagCode}` : shift.tagCode}
                                                        </motion.button>
                                                        );
                                                    })}
                                                </div>
                                            </td>
                                        ))}

                                        <td>{formatUnits(doctor.weekdayShiftCount)}</td>
                                        <td>{formatUnits(doctor.weekendShiftCount)}</td>
                                        <td>{formatUnits(doctor.total)}</td>
                                        <td>{formatCurrency(doctor.weekdayDue)}</td>
                                        <td>{formatCurrency(doctor.weekendDue)}</td>
                                        <td className="chief-payable-final-value">{formatCurrency(doctor.totalDue)}</td>
                                    </motion.tr>
                                    );
                                })}

                                {filteredDoctors.length === 0 ? (
                                    <motion.tr
                                        key="empty"
                                        initial={{ opacity: 0 }}
                                        animate={{ opacity: 1 }}
                                        exit={{ opacity: 0 }}
                                    >
                                        <td className="chief-payable-empty" colSpan={board.days.length + 8}>
                                            Nenhum médico encontrado com os filtros atuais.
                                        </td>
                                    </motion.tr>
                                ) : null}
                            </AnimatePresence>
                        </tbody>
                    </table>
                </div>
            </section>
            </section>

            {dayTargetsPanel ? (
                <div className="chief-payable-modal-backdrop" role="presentation" onClick={() => setDayTargetsPanel(null)}>
                    <section className="chief-payable-action-popover chief-payable-day-panel" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
                        <header className="chief-payable-action-header">
                            <span className="payment-eyebrow">{dayTargetsPanel.kind === "disabled" ? "Desativadas" : "Sem médico"}</span>
                            <strong>
                                Dia {dayTargetsPanel.day}/{board.monthKey.slice(5, 7)}/{board.monthKey.slice(0, 4)}
                            </strong>
                            <small>
                                {dayTargetsPanel.kind === "disabled"
                                    ? "Turnos sem médico por desativação. Clique numa unidade para atribuir médico."
                                    : "Turnos sem cobertura e sem desativação. Clique numa unidade para atribuir médico ou desativar."}
                            </small>
                        </header>

                        {(["SD", "SN"] as const).map((shiftLabel) => {
                            const items = (dayTargetsPanel.kind === "disabled"
                                ? (disabledByDay.get(dayTargetsPanel.day) ?? [])
                                : (uncoveredByDay.get(dayTargetsPanel.day) ?? [])
                            ).filter((item) => item.shiftLabel === shiftLabel);
                            if (items.length === 0) {
                                return null;
                            }
                            return (
                                <div key={shiftLabel} className="chief-payable-day-panel-group">
                                    <span>{shiftLabel === "SD" ? "Diurno (SD)" : "Noturno (SN)"} · {items.length}</span>
                                    <div className="chief-payable-cell-tags">
                                        {items.map((item) => {
                                            const reason = "disabledReason" in item ? item.disabledReason : item.reason;
                                            return (
                                                <button
                                                    type="button"
                                                    key={item.snapshotId}
                                                    data-flash-key={dayTargetsPanel.kind === "disabled"
                                                        ? `disable|${item.domain}|${item.targetCode}|${item.day}|${item.shiftLabel}`
                                                        : undefined}
                                                    className={`chief-payable-tag ${dayTargetsPanel.kind} ${item.shiftLabel === "SD" ? "sd" : "sn"} ${highlightKey === `${item.domain}|${item.targetCode}|${item.day}|${item.shiftLabel}|disable` ? "flash" : ""}`.trim()}
                                                    title={`${item.targetCode} ${item.shiftLabel}${reason ? ` · ${reason}` : ""}`}
                                                    onClick={() => {
                                                        if (!canManageClosing) {
                                                            return;
                                                        }
                                                        setManualDraft({
                                                            domain: item.domain,
                                                            targetCode: item.targetCode,
                                                            targetLabel: item.targetLabel,
                                                            day: item.day,
                                                            shiftLabel: item.shiftLabel,
                                                            sourceType: dayTargetsPanel.kind,
                                                            reason: reason ?? null,
                                                        });
                                                        setManualDoctorName("");
                                                        setManualDisableReason("");
                                                        setManualMode("assign");
                                                        setManualError(null);
                                                        setDayTargetsPanel(null);
                                                        // O card de correção manual renderiza no topo do frame.
                                                        window.scrollTo({ top: 0, behavior: "smooth" });
                                                    }}
                                                >
                                                    {item.targetCode}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            );
                        })}

                        <div className="chief-payable-action-buttons">
                            <button type="button" className="payment-button" onClick={() => setDayTargetsPanel(null)}>
                                Fechar
                            </button>
                        </div>
                    </section>
                </div>
            ) : null}

            {shiftActionDraft ? (
                <div className="chief-payable-modal-backdrop" role="presentation" onClick={() => !shiftActionBusy && setShiftActionDraft(null)}>
                    <section className="chief-payable-action-popover" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
                        <header className="chief-payable-action-header">
                            <span className="payment-eyebrow">Ações do plantão</span>
                            <strong>
                                {shiftActionDraft.targetCode} {shiftActionDraft.shiftLabel} · dia {shiftActionDraft.day}/{board.monthKey.slice(5,7)} · {shiftActionDraft.doctorName}
                            </strong>
                            {shiftActionDraft.source ? <small>Origem: {shiftActionDraft.source === "admin_extra" ? "plantão extra (admin)" : shiftActionDraft.source}</small> : null}
                        </header>

                        {shiftActionError ? (
                            <div className="payment-inline-banner danger">
                                <strong>Falha ao remover</strong>
                                <span>{shiftActionError}</span>
                            </div>
                        ) : null}

                        <div className="chief-payable-action-buttons">
                            {canManageClosing ? (
                                <button
                                    type="button"
                                    className="payment-button danger"
                                    onClick={() => void submitShiftRemoval()}
                                    disabled={shiftActionBusy}
                                >
                                    {shiftActionBusy ? "Removendo..." : `Remover ${shiftActionDraft.doctorName} deste plantão`}
                                </button>
                            ) : null}
                            {shiftActionDraft.source === "admin_extra" ? null : (
                                <a
                                    className="payment-button"
                                    href={cellAuditLink(board.monthKey, shiftActionDraft.day, shiftActionDraft.shiftLabel)}
                                >
                                    Abrir auditoria detalhada
                                </a>
                            )}
                            <button
                                type="button"
                                className="payment-button"
                                onClick={() => setShiftActionDraft(null)}
                                disabled={shiftActionBusy}
                            >
                                Cancelar
                            </button>
                        </div>

                        <p className="chief-payable-action-hint">
                            {canManageClosing
                                ? (shiftActionDraft.source === "admin_extra"
                                    ? "Remover apaga este plantão extra adicionado pelo admin (sai do quadro e do valor a pagar)."
                                    : (shiftActionDraft.source === "admin_correction" || shiftActionDraft.source === "manual"
                                        ? "Remover apaga a correção manual deste plantão."
                                        : "Remover encerra o plantão no início deste turno (recalcula banco de horas). Use quando o médico não estava de fato no plantão."))
                                : "Perfil somente leitura para plantões: remoções e correções manuais ficam bloqueadas."}
                        </p>
                    </section>
                </div>
            ) : null}

            {selectedDoctor ? (
                <div className="chief-payable-modal-backdrop" role="presentation" onClick={() => setSelectedDoctorId(null)}>
                    <section className="chief-payable-modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
                        <header className="chief-payable-modal-header">
                            <div>
                                <span className="payment-eyebrow">Resumo do médico</span>
                                <h3>{selectedDoctor.doctorName}</h3>
                                <p>{paymentProfileLabel(selectedDoctor.paymentProfile)} · {employmentTypeLabel(selectedDoctor.employmentType)} · {board.monthLabel}</p>
                                {/* Toggles de vínculo/tarifa moraram na linha da tabela; migraram
                                    para cá para a coluna do médico ficar estreita. */}
                                <div className="chief-payable-modal-toggles">
                                    <label className="chief-payable-specialist-toggle" title="Estatutário/REDA não gera valor a pagar por plantão">
                                        <input
                                            type="checkbox"
                                            checked={(doctorEmploymentTypeOverrides[selectedDoctor.doctorId] ?? selectedDoctor.employmentType ?? "pj") === "estatutario"}
                                            onChange={(event) => {
                                                void toggleDoctorEmploymentType(selectedDoctor.doctorId, event.target.checked ? "estatutario" : "pj");
                                            }}
                                            disabled={!canManageClosing || employmentTypeBusyDoctorId === selectedDoctor.doctorId}
                                        />
                                        <span>Estatutário</span>
                                    </label>
                                    {(doctorProfileOverrides[selectedDoctor.doctorId] ?? selectedDoctor.paymentProfile ?? "generalist") !== "psychiatry" ? (
                                        <label className="chief-payable-specialist-toggle" title="Tarifa de especialista">
                                            <input
                                                type="checkbox"
                                                checked={(doctorProfileOverrides[selectedDoctor.doctorId] ?? selectedDoctor.paymentProfile ?? "generalist") === "specialist"}
                                                onChange={(event) => {
                                                    void toggleDoctorSpecialistProfile(selectedDoctor.doctorId, event.target.checked);
                                                }}
                                                disabled={!canManageClosing || profileBusyDoctorId === selectedDoctor.doctorId}
                                            />
                                            <span>ESP</span>
                                        </label>
                                    ) : null}
                                </div>
                            </div>
                            <div className="chief-payable-modal-header-actions">
                                <a
                                    className="payment-button"
                                    href={`/folha-ponto/${selectedDoctor.doctorId}/${board.monthKey.slice(0, 4)}/${board.monthKey.slice(5, 7)}`}
                                    target="_blank"
                                    rel="noopener"
                                >
                                    Gerar folha de ponto
                                </a>
                                <button type="button" className="payment-button" onClick={() => setSelectedDoctorId(null)}>Fechar</button>
                            </div>
                        </header>

                        {selectedDoctorConflictCount > 0 ? (
                            <section className="chief-payable-attest-card" style={{ borderColor: "#d97706", background: "#fff7ed", color: "#7c2d12" }}>
                                <p className="chief-payable-attest-hint" style={{ marginBottom: "0.4rem" }}>
                                    <strong>Possível deslocamento por conflito de alocação:</strong> {selectedDoctorConflictCount} caso(s) deste médico no mês.
                                </p>
                                <p className="chief-payable-attest-hint" style={{ marginBottom: "0.4rem" }}>
                                    Este alerta só aparece para médico potencialmente deslocado (segmento descartado por sobreposição no mesmo dia/turno/alvo de um conflito).
                                </p>
                                {selectedDoctorDisplacedConflictSegments.length > 0 ? (
                                    <div className="chief-payable-attest-hint" style={{ marginBottom: "0.5rem" }}>
                                        <strong>Onde pode ter faltado plantão:</strong>
                                        <ul style={{ margin: "0.35rem 0 0", paddingLeft: "1.1rem", fontSize: "0.92rem", lineHeight: 1.45 }}>
                                            {selectedDoctorDisplacedConflictSegments.slice(0, 6).map((segment) => {
                                                const day = segment.operationalDate.slice(8, 10);
                                                const month = segment.operationalDate.slice(5, 7);
                                                return (
                                                    <li key={segment.segmentId}>
                                                        <a href={cellAuditLink(board.monthKey, day, segment.shiftLabel)}>
                                                            {day}/{month} {segment.shiftLabel} {segment.targetCode}
                                                        </a>{" "}
                                                        - escolhido no slot: {segment.chosenDoctorName}
                                                    </li>
                                                );
                                            })}
                                        </ul>
                                        {selectedDoctorDisplacedConflictSegments.length > 6 ? (
                                            <small>
                                                +{selectedDoctorDisplacedConflictSegments.length - 6} ocorrência(s). Abra a auditoria técnica para ver todas.
                                            </small>
                                        ) : null}
                                    </div>
                                ) : null}
                                <p className="chief-payable-attest-hint">
                                    Revise no detalhe para não perder pagamento por sobreposição: <a href="/admin/payment-attestation/audit">abrir auditoria técnica</a>.
                                </p>
                            </section>
                        ) : null}

                        <div className="chief-payable-modal-grid">
                            <article className="chief-payable-modal-card">
                                <span>Plantões dia útil</span>
                                <strong>{formatUnits(selectedDoctor.weekdayShiftCount)}</strong>
                                <small>
                                    Tarifa: {formatCurrency(PROFILE_RATES[(selectedDoctor.paymentProfile ?? "generalist") as DoctorProfile].weekday)} · Total: {formatCurrency(selectedDoctor.weekdayDue)}
                                </small>
                            </article>
                            <article className="chief-payable-modal-card">
                                <span>Plantões fim de semana / feriado</span>
                                <strong>{formatUnits(selectedDoctor.weekendShiftCount)}</strong>
                                <small>
                                    Tarifa: {formatCurrency(PROFILE_RATES[(selectedDoctor.paymentProfile ?? "generalist") as DoctorProfile].weekend)} · Total: {formatCurrency(selectedDoctor.weekendDue)}
                                </small>
                            </article>
                            <article className="chief-payable-modal-card emphasis">
                                <span>Total a pagar no mês</span>
                                <strong>{formatCurrency(selectedDoctor.totalDue)}</strong>
                                <small>{formatCurrency(selectedDoctor.weekdayDue)} (semana) + {formatCurrency(selectedDoctor.weekendDue)} (fim de semana / feriado)</small>
                            </article>
                        </div>

                        {(() => {
                            const usa = selectedDoctor.usaShiftCount;
                            const cru = selectedDoctor.cruShiftCount;
                            const singleFunction = (usa > 0) !== (cru > 0);
                            return (
                                <div className={`chief-payable-functions${singleFunction ? " alert" : ""}`}>
                                    <article className={`chief-payable-function-card${usa === 0 ? " zero" : ""}`}>
                                        <span>Plantões em USA</span>
                                        <strong>{usa}</strong>
                                        <small>Bases de intervenção (ambulância)</small>
                                    </article>
                                    <article className={`chief-payable-function-card${cru === 0 ? " zero" : ""}`}>
                                        <span>Plantões em CRU</span>
                                        <strong>{cru}</strong>
                                        <small>Ramais de regulação</small>
                                    </article>
                                    {singleFunction ? (
                                        <p className="chief-payable-functions-warning">
                                            ⚠ Só desempenhou {usa > 0 ? "USA" : "CRU"} neste mês — não cumpriu as duas funções.
                                        </p>
                                    ) : null}
                                </div>
                            );
                        })()}

                        <section className="chief-payable-financials">
                            <header>
                                <h4>Acompanhamento financeiro</h4>
                                <small>Nota fiscal e processo são preenchidos por você; saldo contratual e banco de horas são calculados.</small>
                            </header>
                            <div className="chief-payable-financials-grid">
                                <div className="chief-payable-financials-meta">
                                    <label>
                                        <span>Nota fiscal</span>
                                        <input
                                            type="text"
                                            value={invoiceDraft}
                                            onChange={(event) => setInvoiceDraft(event.target.value)}
                                            onBlur={() => autoSavePaymentMeta(selectedDoctor)}
                                            placeholder="—"
                                            maxLength={60}
                                            disabled={metaBusy}
                                        />
                                    </label>
                                    <label>
                                        <span>Processo de pagamento</span>
                                        <input
                                            type="text"
                                            value={processDraft}
                                            onChange={(event) => setProcessDraft(event.target.value)}
                                            onBlur={() => autoSavePaymentMeta(selectedDoctor)}
                                            placeholder="—"
                                            maxLength={60}
                                            disabled={metaBusy}
                                        />
                                    </label>
                                    <button
                                        type="button"
                                        className="payment-button"
                                        onClick={() => void submitPaymentMeta(selectedDoctor.doctorId)}
                                        disabled={metaBusy}
                                    >
                                        {metaBusy ? "Salvando..." : "Salvar NF / processo"}
                                    </button>
                                    {metaError ? <p className="chief-payable-extra-feedback danger">{metaError}</p> : null}
                                    {metaFeedback ? <p className="chief-payable-extra-feedback ok">{metaFeedback}</p> : null}
                                </div>

                                <article className="chief-payable-modal-card">
                                    <span>Saldo contratual</span>
                                    {selectedDoctor.contractCeilingBrl == null ? (
                                        <>
                                            <small>
                                                {canManageClosing
                                                    ? "Informe o teto do contrato (R$). A partir daí vira cálculo automático."
                                                    : "Teto de contrato ainda não definido para este médico."}
                                            </small>
                                            {canManageClosing ? (
                                                <>
                                                    <div className="chief-payable-contract-seed">
                                                        <input
                                                            type="number"
                                                            min="0"
                                                            step="0.01"
                                                            value={contractDraft}
                                                            onChange={(event) => setContractDraft(event.target.value)}
                                                            placeholder="ex.: 120000.00"
                                                            disabled={contractBusy}
                                                        />
                                                        <button
                                                            type="button"
                                                            className="payment-button"
                                                            onClick={() => void submitContractSeed(selectedDoctor.doctorId)}
                                                            disabled={contractBusy}
                                                        >
                                                            {contractBusy ? "Salvando..." : "Definir teto"}
                                                        </button>
                                                    </div>
                                                    {contractError ? <p className="chief-payable-extra-feedback danger">{contractError}</p> : null}
                                                </>
                                            ) : null}
                                        </>
                                    ) : (
                                        <>
                                            <strong className={(selectedDoctor.contractBalanceBrl ?? 0) < 0 ? "negative" : ""}>
                                                {formatCurrency(selectedDoctor.contractBalanceBrl)}
                                            </strong>
                                            <small>
                                                Teto {formatCurrency(selectedDoctor.contractCeilingBrl)}
                                                {selectedDoctor.contractSeedMonth ? ` desde ${selectedDoctor.contractSeedMonth}` : ""} · calculado
                                            </small>
                                        </>
                                    )}
                                </article>

                                {(() => {
                                    // Régua do acerto: só horas desde mai/2025 pagam/punem; dívida
                                    // anterior a mai/2025 é amortizada antes de qualquer bônus.
                                    const bank = resolveBankHoursSettlementBalance({
                                        oldMinutes: selectedDoctor.bankHoursOldMinutes ?? 0,
                                        recentMinutes: selectedDoctor.bankHoursRecentMinutes ?? (selectedDoctor.bankHoursMinutes ?? 0),
                                    });
                                    const bonusReady = bank.bonusEligibleMinutes >= BANK_HOURS_THRESHOLD_MINUTES;
                                    const penaltyReady = bank.penaltyEligibleMinutes <= -BANK_HOURS_THRESHOLD_MINUTES;
                                    const amortizing = !bonusReady && bank.oldMinutes < 0 && bank.recentMinutes > 0;
                                    return (
                                        <article className="chief-payable-modal-card">
                                            <span>Banco de horas · desde mai/2025</span>
                                            <strong className={bank.recentMinutes < 0 ? "negative" : ""}>
                                                {formatMinutesAsHours(bank.recentMinutes)}
                                            </strong>
                                            {bank.oldMinutes !== 0 ? (
                                                <small className="chief-payable-bank-note">
                                                    Antes de mai/2025: <strong className={bank.oldMinutes < 0 ? "negative" : ""}>{formatSignedMinutesAsHours(bank.oldMinutes)}</strong>{" "}
                                                    — fora da régua do acerto{bank.oldMinutes < 0 ? " (dívida: as horas novas amortizam primeiro)" : " (crédito antigo não remunera)"}.
                                                    {" "}Bruto total: {formatSignedMinutesAsHours(bank.totalMinutes)}.
                                                </small>
                                            ) : null}
                                            {selectedDoctor.bankHoursSettlement ? (
                                                <small className="chief-payable-bank-note">
                                                    {selectedDoctor.bankHoursSettlement.kind === "bonus" ? "Bônus" : "Punição"} de 12h lançado neste mês
                                                    {selectedDoctor.bankHoursSettlement.operationalDate ? ` (dia ${selectedDoctor.bankHoursSettlement.operationalDate.slice(8, 10)})` : ""}.{" "}
                                                    <a href="/admin/bank-hours" target="_blank" rel="noopener">ver no banco de horas</a>
                                                </small>
                                            ) : null}
                                            {bonusReady ? (
                                                <>
                                                    <small>
                                                        Elegível para bônus: {formatSignedMinutesAsHours(bank.bonusEligibleMinutes)}
                                                        {bank.oldMinutes < 0 ? " (dívida antiga já descontada)" : ""} — bonifique com 1 plantão verde (dia útil) e abata 12h.
                                                    </small>
                                                    {canManageClosing ? (
                                                        <button
                                                            type="button"
                                                            className="payment-button bank-bonus"
                                                            onClick={() => void submitBankHoursSettlement(selectedDoctor.doctorId, "bonus")}
                                                            disabled={bankBusy}
                                                        >
                                                            {bankBusy ? "Lançando..." : "Bonificar +1 plantão (verde) e abater 12h"}
                                                        </button>
                                                    ) : null}
                                                </>
                                            ) : penaltyReady ? (
                                                <>
                                                    <small>-12h ou menos desde mai/2025 — debite 1 plantão vermelho e devolva 12h ao saldo.</small>
                                                    {canManageClosing ? (
                                                        <button
                                                            type="button"
                                                            className="payment-button bank-penalty"
                                                            onClick={() => void submitBankHoursSettlement(selectedDoctor.doctorId, "penalty")}
                                                            disabled={bankBusy}
                                                        >
                                                            {bankBusy ? "Lançando..." : "Debitar 1 plantão (vermelho) e devolver 12h"}
                                                        </button>
                                                    ) : null}
                                                </>
                                            ) : amortizing ? (
                                                <small>
                                                    Formou {formatSignedMinutesAsHours(bank.recentMinutes)} desde mai/2025, mas ainda amortiza a dívida antiga
                                                    ({formatSignedMinutesAsHours(bank.oldMinutes)}). Sem bônus até quitar — saldo elegível atual:{" "}
                                                    {formatSignedMinutesAsHours(bank.bonusEligibleMinutes)}.
                                                </small>
                                            ) : !selectedDoctor.bankHoursSettlement ? (
                                                <small>Dentro de ±12h — sem acerto disponível.</small>
                                            ) : null}
                                            {bankError ? <p className="chief-payable-extra-feedback danger">{bankError}</p> : null}
                                        </article>
                                    );
                                })()}
                            </div>
                        </section>

                        {canManageClosing ? (
                            <section className="chief-payable-extra-form">
                                <header>
                                    <h4>Adicionar plantão extra</h4>
                                    <small>Entra em verde no quadro e conta no valor a pagar. Use para plantões que o bot não registrou.</small>
                                </header>
                                <div className="chief-payable-extra-fields">
                                    <label>
                                        <span>Dia</span>
                                        <select
                                            value={extraDay}
                                            onChange={(event) => setExtraDay(event.target.value)}
                                            disabled={extraBusy}
                                        >
                                            <option value="">—</option>
                                            {board.days.map((day) => (
                                                <option key={day} value={day}>{day}</option>
                                            ))}
                                        </select>
                                    </label>
                                    <label>
                                        <span>Turno</span>
                                        <select
                                            value={extraShift}
                                            onChange={(event) => setExtraShift(event.target.value === "SN" ? "SN" : "SD")}
                                            disabled={extraBusy}
                                        >
                                            <option value="SD">SD (diurno)</option>
                                            <option value="SN">SN (noturno)</option>
                                        </select>
                                    </label>
                                    <label>
                                        <span>Cobertura</span>
                                        <select
                                            value={extraCoverage}
                                            onChange={(event) => setExtraCoverage(event.target.value === "half" ? "half" : "full")}
                                            disabled={extraBusy}
                                        >
                                            <option value="full">Plantão inteiro (1.0)</option>
                                            <option value="half">Meio plantão (0.5)</option>
                                        </select>
                                    </label>
                                    <label>
                                        <span>Motivo (obrigatório, ≥2 caracteres)</span>
                                        <input
                                            type="text"
                                            value={extraLabel}
                                            onChange={(event) => setExtraLabel(event.target.value)}
                                            placeholder="ex.: plantão trocado"
                                            minLength={2}
                                            maxLength={40}
                                            required
                                            disabled={extraBusy}
                                        />
                                    </label>
                                    <button
                                        type="button"
                                        className="payment-button"
                                        onClick={() => void submitAddExtraShift(selectedDoctor.doctorId, selectedDoctor.doctorName)}
                                        disabled={extraBusy}
                                    >
                                        {extraBusy ? "Adicionando..." : "Adicionar plantão"}
                                    </button>
                                </div>
                                {extraError ? <p className="chief-payable-extra-feedback danger">{extraError}</p> : null}
                                {extraFeedback ? <p className="chief-payable-extra-feedback ok">{extraFeedback}</p> : null}
                            </section>
                        ) : null}

                        <section className={`chief-payable-attest-card ${isDoctorAttested(selectedDoctor) ? "on" : ""}`.trim()}>
                            <label className="chief-payable-attest-main">
                                <input
                                    type="checkbox"
                                    checked={isDoctorAttested(selectedDoctor)}
                                    onChange={(event) => {
                                        if (!canManageClosing) {
                                            return;
                                        }
                                        void toggleDoctorAttestation(selectedDoctor.doctorId, event.target.checked);
                                    }}
                                    disabled={!canManageClosing || attestBusyDoctorId === selectedDoctor.doctorId}
                                />
                                <span>
                                    <strong>Conferido e assinado</strong>
                                    <small>Já atestei a produtividade de {selectedDoctor.doctorName} em {board.monthLabel}.</small>
                                </span>
                            </label>
                            <p className="chief-payable-attest-hint">
                                {isDoctorAttested(selectedDoctor)
                                    ? "Assinado — não precisa olhar de novo. Desmarque se algo mudar."
                                    : "Antes de assinar, confira se falta lançar algum plantão extra (formulário acima)."}
                            </p>
                            {attestError && attestBusyDoctorId === null ? (
                                <p className="chief-payable-extra-feedback danger">{attestError}</p>
                            ) : null}
                        </section>

                        {(() => {
                            const profile = (selectedDoctor.paymentProfile ?? "generalist") as DoctorProfile;
                            const flatShifts = selectedDoctor.cells
                                .flatMap((cell) => cell.shifts)
                                .filter((shift) => !pendingRemovals.has(shift.payableShiftId))
                                .slice()
                                .sort((left, right) => {
                                    const byDate = left.operationalDate.localeCompare(right.operationalDate);
                                    if (byDate !== 0) return byDate;
                                    if (left.shiftLabel !== right.shiftLabel) return left.shiftLabel === "SD" ? -1 : 1;
                                    return left.targetCode.localeCompare(right.targetCode, "pt-BR");
                                });

                            return (
                                <section className="chief-payable-modal-shifts">
                                    <header>
                                        <h4>Plantão a plantão</h4>
                                        <small>Confira contra a nota fiscal do plantonista — {flatShifts.length} {flatShifts.length === 1 ? "plantão" : "plantões"}</small>
                                    </header>

                                    {flatShifts.length === 0 ? (
                                        <p className="chief-payable-modal-shifts-empty">Nenhum plantão pagável neste mês com os filtros atuais.</p>
                                    ) : (
                                        <ol className="chief-payable-modal-shifts-list">
                                            {flatShifts.map((shift) => {
                                                const { dayMonth, weekday } = formatOperationalDate(shift.operationalDate);
                                                const kindLabel = dayKindLabel(shift.operationalDate);
                                                const kindClass = dayKindClassName(shift.operationalDate);
                                                const value = resolveShiftAmount(shift, profile);
                                                const rate = isPremiumRateDate(shift.operationalDate)
                                                    ? PROFILE_RATES[profile].weekend
                                                    : PROFILE_RATES[profile].weekday;

                                                return (
                                                    <li key={shift.payableShiftId} className="chief-payable-modal-shift-row">
                                                        <span className="chief-payable-modal-shift-date">
                                                            <strong>{dayMonth}</strong>
                                                            <small>{weekday}</small>
                                                        </span>
                                                        <span className={`chief-payable-modal-shift-turn ${shift.shiftLabel === "SD" ? "sd" : "sn"} ${shift.source === "admin_extra" ? (shift.paymentUnit < 0 ? "admin-penalty" : "admin-extra") : ""}`.trim()}>
                                                            {shift.shiftLabel}
                                                        </span>
                                                        <span className="chief-payable-modal-shift-target">
                                                            {shift.source === "admin_extra" ? (shift.tagCode || "EXTRA") : shift.targetCode}
                                                            {shift.source === "admin_extra" ? <em className="chief-payable-modal-shift-half">{shift.paymentUnit < 0 ? "punição" : "extra"}</em> : null}
                                                            {shift.paymentTag ? <em className="chief-payable-modal-shift-half">{shift.paymentTag}</em> : null}
                                                        </span>
                                                        <span className={`chief-payable-modal-shift-kind ${kindClass}`}>{kindLabel}</span>
                                                        <span className="chief-payable-modal-shift-rate">
                                                            {formatCurrency(rate)}
                                                            {shift.paymentUnit !== 1 ? <em> × {formatUnits(shift.paymentUnit)}</em> : null}
                                                        </span>
                                                        <span className="chief-payable-modal-shift-value">{formatCurrency(value)}</span>
                                                    </li>
                                                );
                                            })}
                                        </ol>
                                    )}
                                </section>
                            );
                        })()}
                    </section>
                </div>
            ) : null}
        </main>
    );
}
