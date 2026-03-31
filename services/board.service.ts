import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  resolveImplicitOccupancyExpiry,
  resolveOperationalShiftWindow,
  shouldKeepRegulationOccupancyVisible,
} from "@/modules/operational/board-rules";
import {
  inferInterventionScheduledEndAt,
  inferOperationalScheduledStartAt,
  inferRegulationScheduledEndAt,
} from "@/modules/operational/rules";
import { calculateBankHours } from "@/modules/bank-hours/calculator";
import { buildContinuityBankHoursSpan } from "@/modules/bank-hours/continuity";
import {
  buildBankHoursBalanceOverrideExplanation,
  listBankHoursBalanceOverridesByContinuityGroupIds,
  MANUAL_BANK_HOURS_OVERRIDE_RULE_CODE,
  type BankHoursBalanceOverrideSummary,
} from "@/modules/bank-hours/service";
import { expireInterventionBaseDeactivations } from "@/modules/intervention/service";
import { expireStaleRegulationOccupancies } from "@/modules/regulation/service";

export interface RegulationBoardRow {
  postId: number;
  occupancyId: string | null;
  postCode: string;
  postLabel: string;
  defaultRole: string | null;
  doctorId: string | null;
  doctorName: string | null;
  displayName: string | null;
  startedAt: string | null;
  boardStartedAt: string | null;
  scheduledEndAt: string | null;
  shiftLabel: "SD" | "SN" | "P" | null;
  roleLabel: string | null;
  ramalLabel: string | null;
  status: "active" | "waiting";
  liveSource: "operations_v2" | "legacy_live" | "none";
  liveUpdatedAt: string | null;
}

export interface InterventionBoardRow {
  baseId: number;
  occupancyId: string | null;
  baseCode: string;
  baseLabel: string;
  doctorId: string | null;
  doctorName: string | null;
  displayName: string | null;
  startedAt: string | null;
  boardStartedAt: string | null;
  scheduledEndAt: string | null;
  shiftLabel: "SD" | "SN" | "P" | null;
  roleLabel: string | null;
  status: "active" | "waiting" | "disabled";
  disabledAt?: string | null;
  disabledReason?: string | null;
  liveSource: "operations_v2" | "legacy_live" | "none";
  liveUpdatedAt: string | null;
}

export type PreviousOperationalBucket = "P_INVERTIDO" | "P" | "SD" | "SN";

export interface PreviousOperationalEntry {
  occupancyId: string;
  domain: "regulation" | "intervention";
  targetCode: string;
  targetLabel: string;
  doctorId: string;
  doctorName: string;
  displayName: string | null;
  startedAt: string;
  boardStartedAt: string | null;
  endedAt: string | null;
  actualEndedAt: string | null;
  scheduledStartAt: string | null;
  scheduledEndAt: string | null;
  shiftLabel: "SD" | "SN" | "P" | null;
  bucket: PreviousOperationalBucket;
  status: "open" | "closed";
  roleLabel: string | null;
  ramalLabel: string | null;
  arrivalDelayMinutes: number | null;
  overtimeMinutes: number | null;
  creditedOvertimeMinutes: number | null;
  balanceMinutes: number | null;
  ruleCode: string | null;
  bankHoursExplanation: string | null;
}

export interface PreviousOperationalSection {
  bucket: PreviousOperationalBucket;
  label: string;
  description: string;
  entries: PreviousOperationalEntry[];
}

export interface PreviousOperationalBoard {
  generatedAt: string;
  operationalDate: string;
  shiftLabel: "SD" | "SN";
  startedAt: string;
  endedAt: string;
  totalEntries: number;
  sections: PreviousOperationalSection[];
}

export type PaymentAllocationStatus = "ready_for_payment" | "needs_review";

export interface PaymentAllocationTargetDefinition {
  domain: "regulation" | "intervention";
  targetCode: string;
  targetLabel: string;
  sortOrder: number;
  defaultRole: string | null;
  disabledAt?: string | null;
  disabledReason?: string | null;
  disabledDuringShift?: boolean;
  disabledEntireShift?: boolean;
}

export interface PaymentAllocationRawRow {
  occupancyId: string;
  domain: "regulation" | "intervention";
  targetCode: string;
  targetLabel: string;
  doctorId: string;
  doctorName: string;
  displayName: string | null;
  startedAt: string;
  boardStartedAt: string | null;
  endedAt: string | null;
  actualEndedAt: string | null;
  scheduledStartAt: string | null;
  scheduledEndAt: string | null;
  continuityGroupId: string | null;
  shiftLabel: "SD" | "SN" | "P" | null;
  roleLabel: string | null;
  ramalLabel: string | null;
  arrivalDelayMinutes: number | null;
  overtimeMinutes: number | null;
  creditedOvertimeMinutes: number | null;
  balanceMinutes: number | null;
  ruleCode: string | null;
  bankHoursExplanation: string | null;
  source: string | null;
  notes: string | null;
}

type PreviousOperationalRawRow = PaymentAllocationRawRow;

export interface PaymentAllocationRow {
  domain: "regulation" | "intervention";
  targetCode: string;
  targetLabel: string;
  sortOrder: number;
  defaultRole: string | null;
  disabledAt?: string | null;
  disabledReason?: string | null;
  disabledDuringShift?: boolean;
  disabledEntireShift?: boolean;
  occupancyId: string | null;
  doctorId: string | null;
  doctorName: string | null;
  displayName: string | null;
  startedAt: string | null;
  endedAt: string | null;
  actualEndedAt: string | null;
  scheduledStartAt: string | null;
  scheduledEndAt: string | null;
  shiftLabel: "SD" | "SN" | "P" | null;
  roleLabel: string | null;
  ramalLabel: string | null;
  source: string | null;
  candidateCount: number;
  paymentStatus: PaymentAllocationStatus;
  issues: string[];
  arrivalDelayMinutes: number | null;
  overtimeMinutes: number | null;
  creditedOvertimeMinutes: number | null;
  balanceMinutes: number | null;
  ruleCode: string | null;
  bankHoursExplanation: string | null;
  sourceShiftLabel?: "SD" | "SN" | "P" | null;
  sourceStartedAt?: string | null;
  sourceBoardStartedAt?: string | null;
  sourceEndedAt?: string | null;
  sourceActualEndedAt?: string | null;
  sourceScheduledStartAt?: string | null;
  sourceScheduledEndAt?: string | null;
  sourceArrivalDelayMinutes?: number | null;
  sourceOvertimeMinutes?: number | null;
  sourceCreditedOvertimeMinutes?: number | null;
  sourceBalanceMinutes?: number | null;
  sourceRuleCode?: string | null;
  sourceBankHoursExplanation?: string | null;
  continuesBeyondShift?: boolean;
}

export interface PaymentAllocationBoard {
  generatedAt: string;
  operationalDate: string;
  shiftLabel: "SD" | "SN";
  startedAt: string;
  endedAt: string;
  summary: {
    totalTargets: number;
    assignedCount: number;
    readyForPaymentCount: number;
    needsReviewCount: number;
    unassignedCount: number;
    disabledCount?: number;
  };
  regulation: PaymentAllocationRow[];
  intervention: PaymentAllocationRow[];
}

type LogicalShiftSlot = "SD" | "SN";

interface LogicalShiftCandidate extends PreviousOperationalRawRow {
  logicalSlotStart: string;
  logicalSlot: LogicalShiftSlot;
  effectiveEndedAt: string | null;
  invalidTimeline: boolean;
  isShadow: boolean;
  duplicateConflict: boolean;
  durationMinutes: number | null;
  isLikelyNoise: boolean;
}

interface PaymentAllocationTargetChoice {
  target: PaymentAllocationTargetDefinition;
  candidates: LogicalShiftCandidate[];
  chosenCandidate: LogicalShiftCandidate | null;
  displacedByDoctorConflict: boolean;
}

interface ContinuitySourceSummary {
  continuityGroupId: string;
  memberCount: number;
  spansMultipleSlots: boolean;
  sourceShiftLabel: "SD" | "SN" | "P" | null;
  sourceStartedAt: string;
  sourceBoardStartedAt: string | null;
  sourceEndedAt: string | null;
  sourceActualEndedAt: string | null;
  sourceScheduledStartAt: string | null;
  sourceScheduledEndAt: string | null;
  syntheticBankHours: SyntheticBankHoursSummary;
}

const OPERATIONAL_LOCAL_OFFSET_MINUTES = -180;
const MAX_SCHEDULE_DRIFT_MINUTES = 180;
const MIN_TITULAR_DURATION_MINUTES = 45;
const MAX_IMPLICIT_HANDOFF_EXTENSION_MINUTES = 180;

interface SyntheticBankHoursSummary {
  arrivalDelayMinutes: number | null;
  overtimeMinutes: number | null;
  creditedOvertimeMinutes: number | null;
  balanceMinutes: number | null;
  ruleCode: string | null;
  bankHoursExplanation: string | null;
}

function applyBankHoursBalanceOverrideToSummary(
  summary: SyntheticBankHoursSummary,
  override: BankHoursBalanceOverrideSummary | null,
) {
  if (!override) {
    return summary;
  }

  return {
    ...summary,
    balanceMinutes: override.balanceMinutes,
    ruleCode: MANUAL_BANK_HOURS_OVERRIDE_RULE_CODE,
    bankHoursExplanation: buildBankHoursBalanceOverrideExplanation({
      balanceMinutes: override.balanceMinutes,
      notes: override.notes,
      automaticBalanceMinutes: summary.balanceMinutes,
    }),
  } satisfies SyntheticBankHoursSummary;
}

function toOperationalLocalClock(date: Date) {
  return new Date(date.getTime() + (OPERATIONAL_LOCAL_OFFSET_MINUTES * 60000));
}

function fromOperationalLocalClockParts(year: number, month: number, day: number, hour: number, minute: number) {
  return new Date(Date.UTC(year, month - 1, day, hour - (OPERATIONAL_LOCAL_OFFSET_MINUTES / 60), minute, 0, 0));
}

function getOperationalLocalDateParts(date: Date) {
  const local = toOperationalLocalClock(date);
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
  };
}

function addOperationalLocalDays(parts: { year: number; month: number; day: number }, days: number) {
  const shifted = new Date(fromOperationalLocalClockParts(parts.year, parts.month, parts.day, 12, 0).getTime() + (days * 86400000));
  return getOperationalLocalDateParts(shifted);
}

function resolveSlotStartByTolerance(date: Date) {
  const parts = getOperationalLocalDateParts(date);
  const sdStart = fromOperationalLocalClockParts(parts.year, parts.month, parts.day, 7, 0);
  const snStart = fromOperationalLocalClockParts(parts.year, parts.month, parts.day, 19, 0);
  const toleranceMs = 2 * 60 * 60 * 1000;

  if (date.getTime() >= snStart.getTime() - toleranceMs) {
    return snStart;
  }

  if (date.getTime() >= sdStart.getTime() - toleranceMs) {
    return sdStart;
  }

  const previousDay = addOperationalLocalDays(parts, -1);
  return fromOperationalLocalClockParts(previousDay.year, previousDay.month, previousDay.day, 19, 0);
}

function resolveSlotLabelFromStart(slotStart: Date): LogicalShiftSlot {
  const local = toOperationalLocalClock(slotStart);
  return local.getUTCHours() >= 19 ? "SN" : "SD";
}

function resolveSlotEnd(slotStart: Date, slot: LogicalShiftSlot) {
  const parts = getOperationalLocalDateParts(slotStart);
  if (slot === "SD") {
    return fromOperationalLocalClockParts(parts.year, parts.month, parts.day, 19, 0);
  }

  const nextDay = addOperationalLocalDays(parts, 1);
  return fromOperationalLocalClockParts(nextDay.year, nextDay.month, nextDay.day, 7, 0);
}

function normalizeFreeText(value: string | null | undefined) {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
}

function diffIsoMinutes(startIso: string, endIso: string) {
  return Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000);
}

function isDurationValid(startIso: string, endIso: string | null) {
  return Boolean(endIso && diffIsoMinutes(startIso, endIso) > 0);
}

function resolveDurationMinutes(startIso: string, endIso: string | null) {
  if (!isDurationValid(startIso, endIso)) {
    return null;
  }

  return diffIsoMinutes(startIso, endIso as string);
}

