"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AdminGlobalNavigationLinks } from "@/components/admin-global-navigation-links";
import type { ChiefPayableBoardModel } from "@/modules/reporting/payable-shifts";
import { isPremiumRateDate } from "@/modules/operational/holidays";
import {
    compactMonthLabel,
    formatCurrency,
    formatUnits,
    normalize,
    resolveAmountCentsByDayKind,
    resolveOperationalDateFromIso,
    resolveSegmentShiftLabel,
    resolveShiftAmount,
    shiftMonthKey,
    targetComparator,
    weekdayShortLabel,
    type CoverageFilter,
    type DoctorEmploymentType,
    type DoctorProfile,
    type DomainFilter,
    type EmploymentTypeFilter,
    type MatrixRowModel,
    type PaymentStatusFilter,
    type ShiftFilter,
    type SortMode,
} from "./chief-payment-shared";
import { DoctorRow } from "./chief-payment-matrix-row";
import { ManualCorrectionDialog, SlotActionPopover, type ManualDraft, type SlotActionDraft } from "./chief-payment-dialogs";
import { DoctorDrawer, type DrawerConflictSegment } from "./chief-payment-doctor-drawer";

interface Props {
    board: ChiefPayableBoardModel;
    canManageClosing?: boolean;
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
const KPIS_STORAGE_KEY = "payment-closing.kpisOpen.v1";
const SEARCH_DEBOUNCE_MS = 150;
const ESTIMATED_ROW_HEIGHT = 40;

export function ChiefPaymentViewClient({ board, canManageClosing = true }: Props) {
    const router = useRouter();
    const [, startRefreshTransition] = useTransition();
    const requestRouterRefresh = useCallback(() => {
        startRefreshTransition(() => { router.refresh(); });
    }, [router]);

    // ── Filtros ─────────────────────────────────────────────────────────────
    const [search, setSearch] = useState("");
    const [debouncedSearch, setDebouncedSearch] = useState("");
    const [targetSearch, setTargetSearch] = useState("");
    const [debouncedTargetSearch, setDebouncedTargetSearch] = useState("");
    const [status, setStatus] = useState<PaymentStatusFilter>("all");
    const [employmentTypeFilter, setEmploymentTypeFilter] = useState<EmploymentTypeFilter>("all");
    const [shiftFilter, setShiftFilter] = useState<ShiftFilter>("all");
    const [domainFilter, setDomainFilter] = useState<DomainFilter>("all");
    const [coverageFilter, setCoverageFilter] = useState<CoverageFilter>("all");
    const [targetFilter, setTargetFilter] = useState("all");
    const [sortMode, setSortMode] = useState<SortMode>("name");
    const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);

