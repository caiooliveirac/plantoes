import type { PaymentAllocationBoard, PaymentAllocationRow } from "@/services/board.service";
import { HALF_SHIFT_DISPLAY_LABEL, HALF_SHIFT_TAG_LABEL, isHalfShiftRoleLabel, resolvePaymentUnitFromRole } from "@/modules/operational/half-shift";
import { isNucleoRegulationPost, isPiamRegulationPost } from "@/modules/operational/board-display";
import { isPremiumRateDate } from "@/modules/operational/holidays";

const SAO_PAULO_OFFSET_MINUTES = -180;
const MIN_SEGMENT_MINUTES = 45;

export type DoctorPaymentProfile = "generalist" | "specialist" | "psychiatry";

const DOCTOR_PAYMENT_RATES: Record<DoctorPaymentProfile, { weekday: number; weekend: number }> = {
    generalist: { weekday: 1244.87, weekend: 1381.10 },
    specialist: { weekday: 1329.66, weekend: 1457.15 },
    psychiatry: { weekday: 1299.82, weekend: 1411.47 },
};

interface DoctorPaymentMetadata {
    preferredOperationalRole?: unknown;
    paymentProfile?: {
        isSpecialist?: unknown;
    };
    isPaymentSpecialist?: unknown;
}

export type AttestationSegmentStatus = "consolidated" | "discarded";
export type AttestationSegmentDiscardReason =
    | "invalid_timeline"
    | "short_fragment"
    | "duplicate_segment"
    | "not_selected_for_payment";

export interface RawPresenceEvent {
    occupancyId: string;
    domain: "regulation" | "intervention";
    doctorId: string;
    doctorName: string;
    displayName: string | null;
    targetCode: string;
    targetLabel: string;
    startedAt: string;
    endedAt: string | null;
    actualEndedAt: string | null;
    scheduledStartAt: string | null;
    scheduledEndAt: string | null;
    shiftLabel: "SD" | "SN" | "P" | null;
    source: "manual" | "telegram" | "import" | "admin_correction";
    continuityGroupId: string | null;
    notes: string | null;
}

export interface AttestationSegment {
    segmentId: string;
    occupancyId: string;
    domain: RawPresenceEvent["domain"];
    doctorId: string;
    doctorName: string;
    displayName: string | null;
    targetCode: string;
    targetLabel: string;
    shiftLabel: RawPresenceEvent["shiftLabel"];
    startedAt: string;
    endedAt: string | null;
    durationMinutes: number | null;
    source: RawPresenceEvent["source"];
    continuityGroupId: string | null;
    status: AttestationSegmentStatus;
    discardReason: AttestationSegmentDiscardReason | null;
    selectedForPayment: boolean;
}

export interface PayableShift {
    payableShiftId: string;
    occupancyId: string;
    domain: "regulation" | "intervention";
    doctorId: string;
    doctorName: string;
    displayName: string | null;
    targetCode: string;
    targetLabel: string;
    tagCode: string;
    operationalDate: string;
    shiftLabel: "SD" | "SN";
    slotStartedAt: string;
    slotEndedAt: string;
    startedAt: string;
    endedAt: string | null;
    durationMinutes: number | null;
    paymentStatus: "ready_for_payment" | "needs_review";
    auditStatus: "clean" | "review";
    issues: string[];
    source: string | null;
    roleLabel: string | null;
    paymentUnit: number;
    paymentTag: string | null;
}

export interface DisabledTargetSnapshot {
    snapshotId: string;
    domain: "regulation" | "intervention";
    targetCode: string;
    targetLabel: string;
    operationalDate: string;
    day: string;
    shiftLabel: "SD" | "SN";
    disabledReason: string | null;
    disabledEntireShift: boolean;
    disabledDuringShift: boolean;
}

export interface UncoveredTargetSnapshot {
    snapshotId: string;
    domain: "regulation" | "intervention";
    targetCode: string;
    targetLabel: string;
    operationalDate: string;
    day: string;
    shiftLabel: "SD" | "SN";
    reason: string | null;
}

export interface PayableTargetOption {
    domain: "regulation" | "intervention";
    targetCode: string;
    targetLabel: string;
}

export interface ChiefPayableCell {
    day: string;
    shifts: PayableShift[];
}