function isBotGeneratedNoise(notes: string | null | undefined) {
  const normalized = normalizeFreeText(notes);
  return normalized.includes("PESSOAL, POR FAVOR ALIMENTEM O GRUPO")
    || normalized.includes("SE EU ENTENDER ALGO ERRADO")
    || normalized.includes("DEBUG COMMAND CORRECTION");
}

function hasDepartureEvidence(notes: string | null | undefined) {
  const normalized = normalizeFreeText(notes);
  return normalized.includes("SAIDA")
    || normalized.includes("SAINDO")
    || normalized.includes("SAIU")
    || normalized.includes("ENCERR")
    || normalized.includes("[TELEGRAM SAIDA AJUSTADA]");
}

function resolveLogicalAnchorAt(row: PreviousOperationalRawRow) {
  if (row.scheduledStartAt) {
    const scheduledStartAt = new Date(row.scheduledStartAt);
    const scheduleDriftMinutes = diffIsoMinutes(row.scheduledStartAt, row.startedAt);
    if (
      row.shiftLabel !== "P"
      && scheduledStartAt.getTime() <= new Date(row.startedAt).getTime()
      && scheduleDriftMinutes >= 0
      && scheduleDriftMinutes <= MAX_SCHEDULE_DRIFT_MINUTES
    ) {
      return scheduledStartAt;
    }
  }

  return new Date(row.startedAt);
}

function resolveDefaultScheduledWindow(domain: "regulation" | "intervention", slotStartIso: string, slot: LogicalShiftSlot) {
  const slotStart = new Date(slotStartIso);
  const scheduledStartAt = inferOperationalScheduledStartAt(slotStart, slot, slotStart)?.toISOString() ?? slotStartIso;
  const scheduledEndAt = (domain === "intervention"
    ? inferInterventionScheduledEndAt(slotStart, slot, null)
    : inferRegulationScheduledEndAt(slotStart, slot, null))?.toISOString() ?? resolveSlotEnd(slotStart, slot).toISOString();

  return {
    scheduledStartAt,
    scheduledEndAt,
  };
}

function resolvePreviousOperationalDate(reference = new Date()) {
  const parts = addOperationalLocalDays(getOperationalLocalDateParts(reference), -1);
  return {
    parts,
    operationalDate: fromOperationalLocalClockParts(parts.year, parts.month, parts.day, 12, 0),
  };
}

function mapRegulationRow(row: Record<string, unknown>): RegulationBoardRow {
  return {
    postId: Number(row.postId ?? row.post_id),
    occupancyId: (row.occupancyId ?? row.occupancy_id ?? null) as string | null,
    postCode: String(row.postCode ?? row.post_code ?? ""),
    postLabel: String(row.postLabel ?? row.post_label ?? ""),
    defaultRole: (row.defaultRole ?? row.default_role ?? null) as string | null,
    doctorId: (row.doctorId ?? row.doctor_id ?? null) as string | null,
    doctorName: (row.doctorName ?? row.doctor_name ?? null) as string | null,
    displayName: (row.displayName ?? row.display_name ?? null) as string | null,
    startedAt: (row.startedAt ?? row.started_at ?? null) as string | null,
    boardStartedAt: (row.boardStartedAt ?? row.board_started_at ?? null) as string | null,
    scheduledEndAt: (row.scheduledEndAt ?? row.scheduled_end_at ?? null) as string | null,
    shiftLabel: (row.shiftLabel ?? row.shift_label ?? null) as RegulationBoardRow["shiftLabel"],
    roleLabel: (row.roleLabel ?? row.role_label ?? null) as string | null,
    ramalLabel: (row.ramalLabel ?? row.ramal_label ?? null) as string | null,
    status: String(row.status ?? "waiting") === "active" ? "active" : "waiting",
    liveSource: (row.liveSource ?? row.live_source ?? "none") as RegulationBoardRow["liveSource"],
    liveUpdatedAt: (row.liveUpdatedAt ?? row.live_updated_at ?? null) as string | null,
  };
}

function mapInterventionRow(row: Record<string, unknown>): InterventionBoardRow {
  const rawStatus = String(row.status ?? "waiting");

  return {
    baseId: Number(row.baseId ?? row.base_id),
    occupancyId: (row.occupancyId ?? row.occupancy_id ?? null) as string | null,
    baseCode: String(row.baseCode ?? row.base_code ?? ""),
    baseLabel: String(row.baseLabel ?? row.base_label ?? ""),
    doctorId: (row.doctorId ?? row.doctor_id ?? null) as string | null,
    doctorName: (row.doctorName ?? row.doctor_name ?? null) as string | null,
    displayName: (row.displayName ?? row.display_name ?? null) as string | null,
    startedAt: (row.startedAt ?? row.started_at ?? null) as string | null,
    boardStartedAt: (row.boardStartedAt ?? row.board_started_at ?? null) as string | null,
    scheduledEndAt: (row.scheduledEndAt ?? row.scheduled_end_at ?? null) as string | null,
    shiftLabel: (row.shiftLabel ?? row.shift_label ?? null) as InterventionBoardRow["shiftLabel"],
    roleLabel: (row.roleLabel ?? row.role_label ?? null) as string | null,
    status: rawStatus === "disabled" ? "disabled" : rawStatus === "active" ? "active" : "waiting",
    disabledAt: (row.disabledAt ?? row.disabled_at ?? null) as string | null,
    disabledReason: (row.disabledReason ?? row.disabled_reason ?? null) as string | null,
    liveSource: (row.liveSource ?? row.live_source ?? "none") as InterventionBoardRow["liveSource"],
    liveUpdatedAt: (row.liveUpdatedAt ?? row.live_updated_at ?? null) as string | null,
  };
}

function normalizeShiftLabel(value: string | null | undefined): "SD" | "SN" | "P" | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toUpperCase();
  if (normalized === "SD" || normalized === "SN" || normalized === "P") {
    return normalized;
  }

  return null;
}

function mapPreviousOperationalRow(row: Record<string, unknown>): PreviousOperationalRawRow {
  return {
    occupancyId: String(row.occupancyId),
    domain: String(row.domain) === "regulation" ? "regulation" : "intervention",
    targetCode: String(row.targetCode),
    targetLabel: String(row.targetLabel),
    doctorId: String(row.doctorId),
    doctorName: String(row.doctorName),
    displayName: (row.displayName ?? null) as string | null,
    startedAt: String(row.startedAt),
    boardStartedAt: (row.boardStartedAt ?? null) as string | null,
    endedAt: (row.endedAt ?? null) as string | null,
    actualEndedAt: (row.actualEndedAt ?? null) as string | null,
    scheduledStartAt: (row.scheduledStartAt ?? null) as string | null,
    scheduledEndAt: (row.scheduledEndAt ?? null) as string | null,
    continuityGroupId: (row.continuityGroupId ?? null) as string | null,
    shiftLabel: normalizeShiftLabel((row.shiftLabel ?? null) as string | null),
    roleLabel: (row.roleLabel ?? null) as string | null,
    ramalLabel: (row.ramalLabel ?? null) as string | null,
    arrivalDelayMinutes: row.arrivalDelayMinutes === null ? null : Number(row.arrivalDelayMinutes),
    overtimeMinutes: row.overtimeMinutes === null ? null : Number(row.overtimeMinutes),
    creditedOvertimeMinutes: row.creditedOvertimeMinutes === null ? null : Number(row.creditedOvertimeMinutes),
    balanceMinutes: row.balanceMinutes === null ? null : Number(row.balanceMinutes),
    ruleCode: (row.ruleCode ?? null) as string | null,
    bankHoursExplanation: (row.bankHoursExplanation ?? null) as string | null,
    source: (row.source ?? null) as string | null,
    notes: (row.notes ?? null) as string | null,
  };
}

function resolvePreviousBucketLabel(bucket: PreviousOperationalBucket) {
  if (bucket === "P_INVERTIDO") {
    return "P invertido";
  }
  if (bucket === "P") {
    return "P";
  }
  return bucket;
}

function resolvePreviousBucketDescription(bucket: PreviousOperationalBucket) {
  if (bucket === "P_INVERTIDO") {
    return "Responsabilidades que começaram no SN e terminaram no SD. O medico responsavel pela entidade vem antes do horario que gerou banco.";
  }
  if (bucket === "P") {
    return "Responsabilidades que atravessaram SD e SN. Primeiro importa quem assumiu e quem entregou o plantao; depois vem o efeito em banco.";
  }
  if (bucket === "SD") {
    return "Plantao diurno tratado como entidade fechada: quem assumiu a responsabilidade do SD e quem encerrou depois.";
  }
  return "Plantao noturno tratado como entidade fechada: o responsavel pelo SN vem antes do horario que gerou mais ou menos banco.";
}

function mapLogicalShiftCandidate(row: PreviousOperationalRawRow): LogicalShiftCandidate {
  const logicalSlotStart = resolveSlotStartByTolerance(resolveLogicalAnchorAt(row)).toISOString();
  const effectiveEndedAt = row.actualEndedAt ?? row.endedAt ?? null;
  const invalidTimeline = Boolean(effectiveEndedAt && new Date(effectiveEndedAt).getTime() <= new Date(row.startedAt).getTime());
  const durationMinutes = resolveDurationMinutes(row.startedAt, effectiveEndedAt);
  const isLikelyNoise = isBotGeneratedNoise(row.notes)
    || (durationMinutes !== null && durationMinutes < MIN_TITULAR_DURATION_MINUTES);

  return {
    ...row,
    logicalSlotStart,
    logicalSlot: resolveSlotLabelFromStart(new Date(logicalSlotStart)),
    effectiveEndedAt,
    invalidTimeline,
    isShadow: /SOMBRA/.test(normalizeFreeText(row.notes)),
    duplicateConflict: false,
    durationMinutes,
    isLikelyNoise,
  };
}

function isPlausibleSuccessorStart(row: PreviousOperationalRawRow) {
  if (isBotGeneratedNoise(row.notes)) {
    return false;
  }

  if (hasDepartureEvidence(row.notes) && row.shiftLabel !== "P") {
    return false;
  }

  if (row.domain === "intervention" && !row.boardStartedAt && row.shiftLabel !== "P") {
    return false;
  }

  const effectiveEndedAt = row.actualEndedAt ?? row.endedAt ?? null;
  const durationMinutes = resolveDurationMinutes(row.startedAt, effectiveEndedAt);
  if (durationMinutes !== null && durationMinutes < MIN_TITULAR_DURATION_MINUTES) {
    return false;
  }

  return true;
}

function resolveSuccessorStartMap(rows: PreviousOperationalRawRow[]) {
  const grouped = new Map<string, PreviousOperationalRawRow[]>();

  for (const row of rows) {
    const key = [row.domain, row.targetCode].join("|");
    const current = grouped.get(key) ?? [];
    current.push(row);
    grouped.set(key, current);
  }

  const successorByOccupancyId = new Map<string, string | null>();
  for (const bucket of grouped.values()) {
    const sorted = [...bucket].sort((left, right) => new Date(left.startedAt).getTime() - new Date(right.startedAt).getTime());
    const successorCandidates = sorted.filter(isPlausibleSuccessorStart);

    for (let index = 0; index < sorted.length; index += 1) {
      const current = sorted[index] as PreviousOperationalRawRow;
      const currentStartedAt = new Date(current.startedAt).getTime();
      const successor = successorCandidates.find((candidate) => (
        candidate.occupancyId !== current.occupancyId
        && new Date(candidate.startedAt).getTime() > currentStartedAt
      ));

      successorByOccupancyId.set(current.occupancyId, successor?.startedAt ?? null);
    }
  }

  return successorByOccupancyId;
}