    useEffect(() => {
        const timer = window.setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS);
        return () => window.clearTimeout(timer);
    }, [search]);

    useEffect(() => {
        const timer = window.setTimeout(() => setDebouncedTargetSearch(targetSearch), SEARCH_DEBOUNCE_MS);
        return () => window.clearTimeout(timer);
    }, [targetSearch]);

    // ── KPIs colapsáveis (persistidos) ──────────────────────────────────────
    const [kpisOpen, setKpisOpen] = useState(true);
    useEffect(() => {
        try {
            const stored = window.localStorage.getItem(KPIS_STORAGE_KEY);
            if (stored !== null) {
                setKpisOpen(stored !== "0");
            }
        } catch {}
    }, []);
    const toggleKpis = useCallback(() => {
        setKpisOpen((previous) => {
            const next = !previous;
            try {
                window.localStorage.setItem(KPIS_STORAGE_KEY, next ? "1" : "0");
            } catch {}
            return next;
        });
    }, []);

    // ── Flash de correção aplicada ──────────────────────────────────────────
    const [flash, setFlash] = useState<FlashRecord | null>(null);
    const [highlightKey, setHighlightKey] = useState<string | null>(null);
    const [coveragePanelOpen, setCoveragePanelOpen] = useState(false);

    // ── Correção manual ─────────────────────────────────────────────────────
    const [manualDraft, setManualDraft] = useState<ManualDraft | null>(null);
    const [manualDoctorName, setManualDoctorName] = useState("");
    const [manualDisableReason, setManualDisableReason] = useState("");
    const [manualMode, setManualMode] = useState<"assign" | "disable">("assign");
    const [manualBusy, setManualBusy] = useState(false);
    const [manualError, setManualError] = useState<string | null>(null);
    const [manualFeedback, setManualFeedback] = useState<string | null>(null);

    // ── Overrides otimistas de perfil/vínculo/meta ──────────────────────────
    const [profileBusyDoctorId, setProfileBusyDoctorId] = useState<string | null>(null);
    const [doctorProfileOverrides, setDoctorProfileOverrides] = useState<Record<string, DoctorProfile>>({});
    const [employmentTypeBusyDoctorId, setEmploymentTypeBusyDoctorId] = useState<string | null>(null);
    const [doctorEmploymentTypeOverrides, setDoctorEmploymentTypeOverrides] = useState<Record<string, DoctorEmploymentType>>({});
    // Última NF/processo confirmados pelo servidor por médico — evita depender só do
    // router.refresh() (assíncrono) para o drawer mostrar o valor recém-salvo ao reabrir.
    const [doctorMetaOverrides, setDoctorMetaOverrides] = useState<Record<string, { invoiceNumber: string | null; paymentProcessNumber: string | null }>>({});

    // ── Drawer do médico ────────────────────────────────────────────────────
    const [drawerDoctorId, setDrawerDoctorId] = useState<string | null>(null);
    // Espelha drawerDoctorId para leitura em callbacks assíncronos (ex.: resposta de
    // save chegando depois que o admin já trocou/fechou o drawer do médico).
    const drawerDoctorIdRef = useRef<string | null>(null);
    useEffect(() => {
        drawerDoctorIdRef.current = drawerDoctorId;
    }, [drawerDoctorId]);

    // ── Popover de ações do slot ────────────────────────────────────────────
    const [slotPopover, setSlotPopover] = useState<SlotActionDraft | null>(null);
    const [pendingRemovals, setPendingRemovals] = useState<Set<string>>(new Set());
    const [shiftActionBusy, setShiftActionBusy] = useState(false);
    const [shiftActionError, setShiftActionError] = useState<string | null>(null);

    // ── Formulário "adicionar plantão extra" dentro do drawer ───────────────
    const [extraDay, setExtraDay] = useState("");
    const [extraShift, setExtraShift] = useState<"SD" | "SN">("SD");
    const [extraCoverage, setExtraCoverage] = useState<"full" | "half">("full");
    const [extraLabel, setExtraLabel] = useState("");
    const [extraBusy, setExtraBusy] = useState(false);
    const [extraError, setExtraError] = useState<string | null>(null);
    const [extraFeedback, setExtraFeedback] = useState<string | null>(null);

    // ── Acompanhamento financeiro do drawer ─────────────────────────────────
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

    // ── Atestação ───────────────────────────────────────────────────────────
    const [attestationOverrides, setAttestationOverrides] = useState<Record<string, boolean>>({});
    const [attestBusyDoctorId, setAttestBusyDoctorId] = useState<string | null>(null);
    const [attestError, setAttestError] = useState<string | null>(null);
    // Quando o board chega atualizado, descarta os estados otimistas de atestação.
    useEffect(() => {
        setAttestationOverrides({});
    }, [board]);

    // Limpa o formulário de plantão extra ao trocar de médico / fechar o drawer.
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
        const baseDoctor = board.doctors.find((doctor) => doctor.doctorId === drawerDoctorId);
        const metaOverride = drawerDoctorId ? doctorMetaOverrides[drawerDoctorId] : undefined;
        setInvoiceDraft(metaOverride?.invoiceNumber ?? baseDoctor?.invoiceNumber ?? "");
        setProcessDraft(metaOverride?.paymentProcessNumber ?? baseDoctor?.paymentProcessNumber ?? "");
        setContractDraft("");
        setMetaError(null);
        setMetaFeedback(null);
        setContractError(null);
        setBankError(null);
        // Semeado só ao (re)abrir o drawer de um médico — não a cada refresh do board,
        // para não apagar o feedback de "salvos" nem o que o admin está digitando.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [drawerDoctorId]);

    const normalized = normalize(debouncedSearch);
    const normalizedTarget = normalize(debouncedTargetSearch);

    function isDoctorAttested(target: { doctorId: string; attestedAt: string | null }) {
        const override = attestationOverrides[target.doctorId];
        return override !== undefined ? override : Boolean(target.attestedAt);
    }

    // ── Linhas da matriz (filtros + overrides + totais) ─────────────────────
    const matrixRows = useMemo<MatrixRowModel[]>(() => {
        const rows = board.doctors
            .map((doctor) => {
                const paymentProfile = doctorProfileOverrides[doctor.doctorId] ?? (doctor.paymentProfile ?? "generalist") as DoctorProfile;
                const employmentType = doctorEmploymentTypeOverrides[doctor.doctorId] ?? (doctor.employmentType ?? "pj") as DoctorEmploymentType;
                const cells = doctor.cells.map((cell) => ({
                    day: cell.day,
                    shifts: cell.shifts.filter((shift) => {
                        if (pendingRemovals.has(shift.payableShiftId)) {
                            return false;
                        }

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

                const visibleShifts = cells.flatMap((cell) => cell.shifts);
                const totalSD = Number(visibleShifts
                    .filter((shift) => shift.shiftLabel === "SD")
                    .reduce((sum, shift) => sum + shift.paymentUnit, 0)
                    .toFixed(2));
                const totalSN = Number(visibleShifts
                    .filter((shift) => shift.shiftLabel === "SN")
                    .reduce((sum, shift) => sum + shift.paymentUnit, 0)
                    .toFixed(2));
                const total = Number(visibleShifts.reduce((sum, shift) => sum + shift.paymentUnit, 0).toFixed(2));
                // Conta em UNIDADES de plantão: meio plantão vale 0,5 (não 1).
                const weekdayShiftCount = Number(visibleShifts
                    .filter((shift) => !isPremiumRateDate(shift.operationalDate))
                    .reduce((sum, shift) => sum + shift.paymentUnit, 0)
                    .toFixed(2));
                const weekendShiftCount = Number(visibleShifts
                    .filter((shift) => isPremiumRateDate(shift.operationalDate))
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
                const pendingCount = visibleShifts.filter((shift) => shift.paymentStatus === "needs_review").length;
                const attested = isDoctorAttested(doctor);
                const metaOverride = doctorMetaOverrides[doctor.doctorId];

                return {
                    doctorId: doctor.doctorId,
                    doctorName: doctor.doctorName,
                    displayName: doctor.displayName,
                    paymentProfile,
                    employmentType,
                    paymentStatus: doctor.paymentStatus,
                    attested,
                    isReady: doctor.paymentStatus === "ready_for_payment" && attested,
                    pendingCount,
                    totalSD,
                    totalSN,
                    total,
                    weekdayShiftCount,
                    weekendShiftCount,
                    weekdayDue: weekdayDueCents / 100,
                    weekendDue: weekendDueCents / 100,
                    totalDue: (weekdayDueCents + weekendDueCents) / 100,
                    invoiceNumber: metaOverride?.invoiceNumber ?? doctor.invoiceNumber ?? null,
                    paymentProcessNumber: metaOverride?.paymentProcessNumber ?? doctor.paymentProcessNumber ?? null,
                    contractCeilingBrl: doctor.contractCeilingBrl ?? null,
                    contractSeedMonth: doctor.contractSeedMonth ?? null,
                    contractBalanceBrl: doctor.contractBalanceBrl ?? null,
                    bankHoursMinutes: doctor.bankHoursMinutes ?? null,
                    bankHoursSettlement: doctor.bankHoursSettlement ?? null,
                    cells,
                } satisfies MatrixRowModel;
            })
            .filter((row) => {
                if (status === "ready" && !row.isReady) {
                    return false;
                }

                if (status === "review" && row.isReady) {
                    return false;
                }

                if (employmentTypeFilter !== "all" && row.employmentType !== employmentTypeFilter) {
                    return false;
                }

                if (normalized) {
                    const haystack = normalize([row.doctorName, row.displayName ?? ""].join(" "));
                    if (!haystack.includes(normalized)) {
                        return false;
                    }
                }

                return row.total > 0;
            });

        return rows.sort((left, right) => {
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
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [attestationOverrides, board.doctors, coverageFilter, doctorEmploymentTypeOverrides, doctorMetaOverrides, doctorProfileOverrides, domainFilter, employmentTypeFilter, normalized, normalizedTarget, pendingRemovals, shiftFilter, sortMode, status, targetFilter]);

    // Índice payableShiftId → linha/plantão visível, para abrir o popover por id.
    const shiftIndex = useMemo(() => {
        const index = new Map<string, { row: MatrixRowModel; shift: MatrixRowModel["cells"][number]["shifts"][number]; day: string }>();
        for (const row of matrixRows) {
            for (const cell of row.cells) {
                for (const shift of cell.shifts) {
                    index.set(shift.payableShiftId, { row, shift, day: cell.day });
                }
            }
        }
        return index;
    }, [matrixRows]);

    // ── Estatísticas board-wide (KPIs estáveis, só descontam remoções) ──────
    const readyStats = useMemo(() => {
        let ready = 0;
        for (const doctor of board.doctors) {
            if (doctor.paymentStatus === "ready_for_payment" && isDoctorAttested(doctor)) {
                ready += 1;
            }
        }
        return { ready, review: board.doctors.length - ready };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [attestationOverrides, board.doctors]);

    const unitStats = useMemo(() => {
        let sdUnits = 0;
        let snUnits = 0;
        for (const shift of board.payableShifts) {
            if (pendingRemovals.has(shift.payableShiftId)) {
                continue;
            }
            if (shift.shiftLabel === "SD") {
                sdUnits += shift.paymentUnit;
            } else {
                snUnits += shift.paymentUnit;
            }
        }
        return {
            sdUnits: Number(sdUnits.toFixed(2)),
            snUnits: Number(snUnits.toFixed(2)),
            totalUnits: Number((sdUnits + snUnits).toFixed(2)),
        };
    }, [board.payableShifts, pendingRemovals]);

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
                .filter((shift) => !isPremiumRateDate(shift.operationalDate))
                .reduce((doctorSum, shift) => doctorSum + shift.paymentUnit, 0);
            const weekendUnits = doctorShifts
                .filter((shift) => isPremiumRateDate(shift.operationalDate))
                .reduce((doctorSum, shift) => doctorSum + shift.paymentUnit, 0);
            totalsCents[employmentType] += resolveAmountCentsByDayKind({
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
        }

        return {
            pj: { totalDue: totalsCents.pj / 100, doctorCount: doctorCounts.pj },
            estatutario: { totalDue: totalsCents.estatutario / 100, doctorCount: doctorCounts.estatutario },
        };
    }, [board.doctors, doctorProfileOverrides, doctorEmploymentTypeOverrides, pendingRemovals]);

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

    const peakDay = useMemo(() => {
        if (dayLoad.length === 0) {
            return null;
        }
        return [...dayLoad].sort((left, right) => right.count - left.count)[0] ?? null;
    }, [dayLoad]);

    const maxDayLoad = useMemo(() => Math.max(...dayLoad.map((entry) => entry.count), 1), [dayLoad]);

    // ── Pendências de cobertura (fora da matriz) ────────────────────────────
    const coverageByDay = useMemo(() => {
        const map = new Map<string, { uncovered: typeof board.uncoveredTargets; disabled: typeof board.disabledTargets }>();
        for (const day of board.days) {
            map.set(day, { uncovered: [], disabled: [] });
        }
        for (const item of board.uncoveredTargets) {
            map.get(item.day)?.uncovered.push(item);
        }
        for (const item of board.disabledTargets) {
            map.get(item.day)?.disabled.push(item);
        }
        return board.days
            .map((day) => ({ day, ...map.get(day)! }))
            .filter((entry) => entry.uncovered.length > 0 || entry.disabled.length > 0);
    }, [board.days, board.disabledTargets, board.uncoveredTargets]);

    // ── Alvos para o popover "Mais filtros" ─────────────────────────────────
    const targetSectors = useMemo(() => {
        const base = board.targetOptions
            .map((target) => ({
                ...target,
                isUsa: normalize(`${target.targetCode} ${target.targetLabel}`).includes("usa"),
            }))
            .sort(targetComparator);

        const usa = base.filter((target) => target.isUsa);
        const regulation = base.filter((target) => target.domain === "regulation" && !target.isUsa);
        const intervention = base.filter((target) => target.domain === "intervention" && !target.isUsa);

        return [
            { key: "usa", title: "USA", targets: usa },
            { key: "regulation", title: "Regulação", targets: regulation },
            { key: "intervention", title: "Intervenção", targets: intervention },
        ].filter((sector) => sector.targets.length > 0);
    }, [board.targetOptions]);

    const advancedFilterCount = (domainFilter !== "all" ? 1 : 0)
        + (coverageFilter !== "all" ? 1 : 0)
        + (targetFilter !== "all" ? 1 : 0)
        + (normalizedTarget ? 1 : 0)
        + (sortMode !== "name" ? 1 : 0);

    const clearAdvancedFilters = useCallback(() => {
        setDomainFilter("all");
        setCoverageFilter("all");
        setTargetFilter("all");
        setTargetSearch("");
        setSortMode("name");
    }, []);

    // ── Dias premium + template da grade ────────────────────────────────────
    const premiumDays = useMemo(
        () => board.days.map((day) => isPremiumRateDate(`${board.monthKey}-${day}`)),
        [board.days, board.monthKey],
    );

    const dayHeaders = useMemo(
        () => board.days.map((day, index) => ({
            day,
            weekday: weekdayShortLabel(`${board.monthKey}-${day}`),
            premium: premiumDays[index],
        })),
        [board.days, board.monthKey, premiumDays],
    );

    const gridTemplate = useMemo(
        () => `var(--cmx-doc-w) repeat(${board.days.length}, var(--cmx-day-w)) var(--cmx-tot-w) var(--cmx-tot-w) var(--cmx-due-w)`,
        [board.days.length],
    );

    // ── Virtualização das linhas ────────────────────────────────────────────
    const matrixScrollRef = useRef<HTMLDivElement | null>(null);
    const rowVirtualizer = useVirtualizer({
        count: matrixRows.length,
        getScrollElement: () => matrixScrollRef.current,
        estimateSize: () => ESTIMATED_ROW_HEIGHT,
        overscan: 8,
        getItemKey: (index) => matrixRows[index]?.doctorId ?? index,
    });
    const virtualRows = rowVirtualizer.getVirtualItems();

    // ── Reconciliação de remoções otimistas com a verdade do servidor ───────
    useEffect(() => {
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

    // ── Flash: carregar/persistir/localizar ─────────────────────────────────
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

    const pendingLocateRef = useRef<FlashRecord | null>(null);
    const [locateNonce, setLocateNonce] = useState(0);

    const locateFlashCell = useCallback(() => {
        if (!flash) return false;
        setStatus("all");
        setShiftFilter("all");
        setDomainFilter("all");
        setCoverageFilter("all");
        setTargetFilter("all");
        setEmploymentTypeFilter("all");
        setSearch("");
        setDebouncedSearch("");
        setTargetSearch("");
        setDebouncedTargetSearch("");

        if (flash.kind === "disable") {
            // Slots desativados/removidos vivem no painel de pendências, não na matriz.
            setCoveragePanelOpen(true);
            setHighlightKey(`${flash.domain}|${flash.targetCode}|${flash.day}|${flash.shiftLabel}|disable`);
            window.setTimeout(() => setHighlightKey(null), 4500);
            window.scrollTo({ top: 0, behavior: "smooth" });
            return true;
        }

        pendingLocateRef.current = flash;
        setLocateNonce((nonce) => nonce + 1);
        return true;
    }, [flash]);

    useEffect(() => {
        const pending = pendingLocateRef.current;
        if (!pending) return;
        const index = matrixRows.findIndex((row) => row.cells.some((cell) => cell.day === pending.day
            && cell.shifts.some((shift) => shift.domain === pending.domain
                && shift.targetCode === pending.targetCode
                && shift.shiftLabel === pending.shiftLabel)));
        if (index === -1) {
            // Ainda esperando o board refletir a correção (router.refresh em voo).
            return;
        }
        pendingLocateRef.current = null;
        rowVirtualizer.scrollToIndex(index, { align: "center" });

        const selector = `[data-flash-key="assign|${pending.domain}|${pending.targetCode}|${pending.day}|${pending.shiftLabel}"]`;
        let attempts = 0;
        const tryLocate = () => {
            const container = matrixScrollRef.current;
            const element = container?.querySelector<HTMLElement>(selector);
            if (element && container) {
                const elementRect = element.getBoundingClientRect();
                const containerRect = container.getBoundingClientRect();
                const targetLeft = container.scrollLeft + (elementRect.left - containerRect.left) - (containerRect.width / 2) + (elementRect.width / 2);
                container.scrollTo({ left: Math.max(0, targetLeft), behavior: "smooth" });
                setHighlightKey(`${pending.domain}|${pending.targetCode}|${pending.day}|${pending.shiftLabel}|assign`);
                window.setTimeout(() => setHighlightKey(null), 4500);
                return true;
            }
            return false;
        };
        const schedule = () => {
            if (tryLocate()) return;
            attempts += 1;
            if (attempts < 10) {
                window.setTimeout(schedule, 120);
            }
        };
        requestAnimationFrame(schedule);
    }, [matrixRows, locateNonce, rowVirtualizer]);

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

    // ── Ações remotas ───────────────────────────────────────────────────────
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
            if (status === "review") {
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
        if (!slotPopover) return;
        const draft = slotPopover;
        setShiftActionBusy(true);
        setShiftActionError(null);

        // Otimista: esconde a célula imediatamente (todas as parcelas da mesma ocupação).
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
                setSlotPopover(null);
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
            setSlotPopover(null);
            requestRouterRefresh();
        } catch (error) {
            // Rollback do otimista.
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
            if (status === "review") {
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

    // Auto-salva NF/processo ao sair do campo (blur) — inclui fechar o drawer, pois
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
            // o drawer antes do refresh do board terminar.
            if (body?.meta) {
                setDoctorMetaOverrides((prev) => ({
                    ...prev,
                    [doctorId]: { invoiceNumber: body.meta!.invoiceNumber, paymentProcessNumber: body.meta!.paymentProcessNumber },
                }));
                // Só escreve nos campos visíveis se o drawer ainda for deste médico —
                // senão uma resposta atrasada pisa no que já foi digitado para outro.
                if (drawerDoctorIdRef.current === doctorId) {
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
            if (status === "review") {
                setStatus("all");
            }
            requestRouterRefresh();
        } catch (error) {
            setBankError(error instanceof Error ? error.message : "Falha ao lançar o acerto.");
        } finally {
            setBankBusy(false);
        }
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

    // ── Abertura de drawer/popover a partir da matriz (delegação) ───────────
    const openDoctorDrawer = useCallback((doctorId: string) => {
        setDrawerDoctorId(doctorId);
    }, []);

    const openSlotPopover = useCallback((payableShiftId: string) => {
        const entry = shiftIndex.get(payableShiftId);
        if (!entry) {
            return;
        }
        const { row, shift, day } = entry;
        setShiftActionError(null);
        setSlotPopover({
            payableShiftId: shift.payableShiftId,
            occupancyId: shift.occupancyId,
            domain: shift.domain,
            targetCode: shift.targetCode,
            targetLabel: shift.targetLabel,
            day,
            shiftLabel: shift.shiftLabel,
            doctorName: row.doctorName,
            source: shift.source,
            paymentTag: shift.paymentTag,
            paymentUnit: shift.paymentUnit,
            amountLabel: formatCurrency(resolveShiftAmount(shift, row.paymentProfile, row.employmentType)),
        });
    }, [shiftIndex]);

    const startReassign = useCallback(() => {
        if (!slotPopover) {
            return;
        }
        setManualDraft({
            domain: slotPopover.domain,
            targetCode: slotPopover.targetCode,
            targetLabel: slotPopover.targetLabel,
            day: slotPopover.day,
            shiftLabel: slotPopover.shiftLabel,
            sourceType: "reassign",
            reason: `atual: ${slotPopover.doctorName}`,
        });
        setManualDoctorName("");
        setManualDisableReason("");
        setManualMode("assign");
        setManualError(null);
        setSlotPopover(null);
    }, [slotPopover]);

    const openCoverageCorrection = useCallback((item: {
        domain: "regulation" | "intervention";
        targetCode: string;
        targetLabel: string;
        day: string;
        shiftLabel: "SD" | "SN";
        sourceType: "disabled" | "uncovered";
        reason: string | null;
    }) => {
        if (!canManageClosing) {
            return;
        }
        setManualDraft({
            domain: item.domain,
            targetCode: item.targetCode,
            targetLabel: item.targetLabel,
            day: item.day,
            shiftLabel: item.shiftLabel,
            sourceType: item.sourceType,
            reason: item.reason,
        });
        setManualDoctorName("");
        setManualDisableReason("");
        setManualMode("assign");
        setManualError(null);
    }, [canManageClosing]);

    // ── Drawer: médico selecionado + conflitos de alocação ──────────────────
    const drawerDoctor = useMemo(
        () => matrixRows.find((row) => row.doctorId === drawerDoctorId) ?? null,
        [matrixRows, drawerDoctorId],
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

        return Array.from(uniqueBySlot.values());
    }, [board.payableShifts]);

    const drawerConflictSegments = useMemo<DrawerConflictSegment[]>(() => {
        if (!drawerDoctor) {
            return [];
        }

        const conflictBySlot = new Map<string, typeof allocationConflictShifts[number]>();
        for (const shift of allocationConflictShifts) {
            const key = [shift.operationalDate, shift.shiftLabel, shift.domain, shift.targetCode].join("|");
            conflictBySlot.set(key, shift);
        }

        const matches = board.attestationSegments
            .filter((segment) => segment.doctorId === drawerDoctor.doctorId)
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
    }, [allocationConflictShifts, board.attestationSegments, drawerDoctor]);

    const uncoveredCount = board.uncoveredTargets.length;
    const disabledCount = board.disabledTargets.length;
    const monthTitle = compactMonthLabel(board.monthLabel);

    // ── Render ──────────────────────────────────────────────────────────────
    return (
        <main className="chief-payable-shell chief-matrix-shell">
            <div className="chief-matrix-toolbar">
                <div className="chief-matrix-toolbar-month">
                    <span className="chief-matrix-eyebrow">Fechamento</span>
                    <a
                        className="chief-matrix-month-btn"
                        href={`/admin/payment-closing?month=${shiftMonthKey(board.monthKey, -1)}`}
                        aria-label="Mês anterior"
                    >
                        ‹
                    </a>
                    <strong className="chief-matrix-month-label">{monthTitle}</strong>
                    <a
                        className="chief-matrix-month-btn"
                        href={`/admin/payment-closing?month=${shiftMonthKey(board.monthKey, 1)}`}
                        aria-label="Próximo mês"
                    >
                        ›
                    </a>
                </div>

                <label className="chief-matrix-search">
                    <span aria-hidden="true">⌕</span>
                    <input
                        type="search"
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder="Buscar médico…"
                        aria-label="Buscar médico"
                    />
                </label>

                <div className="chief-matrix-pills" role="group" aria-label="Status">
                    <button type="button" className={`chief-matrix-pill ${status === "all" ? "active" : ""}`.trim()} onClick={() => setStatus("all")}>
                        Todos ({board.summary.doctorCount})
                    </button>
                    <button type="button" className={`chief-matrix-pill ${status === "ready" ? "active" : ""}`.trim()} onClick={() => setStatus("ready")}>
                        Prontos ({readyStats.ready})
                    </button>
                    <button type="button" className={`chief-matrix-pill ${status === "review" ? "active" : ""}`.trim()} onClick={() => setStatus("review")}>
                        Pendências ({readyStats.review})
                    </button>
                </div>

                <div className="chief-matrix-pills" role="group" aria-label="Turno">
                    <button type="button" className={`chief-matrix-pill ${shiftFilter === "all" ? "active" : ""}`.trim()} onClick={() => setShiftFilter("all")}>
                        SD+SN
                    </button>
                    <button type="button" className={`chief-matrix-pill ${shiftFilter === "SD" ? "active" : ""}`.trim()} onClick={() => setShiftFilter("SD")}>
                        SD
                    </button>
                    <button type="button" className={`chief-matrix-pill ${shiftFilter === "SN" ? "active" : ""}`.trim()} onClick={() => setShiftFilter("SN")}>
                        SN
                    </button>
                </div>

                <div className="chief-matrix-pills" role="group" aria-label="Vínculo">
                    <button type="button" className={`chief-matrix-pill ${employmentTypeFilter === "all" ? "active" : ""}`.trim()} onClick={() => setEmploymentTypeFilter("all")}>
                        Todos
                    </button>
                    <button type="button" className={`chief-matrix-pill ${employmentTypeFilter === "pj" ? "active" : ""}`.trim()} onClick={() => setEmploymentTypeFilter("pj")}>
                        PJ ({dueAmountByEmploymentType.pj.doctorCount})
                    </button>
                    <button type="button" className={`chief-matrix-pill ${employmentTypeFilter === "estatutario" ? "active" : ""}`.trim()} onClick={() => setEmploymentTypeFilter("estatutario")}>
                        Estatutário ({dueAmountByEmploymentType.estatutario.doctorCount})
                    </button>
                </div>

                <div className="chief-matrix-toolbar-anchor">
                    <button
                        type="button"
                        className={`chief-matrix-btn ${advancedFilterCount > 0 ? "flagged" : ""}`.trim()}
                        onClick={() => setMoreFiltersOpen((open) => !open)}
                        aria-expanded={moreFiltersOpen}
                    >
                        Mais filtros{advancedFilterCount > 0 ? ` · ${advancedFilterCount}` : ""}
                    </button>

                    {moreFiltersOpen ? (
                        <>
                            <div className="chief-matrix-popover-backdrop" role="presentation" onClick={() => setMoreFiltersOpen(false)} />
                            <section className="chief-matrix-filters-pop" role="dialog" aria-label="Mais filtros">
                                <header>
                                    <strong>Mais filtros</strong>
                                    <div>
                                        {advancedFilterCount > 0 ? (
                                            <button type="button" className="chief-matrix-btn compact" onClick={clearAdvancedFilters}>
                                                Limpar
                                            </button>
                                        ) : null}
                                        <button type="button" className="chief-matrix-icon-btn" onClick={() => setMoreFiltersOpen(false)} aria-label="Fechar">✕</button>
                                    </div>
                                </header>

                                <div className="chief-matrix-filters-pop-row" role="group" aria-label="Domínio">
                                    <span>Domínio</span>
                                    <div className="chief-matrix-pills">
                                        <button type="button" className={`chief-matrix-pill ${domainFilter === "all" ? "active" : ""}`.trim()} onClick={() => setDomainFilter("all")}>
                                            Regulação + Intervenção
                                        </button>
                                        <button type="button" className={`chief-matrix-pill ${domainFilter === "regulation" ? "active" : ""}`.trim()} onClick={() => setDomainFilter("regulation")}>
                                            Regulação
                                        </button>
                                        <button type="button" className={`chief-matrix-pill ${domainFilter === "intervention" ? "active" : ""}`.trim()} onClick={() => setDomainFilter("intervention")}>
                                            Intervenção
                                        </button>
                                    </div>
                                </div>

                                <div className="chief-matrix-filters-pop-row" role="group" aria-label="Cobertura">
                                    <span>Cobertura</span>
                                    <div className="chief-matrix-pills">
                                        <button type="button" className={`chief-matrix-pill ${coverageFilter === "all" ? "active" : ""}`.trim()} onClick={() => setCoverageFilter("all")}>
                                            Completa + meio
                                        </button>
                                        <button type="button" className={`chief-matrix-pill ${coverageFilter === "half" ? "active" : ""}`.trim()} onClick={() => setCoverageFilter("half")}>
                                            Somente meio
                                        </button>
                                        <button type="button" className={`chief-matrix-pill ${coverageFilter === "full" ? "active" : ""}`.trim()} onClick={() => setCoverageFilter("full")}>
                                            Sem meio
                                        </button>
                                    </div>
                                </div>

                                <div className="chief-matrix-filters-pop-row">
                                    <span>Ordenar por</span>
                                    <select value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)}>
                                        <option value="name">Nome</option>
                                        <option value="pending">Pendências</option>
                                        <option value="total">Total</option>
                                        <option value="weekday">Dia útil</option>
                                        <option value="weekend">Fim de semana / feriado</option>
                                    </select>
                                </div>

                                <div className="chief-matrix-filters-pop-row">
                                    <span>Filtrar alvo</span>
                                    <input
                                        type="search"
                                        value={targetSearch}
                                        onChange={(event) => setTargetSearch(event.target.value)}
                                        placeholder="Ex.: BR60, PM04, USA"
                                    />
                                </div>

                                <div className="chief-matrix-filters-pop-targets">
                                    <button
                                        type="button"
                                        className={`chief-matrix-pill ${targetFilter === "all" ? "active" : ""}`.trim()}
                                        onClick={() => setTargetFilter("all")}
                                    >
                                        Todas as bases/ramais
                                    </button>
                                    {targetSectors.map((sector) => (
                                        <div key={sector.key} className="chief-matrix-filters-pop-sector">
                                            <span>{sector.title}</span>
                                            <div className="chief-matrix-pills wrap">
                                                {sector.targets.map((target) => {
                                                    const value = `${target.domain}|${target.targetCode}`;
                                                    return (
                                                        <button
                                                            type="button"
                                                            key={value}
                                                            className={`chief-matrix-pill compact ${targetFilter === value ? "active" : ""}`.trim()}
                                                            onClick={() => setTargetFilter(targetFilter === value ? "all" : value)}
                                                            title={`${target.targetCode} · ${target.targetLabel}`}
                                                        >
                                                            {target.targetCode}
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    ))}
                                </div>

                                <p className="chief-matrix-filters-pop-hint">Ordem rápida: 01 · 02 · 03 · 04 · 05 · 10 · 20</p>
                            </section>
                        </>
                    ) : null}
                </div>

                <div className="chief-matrix-toolbar-spacer" />

                <button type="button" className="chief-matrix-btn" onClick={toggleKpis}>
                    {kpisOpen ? "Ocultar resumo" : "Mostrar resumo"}
                </button>
                {canManageClosing ? (
                    <a className="chief-matrix-btn gold" href={`/api/admin/reports/export?month=${board.monthKey}`}>
                        Exportar XLSX
                    </a>
                ) : null}
            </div>

            {kpisOpen ? (
                <div className="chief-matrix-kpis">
                    <div className="chief-matrix-kpi gold">
                        <span>Total a pagar (PJ)</span>
                        <strong>{formatCurrency(dueAmountByEmploymentType.pj.totalDue)}</strong>
                        <small>{dueAmountByEmploymentType.pj.doctorCount} médicos PJ · {dueAmountByEmploymentType.estatutario.doctorCount} estatutários (R$ 0)</small>
                    </div>
                    <div className="chief-matrix-kpi">
                        <span>Unidades no mês</span>
                        <strong>{formatUnits(unitStats.totalUnits)}</strong>
                        <small>{formatUnits(unitStats.sdUnits)} SD · {formatUnits(unitStats.snUnits)} SN</small>
                    </div>
                    <div className="chief-matrix-kpi ready">
                        <span>Prontos p/ pagamento</span>
                        <strong>{readyStats.ready}</strong>
                        <small>atestados e sem pendência</small>
                    </div>
                    <button type="button" className="chief-matrix-kpi review actionable" onClick={() => setCoveragePanelOpen((open) => !open)} aria-expanded={coveragePanelOpen}>
                        <span>Com pendências</span>
                        <strong>{readyStats.review}</strong>
                        <small>{uncoveredCount} posições sem cobertura · {disabledCount} desativadas</small>
                    </button>
                    <div className="chief-matrix-kpi bars">
                        <span>Carga por dia · pico dia {peakDay ? peakDay.day : "--"}</span>
                        <div className="chief-matrix-kpi-bars" aria-hidden="true">
                            {dayLoad.map((entry, index) => (
                                <i
                                    key={entry.day}
                                    className={premiumDays[index] ? "we" : undefined}
                                    style={{ height: `${Math.max(8, Math.round((entry.count / maxDayLoad) * 100))}%` }}
                                    title={`Dia ${entry.day}: ${entry.count} plantões`}
                                />
                            ))}
                        </div>
                    </div>
                </div>
            ) : null}

            {coveragePanelOpen ? (
                <section className="chief-matrix-coverage">
                    <header>
                        <div>
                            <strong>Pendências de cobertura</strong>
                            <small>
                                {uncoveredCount} sem médico · {disabledCount} desativadas
                                {canManageClosing ? " — clique numa posição para corrigir" : ""}
                            </small>
                        </div>
                        <button type="button" className="chief-matrix-icon-btn" onClick={() => setCoveragePanelOpen(false)} aria-label="Fechar painel">✕</button>
                    </header>
                    {coverageByDay.length === 0 ? (
                        <p className="chief-matrix-coverage-empty">Nenhuma posição pendente neste mês.</p>
                    ) : (
                        <div className="chief-matrix-coverage-days">
                            {coverageByDay.map((entry) => (
                                <div key={entry.day} className="chief-matrix-coverage-day">
                                    <strong>{entry.day}</strong>
                                    <div>
                                        {entry.uncovered.map((item) => (
                                            <button
                                                key={item.snapshotId}
                                                type="button"
                                                className={`chief-matrix-coverage-chip uncovered ${item.shiftLabel === "SD" ? "sd" : "sn"} ${highlightKey === `${item.domain}|${item.targetCode}|${item.day}|${item.shiftLabel}|disable` ? "flash" : ""}`.trim()}
                                                data-flash-key={`disable|${item.domain}|${item.targetCode}|${item.day}|${item.shiftLabel}`}
                                                title={`Sem médico · ${item.targetCode} ${item.shiftLabel}${item.reason ? ` · ${item.reason}` : ""}`}
                                                onClick={() => openCoverageCorrection({
                                                    domain: item.domain,
                                                    targetCode: item.targetCode,
                                                    targetLabel: item.targetLabel,
                                                    day: item.day,
                                                    shiftLabel: item.shiftLabel,
                                                    sourceType: "uncovered",
                                                    reason: item.reason ?? null,
                                                })}
                                            >
                                                {item.targetCode}{item.shiftLabel}
                                            </button>
                                        ))}
                                        {entry.disabled.map((item) => (
                                            <button
                                                key={item.snapshotId}
                                                type="button"
                                                className={`chief-matrix-coverage-chip disabled ${item.shiftLabel === "SD" ? "sd" : "sn"} ${highlightKey === `${item.domain}|${item.targetCode}|${item.day}|${item.shiftLabel}|disable` ? "flash" : ""}`.trim()}
                                                data-flash-key={`disable|${item.domain}|${item.targetCode}|${item.day}|${item.shiftLabel}`}
                                                title={`Desativada · ${item.targetCode} ${item.shiftLabel}${item.disabledReason ? ` · ${item.disabledReason}` : ""}`}
                                                onClick={() => openCoverageCorrection({
                                                    domain: item.domain,
                                                    targetCode: item.targetCode,
                                                    targetLabel: item.targetLabel,
                                                    day: item.day,
                                                    shiftLabel: item.shiftLabel,
                                                    sourceType: "disabled",
                                                    reason: item.disabledReason ?? null,
                                                })}
                                            >
                                                {item.targetCode}{item.shiftLabel}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </section>
            ) : null}

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

            <section className="chief-matrix-card">
                <div className="chief-matrix-scroll" ref={matrixScrollRef}>
                    <div className="chief-matrix-inner">
                        <div className="chief-matrix-head" style={{ gridTemplateColumns: gridTemplate }} role="row">
                            <div className="chief-matrix-corner">Médico ({matrixRows.length})</div>
                            {dayHeaders.map((header) => (
                                <div key={header.day} className={`chief-matrix-day ${header.premium ? "we" : ""}`.trim()}>
                                    <span>{header.day}</span>
                                    <small>{header.weekday}</small>
                                </div>
                            ))}
                            <div className="chief-matrix-headcell sd">SD</div>
                            <div className="chief-matrix-headcell sn">SN</div>
                            <div className="chief-matrix-headcell due">Valor mês</div>
                        </div>

                        {matrixRows.length === 0 ? (
                            <p className="chief-matrix-empty">Nenhum médico encontrado com os filtros atuais.</p>
                        ) : (
                            <div className="chief-matrix-body" style={{ height: rowVirtualizer.getTotalSize() }}>
                                {virtualRows.map((virtualRow) => {
                                    const row = matrixRows[virtualRow.index];
                                    if (!row) {
                                        return null;
                                    }
                                    return (
                                        <DoctorRow
                                            key={virtualRow.key}
                                            row={row}
                                            premiumDays={premiumDays}
                                            gridTemplate={gridTemplate}
                                            virtualIndex={virtualRow.index}
                                            start={virtualRow.start}
                                            measureRef={rowVirtualizer.measureElement}
                                            highlightKey={highlightKey}
                                            onOpenDoctor={openDoctorDrawer}
                                            onOpenSlot={openSlotPopover}
                                        />
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </div>
            </section>

            <p className="chief-matrix-hint">
                Clique no <strong>nome</strong> para abrir o resumo financeiro do médico (NF, contrato, banco de horas, folha de ponto) ·
                clique num <strong>plantão</strong> para ações do slot. Colunas com fundo âmbar = fim de semana/feriado (tarifa cheia).
                {!canManageClosing ? " Perfil restrito: você pode visualizar todo o fechamento e salvar somente NF/processo." : ""}
            </p>

            <AdminGlobalNavigationLinks current="payment-closing" containerClassName="chief-matrix-footer-nav">
                <a className="reports-secondary-link" href="/admin/payment-attestation/audit">
                    Abrir auditoria técnica
                </a>
            </AdminGlobalNavigationLinks>

            {slotPopover ? (
                <SlotActionPopover
                    draft={slotPopover}
                    monthKey={board.monthKey}
                    busy={shiftActionBusy}
                    error={shiftActionError}
                    canManageClosing={canManageClosing}
                    onReassign={startReassign}
                    onRemove={() => void submitShiftRemoval()}
                    onClose={() => setSlotPopover(null)}
                />
            ) : null}

            {canManageClosing && manualDraft ? (
                <ManualCorrectionDialog
                    draft={manualDraft}
                    monthKey={board.monthKey}
                    mode={manualMode}
                    busy={manualBusy}
                    error={manualError}
                    doctorName={manualDoctorName}
                    disableReason={manualDisableReason}
                    allDoctorNames={board.allDoctorNames}
                    onModeChange={setManualMode}
                    onDoctorNameChange={setManualDoctorName}
                    onDisableReasonChange={setManualDisableReason}
                    onSubmitAssign={() => void submitManualCorrection()}
                    onSubmitDisable={() => void submitManualDisable()}
                    onClose={() => {
                        setManualDraft(null);
                        setManualDoctorName("");
                        setManualDisableReason("");
                        setManualError(null);
                    }}
                />
            ) : null}

            {drawerDoctor ? (
                <DoctorDrawer
                    doctor={drawerDoctor}
                    monthKey={board.monthKey}
                    monthLabel={monthTitle}
                    days={board.days}
                    canManageClosing={canManageClosing}
                    conflictSegments={drawerConflictSegments}
                    attestBusy={attestBusyDoctorId === drawerDoctor.doctorId}
                    attestError={attestError}
                    onToggleAttestation={(attested) => {
                        if (!canManageClosing) return;
                        void toggleDoctorAttestation(drawerDoctor.doctorId, attested);
                    }}
                    profileBusy={profileBusyDoctorId === drawerDoctor.doctorId}
                    employmentBusy={employmentTypeBusyDoctorId === drawerDoctor.doctorId}
                    onToggleSpecialist={(isSpecialist) => void toggleDoctorSpecialistProfile(drawerDoctor.doctorId, isSpecialist)}
                    onToggleEmploymentType={(employmentType) => void toggleDoctorEmploymentType(drawerDoctor.doctorId, employmentType)}
                    invoiceDraft={invoiceDraft}
                    processDraft={processDraft}
                    metaBusy={metaBusy}
                    metaError={metaError}
                    metaFeedback={metaFeedback}
                    onInvoiceChange={setInvoiceDraft}
                    onProcessChange={setProcessDraft}
                    onMetaBlur={() => autoSavePaymentMeta(drawerDoctor)}
                    contractDraft={contractDraft}
                    contractBusy={contractBusy}
                    contractError={contractError}
                    onContractChange={setContractDraft}
                    onSubmitContract={() => void submitContractSeed(drawerDoctor.doctorId)}
                    bankBusy={bankBusy}
                    bankError={bankError}
                    onSettleBank={(kind) => void submitBankHoursSettlement(drawerDoctor.doctorId, kind)}
                    extraDay={extraDay}
                    extraShift={extraShift}
                    extraCoverage={extraCoverage}
                    extraLabel={extraLabel}
                    extraBusy={extraBusy}
                    extraError={extraError}
                    extraFeedback={extraFeedback}
                    onExtraDayChange={setExtraDay}
                    onExtraShiftChange={setExtraShift}
                    onExtraCoverageChange={setExtraCoverage}
                    onExtraLabelChange={setExtraLabel}
                    onSubmitExtra={() => void submitAddExtraShift(drawerDoctor.doctorId, drawerDoctor.doctorName)}
                    onClose={() => setDrawerDoctorId(null)}
                />
            ) : null}
        </main>
    );
}
