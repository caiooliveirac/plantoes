"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { AdminGlobalNavigationLinks } from "@/components/admin-global-navigation-links";
import type { ChiefPayableBoardModel } from "@/modules/reporting/payable-shifts";
import { isPremiumRateDate, isSamuHolidayDate, isWeekendDate as isStrictWeekendDate } from "@/modules/operational/holidays";

interface Props {
    board: ChiefPayableBoardModel;
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

type PaymentStatusFilter = "all" | "ready_for_payment" | "needs_review";
type ShiftFilter = "all" | "SD" | "SN";
type DomainFilter = "all" | "regulation" | "intervention";
type CoverageFilter = "all" | "half" | "full";
type SortMode = "name" | "total" | "pending" | "sd" | "sn";
type DoctorProfile = "generalist" | "specialist" | "psychiatry";

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

function isWeekendDate(operationalDate: string) {
    return isPremiumRateDate(operationalDate);
}

function resolveShiftAmount(shift: { operationalDate: string; paymentUnit: number }, profile: DoctorProfile) {
    const rate = isWeekendDate(shift.operationalDate) ? PROFILE_RATES[profile].weekend : PROFILE_RATES[profile].weekday;
    return Number((rate * shift.paymentUnit).toFixed(2));
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

export function ChiefPaymentViewClient({ board }: Props) {
    const router = useRouter();
    const [, startRefreshTransition] = useTransition();
    const requestRouterRefresh = useCallback(() => {
        startRefreshTransition(() => { router.refresh(); });
    }, [router]);
    const [search, setSearch] = useState("");
    const [targetSearch, setTargetSearch] = useState("");
    const [status, setStatus] = useState<PaymentStatusFilter>("all");
    const [shiftFilter, setShiftFilter] = useState<ShiftFilter>("all");
    const [domainFilter, setDomainFilter] = useState<DomainFilter>("all");
    const [coverageFilter, setCoverageFilter] = useState<CoverageFilter>("all");
    const [targetFilter, setTargetFilter] = useState("all");
    const [sortMode, setSortMode] = useState<SortMode>("name");
    const [flash, setFlash] = useState<FlashRecord | null>(null);
    const [highlightKey, setHighlightKey] = useState<string | null>(null);
    const tableShellRef = useRef<HTMLDivElement | null>(null);
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
    const [selectedDoctorId, setSelectedDoctorId] = useState<string | null>(null);
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
    const normalized = normalize(search);
    const normalizedTarget = normalize(targetSearch);

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
        const readyDoctors = board.doctors.filter((doctor) => doctor.paymentStatus === "ready_for_payment").length;
        const reviewDoctors = board.doctors.length - readyDoctors;
        const sdCount = board.payableShifts
            .filter((shift) => shift.shiftLabel === "SD")
            .reduce((sum, shift) => sum + shift.paymentUnit, 0);
        const snCount = board.payableShifts
            .filter((shift) => shift.shiftLabel === "SN")
            .reduce((sum, shift) => sum + shift.paymentUnit, 0);
        const regulationCount = board.payableShifts.filter((shift) => shift.domain === "regulation").length;
        const interventionCount = board.payableShifts.filter((shift) => shift.domain === "intervention").length;
        const halfCount = board.payableShifts.filter((shift) => Boolean(shift.paymentTag)).length;
        const fullCount = board.payableShifts.length - halfCount;

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
    }, [board.doctors, board.payableShifts]);

    const dayLoad = useMemo(() => {
        const counts = new Map<string, number>();
        for (const shift of board.payableShifts) {
            const day = shift.operationalDate.slice(8, 10);
            counts.set(day, (counts.get(day) ?? 0) + 1);
        }

        return board.days.map((day) => ({ day, count: counts.get(day) ?? 0 }));
    }, [board.days, board.payableShifts]);

