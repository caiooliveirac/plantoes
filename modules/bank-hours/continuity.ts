import { resolveBankHoursScheduledWindow } from "@/modules/bank-hours/window";
import { classifyEarlyDeparture, isEarlyDepartureEligible, isStoredEarlyDepartureOutcome } from "@/modules/operational/early-departure";

export type ContinuityDomain = "regulation" | "intervention";

export interface ContinuityRecord {
    occupancyId: string;
    doctorId: string;
    continuityGroupId: string;
    startedAt: string | Date;
    endedAt?: string | Date | null;
    actualEndedAt?: string | Date | null;
    /**
     * When the chefe/admin confirmed the verbalized departure. If null while
     * actualEndedAt is set, the occupancy is in "hold" — the closure is not
     * authoritative yet and bank hours must NOT be credited until confirmed.
     */
    departureConfirmedAt?: string | Date | null;
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

/**
 * A continuity member is "closure-authoritative" for bank hours when either:
 *   - it was closed without a verbalized real end (endedAt only, no actualEndedAt
 *     to question — typically system or chief direct closure), OR
 *   - actualEndedAt is set AND departureConfirmedAt is set (chief confirmed).
 *
 * If actualEndedAt is set but departureConfirmedAt is null, the closure is in
 * "hold" — chief still needs to review the verbalized departure. Bank hours
 * must wait. We treat this as "not closed yet" for span purposes so that
 * syncBankHoursByContinuityGroup short-circuits.
 */
export function isDepartureClosureAuthoritative(
    record: Pick<ContinuityRecord, "endedAt" | "actualEndedAt" | "departureConfirmedAt">,
) {
    if (!record.endedAt && !record.actualEndedAt) {
        return false;
    }
    if (!record.actualEndedAt) {
        return true;
    }
    return Boolean(record.departureConfirmedAt);
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

function resolveMemberScheduledWindow(member: ContinuityOccupancy, actualEndAt?: Date | null) {
    return resolveBankHoursScheduledWindow({
        domain: member.domain,
        startedAt: member.startedAt,
        shiftLabel: member.shiftLabel,
        scheduledStartAt: member.scheduledStartAt,
        scheduledEndAt: member.scheduledEndAt,
        actualEndAt,
    });
}

export function buildContinuityBankHoursSpan(records: ContinuityOccupancy[]) {
    if (records.length === 0) {
        throw new Error("Continuity span requires at least one occupancy.");
    }

    const group = buildContinuityGroups(records)[0]!;
    const tailEndedAt = resolveContinuityEffectiveEndedAt(group.tail);
    const firstWindow = resolveMemberScheduledWindow(group.carrier);
    // O fim previsto do grupo é o do último membro, recortado pela saída que ele teve:
    // um "P" herdado na ponta esticava a janela mais um turno e engolia a hora extra.
    const tailWindow = resolveMemberScheduledWindow(group.tail, tailEndedAt);

    return {
        doctorId: group.carrier.doctorId,
        continuityGroupId: group.continuityGroupId,
        carrierOccupancyId: group.carrier.occupancyId,
        carrierDomain: (group.carrier as ContinuityOccupancy).domain,
        memberOccupancyIds: group.members.map((member) => member.occupancyId),
        scheduledStartAt: firstWindow.scheduledStartAt,
        scheduledEndAt: tailWindow.scheduledEndAt,
        actualStartAt: asDate(group.carrier.startedAt)!,
        actualEndAt: tailEndedAt,
        isClosed: group.members.every((member) => isDepartureClosureAuthoritative(member)),
    } satisfies ContinuityBankHoursSpan;
}

export type ManualOverrideDepartureCheck<T> =
    | { status: "open" }
    | { status: "early_departure_pending"; member: T }
    | { status: "ok"; toConfirm: T[] };

/**
 * O ajuste manual do saldo é a revisão do admin sobre o grupo inteiro: as saídas
 * ainda em hold (saída real sem confirmação) são confirmadas junto com ele. Sem
 * isso, uma saída que nunca chega à fila da chefia — mudança de posto do próprio
 * médico, ou a que passou da janela de 7 dias — travava o grupo para sempre: sem
 * banco e sem ajuste possível.
 *
 * Duas recusas: plantão ainda aberto (não há saída a revisar) e saída antecipada
 * no fim da cadeia sem desfecho gravado — MEIO ou "só banco" decide pagamento, e
 * essa decisão é da chefia, não do saldo.
 */
export function resolveManualOverrideDepartures<T extends ContinuityOccupancy & {
    roleLabel?: string | null;
    earlyDepartureOutcome?: string | null;
}>(records: T[]): ManualOverrideDepartureCheck<T> {
    if (records.length === 0 || records.some((record) => !record.endedAt && !record.actualEndedAt)) {
        return { status: "open" };
    }

    const group = buildContinuityGroups(records)[0]!;
    const toConfirm = group.members.filter((member) => !isDepartureClosureAuthoritative(member));
    const tail = group.tail;
    if (
        toConfirm.includes(tail)
        && isEarlyDepartureEligible({ roleLabel: tail.roleLabel })
        && !isStoredEarlyDepartureOutcome(tail.earlyDepartureOutcome)
        && classifyEarlyDeparture({
            departureAt: tail.actualEndedAt!,
            scheduledStartAt: tail.scheduledStartAt,
            scheduledEndAt: tail.scheduledEndAt,
            startedAt: tail.startedAt,
        }).outcome !== "full_shift"
    ) {
        return { status: "early_departure_pending", member: tail };
    }

    return { status: "ok", toConfirm };
}