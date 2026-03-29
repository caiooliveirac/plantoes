import { inferInterventionCoverageWindow, inferRegulationCoverageWindow } from "@/modules/operational/rules";

export type ContinuityDomain = "regulation" | "intervention";

export interface ContinuityRecord {
    occupancyId: string;
    doctorId: string;
    continuityGroupId: string;
    startedAt: string | Date;
    endedAt?: string | Date | null;
    actualEndedAt?: string | Date | null;
}

export interface ContinuityOccupancy extends ContinuityRecord {
    domain: ContinuityDomain;
    scheduledStartAt: string | Date | null;
    scheduledEndAt: string | Date | null;
    shiftLabel: string | null;
}

export interface ContinuityGroup<T extends ContinuityRecord> {
    continuityGroupId: string;
    doctorId: string;
    carrier: T;
    tail: T;
    members: T[];
}

export interface ContinuityCarrierAssignment {
    carrierOccupancyId: string;
    continuityGroupId: string;
    memberCount: number;
}

export interface ContinuityBankHoursSpan {
    doctorId: string;
    continuityGroupId: string;
    carrierOccupancyId: string;
    carrierDomain: ContinuityDomain;
    memberOccupancyIds: string[];
    scheduledStartAt: Date | null;
    scheduledEndAt: Date | null;
    actualStartAt: Date;
    actualEndAt: Date | null;
    isClosed: boolean;
}

function asDate(value: string | Date | null | undefined) {
    if (!value) {
        return null;
    }

    return value instanceof Date ? value : new Date(value);
}

export function resolveContinuityEffectiveEndedAt(record: Pick<ContinuityRecord, "endedAt" | "actualEndedAt">) {
    return asDate(record.actualEndedAt ?? record.endedAt ?? null);
}

function compareContinuityMembers<T extends ContinuityRecord>(left: T, right: T) {
    const byStartedAt = asDate(left.startedAt)!.getTime() - asDate(right.startedAt)!.getTime();
    if (byStartedAt !== 0) {
        return byStartedAt;
    }

    const leftEndedAt = resolveContinuityEffectiveEndedAt(left)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const rightEndedAt = resolveContinuityEffectiveEndedAt(right)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    if (leftEndedAt !== rightEndedAt) {
        return leftEndedAt - rightEndedAt;
    }

    return left.occupancyId.localeCompare(right.occupancyId, "pt-BR");
}

export function buildContinuityGroups<T extends ContinuityRecord>(records: T[]) {
    const grouped = new Map<string, T[]>();

    for (const record of records) {
        const key = `${record.doctorId}:${record.continuityGroupId}`;
        const current = grouped.get(key) ?? [];
        current.push(record);
        grouped.set(key, current);
    }

    return Array.from(grouped.values()).map((members) => {
        const orderedMembers = [...members].sort(compareContinuityMembers);
        return {
            continuityGroupId: orderedMembers[0]!.continuityGroupId,
            doctorId: orderedMembers[0]!.doctorId,
            carrier: orderedMembers[0]!,
            tail: orderedMembers[orderedMembers.length - 1]!,
            members: orderedMembers,
        } satisfies ContinuityGroup<T>;
    });
}

export function buildContinuityCarrierLookup<T extends ContinuityRecord>(records: T[]) {
    const lookup = new Map<string, ContinuityCarrierAssignment>();

    for (const group of buildContinuityGroups(records)) {
        for (const member of group.members) {
            lookup.set(member.occupancyId, {
                carrierOccupancyId: group.carrier.occupancyId,
                continuityGroupId: group.continuityGroupId,
                memberCount: group.members.length,
            });
        }
    }

    return lookup;
}

function resolveMemberScheduledWindow(member: ContinuityOccupancy) {
    const startedAt = asDate(member.startedAt)!;
    const explicitScheduledStartAt = asDate(member.scheduledStartAt);
    const explicitScheduledEndAt = asDate(member.scheduledEndAt);

    return member.domain === "intervention"
        ? inferInterventionCoverageWindow({
            startedAt,
            shiftLabel: member.shiftLabel,
            explicitScheduledStartAt,
            explicitScheduledEndAt,
        })
        : inferRegulationCoverageWindow({
            startedAt,
            shiftLabel: member.shiftLabel,
            explicitScheduledStartAt,
            explicitScheduledEndAt,
        });
}

export function buildContinuityBankHoursSpan(records: ContinuityOccupancy[]) {
    if (records.length === 0) {
        throw new Error("Continuity span requires at least one occupancy.");
    }

    const group = buildContinuityGroups(records)[0]!;
    const firstWindow = resolveMemberScheduledWindow(group.carrier);
    const tailWindow = resolveMemberScheduledWindow(group.tail);

    return {
        doctorId: group.carrier.doctorId,
        continuityGroupId: group.continuityGroupId,
        carrierOccupancyId: group.carrier.occupancyId,
        carrierDomain: (group.carrier as ContinuityOccupancy).domain,
        memberOccupancyIds: group.members.map((member) => member.occupancyId),
        scheduledStartAt: firstWindow.scheduledStartAt,
        scheduledEndAt: tailWindow.scheduledEndAt,
        actualStartAt: asDate(group.carrier.startedAt)!,
        actualEndAt: resolveContinuityEffectiveEndedAt(group.tail),
        isClosed: group.members.every((member) => Boolean(resolveContinuityEffectiveEndedAt(member))),
    } satisfies ContinuityBankHoursSpan;
}