function resolveCandidateEffectiveEndedAt(candidate: LogicalShiftCandidate, successorStartedAt: string | null) {
  const explicitEndAt = candidate.actualEndedAt ?? candidate.endedAt ?? null;
  const implicitExpiry = resolveImplicitOccupancyExpiry(
    candidate.logicalSlotStart,
    candidate.shiftLabel === "P" ? candidate.shiftLabel : candidate.logicalSlot,
  )?.toISOString() ?? null;
  const successorBasedClosure = (() => {
    if (!successorStartedAt || !implicitExpiry) {
      return null;
    }

    const extensionMinutes = diffIsoMinutes(implicitExpiry, successorStartedAt);
    if (extensionMinutes <= 0) {
      return successorStartedAt;
    }

    return extensionMinutes <= MAX_IMPLICIT_HANDOFF_EXTENSION_MINUTES ? successorStartedAt : null;
  })();

  if (explicitEndAt && successorStartedAt && new Date(explicitEndAt).getTime() > new Date(successorStartedAt).getTime()) {
    return successorStartedAt;
  }

  if (explicitEndAt && candidate.shiftLabel !== "P" && implicitExpiry) {
    if (new Date(explicitEndAt).getTime() <= new Date(implicitExpiry).getTime()) {
      return explicitEndAt;
    }

    if (successorBasedClosure && new Date(explicitEndAt).getTime() === new Date(successorBasedClosure).getTime()) {
      return explicitEndAt;
    }

    if (hasDepartureEvidence(candidate.notes)) {
      return explicitEndAt;
    }

    return implicitExpiry;
  }

  if (explicitEndAt) {
    return explicitEndAt;
  }

  if (candidate.shiftLabel === "P") {
    return successorStartedAt ?? null;
  }

  return successorBasedClosure ?? implicitExpiry;
}

function applyEffectiveEndedAt(candidate: LogicalShiftCandidate, successorStartedAt: string | null): LogicalShiftCandidate {
  const effectiveEndedAt = resolveCandidateEffectiveEndedAt(candidate, successorStartedAt);
  const invalidTimeline = Boolean(effectiveEndedAt && new Date(effectiveEndedAt).getTime() <= new Date(candidate.startedAt).getTime());
  const durationMinutes = resolveDurationMinutes(candidate.startedAt, effectiveEndedAt);

  return {
    ...candidate,
    effectiveEndedAt,
    invalidTimeline,
    durationMinutes,
    isLikelyNoise: isBotGeneratedNoise(candidate.notes)
      || (durationMinutes !== null && durationMinutes < MIN_TITULAR_DURATION_MINUTES),
  };
}

function demoteRegulationRowToWaiting(row: RegulationBoardRow): RegulationBoardRow {
  return {
    ...row,
    occupancyId: null,
    doctorId: null,
    doctorName: null,
    displayName: null,
    startedAt: null,
    boardStartedAt: null,
    scheduledEndAt: null,
    shiftLabel: null,
    roleLabel: null,
    ramalLabel: row.postCode,
    status: "waiting",
    liveSource: "none",
    liveUpdatedAt: null,
  };
}

function rankLogicalShiftCandidate(candidate: LogicalShiftCandidate) {
  if (candidate.invalidTimeline) {
    return -1000;
  }

  let score = 0;
  if (!candidate.isShadow) {
    score += 100;
  }

  if (candidate.effectiveEndedAt) {
    score += 20;
  }

  if (candidate.actualEndedAt) {
    score += 10;
  }

  if (candidate.shiftLabel === candidate.logicalSlot) {
    score += 8;
  }

  if (candidate.shiftLabel === "P") {
    score += 5;
  }

  if (candidate.notes?.includes("/corrigir")) {
    score += 3;
  }

  if (candidate.effectiveEndedAt) {
    score += Math.min(candidate.durationMinutes ?? 0, 1440) / 100;
  }

  if (candidate.durationMinutes !== null && candidate.durationMinutes < MIN_TITULAR_DURATION_MINUTES) {
    score -= 60;
  }

  if (isBotGeneratedNoise(candidate.notes)) {
    score -= 40;
  }

  return score;
}

function collapseLogicalShiftCandidates(candidates: LogicalShiftCandidate[]) {
  const grouped = new Map<string, LogicalShiftCandidate[]>();

  for (const candidate of candidates) {
    const key = [candidate.doctorId, candidate.domain, candidate.targetCode, candidate.logicalSlotStart].join("|");
    const current = grouped.get(key) ?? [];
    current.push(candidate);
    grouped.set(key, current);
  }

  return Array.from(grouped.values()).map((bucket) => {
    const ranked = [...bucket].sort((left, right) => {
      const startedAtDiff = new Date(left.startedAt).getTime() - new Date(right.startedAt).getTime();
      if (startedAtDiff === 0) {
        const openDiff = Number(right.effectiveEndedAt === null) - Number(left.effectiveEndedAt === null);
        if (openDiff !== 0) {
          return openDiff;
        }
      }

      return rankLogicalShiftCandidate(right) - rankLogicalShiftCandidate(left);
    });
    return {
      ...ranked[0],
      duplicateConflict: bucket.length > 1 && bucket.some((item) => item.invalidTimeline),
    } satisfies LogicalShiftCandidate;
  }).filter((candidate) => !candidate.invalidTimeline);
}

function resolvePreviousSlotStart(slotStartIso: string, slot: LogicalShiftSlot) {
  const slotStart = new Date(slotStartIso);
  const parts = getOperationalLocalDateParts(slotStart);
  if (slot === "SN") {
    return fromOperationalLocalClockParts(parts.year, parts.month, parts.day, 7, 0).toISOString();
  }

  const previousDay = addOperationalLocalDays(parts, -1);
  return fromOperationalLocalClockParts(previousDay.year, previousDay.month, previousDay.day, 19, 0).toISOString();
}

function shouldIgnoreDuplicateRestart(candidate: LogicalShiftCandidate, allCandidates: LogicalShiftCandidate[]) {
  if (!candidate.duplicateConflict || candidate.isShadow) {
    return false;
  }

  if (Math.abs(new Date(candidate.startedAt).getTime() - new Date(candidate.logicalSlotStart).getTime()) > 5 * 60000) {
    return false;
  }

  const previousSlotStart = resolvePreviousSlotStart(candidate.logicalSlotStart, candidate.logicalSlot);
  return allCandidates.some((other) => (
    other.occupancyId !== candidate.occupancyId
    && other.doctorId === candidate.doctorId
    && other.domain === candidate.domain
    && other.targetCode === candidate.targetCode
    && other.logicalSlotStart === previousSlotStart
    && /CONTINU/.test(normalizeFreeText(other.notes))
  ));
}

function sumNullable(values: Array<number | null>) {
  const filtered = values.filter((value): value is number => value !== null);
  if (filtered.length === 0) {
    return null;
  }

  return filtered.reduce((total, value) => total + value, 0);
}

function resolveScheduledBoundary(explicitIso: string | null, expectedIso: string) {
  if (!explicitIso) {
    return expectedIso;
  }

  return Math.abs(diffIsoMinutes(explicitIso, expectedIso)) > MAX_SCHEDULE_DRIFT_MINUTES
    ? expectedIso
    : explicitIso;
}

function calculateSyntheticBankHours(params: {
  scheduledStartAt: string | null;
  scheduledEndAt: string | null;
  actualStartAt: string;
  actualEndAt: string | null;
}): SyntheticBankHoursSummary {
  if (!params.scheduledStartAt || !params.scheduledEndAt || !params.actualEndAt) {
    return {
      arrivalDelayMinutes: null,
      overtimeMinutes: null,
      creditedOvertimeMinutes: null,
      balanceMinutes: null,
      ruleCode: null,
      bankHoursExplanation: null,
    };
  }

  const calculation = calculateBankHours({
    scheduledStartAt: params.scheduledStartAt,
    scheduledEndAt: params.scheduledEndAt,
    actualStartAt: params.actualStartAt,
    actualEndAt: params.actualEndAt,
  });

  return {
    arrivalDelayMinutes: calculation.arrivalDelayMinutes,
    overtimeMinutes: calculation.overtimeMinutes,
    creditedOvertimeMinutes: calculation.creditedOvertimeMinutes,
    balanceMinutes: calculation.balanceMinutes,
    ruleCode: calculation.ruleCode,
    bankHoursExplanation: calculation.explanation,
  };
}

function buildContinuitySourceSummaryMap(rows: PreviousOperationalRawRow[]) {
  const grouped = new Map<string, PreviousOperationalRawRow[]>();

  for (const row of rows) {
    if (!row.continuityGroupId) {
      continue;
    }

    const key = [row.doctorId, row.continuityGroupId].join("|");
    const current = grouped.get(key) ?? [];
    current.push(row);
    grouped.set(key, current);
  }

  const summaryByOccupancyId = new Map<string, ContinuitySourceSummary>();
  for (const bucket of grouped.values()) {
    if (bucket.length < 2) {
      continue;
    }

    const ordered = [...bucket].sort((left, right) => {
      const byStartedAt = new Date(left.startedAt).getTime() - new Date(right.startedAt).getTime();
      if (byStartedAt !== 0) {
        return byStartedAt;
      }

      return left.occupancyId.localeCompare(right.occupancyId, "pt-BR");
    });
    const carrier = ordered[0] as PreviousOperationalRawRow;
    const tail = ordered[ordered.length - 1] as PreviousOperationalRawRow;
    const slotCount = new Set(ordered.map((row) => resolveSlotStartByTolerance(resolveLogicalAnchorAt(row)).toISOString())).size;
    const span = buildContinuityBankHoursSpan(ordered.map((row) => ({
      occupancyId: row.occupancyId,
      domain: row.domain,
      doctorId: row.doctorId,
      continuityGroupId: row.continuityGroupId as string,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      actualEndedAt: row.actualEndedAt,
      scheduledStartAt: row.scheduledStartAt,
      scheduledEndAt: row.scheduledEndAt,
      shiftLabel: row.shiftLabel,
    })));
    const syntheticBankHours = calculateSyntheticBankHours({
      scheduledStartAt: span.scheduledStartAt?.toISOString() ?? null,
      scheduledEndAt: span.scheduledEndAt?.toISOString() ?? null,
      actualStartAt: span.actualStartAt.toISOString(),
      actualEndAt: span.actualEndAt?.toISOString() ?? null,
    });

    const summary = {
      continuityGroupId: carrier.continuityGroupId as string,
      memberCount: ordered.length,
      spansMultipleSlots: slotCount > 1,
      sourceShiftLabel: slotCount > 1 ? "P" : carrier.shiftLabel,
      sourceStartedAt: span.actualStartAt.toISOString(),
      sourceBoardStartedAt: carrier.boardStartedAt,
      sourceEndedAt: tail.endedAt,
      sourceActualEndedAt: tail.actualEndedAt ?? tail.endedAt,
      sourceScheduledStartAt: span.scheduledStartAt?.toISOString() ?? null,
      sourceScheduledEndAt: span.scheduledEndAt?.toISOString() ?? null,
      syntheticBankHours,
    } satisfies ContinuitySourceSummary;

    for (const member of ordered) {
      summaryByOccupancyId.set(member.occupancyId, summary);
    }
  }

  return summaryByOccupancyId;
}

function buildSourceBankHoursSummary(candidate: LogicalShiftCandidate) {
  const scheduledWindow = resolveStandaloneScheduledWindow(candidate, resolveStandaloneBucket(candidate));
  const actualEndAt = candidate.actualEndedAt ?? candidate.endedAt ?? null;
  const syntheticBankHours = calculateSyntheticBankHours({
    scheduledStartAt: scheduledWindow.scheduledStartAt,
    scheduledEndAt: scheduledWindow.scheduledEndAt,
    actualStartAt: candidate.startedAt,
    actualEndAt,
  });

  return {
    scheduledStartAt: scheduledWindow.scheduledStartAt,
    scheduledEndAt: scheduledWindow.scheduledEndAt,
    actualEndAt,
    syntheticBankHours,
  };
}

function isEligibleTitularityCandidate(candidate: LogicalShiftCandidate) {
  if (candidate.isShadow || candidate.invalidTimeline || candidate.isLikelyNoise) {
    return false;
  }

  if (candidate.domain === "intervention" && !candidate.boardStartedAt && candidate.shiftLabel !== "P") {
    return false;
  }

  return true;
}

function isMicroCoverage(candidate: LogicalShiftCandidate) {
  return Boolean(
    candidate.effectiveEndedAt
    && diffIsoMinutes(candidate.startedAt, candidate.effectiveEndedAt) < MIN_TITULAR_DURATION_MINUTES,
  );
}

function joinUnique(values: Array<string | null>, separator: string) {
  const filtered = values.filter((value): value is string => Boolean(value?.trim()));
  if (filtered.length === 0) {
    return null;
  }

  return Array.from(new Set(filtered)).join(separator);
}

function resolveStandaloneBucket(candidate: LogicalShiftCandidate): PreviousOperationalBucket {
  if (candidate.shiftLabel === "P") {
    return candidate.logicalSlot === "SN" ? "P_INVERTIDO" : "P";
  }

  return candidate.logicalSlot;
}