    const totalDueAmount = useMemo(() => {
        return Number(board.doctors
            .reduce((sum, doctor) => {
                const paymentProfile = doctorProfileOverrides[doctor.doctorId] ?? (doctor.paymentProfile ?? "generalist") as DoctorProfile;
                const doctorDue = doctor.cells
                    .flatMap((cell) => cell.shifts)
                    .reduce((doctorSum, shift) => doctorSum + resolveShiftAmount(shift, paymentProfile), 0);
                return sum + doctorDue;
            }, 0)
            .toFixed(2));
    }, [board.doctors, doctorProfileOverrides]);

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
                const totalSD = Number(visibleShifts
                    .filter((shift) => shift.shiftLabel === "SD")
                    .reduce((sum, shift) => sum + shift.paymentUnit, 0)
                    .toFixed(2));
                const totalSN = Number(visibleShifts
                    .filter((shift) => shift.shiftLabel === "SN")
                    .reduce((sum, shift) => sum + shift.paymentUnit, 0)
                    .toFixed(2));
                const total = Number(visibleShifts.reduce((sum, shift) => sum + shift.paymentUnit, 0).toFixed(2));
                const paymentProfile = doctorProfileOverrides[doctor.doctorId] ?? (doctor.paymentProfile ?? "generalist") as DoctorProfile;
                const totalSDDue = Number(visibleShifts
                    .filter((shift) => shift.shiftLabel === "SD")
                    .reduce((sum, shift) => sum + resolveShiftAmount(shift, paymentProfile), 0)
                    .toFixed(2));
                const totalSNDue = Number(visibleShifts
                    .filter((shift) => shift.shiftLabel === "SN")
                    .reduce((sum, shift) => sum + resolveShiftAmount(shift, paymentProfile), 0)
                    .toFixed(2));
                const totalDue = Number(visibleShifts
                    .reduce((sum, shift) => sum + resolveShiftAmount(shift, paymentProfile), 0)
                    .toFixed(2));
                const weekdayShiftCount = visibleShifts.filter((shift) => !isWeekendDate(shift.operationalDate)).length;
                const weekendShiftCount = visibleShifts.length - weekdayShiftCount;
                const weekdayDue = Number(visibleShifts
                    .filter((shift) => !isWeekendDate(shift.operationalDate))
                    .reduce((sum, shift) => sum + resolveShiftAmount(shift, paymentProfile), 0)
                    .toFixed(2));
                const weekendDue = Number(visibleShifts
                    .filter((shift) => isWeekendDate(shift.operationalDate))
                    .reduce((sum, shift) => sum + resolveShiftAmount(shift, paymentProfile), 0)
                    .toFixed(2));
                const pendingCount = visibleShifts.filter((shift) => shift.paymentStatus === "needs_review").length;