export interface ChiefPayableDoctorRow {
    doctorId: string;
    doctorName: string;
    displayName: string | null;
    paymentStatus: "ready_for_payment" | "needs_review";
    totalSD: number;
    totalSN: number;
    total: number;
    totalSDDue?: number;
    totalSNDue?: number;
    totalDue?: number;
    weekdayShiftCount?: number;
    weekendShiftCount?: number;
    paymentProfile?: DoctorPaymentProfile;
    pendingCount: number;
    cells: ChiefPayableCell[];
}

export interface ChiefPayableBoardModel {
    allDoctorNames: string[];
    monthKey: string;
    monthLabel: string;
    presetMonths: Array<{ key: string; label: string }>;
    range: {
        startIso: string;
        endIso: string;
    };
    days: string[];
    summary: {
        doctorCount: number;
        payableShiftCount: number;
        payableUnitCount: number;
        totalDueAmount?: number;
        readyCount: number;
        needsReviewCount: number;
        segmentCount: number;
        discardedSegmentCount: number;
        disabledTargetCount: number;
        uncoveredTargetCount: number;
    };
    targetOptions: PayableTargetOption[];
    doctors: ChiefPayableDoctorRow[];
    payableShifts: PayableShift[];
    disabledTargets: DisabledTargetSnapshot[];
    uncoveredTargets: UncoveredTargetSnapshot[];
    attestationSegments: AttestationSegment[];
}

function toSaoPauloClock(dateIso: string) {
    return new Date(new Date(dateIso).getTime() + (SAO_PAULO_OFFSET_MINUTES * 60000));
}