function resolveStandaloneScheduledWindow(candidate: LogicalShiftCandidate, bucket: PreviousOperationalBucket) {
  if (bucket === "P") {
    const slotStart = new Date(candidate.logicalSlotStart);
    const parts = getOperationalLocalDateParts(slotStart);
    const snStart = fromOperationalLocalClockParts(parts.year, parts.month, parts.day, 19, 0).toISOString();
    const firstWindow = resolveDefaultScheduledWindow(candidate.domain, candidate.logicalSlotStart, "SD");
    const secondWindow = resolveDefaultScheduledWindow(candidate.domain, snStart, "SN");
    return {
      scheduledStartAt: resolveScheduledBoundary(candidate.scheduledStartAt, firstWindow.scheduledStartAt),
      scheduledEndAt: resolveScheduledBoundary(candidate.scheduledEndAt, secondWindow.scheduledEndAt),
    };
  }

  if (bucket === "P_INVERTIDO") {
    const slotStart = new Date(candidate.logicalSlotStart);
    const nextDay = addOperationalLocalDays(getOperationalLocalDateParts(slotStart), 1);
    const sdStart = fromOperationalLocalClockParts(nextDay.year, nextDay.month, nextDay.day, 7, 0).toISOString();
    const firstWindow = resolveDefaultScheduledWindow(candidate.domain, candidate.logicalSlotStart, "SN");
    const secondWindow = resolveDefaultScheduledWindow(candidate.domain, sdStart, "SD");
    return {
      scheduledStartAt: resolveScheduledBoundary(candidate.scheduledStartAt, firstWindow.scheduledStartAt),
      scheduledEndAt: resolveScheduledBoundary(candidate.scheduledEndAt, secondWindow.scheduledEndAt),
    };
  }

  const defaultWindow = resolveDefaultScheduledWindow(candidate.domain, candidate.logicalSlotStart, candidate.logicalSlot);
  return {
    scheduledStartAt: resolveScheduledBoundary(candidate.scheduledStartAt, defaultWindow.scheduledStartAt),
    scheduledEndAt: resolveScheduledBoundary(candidate.scheduledEndAt, defaultWindow.scheduledEndAt),
  };
}

function buildStandalonePreviousEntry(candidate: LogicalShiftCandidate): PreviousOperationalEntry {
  const bucket = resolveStandaloneBucket(candidate);
  const scheduledWindow = resolveStandaloneScheduledWindow(candidate, bucket);
  const syntheticBankHours = calculateSyntheticBankHours({
    scheduledStartAt: scheduledWindow.scheduledStartAt,
    scheduledEndAt: scheduledWindow.scheduledEndAt,
    actualStartAt: candidate.startedAt,
    actualEndAt: candidate.effectiveEndedAt,
  });
  return {
    occupancyId: candidate.occupancyId,
    domain: candidate.domain,
    targetCode: candidate.targetCode,
    targetLabel: candidate.targetLabel,
    doctorId: candidate.doctorId,
    doctorName: candidate.doctorName,
    displayName: candidate.displayName,
    startedAt: candidate.startedAt,
    boardStartedAt: candidate.boardStartedAt,
    endedAt: candidate.effectiveEndedAt,
    actualEndedAt: candidate.effectiveEndedAt,
    scheduledStartAt: scheduledWindow.scheduledStartAt,
    scheduledEndAt: scheduledWindow.scheduledEndAt,
    shiftLabel: candidate.shiftLabel === "P" ? "P" : candidate.logicalSlot,
    bucket,
    status: candidate.effectiveEndedAt ? "closed" : "open",
    roleLabel: candidate.roleLabel,
    ramalLabel: candidate.ramalLabel,
    arrivalDelayMinutes: syntheticBankHours.arrivalDelayMinutes,
    overtimeMinutes: syntheticBankHours.overtimeMinutes,
    creditedOvertimeMinutes: syntheticBankHours.creditedOvertimeMinutes,
    balanceMinutes: syntheticBankHours.balanceMinutes,
    ruleCode: syntheticBankHours.ruleCode,
    bankHoursExplanation: syntheticBankHours.bankHoursExplanation,
  };
}

function buildCombinedPreviousEntry(bucket: PreviousOperationalBucket, first: LogicalShiftCandidate, second: LogicalShiftCandidate): PreviousOperationalEntry {
  const firstWindow = resolveDefaultScheduledWindow(first.domain, first.logicalSlotStart, first.logicalSlot);
  const secondWindow = resolveDefaultScheduledWindow(second.domain, second.logicalSlotStart, second.logicalSlot);
  const combinedTargetCode = first.targetCode === second.targetCode
    ? first.targetCode
    : `${first.targetCode} -> ${second.targetCode}`;
  const combinedTargetLabel = first.targetLabel === second.targetLabel
    ? first.targetLabel
    : `${first.targetLabel} -> ${second.targetLabel}`;
  const scheduledStartAt = resolveScheduledBoundary(first.scheduledStartAt, firstWindow.scheduledStartAt);
  const scheduledEndAt = resolveScheduledBoundary(second.scheduledEndAt, secondWindow.scheduledEndAt);
  const syntheticBankHours = calculateSyntheticBankHours({
    scheduledStartAt,
    scheduledEndAt,
    actualStartAt: first.startedAt,
    actualEndAt: second.effectiveEndedAt,
  });

  return {
    occupancyId: `${first.occupancyId}+${second.occupancyId}`,
    domain: first.domain,
    targetCode: combinedTargetCode,
    targetLabel: combinedTargetLabel,
    doctorId: first.doctorId,
    doctorName: first.doctorName,
    displayName: first.displayName,
    startedAt: first.startedAt,
    boardStartedAt: first.boardStartedAt,
    endedAt: second.effectiveEndedAt,
    actualEndedAt: second.effectiveEndedAt,
    scheduledStartAt,
    scheduledEndAt,
    shiftLabel: "P",
    bucket,
    status: second.effectiveEndedAt ? "closed" : "open",
    roleLabel: joinUnique([first.roleLabel, second.roleLabel], " / "),
    ramalLabel: joinUnique([first.ramalLabel, second.ramalLabel], " / "),
    arrivalDelayMinutes: syntheticBankHours.arrivalDelayMinutes,
    overtimeMinutes: syntheticBankHours.overtimeMinutes,
    creditedOvertimeMinutes: syntheticBankHours.creditedOvertimeMinutes,
    balanceMinutes: syntheticBankHours.balanceMinutes,
    ruleCode: syntheticBankHours.ruleCode,
    bankHoursExplanation: syntheticBankHours.bankHoursExplanation,
  };
}

function comparePreviousEntries(left: PreviousOperationalEntry, right: PreviousOperationalEntry) {
  const leftDoctor = left.displayName ?? left.doctorName;
  const rightDoctor = right.displayName ?? right.doctorName;
  const doctorComparison = leftDoctor.localeCompare(rightDoctor, "pt-BR");
  if (doctorComparison !== 0) {
    return doctorComparison;
  }

  if (left.targetCode !== right.targetCode) {
    return left.targetCode.localeCompare(right.targetCode, "pt-BR");
  }

  const leftCode = Number(left.targetCode);
  const rightCode = Number(right.targetCode);
  if (Number.isFinite(leftCode) && Number.isFinite(rightCode) && leftCode !== rightCode) {
    return leftCode - rightCode;
  }

  return left.domain.localeCompare(right.domain, "pt-BR");
}

export async function listRegulationBoard() {
  const db = getDb();
  const result = await db.execute(sql`
    with legacy_regulation as (
      select
        cs.ramal as post_code,
        app_user.doctor_id,
        coalesce(legacy_doctor.full_name, legacy_user.name) as doctor_name,
        legacy_doctor.display_name,
        cs.arrival_time as started_at,
        cs.arrival_time as board_started_at,
        si.scheduled_end_at,
        coalesce(cs.role_function_detected, si.role_function) as role_label,
        cs.ramal as ramal_label,
        cs.updated_at,
        row_number() over (
          partition by cs.ramal
          order by cs.arrival_time desc nulls last, cs.updated_at desc nulls last, cs.shift_instance_id asc
        ) as row_rank
      from public.shift_current_state cs
      inner join public.shift_instances si on si.id = cs.shift_instance_id
      left join operations_v2.users app_user on app_user.id = cs.executor_user_id
      left join operations_v2.doctors legacy_doctor on legacy_doctor.id = app_user.doctor_id
      left join public.users legacy_user on legacy_user.id = cs.executor_user_id
      where cs.status = 'CONFIRMED'
        and cs.departure_time is null
        and cs.ramal is not null
        and coalesce(si.scheduled_end_at, si.scheduled_start_at + interval '18 hours', now()) >= now() - interval '6 hours'
        and coalesce(si.scheduled_start_at, now()) <= now() + interval '6 hours'
    )
    select
      rp.id as "postId",
      ro.id as "occupancyId",
      rp.code as "postCode",
      rp.label as "postLabel",
      rp.default_role as "defaultRole",
      case
        when ro.id is not null and ro.source <> 'import' then d.id
        else coalesce(lr.doctor_id, d.id)
      end as "doctorId",
      case
        when ro.id is not null and ro.source <> 'import' then d.full_name
        else coalesce(lr.doctor_name, d.full_name)
      end as "doctorName",
      case
        when ro.id is not null and ro.source <> 'import' then d.display_name
        else coalesce(lr.display_name, d.display_name)
      end as "displayName",
      case
        when ro.id is not null and ro.source <> 'import' then ro.started_at
        else coalesce(lr.started_at, ro.started_at)
      end as "startedAt",
      case
        when ro.id is not null and ro.source <> 'import' then ro.board_started_at
        else coalesce(lr.board_started_at, ro.board_started_at)
      end as "boardStartedAt",
      case
        when ro.id is not null and ro.source <> 'import' then ro.scheduled_end_at
        else coalesce(lr.scheduled_end_at, ro.scheduled_end_at)
      end as "scheduledEndAt",
      case
        when ro.id is not null and ro.source <> 'import' then ro.shift_label
        else ro.shift_label
      end as "shiftLabel",
      case
        when ro.id is not null and ro.source <> 'import' then ro.role_label
        else coalesce(lr.role_label, ro.role_label)
      end as "roleLabel",
      case
        when ro.id is not null and ro.source <> 'import' then coalesce(ro.ramal_label, rp.code)
        else coalesce(lr.ramal_label, ro.ramal_label, rp.code)
      end as "ramalLabel",
      case when ro.id is not null or lr.post_code is not null then 'active' else 'waiting' end as "status",
      case
        when ro.id is not null and ro.source <> 'import' then 'operations_v2'
        when lr.post_code is not null then 'legacy_live'
        when ro.id is not null then 'operations_v2'
        else 'none'
      end as "liveSource",
      lr.updated_at as "liveUpdatedAt"
    from operations_v2.regulation_posts rp
    left join operations_v2.regulation_occupancies ro
      on ro.post_id = rp.id
     and ro.board_started_at is not null
     and ro.ended_at is null
    left join operations_v2.doctors d
      on d.id = ro.doctor_id
    left join legacy_regulation lr
      on lr.post_code = rp.code
     and lr.row_rank = 1
    where rp.is_active = true
    order by rp.sort_order asc, rp.code asc
  `);

  const rows = (result as unknown as Record<string, unknown>[]).map(mapRegulationRow);
  const reference = new Date();

  return rows.map((row) => {
    if (row.status !== "active" || !row.doctorId) {
      return row;
    }

    return shouldKeepRegulationOccupancyVisible({
      startedAt: row.startedAt,
      boardStartedAt: row.boardStartedAt,
      shiftLabel: row.shiftLabel,
      reference,
    }) ? row : demoteRegulationRowToWaiting(row);
  });
}