                return {
                    ...doctor,
                    cells: nextCells,
                    totalSD,
                    totalSN,
                    total,
                    totalSDDue,
                    totalSNDue,
                    totalDue,
                    weekdayShiftCount,
                    weekendShiftCount,
                    weekdayDue,
                    weekendDue,
                    pendingCount,
                };
            })
            .filter((doctor) => {
                if (status !== "all" && doctor.paymentStatus !== status) {
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

            if (sortMode === "sd") {
                return right.totalSD - left.totalSD || left.doctorName.localeCompare(right.doctorName, "pt-BR");
            }

            if (sortMode === "sn") {
                return right.totalSN - left.totalSN || left.doctorName.localeCompare(right.doctorName, "pt-BR");
            }

            return right.pendingCount - left.pendingCount || right.total - left.total || left.doctorName.localeCompare(right.doctorName, "pt-BR");
        });

        return sorted;
    }, [board.doctors, coverageFilter, doctorProfileOverrides, domainFilter, normalized, normalizedTarget, shiftFilter, sortMode, status, targetFilter]);

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

        const selector = `[data-flash-key="${flash.kind}|${flash.domain}|${flash.targetCode}|${flash.day}|${flash.shiftLabel}"]`;
        let attempts = 0;
        const tryLocate = () => {
            const root = tableShellRef.current ?? document;
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
        setPendingRemovals((prev) => {
            const next = new Set(prev);
            next.add(draft.payableShiftId);
            return next;
        });

        try {
            const response = await fetch("/api/admin/payment-attestation/slot", {
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
                next.delete(draft.payableShiftId);
                return next;
            });
            setShiftActionError(error instanceof Error ? error.message : "Falha ao remover plantão.");
        } finally {
            setShiftActionBusy(false);
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

    const selectedDoctor = useMemo(
        () => filteredDoctors.find((doctor) => doctor.doctorId === selectedDoctorId) ?? null,
        [filteredDoctors, selectedDoctorId],
    );

    return (
        <main className="chief-payable-shell">
            <section className="chief-payable-hero">
                <div>
                    <p className="reports-kicker">Fechamento mensal do chefe</p>
                    <h1>Unidades pagáveis por médico e por dia</h1>
                    <p className="chief-payable-subtitle">
                        Esta visão mostra apenas o que vira pagamento. Resíduos técnicos, fragmentos e duplicações ficam na auditoria detalhada.
                    </p>
                </div>

                <div className="chief-payable-peak-day" aria-live="polite">
                    <span>Pico operacional do mês</span>
                    <strong>{peakDay ? `${peakDay.day} · ${peakDay.count} unidades` : "sem dados"}</strong>
                    <small>Use os filtros para refinar o fechamento por turno e domínio.</small>
                </div>

                <AdminGlobalNavigationLinks current="payment-closing" containerClassName="chief-payable-hero-actions">
                    <a className="reports-primary-link" href={`/api/admin/reports/export?month=${board.monthKey}`}>
                        Exportar XLSX (payable shifts)
                    </a>
                    <a className="reports-secondary-link" href="/admin/payment-attestation/audit">
                        Abrir auditoria técnica
                    </a>
                </AdminGlobalNavigationLinks>
            </section>

            <section className="reports-presets">
                {board.presetMonths.map((preset) => (
                    <a
                        key={preset.key}
                        href={`/admin/payment-closing?month=${preset.key}`}
                        className={`reports-month-chip ${preset.key === board.monthKey ? "active" : ""}`.trim()}
                    >
                        {preset.label}
                    </a>
                ))}
            </section>

            <section className="chief-payable-summary">
                <article className="chief-payable-summary-card">
                    <span>Unidades pagáveis</span>
                    <strong>{formatUnits(board.summary.payableUnitCount)}</strong>
                </article>
                <article className="chief-payable-summary-card ready">
                    <span>Prontas</span>
                    <strong>{board.summary.readyCount}</strong>
                </article>
                <button className="chief-payable-summary-card review actionable" type="button" onClick={() => setStatus("needs_review")}>
                    <span>Pendências</span>
                    <strong>{board.summary.needsReviewCount}</strong>
                </button>
                <article className="chief-payable-summary-card">
                    <span>Médicos</span>
                    <strong>{board.summary.doctorCount}</strong>
                </article>
                <article className="chief-payable-summary-card">
                    <span>Valor devido</span>
                    <strong>{formatCurrency(totalDueAmount)}</strong>
                </article>
                <article className="chief-payable-summary-card">
                    <span>Desativadas</span>
                    <strong>{visibleDisabledTargets.length}</strong>
                </article>
                <article className="chief-payable-summary-card warning-strong">
                    <span>Sem médico</span>
                    <strong>{visibleUncoveredTargets.length}</strong>
                </article>
            </section>

            <section className="chief-payable-load-strip" aria-label="Ritmo mensal de unidades pagáveis">
                {dayLoad.map((entry) => {
                    const ratio = Math.max(entry.count / maxDayLoad, 0.12);
                    return (
                        <div key={entry.day} className="chief-payable-load-item" title={`Dia ${entry.day}: ${entry.count} unidades`}>
                            <span>{entry.day}</span>
                            <i style={{ transform: `scaleY(${ratio.toFixed(4)})` }} />
                            <strong>{entry.count}</strong>
                        </div>
                    );
                })}
            </section>

            <section className="chief-payable-control-grid">
                <article className="chief-payable-control-card chief-payable-control-card-priority">
                    <h3>Turno e domínio</h3>
                    <div className="chief-payable-chip-row chief-payable-chip-row-priority">
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

                    <div className="chief-payable-chip-row chief-payable-chip-row-priority">
                        <button
                            type="button"
                            className={`chief-payable-chip ${normalizedTarget === "usa" ? "active" : ""}`.trim()}
                            onClick={() => setTargetSearch(normalizedTarget === "usa" ? "" : "USA")}
                        >
                            USA ({board.targetOptions.filter((target) => normalize([target.targetCode, target.targetLabel].join(" ")).includes("usa")).length})
                        </button>
                        <button type="button" className={`chief-payable-chip ${targetFilter === "all" ? "active" : ""}`.trim()} onClick={() => setTargetFilter("all")}>
                            Todas as bases/ramais ({targetPills.length})
                        </button>
                    </div>

                    <div className="chief-payable-chip-row chief-payable-chip-row-priority">
                        <button type="button" className={`chief-payable-chip ${coverageFilter === "all" ? "active" : ""}`.trim()} onClick={() => setCoverageFilter("all")}>
                            Cobertura completa + meio
                        </button>
                        <button type="button" className={`chief-payable-chip warning ${coverageFilter === "half" ? "active" : ""}`.trim()} onClick={() => setCoverageFilter("half")}>
                            Somente MEIO ({filterSummary.halfCount})
                        </button>
                        <button type="button" className={`chief-payable-chip ${coverageFilter === "full" ? "active" : ""}`.trim()} onClick={() => setCoverageFilter("full")}>
                            Sem MEIO ({filterSummary.fullCount})
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
                </article>
            </section>

            <section className="chief-payable-filter-bar">
                <div className="chief-payable-inline-status" aria-label="Status de médicos">
                    <span>Status</span>
                    <div className="chief-payable-chip-row chief-payable-chip-row-inline">
                        <button type="button" className={`chief-payable-chip ${status === "all" ? "active" : ""}`.trim()} onClick={() => setStatus("all")}>
                            Todos ({board.summary.doctorCount})
                        </button>
                        <button type="button" className={`chief-payable-chip ${status === "ready_for_payment" ? "active" : ""}`.trim()} onClick={() => setStatus("ready_for_payment")}>
                            Prontos ({filterSummary.readyDoctors})
                        </button>
                        <button type="button" className={`chief-payable-chip warning ${status === "needs_review" ? "active" : ""}`.trim()} onClick={() => setStatus("needs_review")}>
                            Pendências ({filterSummary.reviewDoctors})
                        </button>
                    </div>
                </div>

                <label className="chief-payable-filter-field chief-payable-search">
                    <span>Filtrar médico</span>
                    <input
                        type="search"
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder="Digite nome ou apelido"
                    />
                </label>

                <label className="chief-payable-filter-field chief-payable-target-search">
                    <span>Filtrar alvo</span>
                    <input
                        type="search"
                        value={targetSearch}
                        onChange={(event) => setTargetSearch(event.target.value)}
                        placeholder="Ex.: BR60, PM04, CRU"
                    />
                </label>

                <label className="chief-payable-filter-field compact">
                    <span>Ordenar por</span>
                    <select value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)}>
                        <option value="pending">Pendências</option>
                        <option value="total">Total</option>
                        <option value="sd">Total SD</option>
                        <option value="sn">Total SN</option>
                        <option value="name">Nome</option>
                    </select>
                </label>

                <label className="chief-payable-filter-field compact">
                    <span>Base/Ramal</span>
                    <select value={targetFilter} onChange={(event) => setTargetFilter(event.target.value)}>
                        <option value="all">Todos</option>
                        {board.targetOptions.map((target) => (
                            <option key={`${target.domain}|${target.targetCode}`} value={`${target.domain}|${target.targetCode}`}>
                                {target.targetCode} · {target.domain === "regulation" ? "Regulação" : "Intervenção"}
                            </option>
                        ))}
                    </select>
                </label>
            </section>

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

            {manualDraft ? (
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

            <section className="chief-payable-table-shell" ref={tableShellRef}>
                <div className="chief-payable-table-scroll">
                    <table className="chief-payable-table">
                        <thead>
                            <tr>
                                <th className="sticky-col doctor">Médico</th>
                                {board.days.map((day) => <th key={day}>{day}</th>)}
                                <th>Total SD</th>
                                <th>Total SN</th>
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

                                    {board.days.map((day) => (
                                        <td key={`disabled-${day}`}>
                                            <div className="chief-payable-cell-tags">
                                                {(disabledByDay.get(day) ?? []).map((item) => (
                                                    <button
                                                        type="button"
                                                        key={item.snapshotId}
                                                        data-flash-key={`disable|${item.domain}|${item.targetCode}|${item.day}|${item.shiftLabel}`}
                                                        className={`chief-payable-tag disabled ${item.shiftLabel === "SD" ? "sd" : "sn"} ${highlightKey === `${item.domain}|${item.targetCode}|${item.day}|${item.shiftLabel}|disable` ? "flash" : ""}`.trim()}
                                                        title={`${item.targetCode} ${item.shiftLabel}${item.disabledReason ? ` · ${item.disabledReason}` : ""}`}
                                                        onClick={() => {
                                                            setManualDraft({
                                                                domain: item.domain,
                                                                targetCode: item.targetCode,
                                                                targetLabel: item.targetLabel,
                                                                day: item.day,
                                                                shiftLabel: item.shiftLabel,
                                                                sourceType: "disabled",
                                                                reason: item.disabledReason ?? null,
                                                            });
                                                            setManualDoctorName("");
                                                            setManualDisableReason("");
                                                            setManualMode("assign");
                                                            setManualError(null);
                                                        }}
                                                    >
                                                        {item.targetCode}{item.shiftLabel}
                                                    </button>
                                                ))}
                                            </div>
                                        </td>
                                    ))}

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

                                    {board.days.map((day) => (
                                        <td key={`uncovered-${day}`}>
                                            <div className="chief-payable-cell-tags">
                                                {(uncoveredByDay.get(day) ?? []).map((item) => (
                                                    <button
                                                        type="button"
                                                        key={item.snapshotId}
                                                        className={`chief-payable-tag uncovered ${item.shiftLabel === "SD" ? "sd" : "sn"}`.trim()}
                                                        title={`${item.targetCode} ${item.shiftLabel}${item.reason ? ` · ${item.reason}` : ""}`}
                                                        onClick={() => {
                                                            setManualDraft({
                                                                domain: item.domain,
                                                                targetCode: item.targetCode,
                                                                targetLabel: item.targetLabel,
                                                                day: item.day,
                                                                shiftLabel: item.shiftLabel,
                                                                sourceType: "uncovered",
                                                                reason: item.reason ?? null,
                                                            });
                                                            setManualDoctorName("");
                                                            setManualDisableReason("");
                                                            setManualMode("assign");
                                                            setManualError(null);
                                                        }}
                                                    >
                                                        {item.targetCode}{item.shiftLabel}
                                                    </button>
                                                ))}
                                            </div>
                                        </td>
                                    ))}

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

                                    return (
                                    <motion.tr
                                        key={doctor.doctorId}
                                        layout
                                        initial={{ opacity: 0, y: 6 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        exit={{ opacity: 0, y: -6 }}
                                        transition={{ duration: 0.2, delay: Math.min(index * 0.018, 0.18) }}
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
                                                </div>

                                                {doctorProfile !== "psychiatry" ? (
                                                    <label className="chief-payable-specialist-toggle">
                                                        <input
                                                            type="checkbox"
                                                            checked={doctorProfile === "specialist"}
                                                            onChange={(event) => {
                                                                void toggleDoctorSpecialistProfile(doctor.doctorId, event.target.checked);
                                                            }}
                                                            disabled={profileBusyDoctorId === doctor.doctorId}
                                                        />
                                                        <span>ESP</span>
                                                    </label>
                                                ) : null}
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
                                                            className={`chief-payable-tag ${shift.shiftLabel === "SD" ? "sd" : "sn"} ${shift.paymentTag ? "half" : ""} ${isFlashTarget ? "flash" : ""}`.trim()}
                                                            title={`${shift.targetCode}${shift.shiftLabel} · ${shift.doctorName}${shift.paymentTag ? " · Meio Plantao" : ""}`}
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

                                        <td>{formatUnits(doctor.totalSD)}</td>
                                        <td>{formatUnits(doctor.totalSN)}</td>
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

            {shiftActionDraft ? (
                <div className="chief-payable-modal-backdrop" role="presentation" onClick={() => !shiftActionBusy && setShiftActionDraft(null)}>
                    <section className="chief-payable-action-popover" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
                        <header className="chief-payable-action-header">
                            <span className="payment-eyebrow">Ações do plantão</span>
                            <strong>
                                {shiftActionDraft.targetCode} {shiftActionDraft.shiftLabel} · dia {shiftActionDraft.day}/{board.monthKey.slice(5,7)} · {shiftActionDraft.doctorName}
                            </strong>
                            {shiftActionDraft.source ? <small>Origem: {shiftActionDraft.source}</small> : null}
                        </header>

                        {shiftActionError ? (
                            <div className="payment-inline-banner danger">
                                <strong>Falha ao remover</strong>
                                <span>{shiftActionError}</span>
                            </div>
                        ) : null}

                        <div className="chief-payable-action-buttons">
                            <button
                                type="button"
                                className="payment-button danger"
                                onClick={() => void submitShiftRemoval()}
                                disabled={shiftActionBusy}
                            >
                                {shiftActionBusy ? "Removendo..." : `Remover ${shiftActionDraft.doctorName} deste plantão`}
                            </button>
                            <a
                                className="payment-button"
                                href={cellAuditLink(board.monthKey, shiftActionDraft.day, shiftActionDraft.shiftLabel)}
                            >
                                Abrir auditoria detalhada
                            </a>
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
                            Remover {shiftActionDraft.source === "admin_correction" || shiftActionDraft.source === "manual"
                                ? "apaga a correção manual deste plantão."
                                : "encerra o plantão no início deste turno (recalcula banco de horas). Use quando o médico não estava de fato no plantão."}
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
                                <p>{paymentProfileLabel(selectedDoctor.paymentProfile)} · {board.monthLabel}</p>
                            </div>
                            <button type="button" className="payment-button" onClick={() => setSelectedDoctorId(null)}>Fechar</button>
                        </header>

                        <div className="chief-payable-modal-grid">
                            <article className="chief-payable-modal-card">
                                <span>Plantões dia útil</span>
                                <strong>{selectedDoctor.weekdayShiftCount}</strong>
                                <small>
                                    Tarifa: {formatCurrency(PROFILE_RATES[(selectedDoctor.paymentProfile ?? "generalist") as DoctorProfile].weekday)} · Total: {formatCurrency(selectedDoctor.weekdayDue)}
                                </small>
                            </article>
                            <article className="chief-payable-modal-card">
                                <span>Plantões fim de semana / feriado</span>
                                <strong>{selectedDoctor.weekendShiftCount}</strong>
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
                                                        <span className={`chief-payable-modal-shift-turn ${shift.shiftLabel === "SD" ? "sd" : "sn"}`}>
                                                            {shift.shiftLabel}
                                                        </span>
                                                        <span className="chief-payable-modal-shift-target">
                                                            {shift.targetCode}
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