function toOperationalDate(dateIso: string) {
    const local = toSaoPauloClock(dateIso);
    const year = local.getUTCFullYear();
    const month = String(local.getUTCMonth() + 1).padStart(2, "0");
    const day = String(local.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function isWeekendOperationalDate(operationalDate: string) {
    return isPremiumRateDate(operationalDate);
}

function asDoctorPaymentMetadata(value: unknown): DoctorPaymentMetadata {
    if (!value || typeof value !== "object") {
        return {};
    }

    return value as DoctorPaymentMetadata;
}

export function resolveDoctorPaymentProfile(metadata: unknown): DoctorPaymentProfile {
    const typed = asDoctorPaymentMetadata(metadata);
    const preferredRole = String(typed.preferredOperationalRole ?? "").trim().toUpperCase();
    if (preferredRole === "PSIQ") {
        return "psychiatry";
    }

    const specialistFlag = typed.paymentProfile?.isSpecialist;
    if (specialistFlag === true) {
        return "specialist";
    }

    if (typed.isPaymentSpecialist === true) {
        return "specialist";
    }

    return "generalist";
}

function resolveShiftDueAmount(params: {
    profile: DoctorPaymentProfile;
    operationalDate: string;
    paymentUnit: number;
}) {
    const rates = DOCTOR_PAYMENT_RATES[params.profile];
    const dayRate = isWeekendOperationalDate(params.operationalDate) ? rates.weekend : rates.weekday;
    return Number((dayRate * params.paymentUnit).toFixed(2));
}

function resolveDurationMinutes(startedAt: string, endedAt: string | null) {
    if (!endedAt) {
        return null;
    }

    const durationMs = new Date(endedAt).getTime() - new Date(startedAt).getTime();
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
        return null;
    }

    return Math.round(durationMs / 60000);
}

function buildSegmentDuplicateKey(event: RawPresenceEvent) {
    const operationalDate = toOperationalDate(event.startedAt);
    return [event.doctorId, event.domain, event.targetCode, event.shiftLabel ?? "UNK", operationalDate, event.startedAt].join("|");
}

function rankSegmentCandidate(event: RawPresenceEvent) {
    let score = 0;
    const durationMinutes = resolveDurationMinutes(event.startedAt, event.actualEndedAt ?? event.endedAt);

    if (durationMinutes !== null) {
        score += Math.min(durationMinutes, 12 * 60);
    }

    if (event.actualEndedAt) {
        score += 40;
    }

    if (event.scheduledStartAt && event.scheduledEndAt) {
        score += 20;
    }

    if (event.source === "telegram") {
        score += 6;
    }

    if (event.source === "manual" || event.source === "admin_correction") {
        score -= 10;
    }

    return score;
}

export function buildAttestationSegments(params: {
    rawEvents: RawPresenceEvent[];
    selectedOccupancyIds: Set<string>;
}) {
    const grouped = new Map<string, RawPresenceEvent[]>();
    for (const event of params.rawEvents) {
        const key = buildSegmentDuplicateKey(event);
        const bucket = grouped.get(key) ?? [];
        bucket.push(event);
        grouped.set(key, bucket);
    }

    const duplicateLosers = new Set<string>();
    for (const bucket of grouped.values()) {
        if (bucket.length < 2) {
            continue;
        }

        const ranked = [...bucket].sort((left, right) => rankSegmentCandidate(right) - rankSegmentCandidate(left));
        for (const loser of ranked.slice(1)) {
            duplicateLosers.add(loser.occupancyId);
        }
    }

    return params.rawEvents.map((event) => {
        const endedAt = event.actualEndedAt ?? event.endedAt;
        const durationMinutes = resolveDurationMinutes(event.startedAt, endedAt);
        const selectedForPayment = params.selectedOccupancyIds.has(event.occupancyId);
        const duplicateDiscard = duplicateLosers.has(event.occupancyId);

        const status: AttestationSegmentStatus = (() => {
            if (duplicateDiscard) {
                return "discarded";
            }

            if (durationMinutes === null) {
                return "discarded";
            }

            if (durationMinutes < MIN_SEGMENT_MINUTES) {
                return "discarded";
            }

            if (!selectedForPayment) {
                return "discarded";
            }

            return "consolidated";
        })();

        const discardReason: AttestationSegmentDiscardReason | null = (() => {
            if (status === "consolidated") {
                return null;
            }

            if (duplicateDiscard) {
                return "duplicate_segment";
            }

            if (durationMinutes === null) {
                return "invalid_timeline";
            }

            if (durationMinutes < MIN_SEGMENT_MINUTES) {
                return "short_fragment";
            }

            return "not_selected_for_payment";
        })();

        return {
            segmentId: `seg:${event.occupancyId}`,
            occupancyId: event.occupancyId,
            domain: event.domain,
            doctorId: event.doctorId,
            doctorName: event.doctorName,
            displayName: event.displayName,
            targetCode: event.targetCode,
            targetLabel: event.targetLabel,
            shiftLabel: event.shiftLabel,
            startedAt: event.startedAt,
            endedAt,
            durationMinutes,
            source: event.source,
            continuityGroupId: event.continuityGroupId,
            status,
            discardReason,
            selectedForPayment,
        } satisfies AttestationSegment;
    });
}

function mapAllocationRowToPayableShift(board: PaymentAllocationBoard, row: PaymentAllocationRow): PayableShift | null {
    if (!row.occupancyId || !row.doctorId || !row.doctorName) {
        return null;
    }

    const durationMinutes = resolveDurationMinutes(row.startedAt ?? board.startedAt, row.endedAt);
    const operationalDate = toOperationalDate(board.startedAt);

    const isHalfShift = isHalfShiftRoleLabel(row.roleLabel);
    return {
        payableShiftId: [row.doctorId, board.startedAt, board.shiftLabel, row.domain, row.targetCode].join("|"),
        occupancyId: row.occupancyId,
        domain: row.domain,
        doctorId: row.doctorId,
        doctorName: row.doctorName,
        displayName: row.displayName,
        targetCode: row.targetCode,
        targetLabel: row.targetLabel,
        tagCode: row.domain === "regulation" ? "CRU" : row.targetCode,
        operationalDate,
        shiftLabel: board.shiftLabel,
        slotStartedAt: board.startedAt,
        slotEndedAt: board.endedAt,
        startedAt: row.startedAt ?? board.startedAt,
        endedAt: row.endedAt,
        durationMinutes,
        paymentStatus: row.paymentStatus,
        auditStatus: row.paymentStatus === "ready_for_payment" ? "clean" : "review",
        issues: isHalfShift ? [...row.issues, HALF_SHIFT_DISPLAY_LABEL] : [...row.issues],
        source: row.source,
        roleLabel: row.roleLabel,
        paymentUnit: resolvePaymentUnitFromRole(row.roleLabel),
        paymentTag: isHalfShift ? HALF_SHIFT_TAG_LABEL : null,
    } satisfies PayableShift;
}

export function buildPayableShiftsFromBoards(boards: PaymentAllocationBoard[]) {
    const payable = boards
        .flatMap((board) => [...board.regulation, ...board.intervention]
            .map((row) => mapAllocationRowToPayableShift(board, row))
            .filter((row): row is PayableShift => Boolean(row))
        )
        .sort((left, right) => {
            const byDate = new Date(left.slotStartedAt).getTime() - new Date(right.slotStartedAt).getTime();
            if (byDate !== 0) {
                return byDate;
            }

            return left.doctorName.localeCompare(right.doctorName, "pt-BR");
        });

    const deduped = new Map<string, PayableShift>();
    for (const shift of payable) {
        deduped.set(shift.payableShiftId, shift);
    }

    return Array.from(deduped.values());
}

export function buildDisabledTargetsFromBoards(params: {
    boards: PaymentAllocationBoard[];
    maxSlotStartedAtIso?: string | null;
}) {
    const snapshots: DisabledTargetSnapshot[] = [];
    const maxSlotStartedAtMs = params.maxSlotStartedAtIso
        ? new Date(params.maxSlotStartedAtIso).getTime()
        : null;

    for (const board of params.boards) {
        if (maxSlotStartedAtMs !== null && new Date(board.startedAt).getTime() > maxSlotStartedAtMs) {
            continue;
        }

        const operationalDate = toOperationalDate(board.startedAt);
        const day = operationalDate.slice(8, 10);
        const rows = [...board.regulation, ...board.intervention];
        for (const row of rows) {
            const disabledEntireShift = Boolean(row.disabledEntireShift ?? false);
            const disabledDuringShift = Boolean(row.disabledDuringShift ?? false);
            if (!disabledEntireShift && !disabledDuringShift) {
                continue;
            }

            // Se há ocupação atribuída no slot, o alvo está efetivamente coberto:
            // o intervalo de desativação registrado é uma residue (ex.: zero-duração
            // do bot ou vazamento do slot vizinho) e não deve aparecer como desativada.
            if (row.occupancyId) {
                continue;
            }

            snapshots.push({
                snapshotId: [operationalDate, board.shiftLabel, row.domain, row.targetCode].join("|"),
                domain: row.domain,
                targetCode: row.targetCode,
                targetLabel: row.targetLabel,
                operationalDate,
                day,
                shiftLabel: board.shiftLabel,
                disabledReason: row.disabledReason ?? null,
                disabledEntireShift,
                disabledDuringShift,
            });
        }
    }

    const unique = new Map<string, DisabledTargetSnapshot>();
    for (const snapshot of snapshots) {
        unique.set(snapshot.snapshotId, snapshot);
    }

    return Array.from(unique.values()).sort((left, right) => {
        const byDate = left.operationalDate.localeCompare(right.operationalDate);
        if (byDate !== 0) {
            return byDate;
        }

        if (left.shiftLabel !== right.shiftLabel) {
            return left.shiftLabel === "SD" ? -1 : 1;
        }

        if (left.domain !== right.domain) {
            return left.domain === "regulation" ? -1 : 1;
        }

        return left.targetCode.localeCompare(right.targetCode, "pt-BR");
    });
}

export function buildUncoveredTargetsFromBoards(params: {
    boards: PaymentAllocationBoard[];
    maxSlotStartedAtIso?: string | null;
}) {
    const snapshots: UncoveredTargetSnapshot[] = [];
    const maxSlotStartedAtMs = params.maxSlotStartedAtIso
        ? new Date(params.maxSlotStartedAtIso).getTime()
        : null;

    for (const board of params.boards) {
        if (maxSlotStartedAtMs !== null && new Date(board.startedAt).getTime() > maxSlotStartedAtMs) {
            continue;
        }

        const operationalDate = toOperationalDate(board.startedAt);
        const day = operationalDate.slice(8, 10);
        const rows = [...board.regulation, ...board.intervention];
        for (const row of rows) {
            const isSpecialRegulationCoverage = row.domain === "regulation"
                && (isPiamRegulationPost(row.targetCode) || (board.shiftLabel === "SD" && isNucleoRegulationPost(row.targetCode)));

            if (row.domain !== "intervention" && !isSpecialRegulationCoverage) {
                continue;
            }

            const isUncovered = !row.occupancyId && !Boolean(row.disabledDuringShift ?? false) && !Boolean(row.disabledEntireShift ?? false);
            if (!isUncovered) {
                continue;
            }

            snapshots.push({
                snapshotId: [operationalDate, board.shiftLabel, row.domain, row.targetCode].join("|"),
                domain: row.domain,
                targetCode: row.targetCode,
                targetLabel: row.targetLabel,
                operationalDate,
                day,
                shiftLabel: board.shiftLabel,
                reason: row.issues[0] ?? null,
            });
        }
    }

    const unique = new Map<string, UncoveredTargetSnapshot>();
    for (const snapshot of snapshots) {
        unique.set(snapshot.snapshotId, snapshot);
    }

    return Array.from(unique.values()).sort((left, right) => {
        const byDate = left.operationalDate.localeCompare(right.operationalDate);
        if (byDate !== 0) {
            return byDate;
        }

        if (left.shiftLabel !== right.shiftLabel) {
            return left.shiftLabel === "SD" ? -1 : 1;
        }

        if (left.domain !== right.domain) {
            return left.domain === "regulation" ? -1 : 1;
        }

        return left.targetCode.localeCompare(right.targetCode, "pt-BR");
    });
}

export function buildPayableTargetOptions(params: {
    payableShifts: PayableShift[];
    disabledTargets: DisabledTargetSnapshot[];
    uncoveredTargets: UncoveredTargetSnapshot[];
}) {
    const options = new Map<string, PayableTargetOption>();

    for (const shift of params.payableShifts) {
        const key = `${shift.domain}|${shift.targetCode}`;
        if (!options.has(key)) {
            options.set(key, {
                domain: shift.domain,
                targetCode: shift.targetCode,
                targetLabel: shift.targetLabel,
            });
        }
    }

    for (const snapshot of params.disabledTargets) {
        const key = `${snapshot.domain}|${snapshot.targetCode}`;
        if (!options.has(key)) {
            options.set(key, {
                domain: snapshot.domain,
                targetCode: snapshot.targetCode,
                targetLabel: snapshot.targetLabel,
            });
        }
    }

    for (const snapshot of params.uncoveredTargets) {
        const key = `${snapshot.domain}|${snapshot.targetCode}`;
        if (!options.has(key)) {
            options.set(key, {
                domain: snapshot.domain,
                targetCode: snapshot.targetCode,
                targetLabel: snapshot.targetLabel,
            });
        }
    }

    return Array.from(options.values()).sort((left, right) => {
        if (left.domain !== right.domain) {
            return left.domain === "regulation" ? -1 : 1;
        }
        return left.targetCode.localeCompare(right.targetCode, "pt-BR");
    });
}

export function buildChiefPayableBoard(params: {
    monthKey: string;
    monthLabel: string;
    presetMonths: Array<{ key: string; label: string }>;
    rangeStartIso: string;
    rangeEndIso: string;
    payableShifts: PayableShift[];
    disabledTargets: DisabledTargetSnapshot[];
    uncoveredTargets: UncoveredTargetSnapshot[];
    targetOptions: PayableTargetOption[];
    attestationSegments: AttestationSegment[];
    allDoctorNames: string[];
    doctorPaymentProfiles?: Record<string, DoctorPaymentProfile>;
}) {
    const dayCount = new Date(params.rangeEndIso).getTime() > new Date(params.rangeStartIso).getTime()
        ? Math.round((new Date(params.rangeEndIso).getTime() - new Date(params.rangeStartIso).getTime()) / 86400000)
        : 0;
    const days = Array.from({ length: dayCount }, (_, index) => {
        const day = new Date(new Date(params.rangeStartIso).getTime() + (index * 86400000));
        const local = toSaoPauloClock(day.toISOString());
        return String(local.getUTCDate()).padStart(2, "0");
    });

    const grouped = new Map<string, PayableShift[]>();
    for (const shift of params.payableShifts) {
        const key = shift.doctorId;
        const bucket = grouped.get(key) ?? [];
        bucket.push(shift);
        grouped.set(key, bucket);
    }

    const doctors = Array.from(grouped.entries()).map(([doctorId, shifts]) => {
        const dayMap = new Map<string, PayableShift[]>();
        for (const shift of shifts) {
            const day = shift.operationalDate.slice(8, 10);
            const bucket = dayMap.get(day) ?? [];
            bucket.push(shift);
            dayMap.set(day, bucket);
        }

        const orderedShifts = [...shifts].sort((left, right) => {
            const bySlot = new Date(left.slotStartedAt).getTime() - new Date(right.slotStartedAt).getTime();
            if (bySlot !== 0) {
                return bySlot;
            }
            if (left.shiftLabel !== right.shiftLabel) {
                return left.shiftLabel === "SD" ? -1 : 1;
            }
            return left.targetCode.localeCompare(right.targetCode, "pt-BR");
        });

        const totalSDUnits = orderedShifts
            .filter((shift) => shift.shiftLabel === "SD")
            .reduce((sum, shift) => sum + shift.paymentUnit, 0);
        const totalSNUnits = orderedShifts
            .filter((shift) => shift.shiftLabel === "SN")
            .reduce((sum, shift) => sum + shift.paymentUnit, 0);
        const totalUnits = orderedShifts.reduce((sum, shift) => sum + shift.paymentUnit, 0);
        const paymentProfile = params.doctorPaymentProfiles?.[doctorId] ?? "generalist";
        const totalSDDueValue = orderedShifts
            .filter((shift) => shift.shiftLabel === "SD")
            .reduce((sum, shift) => sum + resolveShiftDueAmount({
                profile: paymentProfile,
                operationalDate: shift.operationalDate,
                paymentUnit: shift.paymentUnit,
            }), 0);
        const totalSNDueValue = orderedShifts
            .filter((shift) => shift.shiftLabel === "SN")
            .reduce((sum, shift) => sum + resolveShiftDueAmount({
                profile: paymentProfile,
                operationalDate: shift.operationalDate,
                paymentUnit: shift.paymentUnit,
            }), 0);
        const totalDueValue = orderedShifts
            .reduce((sum, shift) => sum + resolveShiftDueAmount({
                profile: paymentProfile,
                operationalDate: shift.operationalDate,
                paymentUnit: shift.paymentUnit,
            }), 0);
        const weekdayShiftCount = orderedShifts.filter((shift) => !isWeekendOperationalDate(shift.operationalDate)).length;
        const weekendShiftCount = orderedShifts.length - weekdayShiftCount;
        const pendingCount = orderedShifts.filter((shift) => shift.paymentStatus === "needs_review").length;
        const paymentStatus = pendingCount > 0 ? "needs_review" : "ready_for_payment";

        return {
            doctorId,
            doctorName: orderedShifts[0]?.doctorName ?? "Desconhecido",
            displayName: orderedShifts[0]?.displayName ?? null,
            paymentStatus,
            totalSD: Number(totalSDUnits.toFixed(2)),
            totalSN: Number(totalSNUnits.toFixed(2)),
            total: Number(totalUnits.toFixed(2)),
            totalSDDue: Number(totalSDDueValue.toFixed(2)),
            totalSNDue: Number(totalSNDueValue.toFixed(2)),
            totalDue: Number(totalDueValue.toFixed(2)),
            weekdayShiftCount,
            weekendShiftCount,
            paymentProfile,
            pendingCount,
            cells: days.map((day) => ({
                day,
                shifts: [...(dayMap.get(day) ?? [])].sort((left, right) => {
                    if (left.shiftLabel !== right.shiftLabel) {
                        return left.shiftLabel === "SD" ? -1 : 1;
                    }
                    return left.targetCode.localeCompare(right.targetCode, "pt-BR");
                }),
            })),
        } satisfies ChiefPayableDoctorRow;
    }).sort((left, right) => left.doctorName.localeCompare(right.doctorName, "pt-BR"));

    return {
        monthKey: params.monthKey,
        monthLabel: params.monthLabel,
        presetMonths: params.presetMonths,
        range: {
            startIso: params.rangeStartIso,
            endIso: params.rangeEndIso,
        },
        days,
        summary: {
            doctorCount: doctors.length,
            payableShiftCount: params.payableShifts.length,
            payableUnitCount: Number(params.payableShifts.reduce((sum, shift) => sum + shift.paymentUnit, 0).toFixed(2)),
            totalDueAmount: Number(doctors.reduce((sum, doctor) => sum + (doctor.totalDue ?? 0), 0).toFixed(2)),
            readyCount: params.payableShifts.filter((shift) => shift.paymentStatus === "ready_for_payment").length,
            needsReviewCount: params.payableShifts.filter((shift) => shift.paymentStatus === "needs_review").length,
            segmentCount: params.attestationSegments.length,
            discardedSegmentCount: params.attestationSegments.filter((segment) => segment.status === "discarded").length,
            disabledTargetCount: params.disabledTargets.length,
            uncoveredTargetCount: params.uncoveredTargets.length,
        },
        targetOptions: params.targetOptions,
        doctors,
        payableShifts: params.payableShifts,
        disabledTargets: params.disabledTargets,
        uncoveredTargets: params.uncoveredTargets,
        attestationSegments: params.attestationSegments,
        allDoctorNames: params.allDoctorNames,
    } satisfies ChiefPayableBoardModel;
}