export async function listInterventionBoard() {
  const db = getDb();
  const result = await db.execute(sql`
    with legacy_intervention as (
      select
        legacy_base.code as base_code,
        app_user.doctor_id,
        coalesce(legacy_doctor.full_name, legacy_user.name) as doctor_name,
        legacy_doctor.display_name,
        cs.arrival_time as started_at,
        cs.arrival_time as board_started_at,
        si.scheduled_end_at,
        coalesce(cs.role_function_detected, si.role_function) as role_label,
        cs.updated_at,
        row_number() over (
          partition by legacy_base.code
          order by cs.arrival_time desc nulls last, cs.updated_at desc nulls last, cs.shift_instance_id asc
        ) as row_rank
      from public.shift_current_state cs
      inner join public.shift_instances si on si.id = cs.shift_instance_id
      inner join public.bases legacy_base on legacy_base.id = si.base_id
      left join operations_v2.users app_user on app_user.id = cs.executor_user_id
      left join operations_v2.doctors legacy_doctor on legacy_doctor.id = app_user.doctor_id
      left join public.users legacy_user on legacy_user.id = cs.executor_user_id
      where cs.status = 'CONFIRMED'
        and cs.departure_time is null
        and cs.ramal is null
        and upper(coalesce(legacy_base.sector::text, '')) = 'INTERVENTION'
        and coalesce(si.scheduled_end_at, si.scheduled_start_at + interval '18 hours', now()) >= now() - interval '6 hours'
        and coalesce(si.scheduled_start_at, now()) <= now() + interval '6 hours'
    ),
    active_deactivations as (
      select
        ibd.base_id,
        ibd.deactivated_at,
        ibd.notes,
        row_number() over (
          partition by ibd.base_id
          order by ibd.deactivated_at desc, ibd.created_at desc
        ) as row_rank
      from operations_v2.intervention_base_deactivations ibd
      where ibd.reactivated_at is null
    )
    select
      ib.id as "baseId",
      io.id as "occupancyId",
      ib.code as "baseCode",
      ib.label as "baseLabel",
      case
        when ad.base_id is not null then null
        when io.id is not null and io.source <> 'import' then d.id
        else coalesce(li.doctor_id, d.id)
      end as "doctorId",
      case
        when ad.base_id is not null then null
        when io.id is not null and io.source <> 'import' then d.full_name
        else coalesce(li.doctor_name, d.full_name)
      end as "doctorName",
      case
        when ad.base_id is not null then null
        when io.id is not null and io.source <> 'import' then d.display_name
        else coalesce(li.display_name, d.display_name)
      end as "displayName",
      case
        when ad.base_id is not null then null
        when io.id is not null and io.source <> 'import' then io.started_at
        else coalesce(li.started_at, io.started_at)
      end as "startedAt",
      case
        when ad.base_id is not null then null
        when io.id is not null and io.source <> 'import' then io.board_started_at
        else coalesce(li.board_started_at, io.board_started_at)
      end as "boardStartedAt",
      case
        when ad.base_id is not null then null
        when io.id is not null and io.source <> 'import' then io.scheduled_end_at
        else coalesce(li.scheduled_end_at, io.scheduled_end_at)
      end as "scheduledEndAt",
      case
        when ad.base_id is not null then null
        when io.id is not null and io.source <> 'import' then io.shift_label
        else io.shift_label
      end as "shiftLabel",
      case
        when ad.base_id is not null then null
        when io.id is not null and io.source <> 'import' then io.role_label
        else coalesce(li.role_label, io.role_label)
      end as "roleLabel",
      ad.deactivated_at as "disabledAt",
      ad.notes as "disabledReason",
      case
        when ad.base_id is not null then 'disabled'
        when io.id is not null or li.base_code is not null then 'active'
        else 'waiting'
      end as "status",
      case
        when ad.base_id is not null then 'none'
        when io.id is not null and io.source <> 'import' then 'operations_v2'
        when li.base_code is not null then 'legacy_live'
        when io.id is not null then 'operations_v2'
        else 'none'
      end as "liveSource",
      case when ad.base_id is not null then null else li.updated_at end as "liveUpdatedAt"
    from operations_v2.intervention_bases ib
    left join operations_v2.intervention_occupancies io
      on io.base_id = ib.id
     and io.board_started_at is not null
     and io.ended_at is null
    left join operations_v2.doctors d
      on d.id = io.doctor_id
    left join legacy_intervention li
      on li.base_code = ib.code
     and li.row_rank = 1
    left join active_deactivations ad
      on ad.base_id = ib.id
     and ad.row_rank = 1
    where ib.is_active = true
    order by ib.sort_order asc, ib.code asc
  `);

  return (result as unknown as Record<string, unknown>[]).map(mapInterventionRow);
}

export async function getOperationalBoard() {
  await expireInterventionBaseDeactivations(new Date());
  await expireStaleRegulationOccupancies(new Date());

  const [regulation, intervention] = await Promise.all([
    listRegulationBoard(),
    listInterventionBoard(),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    regulation,
    intervention,
  };
}

export async function getPreviousOperationalBoard(reference = new Date()): Promise<PreviousOperationalBoard> {
  const db = getDb();
  const previousDate = resolvePreviousOperationalDate(reference);
  const previousDayParts = previousDate.parts;
  const previousNightParts = addOperationalLocalDays(previousDayParts, -1);
  const nextDayParts = addOperationalLocalDays(previousDayParts, 1);
  const queryStart = fromOperationalLocalClockParts(previousNightParts.year, previousNightParts.month, previousNightParts.day, 0, 0).toISOString();
  const queryEnd = fromOperationalLocalClockParts(addOperationalLocalDays(previousDayParts, 2).year, addOperationalLocalDays(previousDayParts, 2).month, addOperationalLocalDays(previousDayParts, 2).day, 0, 0).toISOString();
  const previousStartedAtIso = fromOperationalLocalClockParts(previousDayParts.year, previousDayParts.month, previousDayParts.day, 7, 0).toISOString();
  const previousEndedAtIso = fromOperationalLocalClockParts(nextDayParts.year, nextDayParts.month, nextDayParts.day, 7, 0).toISOString();
  const previousShiftLabel = "SN" as const;
  const relevantSlotStarts = new Set([
    fromOperationalLocalClockParts(previousNightParts.year, previousNightParts.month, previousNightParts.day, 19, 0).toISOString(),
    fromOperationalLocalClockParts(previousDayParts.year, previousDayParts.month, previousDayParts.day, 7, 0).toISOString(),
    fromOperationalLocalClockParts(previousDayParts.year, previousDayParts.month, previousDayParts.day, 19, 0).toISOString(),
  ]);

  const result = await db.execute(sql`
    with previous_regulation as (
      select
        ro.id as "occupancyId",
        'regulation' as domain,
        rp.code as "targetCode",
        rp.label as "targetLabel",
        d.id as "doctorId",
        d.full_name as "doctorName",
        d.display_name as "displayName",
        ro.started_at as "startedAt",
        ro.board_started_at as "boardStartedAt",
        coalesce(ro.actual_ended_at, ro.ended_at) as "endedAt",
        ro.actual_ended_at as "actualEndedAt",
        ro.scheduled_start_at as "scheduledStartAt",
        ro.scheduled_end_at as "scheduledEndAt",
        ro.shift_label as "shiftLabel",
        ro.role_label as "roleLabel",
        coalesce(ro.ramal_label, rp.code) as "ramalLabel",
        ro.source as source,
        ro.notes as notes,
        bhe.arrival_delay_minutes as "arrivalDelayMinutes",
        bhe.overtime_minutes as "overtimeMinutes",
        bhe.credited_overtime_minutes as "creditedOvertimeMinutes",
        bhe.balance_minutes as "balanceMinutes",
        bhe.rule_code as "ruleCode",
        bhe.explanation as "bankHoursExplanation"
      from operations_v2.regulation_occupancies ro
      inner join operations_v2.regulation_posts rp on rp.id = ro.post_id
      inner join operations_v2.doctors d on d.id = ro.doctor_id
      left join operations_v2.bank_hours_entries bhe on bhe.regulation_occupancy_id = ro.id
      where ro.started_at >= ${queryStart}::timestamptz
        and ro.started_at < ${queryEnd}::timestamptz
    ),
    previous_intervention as (
      select
        io.id as "occupancyId",
        'intervention' as domain,
        ib.code as "targetCode",
        ib.label as "targetLabel",
        d.id as "doctorId",
        d.full_name as "doctorName",
        d.display_name as "displayName",
        io.started_at as "startedAt",
        io.board_started_at as "boardStartedAt",
        coalesce(io.actual_ended_at, io.ended_at) as "endedAt",
        io.actual_ended_at as "actualEndedAt",
        io.scheduled_start_at as "scheduledStartAt",
        io.scheduled_end_at as "scheduledEndAt",
        io.shift_label as "shiftLabel",
        io.role_label as "roleLabel",
        null::text as "ramalLabel",
        io.source as source,
        io.notes as notes,
        bhe.arrival_delay_minutes as "arrivalDelayMinutes",
        bhe.overtime_minutes as "overtimeMinutes",
        bhe.credited_overtime_minutes as "creditedOvertimeMinutes",
        bhe.balance_minutes as "balanceMinutes",
        bhe.rule_code as "ruleCode",
        bhe.explanation as "bankHoursExplanation"
      from operations_v2.intervention_occupancies io
      inner join operations_v2.intervention_bases ib on ib.id = io.base_id
      inner join operations_v2.doctors d on d.id = io.doctor_id
      left join operations_v2.bank_hours_entries bhe on bhe.intervention_occupancy_id = io.id
      where io.started_at >= ${queryStart}::timestamptz
        and io.started_at < ${queryEnd}::timestamptz
    )
    select * from previous_regulation
    union all
    select * from previous_intervention
  `);

  const rawRows = (result as unknown as Record<string, unknown>[]).map(mapPreviousOperationalRow);
  const successorStartMap = resolveSuccessorStartMap(rawRows);

  const logicalCandidates = collapseLogicalShiftCandidates(rawRows
    .map(mapLogicalShiftCandidate)
    .map((candidate) => applyEffectiveEndedAt(candidate, successorStartMap.get(candidate.occupancyId) ?? null))
    .filter((candidate) => relevantSlotStarts.has(candidate.logicalSlotStart))
  ).filter((candidate) => isEligibleTitularityCandidate(candidate))
    .filter((candidate) => !isMicroCoverage(candidate))
    .filter((candidate, _, all) => !shouldIgnoreDuplicateRestart(candidate, all));

  const candidatesByDoctorTarget = new Map<string, Map<string, LogicalShiftCandidate>>();
  for (const candidate of logicalCandidates) {
    const key = [candidate.domain, candidate.targetCode, candidate.doctorId].join("|");
    const current = candidatesByDoctorTarget.get(key) ?? new Map<string, LogicalShiftCandidate>();
    current.set(candidate.logicalSlotStart, candidate);
    candidatesByDoctorTarget.set(key, current);
  }

  const consumedOccupancyIds = new Set<string>();
  const entries: PreviousOperationalEntry[] = [];
  const previousSnSlotStart = fromOperationalLocalClockParts(previousNightParts.year, previousNightParts.month, previousNightParts.day, 19, 0).toISOString();
  const sdSlotStart = fromOperationalLocalClockParts(previousDayParts.year, previousDayParts.month, previousDayParts.day, 7, 0).toISOString();
  const snSlotStart = fromOperationalLocalClockParts(previousDayParts.year, previousDayParts.month, previousDayParts.day, 19, 0).toISOString();

  for (const slotMap of candidatesByDoctorTarget.values()) {
    const previousSn = slotMap.get(previousSnSlotStart);
    const sd = slotMap.get(sdSlotStart);
    const sn = slotMap.get(snSlotStart);

    if (previousSn && sd) {
      entries.push(buildCombinedPreviousEntry("P_INVERTIDO", previousSn, sd));
      consumedOccupancyIds.add(previousSn.occupancyId);
      consumedOccupancyIds.add(sd.occupancyId);
    }

    if (sd && sn) {
      entries.push(buildCombinedPreviousEntry("P", sd, sn));
      consumedOccupancyIds.add(sd.occupancyId);
      consumedOccupancyIds.add(sn.occupancyId);
    }
  }

  const candidatesByDoctorDomain = new Map<string, LogicalShiftCandidate[]>();
  for (const candidate of logicalCandidates) {
    if (consumedOccupancyIds.has(candidate.occupancyId)) {
      continue;
    }

    const key = [candidate.domain, candidate.doctorId].join("|");
    const current = candidatesByDoctorDomain.get(key) ?? [];
    current.push(candidate);
    candidatesByDoctorDomain.set(key, current);
  }

  for (const doctorCandidates of candidatesByDoctorDomain.values()) {
    const previousSnCandidates = doctorCandidates.filter((candidate) => candidate.logicalSlotStart === previousSnSlotStart);
    const sdCandidates = doctorCandidates.filter((candidate) => candidate.logicalSlotStart === sdSlotStart);

    if (previousSnCandidates.length !== 1 || sdCandidates.length !== 1) {
      continue;
    }

    const previousSn = previousSnCandidates[0] as LogicalShiftCandidate;
    const sd = sdCandidates[0] as LogicalShiftCandidate;
    if (consumedOccupancyIds.has(previousSn.occupancyId) || consumedOccupancyIds.has(sd.occupancyId)) {
      continue;
    }

    if (previousSn.targetCode === sd.targetCode) {
      continue;
    }

    entries.push(buildCombinedPreviousEntry("P_INVERTIDO", previousSn, sd));
    consumedOccupancyIds.add(previousSn.occupancyId);
    consumedOccupancyIds.add(sd.occupancyId);
  }

  for (const candidate of logicalCandidates) {
    if (consumedOccupancyIds.has(candidate.occupancyId)) {
      continue;
    }

    entries.push(buildStandalonePreviousEntry(candidate));
  }

  const sortedEntries = entries.sort(comparePreviousEntries);

  const sectionOrder: PreviousOperationalBucket[] = ["P_INVERTIDO", "P", "SD", "SN"];
  const sections = sectionOrder.map((bucket) => ({
    bucket,
    label: resolvePreviousBucketLabel(bucket),
    description: resolvePreviousBucketDescription(bucket),
    entries: sortedEntries.filter((entry) => entry.bucket === bucket),
  }));

  return {
    generatedAt: new Date().toISOString(),
    operationalDate: previousDate.operationalDate.toISOString(),
    shiftLabel: previousShiftLabel,
    startedAt: previousStartedAtIso,
    endedAt: previousEndedAtIso,
    totalEntries: sortedEntries.length,
    sections,
  };
}

function resolvePaymentAllocationTarget(row: Record<string, unknown>): PaymentAllocationTargetDefinition {
  return {
    domain: String(row.domain) === "regulation" ? "regulation" : "intervention",
    targetCode: String(row.targetCode),
    targetLabel: String(row.targetLabel),
    sortOrder: Number(row.sortOrder ?? 0),
    defaultRole: (row.defaultRole ?? null) as string | null,
    disabledAt: (row.disabledAt ?? null) as string | null,
    disabledReason: (row.disabledReason ?? null) as string | null,
    disabledDuringShift: Boolean(row.disabledDuringShift ?? false),
    disabledEntireShift: Boolean(row.disabledEntireShift ?? false),
  };
}

function resolvePaymentAllocationStatus(issues: string[]): PaymentAllocationStatus {
  return issues.length > 0 ? "needs_review" : "ready_for_payment";
}

function comparePaymentAllocationRows(left: PaymentAllocationRow, right: PaymentAllocationRow) {
  if (left.sortOrder !== right.sortOrder) {
    return left.sortOrder - right.sortOrder;
  }

  const leftCode = Number(left.targetCode);
  const rightCode = Number(right.targetCode);
  if (Number.isFinite(leftCode) && Number.isFinite(rightCode) && leftCode !== rightCode) {
    return leftCode - rightCode;
  }

  return left.targetCode.localeCompare(right.targetCode, "pt-BR");
}

function buildPaymentAllocationScheduledWindow(candidate: LogicalShiftCandidate) {
  const defaultWindow = resolveDefaultScheduledWindow(candidate.domain, candidate.logicalSlotStart, candidate.logicalSlot);
  return {
    scheduledStartAt: resolveScheduledBoundary(candidate.scheduledStartAt, defaultWindow.scheduledStartAt),
    scheduledEndAt: resolveScheduledBoundary(candidate.scheduledEndAt, defaultWindow.scheduledEndAt),
  };
}

function resolvePlannedCoverageEndAt(candidate: LogicalShiftCandidate) {
  if (candidate.scheduledEndAt) {
    return candidate.scheduledEndAt;
  }

  if (candidate.shiftLabel === "P") {
    return resolveStandaloneScheduledWindow(candidate, resolveStandaloneBucket(candidate)).scheduledEndAt;
  }

  return resolveImplicitOccupancyExpiry(candidate.logicalSlotStart, candidate.logicalSlot)?.toISOString() ?? null;
}

function resolveCandidateCoverageEndAt(candidate: LogicalShiftCandidate) {
  if (candidate.shiftLabel === "P") {
    const plannedCoverageEndAt = resolvePlannedCoverageEndAt(candidate);
    if (!candidate.effectiveEndedAt) {
      return plannedCoverageEndAt;
    }

    if (!plannedCoverageEndAt) {
      return candidate.effectiveEndedAt;
    }

    return new Date(candidate.effectiveEndedAt).getTime() <= new Date(plannedCoverageEndAt).getTime()
      ? candidate.effectiveEndedAt
      : plannedCoverageEndAt;
  }

  if (candidate.effectiveEndedAt) {
    return candidate.effectiveEndedAt;
  }

  return resolvePlannedCoverageEndAt(candidate);
}

function doesCandidateCoverPaymentSlot(candidate: LogicalShiftCandidate, slotStartIso: string) {
  if (candidate.logicalSlotStart === slotStartIso) {
    return true;
  }

  if (candidate.shiftLabel !== "P") {
    return false;
  }

  const slotStart = new Date(slotStartIso).getTime();
  if (new Date(candidate.logicalSlotStart).getTime() > slotStart) {
    return false;
  }

  const coverageEndAt = resolveCandidateCoverageEndAt(candidate);
  return Boolean(coverageEndAt && new Date(coverageEndAt).getTime() > slotStart);
}

function buildPaymentAllocationSlotWindow(params: {
  candidate: LogicalShiftCandidate;
  slotStartIso: string;
  shiftLabel: "SD" | "SN";
}) {
  const defaultWindow = resolveDefaultScheduledWindow(params.candidate.domain, params.slotStartIso, params.shiftLabel);
  if (params.candidate.logicalSlotStart !== params.slotStartIso) {
    return defaultWindow;
  }

  return {
    scheduledStartAt: resolveScheduledBoundary(params.candidate.scheduledStartAt, defaultWindow.scheduledStartAt),
    scheduledEndAt: resolveScheduledBoundary(params.candidate.scheduledEndAt, defaultWindow.scheduledEndAt),
  };
}

function buildPaymentAllocationActualWindow(params: {
  candidate: LogicalShiftCandidate;
  slotStartIso: string;
  shiftLabel: "SD" | "SN";
}) {
  const slotStart = new Date(params.slotStartIso);
  const slotEnd = resolveSlotEnd(slotStart, params.shiftLabel);
  const actualStartAt = new Date(params.candidate.startedAt).getTime() < slotStart.getTime()
    ? params.slotStartIso
    : params.candidate.startedAt;

  if (!params.candidate.effectiveEndedAt) {
    return {
      actualStartAt,
      actualEndAt: null,
    };
  }

  const actualEndTime = Math.min(new Date(params.candidate.effectiveEndedAt).getTime(), slotEnd.getTime());
  return {
    actualStartAt,
    actualEndAt: actualEndTime <= new Date(actualStartAt).getTime()
      ? null
      : new Date(actualEndTime).toISOString(),
  };
}

function resolvePaymentSlotCoverageMinutes(params: {
  candidate: LogicalShiftCandidate;
  slotStartIso: string;
  shiftLabel: "SD" | "SN";
}) {
  const slotStartAt = new Date(params.slotStartIso);
  const slotEndAt = resolveSlotEnd(slotStartAt, params.shiftLabel);
  const coverageStartAt = Math.max(new Date(params.candidate.startedAt).getTime(), slotStartAt.getTime());
  const coverageEndAt = resolveCandidateCoverageEndAt(params.candidate);
  const coverageEndTime = coverageEndAt
    ? Math.min(new Date(coverageEndAt).getTime(), slotEndAt.getTime())
    : slotEndAt.getTime();

  if (coverageEndTime <= coverageStartAt) {
    return 0;
  }

  return Math.round((coverageEndTime - coverageStartAt) / 60000);
}

function rankPaymentAllocationCandidate(params: {
  candidate: LogicalShiftCandidate;
  slotStartIso: string;
  shiftLabel: "SD" | "SN";
}) {
  const coverageMinutes = resolvePaymentSlotCoverageMinutes(params);
  let score = rankLogicalShiftCandidate(params.candidate);

  score += coverageMinutes / 10;

  if (params.candidate.logicalSlotStart === params.slotStartIso) {
    score += 35;
  }

  if (params.candidate.shiftLabel === params.shiftLabel) {
    score += 18;
  }

  if (params.candidate.source === "import") {
    score -= 25;
  }

  if (params.candidate.source === "manual" || params.candidate.source === "admin_correction") {
    score -= 30;
  }

  if (params.candidate.shiftLabel === "P" && params.candidate.logicalSlotStart !== params.slotStartIso) {
    score -= 20;
  }

  if (coverageMinutes >= MIN_TITULAR_DURATION_MINUTES) {
    score += 10;
  }

  return score;
}

function sortPaymentAllocationCandidates(params: {
  candidates: LogicalShiftCandidate[];
  slotStartIso: string;
  shiftLabel: "SD" | "SN";
}) {
  return [...params.candidates].sort((left, right) => {
    const scoreDiff = rankPaymentAllocationCandidate({
      candidate: right,
      slotStartIso: params.slotStartIso,
      shiftLabel: params.shiftLabel,
    }) - rankPaymentAllocationCandidate({
      candidate: left,
      slotStartIso: params.slotStartIso,
      shiftLabel: params.shiftLabel,
    });
    if (scoreDiff !== 0) {
      return scoreDiff;
    }

    const startedAtDiff = new Date(left.startedAt).getTime() - new Date(right.startedAt).getTime();
    const isSameRestart = startedAtDiff === 0
      && left.doctorId === right.doctorId
      && left.targetCode === right.targetCode
      && left.domain === right.domain;
    if (isSameRestart) {
      const openDiff = Number(right.effectiveEndedAt === null) - Number(left.effectiveEndedAt === null);
      if (openDiff !== 0) {
        return openDiff;
      }
    }

    const coverageDiff = resolvePaymentSlotCoverageMinutes({
      candidate: right,
      slotStartIso: params.slotStartIso,
      shiftLabel: params.shiftLabel,
    }) - resolvePaymentSlotCoverageMinutes({
      candidate: left,
      slotStartIso: params.slotStartIso,
      shiftLabel: params.shiftLabel,
    });
    if (coverageDiff !== 0) {
      return coverageDiff;
    }

    const leftEndedAt = left.effectiveEndedAt ? new Date(left.effectiveEndedAt).getTime() : 0;
    const rightEndedAt = right.effectiveEndedAt ? new Date(right.effectiveEndedAt).getTime() : 0;
    if (rightEndedAt !== leftEndedAt) {
      return rightEndedAt - leftEndedAt;
    }

    return startedAtDiff;
  });
}

function filterTargetPaymentCandidates(params: {
  candidates: LogicalShiftCandidate[];
  slotStartIso: string;
}) {
  const sameSlotStarters = params.candidates.filter((candidate) => {
    if (candidate.logicalSlotStart !== params.slotStartIso) {
      return false;
    }

    const offsetMinutes = diffIsoMinutes(params.slotStartIso, candidate.startedAt);
    return offsetMinutes >= 0 && offsetMinutes <= MAX_IMPLICIT_HANDOFF_EXTENSION_MINUTES;
  });

  if (sameSlotStarters.length === 0) {
    return params.candidates;
  }

  const earliestSameSlotStartAt = Math.min(...sameSlotStarters.map((candidate) => new Date(candidate.startedAt).getTime()));
  const filtered = params.candidates.filter((candidate) => {
    if (candidate.logicalSlotStart === params.slotStartIso) {
      return true;
    }

    const coverageEndAt = resolveCandidateCoverageEndAt(candidate);
    if (!coverageEndAt) {
      return true;
    }

    return new Date(coverageEndAt).getTime() > earliestSameSlotStartAt;
  });

  return filtered.length > 0 ? filtered : params.candidates;
}

function detectPaymentAllocationIssues(params: {
  candidate: LogicalShiftCandidate;
  candidateCount: number;
  syntheticBankHours: SyntheticBankHoursSummary;
}) {
  const issues: string[] = [];

  if (params.candidateCount > 1) {
    issues.push("Mais de um medico candidato no mesmo alvo/turno");
  }

  if (!params.candidate.effectiveEndedAt) {
    issues.push("Plantao sem saida consolidada");
  }

  if (params.candidate.source === "manual" || params.candidate.source === "admin_correction") {
    issues.push("Lancamento manual ou corrigido manualmente");
  }

  if (params.candidate.duplicateConflict) {
    issues.push("Existem registros redundantes para o mesmo alvo");
  }

  return issues;
}

function buildEmptyPaymentAllocationRow(params: {
  target: PaymentAllocationTargetDefinition;
  shiftLabel: "SD" | "SN";
  issues?: string[];
  candidateCount?: number;
}) {
  const issues = params.issues ?? ["Sem ocupacao identificada para o turno"];
  return {
    domain: params.target.domain,
    targetCode: params.target.targetCode,
    targetLabel: params.target.targetLabel,
    sortOrder: params.target.sortOrder,
    defaultRole: params.target.defaultRole,
    disabledAt: params.target.disabledAt,
    disabledReason: params.target.disabledReason,
    disabledDuringShift: params.target.disabledDuringShift,
    disabledEntireShift: params.target.disabledEntireShift,
    occupancyId: null,
    doctorId: null,
    doctorName: null,
    displayName: null,
    startedAt: null,
    endedAt: null,
    actualEndedAt: null,
    scheduledStartAt: null,
    scheduledEndAt: null,
    shiftLabel: params.shiftLabel,
    roleLabel: params.target.defaultRole,
    ramalLabel: params.target.domain === "regulation" ? params.target.targetCode : null,
    source: null,
    candidateCount: params.candidateCount ?? 0,
    paymentStatus: resolvePaymentAllocationStatus(issues),
    issues,
    arrivalDelayMinutes: null,
    overtimeMinutes: null,
    creditedOvertimeMinutes: null,
    balanceMinutes: null,
    ruleCode: null,
    bankHoursExplanation: null,
    sourceShiftLabel: null,
    sourceStartedAt: null,
    sourceBoardStartedAt: null,
    sourceEndedAt: null,
    sourceActualEndedAt: null,
    sourceScheduledStartAt: null,
    sourceScheduledEndAt: null,
    sourceArrivalDelayMinutes: null,
    sourceOvertimeMinutes: null,
    sourceCreditedOvertimeMinutes: null,
    sourceBalanceMinutes: null,
    sourceRuleCode: null,
    sourceBankHoursExplanation: null,
    continuesBeyondShift: false,
  } satisfies PaymentAllocationRow;
}

function buildDisabledPaymentAllocationRow(params: {
  target: PaymentAllocationTargetDefinition;
  shiftLabel: "SD" | "SN";
  candidateCount?: number;
}) {
  const issues = [
    params.target.disabledAt
      ? `Base desativada desde ${new Date(params.target.disabledAt).toISOString()}`
      : "Base desativada para este turno",
  ];

  return {
    ...buildEmptyPaymentAllocationRow({
      target: params.target,
      shiftLabel: params.shiftLabel,
      issues,
      candidateCount: params.candidateCount,
    }),
    paymentStatus: "ready_for_payment",
  } satisfies PaymentAllocationRow;
}

function buildChosenPaymentAllocationRow(params: {
  target: PaymentAllocationTargetDefinition;
  candidates: LogicalShiftCandidate[];
  chosenCandidate: LogicalShiftCandidate;
  slotStartIso: string;
  shiftLabel: "SD" | "SN";
  continuitySourceSummaryByOccupancyId: Map<string, ContinuitySourceSummary>;
  bankHoursBalanceOverridesByContinuityGroupId: Map<string, BankHoursBalanceOverrideSummary>;
}) {
  const chosen = params.chosenCandidate;
  const scheduledWindow = buildPaymentAllocationSlotWindow({
    candidate: chosen,
    slotStartIso: params.slotStartIso,
    shiftLabel: params.shiftLabel,
  });
  const actualWindow = buildPaymentAllocationActualWindow({
    candidate: chosen,
    slotStartIso: params.slotStartIso,
    shiftLabel: params.shiftLabel,
  });
  const slotEndAt = resolveSlotEnd(new Date(params.slotStartIso), params.shiftLabel);
  const continuitySource = params.continuitySourceSummaryByOccupancyId.get(chosen.occupancyId) ?? null;
  const shouldUseContinuitySource = Boolean(continuitySource?.spansMultipleSlots);
  const sourceShiftLabel = shouldUseContinuitySource ? continuitySource?.sourceShiftLabel ?? chosen.shiftLabel : chosen.shiftLabel;
  const sourceStartedAt = shouldUseContinuitySource ? continuitySource?.sourceStartedAt ?? chosen.startedAt : chosen.startedAt;
  const sourceBoardStartedAt = shouldUseContinuitySource ? continuitySource?.sourceBoardStartedAt ?? chosen.boardStartedAt : chosen.boardStartedAt;
  const sourceEndedAt = shouldUseContinuitySource ? continuitySource?.sourceEndedAt ?? chosen.endedAt : chosen.endedAt;
  const sourceActualEndedAt = shouldUseContinuitySource ? continuitySource?.sourceActualEndedAt ?? chosen.actualEndedAt : chosen.actualEndedAt;
  const sourceScheduledStartAt = shouldUseContinuitySource ? continuitySource?.sourceScheduledStartAt ?? null : null;
  const sourceScheduledEndAt = shouldUseContinuitySource ? continuitySource?.sourceScheduledEndAt ?? null : null;
  const sourceCoverageEndAt = shouldUseContinuitySource
    ? sourceActualEndedAt ?? sourceEndedAt ?? sourceScheduledEndAt
    : resolveCandidateCoverageEndAt(chosen);
  const sourceBankHours = shouldUseContinuitySource
    ? {
      scheduledStartAt: sourceScheduledStartAt,
      scheduledEndAt: sourceScheduledEndAt,
      actualEndAt: sourceActualEndedAt ?? sourceEndedAt,
      syntheticBankHours: continuitySource?.syntheticBankHours ?? calculateSyntheticBankHours({
        scheduledStartAt: sourceScheduledStartAt,
        scheduledEndAt: sourceScheduledEndAt,
        actualStartAt: sourceStartedAt,
        actualEndAt: sourceActualEndedAt ?? sourceEndedAt,
      }),
    }
    : buildSourceBankHoursSummary(chosen);
  const continuityGroupId = continuitySource?.continuityGroupId ?? chosen.continuityGroupId ?? null;
  const bankHoursOverride = continuityGroupId
    ? params.bankHoursBalanceOverridesByContinuityGroupId.get(continuityGroupId) ?? null
    : null;
  const continuesBeyondShift = sourceShiftLabel === "P"
    && Boolean(sourceCoverageEndAt && new Date(sourceCoverageEndAt).getTime() > slotEndAt.getTime());
  const syntheticBankHours = applyBankHoursBalanceOverrideToSummary(calculateSyntheticBankHours({
    scheduledStartAt: scheduledWindow.scheduledStartAt,
    scheduledEndAt: scheduledWindow.scheduledEndAt,
    actualStartAt: actualWindow.actualStartAt,
    actualEndAt: actualWindow.actualEndAt,
  }), bankHoursOverride);
  const adjustedSourceBankHours = {
    ...sourceBankHours,
    syntheticBankHours: applyBankHoursBalanceOverrideToSummary(sourceBankHours.syntheticBankHours, bankHoursOverride),
  };
  const effectiveBankHours = shouldUseContinuitySource ? adjustedSourceBankHours.syntheticBankHours : syntheticBankHours;
  const issues = detectPaymentAllocationIssues({
    candidate: chosen,
    candidateCount: params.candidates.length,
    syntheticBankHours: effectiveBankHours,
  });

  return {
    domain: params.target.domain,
    targetCode: params.target.targetCode,
    targetLabel: params.target.targetLabel,
    sortOrder: params.target.sortOrder,
    defaultRole: params.target.defaultRole,
    disabledAt: params.target.disabledAt,
    disabledReason: params.target.disabledReason,
    disabledDuringShift: params.target.disabledDuringShift,
    disabledEntireShift: params.target.disabledEntireShift,
    occupancyId: chosen.occupancyId,
    doctorId: chosen.doctorId,
    doctorName: chosen.doctorName,
    displayName: chosen.displayName,
    startedAt: actualWindow.actualStartAt,
    endedAt: actualWindow.actualEndAt,
    actualEndedAt: actualWindow.actualEndAt,
    scheduledStartAt: scheduledWindow.scheduledStartAt,
    scheduledEndAt: scheduledWindow.scheduledEndAt,
    shiftLabel: params.shiftLabel,
    roleLabel: chosen.roleLabel ?? params.target.defaultRole,
    ramalLabel: chosen.ramalLabel ?? (params.target.domain === "regulation" ? params.target.targetCode : null),
    source: chosen.source,
    candidateCount: params.candidates.length,
    paymentStatus: resolvePaymentAllocationStatus(issues),
    issues,
    arrivalDelayMinutes: syntheticBankHours.arrivalDelayMinutes,
    overtimeMinutes: syntheticBankHours.overtimeMinutes,
    creditedOvertimeMinutes: syntheticBankHours.creditedOvertimeMinutes,
    balanceMinutes: syntheticBankHours.balanceMinutes,
    ruleCode: syntheticBankHours.ruleCode,
    bankHoursExplanation: syntheticBankHours.bankHoursExplanation,
    sourceShiftLabel,
    sourceStartedAt,
    sourceBoardStartedAt,
    sourceEndedAt,
    sourceActualEndedAt,
    sourceScheduledStartAt: adjustedSourceBankHours.scheduledStartAt,
    sourceScheduledEndAt: adjustedSourceBankHours.scheduledEndAt,
    sourceArrivalDelayMinutes: adjustedSourceBankHours.syntheticBankHours.arrivalDelayMinutes,
    sourceOvertimeMinutes: adjustedSourceBankHours.syntheticBankHours.overtimeMinutes,
    sourceCreditedOvertimeMinutes: adjustedSourceBankHours.syntheticBankHours.creditedOvertimeMinutes,
    sourceBalanceMinutes: adjustedSourceBankHours.syntheticBankHours.balanceMinutes,
    sourceRuleCode: adjustedSourceBankHours.syntheticBankHours.ruleCode,
    sourceBankHoursExplanation: adjustedSourceBankHours.syntheticBankHours.bankHoursExplanation,
    continuesBeyondShift,
  } satisfies PaymentAllocationRow;
}

function resolvePaymentAllocationTargetChoices(params: {
  targets: PaymentAllocationTargetDefinition[];
  candidatesByTarget: Map<string, LogicalShiftCandidate[]>;
  slotStartIso: string;
  shiftLabel: "SD" | "SN";
}) {
  const choices: PaymentAllocationTargetChoice[] = params.targets.map((target) => {
    const key = [target.domain, target.targetCode].join("|");
    const candidates = sortPaymentAllocationCandidates({
      candidates: filterTargetPaymentCandidates({
        candidates: params.candidatesByTarget.get(key) ?? [],
        slotStartIso: params.slotStartIso,
      }),
      slotStartIso: params.slotStartIso,
      shiftLabel: params.shiftLabel,
    });

    return {
      target,
      candidates,
      chosenCandidate: null,
      displacedByDoctorConflict: false,
    };
  });

  const usedDoctorIds = new Set<string>();
  const prioritizedChoices = [...choices].sort((left, right) => {
    const leftCandidate = left.candidates[0] ?? null;
    const rightCandidate = right.candidates[0] ?? null;
    if (!leftCandidate || !rightCandidate) {
      if (!leftCandidate && !rightCandidate) {
        return left.target.sortOrder - right.target.sortOrder;
      }

      return leftCandidate ? -1 : 1;
    }

    const scoreDiff = rankPaymentAllocationCandidate({
      candidate: rightCandidate,
      slotStartIso: params.slotStartIso,
      shiftLabel: params.shiftLabel,
    }) - rankPaymentAllocationCandidate({
      candidate: leftCandidate,
      slotStartIso: params.slotStartIso,
      shiftLabel: params.shiftLabel,
    });
    if (scoreDiff !== 0) {
      return scoreDiff;
    }

    return left.target.sortOrder - right.target.sortOrder;
  });

  for (const choice of prioritizedChoices) {
    const chosenCandidate = choice.candidates.find((candidate) => !usedDoctorIds.has(candidate.doctorId)) ?? null;
    choice.chosenCandidate = chosenCandidate;
    choice.displacedByDoctorConflict = !chosenCandidate && choice.candidates.length > 0;

    if (chosenCandidate) {
      usedDoctorIds.add(chosenCandidate.doctorId);
    }
  }

  return choices;
}

export function buildPaymentAllocationBoardModel(params: {
  targets: PaymentAllocationTargetDefinition[];
  rawRows: PaymentAllocationRawRow[];
  operationalDate: string;
  shiftLabel: "SD" | "SN";
  startedAt: string;
  endedAt: string;
  bankHoursBalanceOverridesByContinuityGroupId?: Map<string, BankHoursBalanceOverrideSummary>;
  generatedAt?: string;
}) {
  const successorStartMap = resolveSuccessorStartMap(params.rawRows);
  const continuitySourceSummaryByOccupancyId = buildContinuitySourceSummaryMap(params.rawRows);
  const logicalCandidates = collapseLogicalShiftCandidates(params.rawRows
    .map(mapLogicalShiftCandidate)
    .map((candidate) => applyEffectiveEndedAt(candidate, successorStartMap.get(candidate.occupancyId) ?? null))
    .filter((candidate) => doesCandidateCoverPaymentSlot(candidate, params.startedAt))
  ).filter((candidate) => isEligibleTitularityCandidate(candidate))
    .filter((candidate) => !isMicroCoverage(candidate))
    .filter((candidate, _, all) => !shouldIgnoreDuplicateRestart(candidate, all));

  const candidatesByTarget = new Map<string, LogicalShiftCandidate[]>();
  for (const candidate of logicalCandidates) {
    const key = [candidate.domain, candidate.targetCode].join("|");
    const current = candidatesByTarget.get(key) ?? [];
    current.push(candidate);
    candidatesByTarget.set(key, current);
  }

  const targetChoices = resolvePaymentAllocationTargetChoices({
    targets: params.targets,
    candidatesByTarget,
    slotStartIso: params.startedAt,
    shiftLabel: params.shiftLabel,
  });

  const rows = targetChoices
    .map((choice) => {
      if (choice.target.disabledEntireShift) {
        return buildDisabledPaymentAllocationRow({
          target: choice.target,
          shiftLabel: params.shiftLabel,
          candidateCount: choice.candidates.length,
        });
      }

      return choice.chosenCandidate
        ? buildChosenPaymentAllocationRow({
          target: choice.target,
          candidates: choice.candidates,
          chosenCandidate: choice.chosenCandidate,
          slotStartIso: params.startedAt,
          shiftLabel: params.shiftLabel,
          continuitySourceSummaryByOccupancyId,
          bankHoursBalanceOverridesByContinuityGroupId: params.bankHoursBalanceOverridesByContinuityGroupId ?? new Map(),
        })
        : buildEmptyPaymentAllocationRow({
          target: choice.target,
          shiftLabel: params.shiftLabel,
          candidateCount: choice.candidates.length,
          issues: choice.displacedByDoctorConflict
            ? ["Todos os candidatos deste alvo conflitam com alocacoes mais confiaveis do mesmo turno"]
            : undefined,
        });
    })
    .sort(comparePaymentAllocationRows);

  const regulation = rows.filter((row) => row.domain === "regulation");
  const intervention = rows.filter((row) => row.domain === "intervention");
  const payableRows = rows.filter((row) => !row.disabledEntireShift);
  const disabledCount = rows.filter((row) => row.disabledEntireShift).length;
  const assignedCount = payableRows.filter((row) => Boolean(row.occupancyId)).length;
  const needsReviewCount = payableRows.filter((row) => row.paymentStatus === "needs_review").length;
  const readyForPaymentCount = payableRows.filter((row) => row.paymentStatus === "ready_for_payment").length;
  const unassignedCount = payableRows.filter((row) => !row.occupancyId).length;

  return {
    generatedAt: params.generatedAt ?? new Date().toISOString(),
    operationalDate: params.operationalDate,
    shiftLabel: params.shiftLabel,
    startedAt: params.startedAt,
    endedAt: params.endedAt,
    summary: {
      totalTargets: payableRows.length,
      assignedCount,
      readyForPaymentCount,
      needsReviewCount,
      unassignedCount,
      disabledCount,
    },
    regulation,
    intervention,
  } satisfies PaymentAllocationBoard;
}

function parsePaymentAllocationOperationalDate(value: string | Date) {
  if (value instanceof Date) {
    return getOperationalLocalDateParts(value);
  }

  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error("Operational date must use YYYY-MM-DD.");
  }

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

function resolvePaymentAllocationRequest(params: {
  operationalDate?: string | Date | null;
  shiftLabel?: "SD" | "SN" | null;
  reference?: Date;
}) {
  const reference = params.reference ?? new Date();

  if (params.operationalDate && !params.shiftLabel) {
    throw new Error("Shift label is required when querying a specific operational date.");
  }

  if (!params.operationalDate) {
    const currentShift = resolveOperationalShiftWindow(reference);
    const parts = getOperationalLocalDateParts(currentShift.startedAt);
    const startedAt = currentShift.shiftLabel === "SD"
      ? fromOperationalLocalClockParts(parts.year, parts.month, parts.day, 7, 0)
      : fromOperationalLocalClockParts(parts.year, parts.month, parts.day, 19, 0);
    const shiftLabel = params.shiftLabel ?? currentShift.shiftLabel;

    if (shiftLabel !== currentShift.shiftLabel) {
      throw new Error("Specific shift label without operational date is ambiguous. Provide YYYY-MM-DD as well.");
    }

    return {
      operationalDate: fromOperationalLocalClockParts(parts.year, parts.month, parts.day, 12, 0).toISOString(),
      shiftLabel,
      startedAt: startedAt.toISOString(),
      endedAt: resolveSlotEnd(startedAt, shiftLabel).toISOString(),
    };
  }

  const shiftLabel = params.shiftLabel as "SD" | "SN";
  const parts = parsePaymentAllocationOperationalDate(params.operationalDate as string | Date);
  const startedAt = shiftLabel === "SD"
    ? fromOperationalLocalClockParts(parts.year, parts.month, parts.day, 7, 0)
    : fromOperationalLocalClockParts(parts.year, parts.month, parts.day, 19, 0);

  return {
    operationalDate: fromOperationalLocalClockParts(parts.year, parts.month, parts.day, 12, 0).toISOString(),
    shiftLabel,
    startedAt: startedAt.toISOString(),
    endedAt: resolveSlotEnd(startedAt, shiftLabel).toISOString(),
  };
}

export async function getPaymentAllocationBoard(params: {
  operationalDate?: string | Date | null;
  shiftLabel?: "SD" | "SN" | null;
  reference?: Date;
} = {}): Promise<PaymentAllocationBoard> {
  const db = getDb();
  const request = resolvePaymentAllocationRequest(params);
  await expireInterventionBaseDeactivations(new Date(request.startedAt));
  const queryStart = new Date(new Date(request.startedAt).getTime() - 86400000).toISOString();
  const queryEnd = new Date(new Date(request.endedAt).getTime() + 86400000).toISOString();

  const targetResult = await db.execute(sql`
    select
      'regulation' as domain,
      rp.code as "targetCode",
      rp.label as "targetLabel",
      rp.sort_order as "sortOrder",
      rp.default_role as "defaultRole",
      null::timestamptz as "disabledAt",
      null::text as "disabledReason",
      false as "disabledDuringShift",
      false as "disabledEntireShift"
    from operations_v2.regulation_posts rp
    where rp.is_active = true
    union all
    select
      'intervention' as domain,
      ib.code as "targetCode",
      ib.label as "targetLabel",
      ib.sort_order as "sortOrder",
      null::text as "defaultRole",
      ibd.deactivated_at as "disabledAt",
      ibd.notes as "disabledReason",
      case when ibd.base_id is not null then true else false end as "disabledDuringShift",
      case
        when ibd.base_id is not null
          and ibd.deactivated_at <= ${request.startedAt}::timestamptz
          and coalesce(ibd.reactivated_at, 'infinity'::timestamptz) >= ${request.endedAt}::timestamptz
        then true
        else false
      end as "disabledEntireShift"
    from operations_v2.intervention_bases ib
    left join lateral (
      select
        state.base_id,
        state.deactivated_at,
        state.reactivated_at,
        state.notes
      from operations_v2.intervention_base_deactivations state
      where state.base_id = ib.id
        and state.deactivated_at < ${request.endedAt}::timestamptz
        and coalesce(state.reactivated_at, 'infinity'::timestamptz) > ${request.startedAt}::timestamptz
      order by state.deactivated_at desc, state.created_at desc
      limit 1
    ) ibd on true
    where ib.is_active = true
  `);

  const rawResult = await db.execute(sql`
    with allocation_regulation as (
      select
        ro.id as "occupancyId",
        'regulation' as domain,
        rp.code as "targetCode",
        rp.label as "targetLabel",
        d.id as "doctorId",
        d.full_name as "doctorName",
        d.display_name as "displayName",
        ro.started_at as "startedAt",
        ro.board_started_at as "boardStartedAt",
        coalesce(ro.actual_ended_at, ro.ended_at) as "endedAt",
        ro.actual_ended_at as "actualEndedAt",
        ro.scheduled_start_at as "scheduledStartAt",
        ro.scheduled_end_at as "scheduledEndAt",
        ro.continuity_group_id as "continuityGroupId",
        ro.shift_label as "shiftLabel",
        ro.role_label as "roleLabel",
        coalesce(ro.ramal_label, rp.code) as "ramalLabel",
        bhe.arrival_delay_minutes as "arrivalDelayMinutes",
        bhe.overtime_minutes as "overtimeMinutes",
        bhe.credited_overtime_minutes as "creditedOvertimeMinutes",
        bhe.balance_minutes as "balanceMinutes",
        bhe.rule_code as "ruleCode",
        bhe.explanation as "bankHoursExplanation",
        ro.source as source,
        ro.notes as notes
      from operations_v2.regulation_occupancies ro
      inner join operations_v2.regulation_posts rp on rp.id = ro.post_id
      inner join operations_v2.doctors d on d.id = ro.doctor_id
      left join operations_v2.bank_hours_entries bhe on bhe.regulation_occupancy_id = ro.id
      where ro.started_at >= ${queryStart}::timestamptz
        and ro.started_at < ${queryEnd}::timestamptz
    ),
    allocation_intervention as (
      select
        io.id as "occupancyId",
        'intervention' as domain,
        ib.code as "targetCode",
        ib.label as "targetLabel",
        d.id as "doctorId",
        d.full_name as "doctorName",
        d.display_name as "displayName",
        io.started_at as "startedAt",
        io.board_started_at as "boardStartedAt",
        coalesce(io.actual_ended_at, io.ended_at) as "endedAt",
        io.actual_ended_at as "actualEndedAt",
        io.scheduled_start_at as "scheduledStartAt",
        io.scheduled_end_at as "scheduledEndAt",
        io.continuity_group_id as "continuityGroupId",
        io.shift_label as "shiftLabel",
        io.role_label as "roleLabel",
        null::text as "ramalLabel",
        bhe.arrival_delay_minutes as "arrivalDelayMinutes",
        bhe.overtime_minutes as "overtimeMinutes",
        bhe.credited_overtime_minutes as "creditedOvertimeMinutes",
        bhe.balance_minutes as "balanceMinutes",
        bhe.rule_code as "ruleCode",
        bhe.explanation as "bankHoursExplanation",
        io.source as source,
        io.notes as notes
      from operations_v2.intervention_occupancies io
      inner join operations_v2.intervention_bases ib on ib.id = io.base_id
      inner join operations_v2.doctors d on d.id = io.doctor_id
      left join operations_v2.bank_hours_entries bhe on bhe.intervention_occupancy_id = io.id
      where io.started_at >= ${queryStart}::timestamptz
        and io.started_at < ${queryEnd}::timestamptz
    )
    select * from allocation_regulation
    union all
    select * from allocation_intervention
  `);

  const rawRows = (rawResult as unknown as Record<string, unknown>[]).map(mapPreviousOperationalRow);

  return buildPaymentAllocationBoardModel({
    targets: (targetResult as unknown as Record<string, unknown>[]).map(resolvePaymentAllocationTarget),
    rawRows,
    operationalDate: request.operationalDate,
    shiftLabel: request.shiftLabel,
    startedAt: request.startedAt,
    endedAt: request.endedAt,
    bankHoursBalanceOverridesByContinuityGroupId: await listBankHoursBalanceOverridesByContinuityGroupIds(
      db,
      rawRows.map((row) => row.continuityGroupId).filter((value): value is string => Boolean(value)),
    ),
  });
}
