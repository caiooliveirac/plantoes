/**
 * Operational Board Service (read model)
 *
 * Purpose: Builds the real-time operational board view from regulation/intervention
 * occupancies. Also provides payment allocation board and bank-hours summaries.
 *
 * Source of truth for: board display state (active/pending occupants per slot),
 * payment allocation heuristics, bank-hours balance per doctor.
 *
 * Key exports:
 *   - getOperationalBoard() — full board for a given shift window
 *   - getPaymentAllocationBoard() — payment-focused view with candidate ranking
 *
 * DANGER: Hidden business rules embedded in SQL queries and row transformations.
 * Bank-hours calculations depend on continuity group resolution which can span
 * multiple shifts. Payment allocation uses a multi-factor heuristic (see
 * docs/bug-hotspots.md for known edge cases).
 *
 * Invariants:
 *   - Board rows are always scoped to a single operational shift window (SD/SN)
 *   - Disabled slots appear explicitly (disabledEntireShift = true)
 *   - Regulation posts with isNucleo=true get special pending-label logic
 */
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
import { isNucleoRegulationPost, resolvePendingRegulationOccupantLabel } from "@/modules/operational/board-display";
import { calculateBankHours } from "@/modules/bank-hours/calculator";
import { buildContinuityBankHoursSpan } from "@/modules/bank-hours/continuity";
import {
  buildBankHoursBalanceOverrideExplanation,
  listBankHoursBalanceOverridesByContinuityGroupIds,
  MANUAL_BANK_HOURS_OVERRIDE_RULE_CODE,
  type BankHoursBalanceOverrideSummary,
} from "@/modules/bank-hours/service";
import { extractTelegramOccurrenceNumber } from "@/modules/telegram/departure-flow";
import { expireInterventionBaseDeactivations, expireStaleShadowInterventionOccupancies } from "@/modules/intervention/service";
import { expireStaleRegulationOccupancies } from "@/modules/regulation/service";

// A "sombra" (shadow) doctor coexisting on the same ramal/base as the titular.
// Shown on the live board as a distinct sub-line under the active occupant, never
// in its place.
export interface BoardShadowOccupant {
  occupancyId: string;
  doctorId: string;
  doctorName: string;
  displayName: string | null;
  startedAt: string | null;
  boardStartedAt: string | null;
}

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
  status: "active" | "waiting" | "disabled";
  disabledAt?: string | null;
  disabledReason?: string | null;
  liveSource: "operations_v2" | "legacy_live" | "none";
  liveUpdatedAt: string | null;
  shadowOccupants?: BoardShadowOccupant[];
  displacedOccupants?: BoardShadowOccupant[];
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
  scheduledStartAt?: string | null;
  lateArrivalAcknowledgedAt?: string | null;
  lateArrivalAcknowledgedNote?: string | null;
  shadowOccupants?: BoardShadowOccupant[];
  displacedOccupants?: BoardShadowOccupant[];
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
  /** Define se a entry aceita correcao inline (chegada/saida). false em back-sn para tudo que nao seja SN. */
  editable: boolean;
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
  /** Modo aplicado para montar a board (define janela + edicao). */
  mode: PreviousOperationalMode;
  /** Turno operacional corrente no momento da consulta — usado para decidir se "Voltar 1 dia" aparece. */
  currentShiftLabel: "SD" | "SN";
}

export type PaymentAllocationStatus = "ready_for_payment" | "needs_review";

export interface PaymentAllocationTargetDefinition {
  domain: "regulation" | "intervention";
  targetId?: number | null;
  targetCode: string;
  targetLabel: string;
  sortOrder: number;
  defaultRole: string | null;
  disabledAt?: string | null;
  reactivatedAt?: string | null;
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
  createdAt: string | null;
}

type PreviousOperationalRawRow = PaymentAllocationRawRow;

export interface PaymentAllocationRow {
  domain: "regulation" | "intervention";
  targetId?: number | null;
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
  notes?: string | null;
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

export interface OperationalSlotPresenceRow {
  domain: "regulation" | "intervention";
  targetId?: number | null;
  targetCode: string;
  targetLabel: string;
  sortOrder: number;
  defaultRole: string | null;
  disabledAt?: string | null;
  disabledReason?: string | null;
  disabledDuringShift?: boolean;
  disabledEntireShift?: boolean;
  status: "occupied" | "empty" | "disabled";
  doctorId: string | null;
  doctorName: string | null;
  displayName: string | null;
  doctorLabel: string;
  occupantLabels: string[];
  occupancyIds: string[];
  occupancyCount: number;
}

export interface OperationalSlotPresenceBoard {
  generatedAt: string;
  operationalDate: string;
  shiftLabel: "SD" | "SN";
  startedAt: string;
  endedAt: string;
  summary: {
    totalTargets: number;
    occupiedCount: number;
    emptyCount: number;
    disabledCount: number;
  };
  regulation: OperationalSlotPresenceRow[];
  intervention: OperationalSlotPresenceRow[];
}

export interface HistoricalOperationalPresenceRow {
  domain: "regulation" | "intervention";
  targetId?: number | null;
  targetCode: string;
  targetLabel: string;
  sortOrder: number;
  defaultRole: string | null;
  disabledAt?: string | null;
  disabledReason?: string | null;
  disabledDuringShift?: boolean;
  disabledEntireShift?: boolean;
  status: "occupied" | "empty" | "disabled";
  occupancyId: string | null;
  doctorId: string | null;
  doctorName: string | null;
  displayName: string | null;
  doctorLabel: string;
  occupantLabels: string[];
  occupancyIds: string[];
  occupancyCount: number;
  startedAt: string | null;
  endedAt: string | null;
  actualEndedAt: string | null;
  scheduledStartAt: string | null;
  scheduledEndAt: string | null;
  shiftLabel: "SD" | "SN" | "P" | null;
  roleLabel: string | null;
  ramalLabel: string | null;
  source: string | null;
  notes: string | null;
  arrivalDelayMinutes: number | null;
  issues: string[];
}

export interface HistoricalOperationalPresenceBoard {
  generatedAt: string;
  operationalDate: string;
  shiftLabel: "SD" | "SN";
  startedAt: string;
  endedAt: string;
  summary: {
    totalTargets: number;
    occupiedCount: number;
    emptyCount: number;
    disabledCount: number;
  };
  regulation: HistoricalOperationalPresenceRow[];
  intervention: HistoricalOperationalPresenceRow[];
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

/**
 * Detects phantom zero-duration occupancies created by Telegram board-takeover
 * race conditions. These records have started_at = ended_at = actualEndedAt and
 * carry no real operational meaning — they pollute the candidate pipeline, create
 * false "registros redundantes" issues, and contaminate bank hours entries.
 *
 * Occupancies where actualEndedAt differs from startedAt represent real work (the
 * doctor was physically present) even if ended_at was set to startedAt by the
 * board-takeover logic — these MUST NOT be filtered.
 */
function isTrueZeroDurationPhantom(row: PreviousOperationalRawRow): boolean {
  if (!row.endedAt) return false;
  const startMs = new Date(row.startedAt).getTime();
  const endMs = new Date(row.endedAt).getTime();
  if (startMs !== endMs) return false;
  const effectiveEndMs = row.actualEndedAt
    ? new Date(row.actualEndedAt).getTime()
    : endMs;
  return effectiveEndMs === startMs;
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

    if (row.shiftLabel && row.shiftLabel !== "P") {
      const startedAtSlotLabel = resolveSlotLabelFromStart(resolveSlotStartByTolerance(new Date(row.startedAt)));
      const scheduledSlotLabel = resolveSlotLabelFromStart(resolveSlotStartByTolerance(scheduledStartAt));
      if (startedAtSlotLabel !== row.shiftLabel && scheduledSlotLabel === row.shiftLabel) {
        return scheduledStartAt;
      }
    }
  }

  if (row.boardStartedAt && row.shiftLabel && row.shiftLabel !== "P") {
    const boardStartedAt = new Date(row.boardStartedAt);
    const startedAtSlotLabel = resolveSlotLabelFromStart(resolveSlotStartByTolerance(new Date(row.startedAt)));
    const boardSlotLabel = resolveSlotLabelFromStart(resolveSlotStartByTolerance(boardStartedAt));
    if (startedAtSlotLabel !== row.shiftLabel && boardSlotLabel === row.shiftLabel) {
      return boardStartedAt;
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

/**
 * Anchor + modo de exibicao do Plantao Anterior.
 *
 * - "full-prev": SD + SN do dia operacional D-1, tudo editavel.
 *   Default legado, usado pelo dashboard home e pelo turno SD na pagina dedicada.
 * - "sd-only-current": somente SD do dia operacional D (o que acabou de fechar)
 *   + P invertido associado. SN em curso e P (SD+SN em curso) sao suprimidos.
 *   Usado pelo turno SN na pagina dedicada.
 * - "back-sn": SD + SN de D-1 (mesma janela do full-prev) mas com edicao
 *   restrita ao SN. Usado quando o chefe SN clica "Voltar 1 dia".
 */
export type PreviousOperationalMode = "full-prev" | "sd-only-current" | "back-sn";

function resolvePreviousBoardLayout(reference: Date, mode: PreviousOperationalMode) {
  const currentShiftStartedAt = mode === "sd-only-current"
    || mode === "back-sn"
    ? (toOperationalLocalClock(reference).getUTCHours() >= 19
      ? reference // SN noite: turno corrente comecou hoje 19h
      : new Date(reference.getTime() - 12 * 60 * 60 * 1000)) // SN madrugada: turno corrente comecou ontem 19h
    : reference;

  const currentOpDateParts = getOperationalLocalDateParts(currentShiftStartedAt);

  // Para SD shift (full-prev): anchor = ontem operacional.
  // Para SN auto (sd-only-current): anchor = dia operacional corrente (o SD que fechou).
  // Para SN back (back-sn): anchor = dia operacional anterior ao corrente.
  const anchorParts = mode === "sd-only-current"
    ? currentOpDateParts
    : addOperationalLocalDays(currentOpDateParts, -1);

  const previousNightParts = addOperationalLocalDays(anchorParts, -1);
  const nextDayParts = addOperationalLocalDays(anchorParts, 1);

  const previousSnSlotStart = fromOperationalLocalClockParts(previousNightParts.year, previousNightParts.month, previousNightParts.day, 19, 0).toISOString();
  const sdSlotStart = fromOperationalLocalClockParts(anchorParts.year, anchorParts.month, anchorParts.day, 7, 0).toISOString();
  const snSlotStart = fromOperationalLocalClockParts(anchorParts.year, anchorParts.month, anchorParts.day, 19, 0).toISOString();

  // sd-only-current omite o slot SN do dia (em curso); demais modos veem tudo.
  const includeAnchorSn = mode !== "sd-only-current";
  const relevantSlotStarts = new Set(
    includeAnchorSn
      ? [previousSnSlotStart, sdSlotStart, snSlotStart]
      : [previousSnSlotStart, sdSlotStart],
  );

  return {
    anchorParts,
    previousNightParts,
    nextDayParts,
    previousSnSlotStart,
    sdSlotStart,
    snSlotStart,
    relevantSlotStarts,
    includeAnchorSn,
  };
}

function resolveEditableScope(mode: PreviousOperationalMode, bucket: PreviousOperationalBucket): boolean {
  // back-sn: so o SN standalone pode ser editado (o usuario voltou um dia para
  // corrigir o SN que ele assumiu apos; SD, P e P invertido sao contexto).
  if (mode === "back-sn") {
    return bucket === "SN";
  }
  return true;
}

function mapRegulationRow(row: Record<string, unknown>): RegulationBoardRow {
  const rawStatus = String(row.status ?? "waiting");

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
    status: rawStatus === "disabled" ? "disabled" : rawStatus === "active" ? "active" : "waiting",
    disabledAt: (row.disabledAt ?? row.disabled_at ?? null) as string | null,
    disabledReason: (row.disabledReason ?? row.disabled_reason ?? null) as string | null,
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
    scheduledStartAt: (row.scheduledStartAt ?? row.scheduled_start_at ?? null) as string | null,
    scheduledEndAt: (row.scheduledEndAt ?? row.scheduled_end_at ?? null) as string | null,
    shiftLabel: (row.shiftLabel ?? row.shift_label ?? null) as InterventionBoardRow["shiftLabel"],
    roleLabel: (row.roleLabel ?? row.role_label ?? null) as string | null,
    status: rawStatus === "disabled" ? "disabled" : rawStatus === "active" ? "active" : "waiting",
    disabledAt: (row.disabledAt ?? row.disabled_at ?? null) as string | null,
    disabledReason: (row.disabledReason ?? row.disabled_reason ?? null) as string | null,
    liveSource: (row.liveSource ?? row.live_source ?? "none") as InterventionBoardRow["liveSource"],
    liveUpdatedAt: (row.liveUpdatedAt ?? row.live_updated_at ?? null) as string | null,
    lateArrivalAcknowledgedAt: (row.lateArrivalAcknowledgedAt ?? row.late_arrival_acknowledged_at ?? null) as string | null,
    lateArrivalAcknowledgedNote: (row.lateArrivalAcknowledgedNote ?? row.late_arrival_acknowledged_note ?? null) as string | null,
  };
}

function groupShadowOccupantsByTarget(
  result: unknown,
  targetKey: "postId" | "baseId",
): Map<number, BoardShadowOccupant[]> {
  const map = new Map<number, BoardShadowOccupant[]>();
  for (const raw of result as unknown as Record<string, unknown>[]) {
    const targetId = Number(raw[targetKey]);
    if (!Number.isFinite(targetId)) {
      continue;
    }
    const list = map.get(targetId) ?? [];
    list.push({
      occupancyId: String(raw.occupancyId),
      doctorId: String(raw.doctorId),
      doctorName: String(raw.doctorName ?? ""),
      displayName: (raw.displayName ?? null) as string | null,
      startedAt: (raw.startedAt ?? null) as string | null,
      boardStartedAt: (raw.boardStartedAt ?? null) as string | null,
    });
    map.set(targetId, list);
  }
  return map;
}

// Open "sombra" occupancies coexisting with the titular, keyed by post/base. The
// shadow is detected by the operational note marker ("[telegram sombra]" / SOMBRA),
// the same signal used everywhere else for shadow recognition.
async function listOpenRegulationShadowOccupantsByPost(): Promise<Map<number, BoardShadowOccupant[]>> {
  const db = getDb();
  const result = await db.execute(sql`
    select ro.id as "occupancyId", ro.post_id as "postId", ro.doctor_id as "doctorId",
           d.full_name as "doctorName", d.display_name as "displayName",
           ro.started_at as "startedAt", ro.board_started_at as "boardStartedAt"
    from operations_v2.regulation_occupancies ro
    join operations_v2.doctors d on d.id = ro.doctor_id
    where ro.ended_at is null and coalesce(ro.notes, '') ~* 'SOMBRA'
  `);
  return groupShadowOccupantsByTarget(result, "postId");
}

async function listOpenInterventionShadowOccupantsByBase(): Promise<Map<number, BoardShadowOccupant[]>> {
  const db = getDb();
  const result = await db.execute(sql`
    select io.id as "occupancyId", io.base_id as "baseId", io.doctor_id as "doctorId",
           d.full_name as "doctorName", d.display_name as "displayName",
           io.started_at as "startedAt", io.board_started_at as "boardStartedAt"
    from operations_v2.intervention_occupancies io
    join operations_v2.doctors d on d.id = io.doctor_id
    where io.ended_at is null and coalesce(io.notes, '') ~* 'SOMBRA'
  `);
  return groupShadowOccupantsByTarget(result, "baseId");
}

// Ocupações "deslocadas" (perderam o board numa tomada confirmada): seguem ativas
// fora do quadro, com a chegada preservada, aguardando o médico redeclarar posição.
// Renderizadas no painel como "deslocado" para a chefia não esquecê-las.
async function listOpenRegulationDisplacedOccupantsByPost(): Promise<Map<number, BoardShadowOccupant[]>> {
  const db = getDb();
  const result = await db.execute(sql`
    select ro.id as "occupancyId", ro.post_id as "postId", ro.doctor_id as "doctorId",
           d.full_name as "doctorName", d.display_name as "displayName",
           ro.started_at as "startedAt", ro.board_started_at as "boardStartedAt"
    from operations_v2.regulation_occupancies ro
    join operations_v2.doctors d on d.id = ro.doctor_id
    where ro.ended_at is null and coalesce(ro.notes, '') like '%[DESLOCADO]%'
  `);
  return groupShadowOccupantsByTarget(result, "postId");
}

async function listOpenInterventionDisplacedOccupantsByBase(): Promise<Map<number, BoardShadowOccupant[]>> {
  const db = getDb();
  const result = await db.execute(sql`
    select io.id as "occupancyId", io.base_id as "baseId", io.doctor_id as "doctorId",
           d.full_name as "doctorName", d.display_name as "displayName",
           io.started_at as "startedAt", io.board_started_at as "boardStartedAt"
    from operations_v2.intervention_occupancies io
    join operations_v2.doctors d on d.id = io.doctor_id
    where io.ended_at is null and coalesce(io.notes, '') like '%[DESLOCADO]%'
  `);
  return groupShadowOccupantsByTarget(result, "baseId");
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
    createdAt: (row.createdAt ?? null) as string | null,
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

  // A "sombra" (shadow) doctor coexists with the titular on the ramal — she never
  // takes the slot over. Treating a shadow arrival as a successor would truncate the
  // active doctor's coverage to a few minutes and drop it as micro-coverage (this is
  // how Yngra's shadow arrival made Indira vanish from the 2152 records). Intervention
  // shadows already dodge this via the boardStartedAt-null check below; regulation
  // shadows carry a boardStartedAt, so they need this explicit guard.
  if (/SOMBRA/.test(normalizeFreeText(row.notes))) {
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
  if (effectiveEndedAt !== null && (durationMinutes === null || durationMinutes < MIN_TITULAR_DURATION_MINUTES)) {
    return false;
  }

  return true;
}

// A telegram-sourced record whose started_at sits more than this many minutes
// before its created_at was almost certainly produced by the continuation bug
// (cross-target arrival anchored to the previous post's startedAt). Such a
// record cannot truncate other doctors' coverage as a "successor" — the doctor
// did not actually arrive at this target when started_at claims.
// Threshold matches the D1 criterion used in the May/2026 victims audit
// (CONTINUATION_BUG_VICTIMS.md): created_at - started_at > 6h.
const BACKDATED_SUCCESSOR_THRESHOLD_MINUTES = 6 * 60;

function isBackdatedTelegramSuccessor(row: PreviousOperationalRawRow): boolean {
  if (row.source !== "telegram") {
    return false;
  }
  if (!row.createdAt) {
    return false;
  }
  const createdAtMs = new Date(row.createdAt).getTime();
  const startedAtMs = new Date(row.startedAt).getTime();
  if (!Number.isFinite(createdAtMs) || !Number.isFinite(startedAtMs)) {
    return false;
  }
  return createdAtMs - startedAtMs > BACKDATED_SUCCESSOR_THRESHOLD_MINUTES * 60 * 1000;
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
      // Explicit human attestations (admin_correction / manual) carry the
      // authoritative time window — never shrink them via successor closure.
      // Bot echoes that arrive seconds after the attestation, or telegram
      // races where the next doctor's start aligns with a brief miscapture,
      // would otherwise collapse the attestation to a few minutes.
      if (current.source === "admin_correction" || current.source === "manual") {
        successorByOccupancyId.set(current.occupancyId, null);
        continue;
      }
      // A handoff is by definition a different doctor taking the slot.
      // Two rows for the same doctor on the same target are duplicates
      // (telegram echo + admin_correction, etc.) — neither shrinks the other.
      // Records of the SAME continuity_group_id belong to one doctor's chain
      // across targets and never represent a real handoff to a different doctor.
      // Backdated telegram records (continuation-bug ghosts) likewise must not
      // be treated as successors of unrelated doctors — see comment above.
      const successor = successorCandidates.find((candidate) => (
        candidate.occupancyId !== current.occupancyId
        && candidate.doctorId !== current.doctorId
        && new Date(candidate.startedAt).getTime() > currentStartedAt
        && (
          !current.continuityGroupId
          || !candidate.continuityGroupId
          || candidate.continuityGroupId !== current.continuityGroupId
        )
        && !isBackdatedTelegramSuccessor(candidate)
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
  const canUseSuccessorBasedClosure = !candidate.isShadow;
  const successorBasedClosure = (() => {
    if (!canUseSuccessorBasedClosure || !successorStartedAt || !implicitExpiry) {
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

    // actual_ended_at gravado explicitamente (bot /saiu, edicao manual,
    // confirmacao do chefe) ja constitui evidencia de saida — nao clampar
    // para o limite canonico do turno, senao Plantao Anterior mostra 07:00
    // enquanto Banco de Horas (que le actualEndedAt direto) mostra 07:51.
    if (candidate.actualEndedAt) {
      return candidate.actualEndedAt;
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
    status: row.status === "disabled" ? "disabled" : "waiting",
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
    editable: true,
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
    editable: true,
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
    ),
    active_deactivations as (
      select
        rpd.post_id,
        rpd.deactivated_at,
        rpd.notes,
        row_number() over (
          partition by rpd.post_id
          order by rpd.deactivated_at desc, rpd.created_at desc
        ) as row_rank
      from operations_v2.regulation_post_deactivations rpd
      where rpd.reactivated_at is null
        and rpd.deactivated_at <= now()
    )
    select
      rp.id as "postId",
      ro.id as "occupancyId",
      rp.code as "postCode",
      rp.label as "postLabel",
      rp.default_role as "defaultRole",
      case when ro.id is not null or lr.post_code is not null then coalesce(d.id, lr.doctor_id) else null end as "doctorId",
      case when ro.id is not null or lr.post_code is not null then coalesce(d.full_name, lr.doctor_name) else null end as "doctorName",
      case when ro.id is not null or lr.post_code is not null then coalesce(d.display_name, lr.display_name) else null end as "displayName",
      case when ro.id is not null or lr.post_code is not null then coalesce(ro.started_at, lr.started_at) else null end as "startedAt",
      case when ro.id is not null or lr.post_code is not null then coalesce(ro.board_started_at, lr.board_started_at) else null end as "boardStartedAt",
      case when ro.id is not null or lr.post_code is not null then coalesce(ro.scheduled_end_at, lr.scheduled_end_at) else null end as "scheduledEndAt",
      case when ro.id is not null or lr.post_code is not null then ro.shift_label else null end as "shiftLabel",
      case
        when ro.id is not null then ro.role_label
        when lr.post_code is not null then lr.role_label
        else null
      end as "roleLabel",
      case when ro.id is not null or lr.post_code is not null then coalesce(ro.ramal_label, lr.ramal_label, rp.code) else rp.code end as "ramalLabel",
      ad.deactivated_at as "disabledAt",
      ad.notes as "disabledReason",
      case
        when ro.id is not null or lr.post_code is not null then 'active'
        when ad.post_id is not null then 'disabled'
        else 'waiting'
      end as "status",
      case
        when ro.id is not null and ro.source <> 'import' then 'operations_v2'
        when lr.post_code is not null then 'legacy_live'
        when ro.id is not null then 'operations_v2'
        else 'none'
      end as "liveSource",
      lr.updated_at as "liveUpdatedAt"
    from operations_v2.regulation_posts rp
    left join operations_v2.regulation_occupancies ro
      on ro.id = (
        select ro2.id
        from operations_v2.regulation_occupancies ro2
        where ro2.post_id = rp.id
          and ro2.board_started_at is not null
          and (
            ro2.ended_at is null
            or (
              rp.code = 'PIAM'
              and ro2.scheduled_start_at is not null
              and ro2.scheduled_end_at is not null
              and ro2.scheduled_start_at <= now()
              and ro2.scheduled_end_at > now()
            )
          )
        order by
          (ro2.ended_at is null) desc,
          -- Prefer the titular over a coexisting "sombra": a shadow occupies the same
          -- ramal as the active doctor but must never be shown in its place. Without
          -- this, the shadow (which usually arrives later) would win started_at desc
          -- and hide the titular on the live board.
          (coalesce(ro2.notes, '') ~* 'SOMBRA') asc,
          ro2.scheduled_start_at desc nulls last,
          ro2.started_at desc,
          ro2.created_at desc
        limit 1
      )
    left join operations_v2.doctors d
      on d.id = ro.doctor_id
    left join legacy_regulation lr
      on lr.post_code = rp.code
     and lr.row_rank = 1
    left join active_deactivations ad
      on ad.post_id = rp.id
     and ad.row_rank = 1
    where rp.is_active = true
    order by rp.sort_order asc, rp.code asc
  `);

  const rows = (result as unknown as Record<string, unknown>[]).map(mapRegulationRow);
  const reference = new Date();
  const shadowByPost = await listOpenRegulationShadowOccupantsByPost();
  const displacedByPost = await listOpenRegulationDisplacedOccupantsByPost();

  return rows.map((row) => {
    const visible = (row.status !== "active" || !row.doctorId)
      ? row
      : (shouldKeepRegulationOccupancyVisible({
          startedAt: row.startedAt,
          boardStartedAt: row.boardStartedAt,
          scheduledEndAt: row.scheduledEndAt,
          shiftLabel: row.shiftLabel,
          reference,
        }) ? row : demoteRegulationRowToWaiting(row));

    const shadows = (shadowByPost.get(visible.postId) ?? [])
      .filter((shadow) => shadow.occupancyId !== visible.occupancyId);
    const displaced = (displacedByPost.get(visible.postId) ?? [])
      .filter((occ) => occ.occupancyId !== visible.occupancyId);
    const withShadows = shadows.length > 0 ? { ...visible, shadowOccupants: shadows } : visible;
    return displaced.length > 0 ? { ...withShadows, displacedOccupants: displaced } : withShadows;
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
        and ibd.deactivated_at <= now()
    )
    select
      ib.id as "baseId",
      io.id as "occupancyId",
      ib.code as "baseCode",
      ib.label as "baseLabel",
      case when io.id is not null or li.base_code is not null then coalesce(d.id, li.doctor_id) else null end as "doctorId",
      case when io.id is not null or li.base_code is not null then coalesce(d.full_name, li.doctor_name) else null end as "doctorName",
      case when io.id is not null or li.base_code is not null then coalesce(d.display_name, li.display_name) else null end as "displayName",
      case when io.id is not null or li.base_code is not null then coalesce(io.started_at, li.started_at) else null end as "startedAt",
      case when io.id is not null or li.base_code is not null then io.scheduled_start_at else null end as "scheduledStartAt",
      case when io.id is not null or li.base_code is not null then coalesce(io.board_started_at, li.board_started_at) else null end as "boardStartedAt",
      case when io.id is not null or li.base_code is not null then coalesce(io.scheduled_end_at, li.scheduled_end_at) else null end as "scheduledEndAt",
      case when io.id is not null or li.base_code is not null then io.shift_label else null end as "shiftLabel",
      case
        when io.id is not null then io.role_label
        when li.base_code is not null then li.role_label
        else null
      end as "roleLabel",
      ad.deactivated_at as "disabledAt",
      ad.notes as "disabledReason",
      io.late_arrival_acknowledged_at as "lateArrivalAcknowledgedAt",
      io.late_arrival_acknowledged_note as "lateArrivalAcknowledgedNote",
      case
        when io.id is not null or li.base_code is not null then 'active'
        when ad.base_id is not null then 'disabled'
        else 'waiting'
      end as "status",
      case
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

  const shadowByBase = await listOpenInterventionShadowOccupantsByBase();
  const displacedByBase = await listOpenInterventionDisplacedOccupantsByBase();

  return (result as unknown as Record<string, unknown>[]).map(mapInterventionRow).map((row) => {
    const shadows = (shadowByBase.get(row.baseId) ?? [])
      .filter((shadow) => shadow.occupancyId !== row.occupancyId);
    const displaced = (displacedByBase.get(row.baseId) ?? [])
      .filter((occ) => occ.occupancyId !== row.occupancyId);
    const withShadows = shadows.length > 0 ? { ...row, shadowOccupants: shadows } : row;
    return displaced.length > 0 ? { ...withShadows, displacedOccupants: displaced } : withShadows;
  });
}

export interface OperationalBoardSnapshot {
  generatedAt: string;
  regulation: RegulationBoardRow[];
  intervention: InterventionBoardRow[];
  /**
   * Verbalized departures waiting for chefe/admin review. Optional so existing
   * test fixtures that mock the board do not have to backfill the field; the
   * live path always populates it. When absent, callers treat as empty.
   */
  pendingDepartures?: PendingDepartureConfirmation[];
  /**
   * Recent handoffs (rendições): predecessor closed at the handoff time with no
   * verbalized departure, where a successor took over the same target. Purely
   * informational for the chefe — NO confirm/finalize affordance. Optional for
   * the same fixture-compatibility reason as pendingDepartures.
   */
  recentHandoffs?: RecentHandoff[];
}

export async function getOperationalBoard(): Promise<OperationalBoardSnapshot> {
  await expireInterventionBaseDeactivations(new Date());
  await expireStaleShadowInterventionOccupancies(new Date());
  await expireStaleRegulationOccupancies(new Date());

  const [regulation, intervention, pendingDepartures, recentHandoffs] = await Promise.all([
    listRegulationBoard(),
    listInterventionBoard(),
    listPendingDepartureConfirmations(),
    listRecentHandoffs(),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    regulation,
    intervention,
    pendingDepartures,
    recentHandoffs,
  };
}

export interface RecentHandoff {
  /** Predecessor occupancy id (the doctor who was relieved). */
  occupancyId: string;
  domain: "regulation" | "intervention";
  targetCode: string;
  targetLabel: string;
  /** Doctor who was relieved (left at the handoff). */
  predecessorName: string;
  predecessorDisplayName: string | null;
  /** Doctor who took over. */
  successorName: string;
  successorDisplayName: string | null;
  /** Instant of the handoff (predecessor.ended_at == successor.started_at, approx). */
  handoffAt: string;
}

/**
 * Recent renditions for the chefe's awareness. A predecessor closed as handoff has
 * `ended_at` set and `actual_ended_at` null; the discriminator from any other
 * actual_ended_at-null closure is the EXISTENCE OF A SUCCESSOR (different doctor) who
 * took over the same target around the handoff instant. Read-only and non-finalizable.
 */
export async function listRecentHandoffs(
  options: { windowHours?: number; toleranceMinutes?: number; limit?: number } = {},
): Promise<RecentHandoff[]> {
  const db = getDb();
  const windowHours = options.windowHours ?? 12;
  const toleranceMinutes = options.toleranceMinutes ?? 90;
  const limit = options.limit ?? 100;
  const cutoffAt = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();

  const rows = await db.execute<{
    occupancyId: string;
    domain: "regulation" | "intervention";
    targetCode: string;
    targetLabel: string;
    predecessorName: string;
    predecessorDisplayName: string | null;
    successorName: string;
    successorDisplayName: string | null;
    handoffAt: string;
  }>(sql`
    select
      ro.id as "occupancyId",
      'regulation'::text as "domain",
      rp.code as "targetCode",
      rp.label as "targetLabel",
      pd.full_name as "predecessorName",
      pd.display_name as "predecessorDisplayName",
      sd.full_name as "successorName",
      sd.display_name as "successorDisplayName",
      ro.ended_at as "handoffAt"
    from operations_v2.regulation_occupancies ro
    inner join operations_v2.regulation_posts rp on rp.id = ro.post_id
    inner join operations_v2.doctors pd on pd.id = ro.doctor_id
    inner join lateral (
      select so.doctor_id, so.started_at
      from operations_v2.regulation_occupancies so
      where so.post_id = ro.post_id
        and so.doctor_id <> ro.doctor_id
        and so.id <> ro.id
        and so.started_at >= ro.ended_at - ${sql.raw(`interval '${toleranceMinutes} minutes'`)}
      order by abs(extract(epoch from (so.started_at - ro.ended_at)))
      limit 1
    ) succ on true
    inner join operations_v2.doctors sd on sd.id = succ.doctor_id
    where ro.ended_at is not null
      and ro.actual_ended_at is null
      and ro.ended_at >= ${cutoffAt}

    union all

    select
      io.id as "occupancyId",
      'intervention'::text as "domain",
      ib.code as "targetCode",
      ib.label as "targetLabel",
      pd.full_name as "predecessorName",
      pd.display_name as "predecessorDisplayName",
      sd.full_name as "successorName",
      sd.display_name as "successorDisplayName",
      io.ended_at as "handoffAt"
    from operations_v2.intervention_occupancies io
    inner join operations_v2.intervention_bases ib on ib.id = io.base_id
    inner join operations_v2.doctors pd on pd.id = io.doctor_id
    inner join lateral (
      select so.doctor_id, so.started_at
      from operations_v2.intervention_occupancies so
      where so.base_id = io.base_id
        and so.doctor_id <> io.doctor_id
        and so.id <> io.id
        and so.started_at >= io.ended_at - ${sql.raw(`interval '${toleranceMinutes} minutes'`)}
      order by abs(extract(epoch from (so.started_at - io.ended_at)))
      limit 1
    ) succ on true
    inner join operations_v2.doctors sd on sd.id = succ.doctor_id
    where io.ended_at is not null
      and io.actual_ended_at is null
      and io.ended_at >= ${cutoffAt}

    order by "handoffAt" desc
    limit ${limit}
  `);

  const items = (rows as unknown as { rows: any[] }).rows ?? (rows as any);
  if (!Array.isArray(items)) {
    return [];
  }
  return items as RecentHandoff[];
}

export interface PendingDepartureCorrelatedMessage {
  ingestedMessageId: string;
  createdAt: string;
  parsedAction: string | null;
  rawText: string;
}

export interface PendingDepartureRecentOccurrence {
  occupancyId: string;
  domain: "regulation" | "intervention";
  endedAt: string;
  reasonCode: TelegramLateDepartureReasonCode | null;
}

export interface PendingDepartureConfirmation {
  occupancyId: string;
  domain: "regulation" | "intervention";
  targetCode: string;
  targetLabel: string;
  doctorId: string;
  doctorName: string;
  displayName: string | null;
  shiftLabel: "SD" | "SN" | "P" | null;
  roleLabel: string | null;
  startedAt: string;
  scheduledStartAt: string | null;
  scheduledEndAt: string | null;
  /** Verbalized real departure time — the value the chefe needs to validate. */
  actualEndedAt: string;
  /** Board-end (scheduled handoff). */
  endedAt: string | null;
  reasonCode: TelegramLateDepartureReasonCode | null;
  /**
   * The 4-digit occurrence number the doctor reported (rule: an "occurrence" late
   * departure must say which occurrence). Null when not an occurrence or not provided.
   */
  occurrenceNumber: string | null;
  /**
   * True when the reason is "occurrence" but no 4-digit number was found — the chefe
   * must scrutinize this before confirming (the bot did not vouch for it).
   */
  occurrenceNumberMissing: boolean;
  /** Minutes between scheduledEndAt and actualEndedAt; positive = ran long. */
  delayMinutes: number | null;
  /** Last messages from the bot ingestion referencing this occupancy. */
  recentMessages: PendingDepartureCorrelatedMessage[];
  /**
   * The single message the late-departure claim was read from — the one whose
   * raw text produced `reasonCode` (or the most recent, when no reason matched).
   * Surfaced on the card so the chefe sees the source verbatim before confirming.
   */
  sourceMessage: PendingDepartureCorrelatedMessage | null;
  /** Same-reason departures by this doctor in the past 30 days (pattern signal). */
  reasonOccurrenceCount30d: number;
  /** When the verbalized departure was recorded. */
  recordedAt: string;
}

export type TelegramLateDepartureReasonCode = "occurrence" | "hygienization" | "chief_release" | "handoff";

const LATE_DEPARTURE_REASON_PATTERNS: Array<{ code: TelegramLateDepartureReasonCode; pattern: RegExp }> = [
  { code: "occurrence", pattern: /\b(OCORR|ATEND|CHAMADO)/i },
  { code: "hygienization", pattern: /\b(HIGIE|LIMP|LAVA|DESINF|DESCONTAMIN)/i },
  { code: "chief_release", pattern: /\b(CHEFIA|CHEFE|LIBERAD|LIBEROU|AUTORIZ|DETERMIN)/i },
  { code: "handoff", pattern: /\b(RENDIDO|RENDIDA|RENDIC|REDIC|TROCA|SUBSTITUI)/i },
];

function detectLateDepartureReasonCode(text: string | null | undefined): TelegramLateDepartureReasonCode | null {
  if (!text) return null;
  const normalized = text.toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  for (const { code, pattern } of LATE_DEPARTURE_REASON_PATTERNS) {
    if (pattern.test(normalized)) return code;
  }
  return null;
}

export async function listPendingDepartureConfirmations(
  options: { windowDays?: number; limit?: number } = {},
): Promise<PendingDepartureConfirmation[]> {
  const db = getDb();
  const windowDays = options.windowDays ?? 7;
  const limit = options.limit ?? 200;
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const cutoffAt = new Date(Date.now() - windowMs).toISOString();

  const rows = await db.execute<{
    occupancyId: string;
    domain: "regulation" | "intervention";
    targetCode: string;
    targetLabel: string;
    doctorId: string;
    doctorName: string;
    displayName: string | null;
    shiftLabel: "SD" | "SN" | "P" | null;
    roleLabel: string | null;
    startedAt: string;
    scheduledStartAt: string | null;
    scheduledEndAt: string | null;
    actualEndedAt: string;
    endedAt: string | null;
    notes: string | null;
    recordedAt: string;
  }>(sql`
    select
      ro.id as "occupancyId",
      'regulation'::text as "domain",
      rp.code as "targetCode",
      rp.label as "targetLabel",
      ro.doctor_id as "doctorId",
      d.full_name as "doctorName",
      d.display_name as "displayName",
      ro.shift_label as "shiftLabel",
      ro.role_label as "roleLabel",
      ro.started_at as "startedAt",
      ro.scheduled_start_at as "scheduledStartAt",
      ro.scheduled_end_at as "scheduledEndAt",
      ro.actual_ended_at as "actualEndedAt",
      ro.ended_at as "endedAt",
      ro.notes as "notes",
      ro.updated_at as "recordedAt"
    from operations_v2.regulation_occupancies ro
    inner join operations_v2.regulation_posts rp on rp.id = ro.post_id
    inner join operations_v2.doctors d on d.id = ro.doctor_id
    where ro.actual_ended_at is not null
      and ro.departure_confirmed_at is null
      and ro.actual_ended_at >= ${cutoffAt}

    union all

    select
      io.id as "occupancyId",
      'intervention'::text as "domain",
      ib.code as "targetCode",
      ib.label as "targetLabel",
      io.doctor_id as "doctorId",
      d.full_name as "doctorName",
      d.display_name as "displayName",
      io.shift_label as "shiftLabel",
      io.role_label as "roleLabel",
      io.started_at as "startedAt",
      io.scheduled_start_at as "scheduledStartAt",
      io.scheduled_end_at as "scheduledEndAt",
      io.actual_ended_at as "actualEndedAt",
      io.ended_at as "endedAt",
      io.notes as "notes",
      io.updated_at as "recordedAt"
    from operations_v2.intervention_occupancies io
    inner join operations_v2.intervention_bases ib on ib.id = io.base_id
    inner join operations_v2.doctors d on d.id = io.doctor_id
    where io.actual_ended_at is not null
      and io.departure_confirmed_at is null
      and io.actual_ended_at >= ${cutoffAt}

    order by "actualEndedAt" desc
    limit ${limit}
  `);

  const items = (rows as unknown as { rows: any[] }).rows ?? (rows as any);
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  const occupancyIds = items.map((row) => row.occupancyId);
  const doctorIds = Array.from(new Set(items.map((row) => row.doctorId)));
  const occupancyIdList = sql.join(occupancyIds.map((id) => sql`${id}::uuid`), sql`, `);
  const doctorIdList = sql.join(doctorIds.map((id) => sql`${id}::uuid`), sql`, `);

  const [messageRows, patternRows] = await Promise.all([
    db.execute<{ occupancyId: string; ingestedMessageId: string; createdAt: string; parsedAction: string | null; rawText: string }>(sql`
      select
        related_occupancy_id::text as "occupancyId",
        id::text as "ingestedMessageId",
        created_at as "createdAt",
        parsed_action as "parsedAction",
        raw_text as "rawText"
      from operations_v2.telegram_ingested_messages
      where related_occupancy_id in (${occupancyIdList})
      order by created_at desc
      limit 600
    `),
    db.execute<{ doctorId: string; reasonText: string | null; actualEndedAt: string; occupancyId: string; domain: string }>(sql`
      select
        ro.doctor_id::text as "doctorId",
        ro.notes as "reasonText",
        ro.actual_ended_at as "actualEndedAt",
        ro.id::text as "occupancyId",
        'regulation'::text as "domain"
      from operations_v2.regulation_occupancies ro
      where ro.doctor_id in (${doctorIdList})
        and ro.actual_ended_at is not null
        and ro.actual_ended_at >= ${new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()}

      union all

      select
        io.doctor_id::text as "doctorId",
        io.notes as "reasonText",
        io.actual_ended_at as "actualEndedAt",
        io.id::text as "occupancyId",
        'intervention'::text as "domain"
      from operations_v2.intervention_occupancies io
      where io.doctor_id in (${doctorIdList})
        and io.actual_ended_at is not null
        and io.actual_ended_at >= ${new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()}
    `),
  ]);

  const messagesByOccupancy = new Map<string, PendingDepartureCorrelatedMessage[]>();
  const messageItems = (messageRows as unknown as { rows: any[] }).rows ?? (messageRows as any);
  for (const row of messageItems as any[]) {
    const list = messagesByOccupancy.get(row.occupancyId) ?? [];
    if (list.length < 5) {
      list.push({
        ingestedMessageId: row.ingestedMessageId,
        createdAt: row.createdAt,
        parsedAction: row.parsedAction ?? null,
        rawText: row.rawText,
      });
      messagesByOccupancy.set(row.occupancyId, list);
    }
  }

  const reasonCountsByDoctor = new Map<string, Map<TelegramLateDepartureReasonCode, number>>();
  const patternItems = (patternRows as unknown as { rows: any[] }).rows ?? (patternRows as any);
  for (const row of patternItems as any[]) {
    const code = detectLateDepartureReasonCode(row.reasonText);
    if (!code) continue;
    const inner = reasonCountsByDoctor.get(row.doctorId) ?? new Map<TelegramLateDepartureReasonCode, number>();
    inner.set(code, (inner.get(code) ?? 0) + 1);
    reasonCountsByDoctor.set(row.doctorId, inner);
  }

  return items.map((row: any): PendingDepartureConfirmation => {
    const recentMessages = messagesByOccupancy.get(row.occupancyId) ?? [];
    const reasonFromMessages = recentMessages
      .map((message) => detectLateDepartureReasonCode(message.rawText))
      .find((code) => code !== null) ?? null;
    const reasonFromNotes = detectLateDepartureReasonCode(row.notes);
    const reasonCode = reasonFromMessages ?? reasonFromNotes;
    const sourceMessage =
      (reasonCode
        ? recentMessages.find((message) => detectLateDepartureReasonCode(message.rawText) === reasonCode)
        : undefined) ?? recentMessages[0] ?? null;
    // Recover the 4-digit occurrence number from the doctor's message(s) / notes.
    // Pass the shift times as fragments so the verbalized departure time is never
    // mistaken for the occurrence number.
    const timeFragments = [row.actualEndedAt, row.scheduledEndAt]
      .filter(Boolean)
      .map((iso: string) => {
        const d = new Date(iso);
        return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      });
    const occurrenceNumber = reasonCode === "occurrence"
      ? (extractTelegramOccurrenceNumber(sourceMessage?.rawText ?? "", timeFragments)
        ?? extractTelegramOccurrenceNumber(row.notes ?? "", timeFragments)
        ?? recentMessages
          .map((message) => extractTelegramOccurrenceNumber(message.rawText, timeFragments))
          .find((value) => value !== null)
        ?? null)
      : null;
    const occurrenceNumberMissing = reasonCode === "occurrence" && !occurrenceNumber;
    const delayMinutes = row.scheduledEndAt
      ? Math.round((new Date(row.actualEndedAt).getTime() - new Date(row.scheduledEndAt).getTime()) / 60000)
      : null;
    const reasonOccurrenceCount30d = reasonCode
      ? (reasonCountsByDoctor.get(row.doctorId)?.get(reasonCode) ?? 0)
      : 0;

    return {
      occupancyId: row.occupancyId,
      domain: row.domain,
      targetCode: row.targetCode,
      targetLabel: row.targetLabel,
      doctorId: row.doctorId,
      doctorName: row.doctorName,
      displayName: row.displayName,
      shiftLabel: row.shiftLabel,
      roleLabel: row.roleLabel,
      startedAt: row.startedAt,
      scheduledStartAt: row.scheduledStartAt,
      scheduledEndAt: row.scheduledEndAt,
      actualEndedAt: row.actualEndedAt,
      endedAt: row.endedAt,
      reasonCode,
      occurrenceNumber,
      occurrenceNumberMissing,
      delayMinutes,
      recentMessages,
      sourceMessage,
      reasonOccurrenceCount30d,
      recordedAt: row.recordedAt,
    };
  });
}

export async function getPreviousOperationalBoard(
  reference: Date = new Date(),
  options: { mode?: PreviousOperationalMode } = {},
): Promise<PreviousOperationalBoard> {
  const db = getDb();
  // Resolve modo: o caller pode forcar (back-sn da pagina dedicada). Sem
  // override, deduz pelo turno corrente — SD => full-prev (auditar ontem),
  // SN => sd-only-current (auditar o SD que acabou de fechar).
  const currentShiftLabel: "SD" | "SN" = toOperationalLocalClock(reference).getUTCHours() >= 7
    && toOperationalLocalClock(reference).getUTCHours() < 19
    ? "SD"
    : "SN";
  const mode: PreviousOperationalMode = options.mode
    ?? (currentShiftLabel === "SN" ? "sd-only-current" : "full-prev");

  const layout = resolvePreviousBoardLayout(reference, mode);
  const { anchorParts, previousNightParts, nextDayParts, previousSnSlotStart, sdSlotStart, snSlotStart, relevantSlotStarts, includeAnchorSn } = layout;

  const queryStart = fromOperationalLocalClockParts(previousNightParts.year, previousNightParts.month, previousNightParts.day, 0, 0).toISOString();
  const queryEnd = fromOperationalLocalClockParts(addOperationalLocalDays(anchorParts, 2).year, addOperationalLocalDays(anchorParts, 2).month, addOperationalLocalDays(anchorParts, 2).day, 0, 0).toISOString();
  const previousStartedAtIso = fromOperationalLocalClockParts(anchorParts.year, anchorParts.month, anchorParts.day, 7, 0).toISOString();
  const previousEndedAtIso = fromOperationalLocalClockParts(nextDayParts.year, nextDayParts.month, nextDayParts.day, 7, 0).toISOString();
  const previousShiftLabel = "SN" as const;
  const operationalDateIso = fromOperationalLocalClockParts(anchorParts.year, anchorParts.month, anchorParts.day, 12, 0).toISOString();

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
        ro.created_at as "createdAt",
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
        io.created_at as "createdAt",
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

  const rawRows = (result as unknown as Record<string, unknown>[]).map(mapPreviousOperationalRow)
    .filter((row) => !isTrueZeroDurationPhantom(row));
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

  for (const slotMap of candidatesByDoctorTarget.values()) {
    const previousSn = slotMap.get(previousSnSlotStart);
    const sd = slotMap.get(sdSlotStart);
    const sn = includeAnchorSn ? slotMap.get(snSlotStart) : undefined;

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

    // SN do dia anterior so entra no plantao avaliado quando combina com SD
    // formando P invertido. Sem essa combinacao, pertence ao plantao anterior
    // (segunda) e nao deve aparecer como standalone no fechamento de terca.
    if (candidate.logicalSlotStart === previousSnSlotStart) {
      continue;
    }

    entries.push(buildStandalonePreviousEntry(candidate));
  }

  // Aplica editavel por bucket conforme o modo (back-sn restringe a SN).
  const scopedEntries = entries.map((entry) => ({
    ...entry,
    editable: resolveEditableScope(mode, entry.bucket),
  }));

  const sortedEntries = scopedEntries.sort(comparePreviousEntries);

  const sectionOrder: PreviousOperationalBucket[] = ["P_INVERTIDO", "P", "SD", "SN"];
  const sections = sectionOrder.map((bucket) => ({
    bucket,
    label: resolvePreviousBucketLabel(bucket),
    description: resolvePreviousBucketDescription(bucket),
    entries: sortedEntries.filter((entry) => entry.bucket === bucket),
  }));

  return {
    generatedAt: new Date().toISOString(),
    operationalDate: operationalDateIso,
    shiftLabel: previousShiftLabel,
    startedAt: previousStartedAtIso,
    endedAt: previousEndedAtIso,
    totalEntries: sortedEntries.length,
    sections,
    mode,
    currentShiftLabel,
  };
}

function resolvePaymentAllocationTarget(row: Record<string, unknown>): PaymentAllocationTargetDefinition {
  return {
    domain: String(row.domain) === "regulation" ? "regulation" : "intervention",
    targetId: row.targetId === null || row.targetId === undefined ? null : Number(row.targetId),
    targetCode: String(row.targetCode),
    targetLabel: String(row.targetLabel),
    sortOrder: Number(row.sortOrder ?? 0),
    defaultRole: (row.defaultRole ?? null) as string | null,
    disabledAt: (row.disabledAt ?? null) as string | null,
    reactivatedAt: (row.reactivatedAt ?? null) as string | null,
    disabledReason: (row.disabledReason ?? null) as string | null,
    disabledDuringShift: Boolean(row.disabledDuringShift ?? false),
    disabledEntireShift: Boolean(row.disabledEntireShift ?? false),
  };
}

function resolvePaymentAllocationStatus(issues: string[]): PaymentAllocationStatus {
  return issues.length > 0 ? "needs_review" : "ready_for_payment";
}

function isNucleoPaymentTarget(target: PaymentAllocationTargetDefinition) {
  return target.domain === "regulation" && isNucleoRegulationPost(target.targetCode);
}

function shouldIncludePaymentAllocationTarget(target: PaymentAllocationTargetDefinition, shiftLabel: "SD" | "SN") {
  if (isNucleoPaymentTarget(target)) {
    return shiftLabel === "SD";
  }

  return true;
}

function shouldAllowCarriedPaymentCandidate(params: {
  target: PaymentAllocationTargetDefinition;
  candidate: LogicalShiftCandidate;
  slotStartIso: string;
}) {
  if (isNucleoPaymentTarget(params.target) && params.candidate.logicalSlotStart !== params.slotStartIso) {
    return false;
  }

  return true;
}

function resolveEmptyPaymentAllocationIssues(params: {
  target: PaymentAllocationTargetDefinition;
  displacedByDoctorConflict: boolean;
}) {
  if (params.displacedByDoctorConflict) {
    return ["Todos os candidatos deste alvo conflitam com alocacoes mais confiaveis do mesmo turno"];
  }

  if (isNucleoPaymentTarget(params.target)) {
    return [
      `${resolvePendingRegulationOccupantLabel(params.target.targetCode)}: chefia não lançou o médico do núcleo no SD.`,
      "Pagamento do núcleo não pode reaproveitar o plantonista anterior.",
    ];
  }

  return ["Sem ocupacao identificada para o turno"];
}

function comparePaymentAllocationRows(
  left: { sortOrder: number; targetCode: string },
  right: { sortOrder: number; targetCode: string },
) {
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
      const shiftBoundary = resolveImplicitOccupancyExpiry(
        candidate.logicalSlotStart,
        candidate.shiftLabel,
      )?.toISOString() ?? null;
      return shiftBoundary ?? plannedCoverageEndAt;
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
  if (!coverageEndAt) return false;
  // Um plantao P cobre automaticamente apenas seu intervalo logico de 24h
  // (dois slots). Atraso na saida — actual_ended_at vazando minutos para o
  // slot seguinte — nao pode fazer o P cobrir um terceiro slot de pagamento.
  // 36h sao computadas apenas via ocupacao de continuidade explicita, que
  // tem logicalSlotStart proprio e e avaliada como candidato separado.
  const logicalSpanEndMs = new Date(candidate.logicalSlotStart).getTime() + 86400000;
  const coverageEndMs = Math.min(new Date(coverageEndAt).getTime(), logicalSpanEndMs);
  if (coverageEndMs > slotStart) return true;
  // Boundary equality: resolveProlongedShiftExpiry returns exactly the next-slot start
  // (e.g. 07:00 next day for a SN P-shift). Accept only when slotStartIso is the
  // *immediately* next slot from the candidate's logical slot — this prevents an SD
  // P-shift from bleeding 24h into the following SD while correctly including an
  // SN P-shift that reaches the following morning's SD.
  if (coverageEndMs === slotStart) {
    const immediatelyNextSlotStart = resolveSlotEnd(
      new Date(candidate.logicalSlotStart),
      candidate.logicalSlot,
    );
    return immediatelyNextSlotStart.getTime() === slotStart;
  }
  return false;
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
    if (params.candidate.logicalSlotStart === params.slotStartIso) {
      score += 120;
    } else {
      score -= 30;
    }
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
    targetId: params.target.targetId ?? null,
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
    notes: null,
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
      ? `Slot desativado desde ${new Date(params.target.disabledAt).toISOString()}`
      : "Slot desativado para este turno",
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

function resolveChosenCandidateDeactivationOutcome(params: {
  target: PaymentAllocationTargetDefinition;
  chosenCandidate: LogicalShiftCandidate;
  slotStartIso: string;
  shiftLabel: "SD" | "SN";
}) {
  const disabledAt = params.target.disabledAt ?? null;
  if (!params.target.disabledDuringShift || !disabledAt) {
    return {
      shouldSuppressChosenCoverage: false,
      clearedDisabledState: null,
    };
  }

  // Lançamentos manuais no fechamento de pagamento (admin_correction/manual)
  // são autoritativos: o admin acabou de atestar que houve médico no slot.
  // Deactivations anteriores ("Remanejado", restos de turnos vizinhos, etc.)
  // que vazaram pelo boundary não devem suprimir a coverage atestada.
  if (params.chosenCandidate.source === "admin_correction"
    || params.chosenCandidate.source === "manual") {
    return {
      shouldSuppressChosenCoverage: false,
      clearedDisabledState: {
        disabledAt: null,
        disabledReason: null,
        disabledDuringShift: false,
        disabledEntireShift: false,
      },
    };
  }

  const actualWindow = buildPaymentAllocationActualWindow({
    candidate: params.chosenCandidate,
    slotStartIso: params.slotStartIso,
    shiftLabel: params.shiftLabel,
  });
  const actualStartMs = new Date(actualWindow.actualStartAt).getTime();
  const reactivatedAtMs = params.target.reactivatedAt
    ? new Date(params.target.reactivatedAt).getTime()
    : Number.POSITIVE_INFINITY;

  if (actualStartMs >= reactivatedAtMs) {
    return {
      shouldSuppressChosenCoverage: false,
      clearedDisabledState: {
        disabledAt: null,
        disabledReason: null,
        disabledDuringShift: false,
        disabledEntireShift: false,
      },
    };
  }

  return {
    shouldSuppressChosenCoverage: true,
    clearedDisabledState: null,
  };
}

function buildChosenPaymentAllocationRow(params: {
  target: PaymentAllocationTargetDefinition;
  candidates: LogicalShiftCandidate[];
  chosenCandidate: LogicalShiftCandidate;
  slotStartIso: string;
  shiftLabel: "SD" | "SN";
  continuitySourceSummaryByOccupancyId: Map<string, ContinuitySourceSummary>;
  bankHoursBalanceOverridesByContinuityGroupId: Map<string, BankHoursBalanceOverrideSummary>;
  disabledStateOverride?: {
    disabledAt: string | null;
    disabledReason: string | null;
    disabledDuringShift: boolean;
    disabledEntireShift: boolean;
  } | null;
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
  const disabledState = params.disabledStateOverride ?? {
    disabledAt: params.target.disabledAt ?? null,
    disabledReason: params.target.disabledReason ?? null,
    disabledDuringShift: params.target.disabledDuringShift ?? false,
    disabledEntireShift: params.target.disabledEntireShift ?? false,
  };

  return {
    domain: params.target.domain,
    targetId: params.target.targetId ?? null,
    targetCode: params.target.targetCode,
    targetLabel: params.target.targetLabel,
    sortOrder: params.target.sortOrder,
    defaultRole: params.target.defaultRole,
    disabledAt: disabledState.disabledAt,
    disabledReason: disabledState.disabledReason,
    disabledDuringShift: disabledState.disabledDuringShift,
    disabledEntireShift: disabledState.disabledEntireShift,
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
    notes: chosen.notes,
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
        candidates: (params.candidatesByTarget.get(key) ?? []).filter((candidate) => shouldAllowCarriedPaymentCandidate({
          target,
          candidate,
          slotStartIso: params.slotStartIso,
        })),
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

  // Lock-in pass: explicit human attestations (admin_correction/manual) whose
  // logical slot matches this slot are authoritative — allocate them first so
  // the priority loop below cannot displace the doctor onto another target.
  for (const choice of choices) {
    if (choice.candidates.length === 0) continue;
    const explicitCandidate = choice.candidates.find((candidate) => (
      (candidate.source === "admin_correction" || candidate.source === "manual")
      && candidate.logicalSlotStart === params.slotStartIso
      && !usedDoctorIds.has(candidate.doctorId)
    ));
    if (explicitCandidate) {
      choice.chosenCandidate = explicitCandidate;
      usedDoctorIds.add(explicitCandidate.doctorId);
    }
  }

  const remainingChoices = choices.filter((choice) => !choice.chosenCandidate);
  const prioritizedChoices = [...remainingChoices].sort((left, right) => {
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

function buildAdditionalShadowPaymentAllocationRows(params: {
  targetChoices: PaymentAllocationTargetChoice[];
  slotStartIso: string;
  shiftLabel: "SD" | "SN";
  continuitySourceSummaryByOccupancyId: Map<string, ContinuitySourceSummary>;
  bankHoursBalanceOverridesByContinuityGroupId: Map<string, BankHoursBalanceOverrideSummary>;
}) {
  const rows: PaymentAllocationRow[] = [];

  for (const choice of params.targetChoices) {
    if (choice.target.disabledEntireShift) {
      continue;
    }

    const chosenOccupancyId = choice.chosenCandidate?.occupancyId ?? null;
    const shadowCandidates = choice.candidates.filter((candidate) => (
      candidate.isShadow
      && candidate.occupancyId !== chosenOccupancyId
    ));

    for (const shadowCandidate of shadowCandidates) {
      const deactivationOutcome = resolveChosenCandidateDeactivationOutcome({
        target: choice.target,
        chosenCandidate: shadowCandidate,
        slotStartIso: params.slotStartIso,
        shiftLabel: params.shiftLabel,
      });

      if (deactivationOutcome.shouldSuppressChosenCoverage) {
        continue;
      }

      rows.push(buildChosenPaymentAllocationRow({
        target: choice.target,
        candidates: [shadowCandidate],
        chosenCandidate: shadowCandidate,
        slotStartIso: params.slotStartIso,
        shiftLabel: params.shiftLabel,
        continuitySourceSummaryByOccupancyId: params.continuitySourceSummaryByOccupancyId,
        bankHoursBalanceOverridesByContinuityGroupId: params.bankHoursBalanceOverridesByContinuityGroupId,
        disabledStateOverride: deactivationOutcome.clearedDisabledState,
      }));
    }
  }

  return rows;
}

const PAYMENT_SLOT_DURATION_MS = 12 * 60 * 60 * 1000;

/**
 * Médicos que já têm um SD elegível no MESMO dia operacional da noite (o SD
 * imediatamente antes do SN), para o slot SD que está sendo montado.
 *
 * Um SD anchorado no dia anterior fica em `slotStartIso - 24h` (o SN dessa noite
 * fica em `slotStartIso - 12h`). Só é relevante quando o board é SD, porque é o
 * único caso em que um P noturno carregaria para frente.
 */
function buildDoctorsWithSdOnSnDay(
  candidates: LogicalShiftCandidate[],
  slotStartIso: string,
  boardShiftLabel: "SD" | "SN",
) {
  const doctors = new Set<string>();
  if (boardShiftLabel !== "SD") {
    return doctors;
  }

  const sameDaySdStartIso = new Date(new Date(slotStartIso).getTime() - (2 * PAYMENT_SLOT_DURATION_MS)).toISOString();
  for (const candidate of candidates) {
    if (candidate.logicalSlot !== "SD" || candidate.logicalSlotStart !== sameDaySdStartIso) {
      continue;
    }
    if (!isEligiblePresenceCandidate(candidate) || isMicroCoverage(candidate)) {
      continue;
    }
    doctors.add(candidate.doctorId);
  }

  return doctors;
}

/**
 * Um "P" declarado à noite (SN) que carregaria para o SD do dia seguinte deve
 * ser suprimido quando o médico JÁ tem um SD no mesmo dia: nesse caso o P é a
 * continuidade do dia que ele já trabalhou (fecha às 07h), não um novo plantão
 * que avança até as 19h de amanhã. Sem isso, surge um SD fantasma no dia
 * seguinte (caso Reinaldo: SD@1368 + SN(P)@2033 virava SD@2033 fantasma) que
 * ainda pode deslocar o SD real via dedup por doctorId.
 *
 * Quem avisa P à noite SEM ter SD no dia (chegada noturna fresca) não entra em
 * `doctorsWithSdOnSnDay` e segue cobrindo o SD seguinte normalmente.
 */
function isSuppressedBackwardContinuityCarry(
  candidate: LogicalShiftCandidate,
  slotStartIso: string,
  boardShiftLabel: "SD" | "SN",
  doctorsWithSdOnSnDay: Set<string>,
) {
  if (boardShiftLabel !== "SD") {
    return false;
  }
  if (candidate.shiftLabel !== "P" || candidate.logicalSlot !== "SN") {
    return false;
  }
  // Só carregamentos (o SN começou no slot anterior); um candidato in-slot não é carry.
  if (candidate.logicalSlotStart === slotStartIso) {
    return false;
  }

  return doctorsWithSdOnSnDay.has(candidate.doctorId);
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
  const cleanRows = params.rawRows.filter((row) => !isTrueZeroDurationPhantom(row));
  const successorStartMap = resolveSuccessorStartMap(cleanRows);
  const continuitySourceSummaryByOccupancyId = buildContinuitySourceSummaryMap(cleanRows);
  const eligibleTargets = params.targets.filter((target) => shouldIncludePaymentAllocationTarget(target, params.shiftLabel));
  const mappedCandidates = cleanRows
    .map(mapLogicalShiftCandidate)
    .map((candidate) => applyEffectiveEndedAt(candidate, successorStartMap.get(candidate.occupancyId) ?? null));
  // Calculado ANTES do filtro de cobertura: o SD do dia anterior não cobre este
  // slot SD, então some do pipeline — mas precisamos saber que ele existe.
  const doctorsWithSdOnSnDay = buildDoctorsWithSdOnSnDay(mappedCandidates, params.startedAt, params.shiftLabel);
  const logicalCandidates = collapseLogicalShiftCandidates(mappedCandidates
    .filter((candidate) => doesCandidateCoverPaymentSlot(candidate, params.startedAt))
    .filter((candidate) => !isSuppressedBackwardContinuityCarry(candidate, params.startedAt, params.shiftLabel, doctorsWithSdOnSnDay))
  ).filter((candidate) => isEligiblePresenceCandidate(candidate))
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
    targets: eligibleTargets,
    candidatesByTarget,
    slotStartIso: params.startedAt,
    shiftLabel: params.shiftLabel,
  });

  const rows = targetChoices
    .map((choice) => {
      if (choice.chosenCandidate) {
        const deactivationOutcome = resolveChosenCandidateDeactivationOutcome({
          target: choice.target,
          chosenCandidate: choice.chosenCandidate,
          slotStartIso: params.startedAt,
          shiftLabel: params.shiftLabel,
        });
        if (deactivationOutcome.shouldSuppressChosenCoverage) {
          return buildDisabledPaymentAllocationRow({
            target: choice.target,
            shiftLabel: params.shiftLabel,
            candidateCount: choice.candidates.length,
          });
        }

        return buildChosenPaymentAllocationRow({
          target: choice.target,
          candidates: choice.candidates,
          chosenCandidate: choice.chosenCandidate,
          slotStartIso: params.startedAt,
          shiftLabel: params.shiftLabel,
          continuitySourceSummaryByOccupancyId,
          bankHoursBalanceOverridesByContinuityGroupId: params.bankHoursBalanceOverridesByContinuityGroupId ?? new Map(),
          disabledStateOverride: deactivationOutcome.clearedDisabledState,
        });
      }

      if (choice.target.disabledEntireShift) {
        return buildDisabledPaymentAllocationRow({
          target: choice.target,
          shiftLabel: params.shiftLabel,
          candidateCount: choice.candidates.length,
        });
      }

      return buildEmptyPaymentAllocationRow({
        target: choice.target,
        shiftLabel: params.shiftLabel,
        candidateCount: choice.candidates.length,
        issues: resolveEmptyPaymentAllocationIssues({
          target: choice.target,
          displacedByDoctorConflict: choice.displacedByDoctorConflict,
        }),
      });
    });

  const additionalShadowRows = buildAdditionalShadowPaymentAllocationRows({
    targetChoices,
    slotStartIso: params.startedAt,
    shiftLabel: params.shiftLabel,
    continuitySourceSummaryByOccupancyId,
    bankHoursBalanceOverridesByContinuityGroupId: params.bankHoursBalanceOverridesByContinuityGroupId ?? new Map(),
  });

  const mergedRows = [...rows, ...additionalShadowRows]
    .sort(comparePaymentAllocationRows);

  const regulation = mergedRows.filter((row) => row.domain === "regulation");
  const intervention = mergedRows.filter((row) => row.domain === "intervention");
  const payableRows = mergedRows.filter((row) => !(row.disabledDuringShift && !row.occupancyId));
  const disabledCount = mergedRows.filter((row) => row.disabledDuringShift && !row.occupancyId).length;
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

function resolveSlotPresenceCandidateLabel(candidate: LogicalShiftCandidate) {
  const label = candidate.displayName?.trim() || candidate.doctorName.trim();
  return candidate.isShadow ? `${label} (sombra)` : label;
}

function compareSlotPresenceCandidates(left: LogicalShiftCandidate, right: LogicalShiftCandidate) {
  const leftStartedAt = new Date(left.startedAt).getTime();
  const rightStartedAt = new Date(right.startedAt).getTime();
  if (leftStartedAt !== rightStartedAt) {
    return leftStartedAt - rightStartedAt;
  }

  const leftBoardStartedAt = left.boardStartedAt ? new Date(left.boardStartedAt).getTime() : Number.POSITIVE_INFINITY;
  const rightBoardStartedAt = right.boardStartedAt ? new Date(right.boardStartedAt).getTime() : Number.POSITIVE_INFINITY;
  if (leftBoardStartedAt !== rightBoardStartedAt) {
    return leftBoardStartedAt - rightBoardStartedAt;
  }

  return left.occupancyId.localeCompare(right.occupancyId, "pt-BR");
}

function buildOccupiedSlotPresenceRow(params: {
  target: PaymentAllocationTargetDefinition;
  candidates: LogicalShiftCandidate[];
  slotStartIso: string;
}): OperationalSlotPresenceRow {
  const orderedCandidates = [...params.candidates].sort((left, right) => {
    const leftNative = left.logicalSlotStart === params.slotStartIso ? 0 : 1;
    const rightNative = right.logicalSlotStart === params.slotStartIso ? 0 : 1;
    if (leftNative !== rightNative) return leftNative - rightNative;
    return compareSlotPresenceCandidates(left, right);
  });
  const primaryCandidate = orderedCandidates.find((candidate) => !candidate.isShadow) ?? orderedCandidates[0] as LogicalShiftCandidate;
  const occupantLabels = orderedCandidates.map(resolveSlotPresenceCandidateLabel);

  return {
    domain: params.target.domain,
    targetId: params.target.targetId ?? null,
    targetCode: params.target.targetCode,
    targetLabel: params.target.targetLabel,
    sortOrder: params.target.sortOrder,
    defaultRole: params.target.defaultRole,
    disabledAt: params.target.disabledAt ?? null,
    disabledReason: params.target.disabledReason ?? null,
    disabledDuringShift: params.target.disabledDuringShift ?? false,
    disabledEntireShift: params.target.disabledEntireShift ?? false,
    status: "occupied",
    doctorId: primaryCandidate.doctorId,
    doctorName: primaryCandidate.doctorName,
    displayName: primaryCandidate.displayName,
    doctorLabel: occupantLabels.join(" -> "),
    occupantLabels,
    occupancyIds: orderedCandidates.map((candidate) => candidate.occupancyId),
    occupancyCount: orderedCandidates.length,
  };
}

function isEligiblePresenceCandidate(candidate: LogicalShiftCandidate) {
  if (candidate.invalidTimeline || candidate.isLikelyNoise) {
    return false;
  }

  if (
    candidate.domain === "intervention"
    && !candidate.boardStartedAt
    && candidate.shiftLabel !== "P"
    && !candidate.isShadow
    && candidate.source !== "admin_correction"
    && candidate.source !== "manual"
  ) {
    return false;
  }

  return true;
}

function buildEmptySlotPresenceRow(params: {
  target: PaymentAllocationTargetDefinition;
}): OperationalSlotPresenceRow {
  return {
    domain: params.target.domain,
    targetId: params.target.targetId ?? null,
    targetCode: params.target.targetCode,
    targetLabel: params.target.targetLabel,
    sortOrder: params.target.sortOrder,
    defaultRole: params.target.defaultRole,
    disabledAt: params.target.disabledAt ?? null,
    disabledReason: params.target.disabledReason ?? null,
    disabledDuringShift: params.target.disabledDuringShift ?? false,
    disabledEntireShift: params.target.disabledEntireShift ?? false,
    status: params.target.disabledEntireShift ? "disabled" : "empty",
    doctorId: null,
    doctorName: null,
    displayName: null,
    doctorLabel: params.target.disabledEntireShift ? "Base desativada" : "Sem medico",
    occupantLabels: [],
    occupancyIds: [],
    occupancyCount: 0,
  };
}

function resolveHistoricalOperationalIssues(candidates: LogicalShiftCandidate[]) {
  const issues: string[] = [];

  if (candidates.length > 1) {
    issues.push("Cobertura multipla no turno");
  }

  if (candidates.some((candidate) => candidate.source === "admin_correction")) {
    issues.push("Lancamento manual ou corrigido manualmente");
  }

  return issues;
}

function buildOccupiedHistoricalOperationalPresenceRow(params: {
  target: PaymentAllocationTargetDefinition;
  candidates: LogicalShiftCandidate[];
  slotStartIso: string;
}): HistoricalOperationalPresenceRow {
  const orderedCandidates = [...params.candidates].sort((left, right) => {
    const leftNative = left.logicalSlotStart === params.slotStartIso ? 0 : 1;
    const rightNative = right.logicalSlotStart === params.slotStartIso ? 0 : 1;
    if (leftNative !== rightNative) return leftNative - rightNative;
    return compareSlotPresenceCandidates(left, right);
  });
  const primaryCandidate = orderedCandidates.find((candidate) => !candidate.isShadow) ?? orderedCandidates[0] as LogicalShiftCandidate;
  const occupantLabels = orderedCandidates.map(resolveSlotPresenceCandidateLabel);

  return {
    domain: params.target.domain,
    targetId: params.target.targetId ?? null,
    targetCode: params.target.targetCode,
    targetLabel: params.target.targetLabel,
    sortOrder: params.target.sortOrder,
    defaultRole: params.target.defaultRole,
    disabledAt: params.target.disabledAt ?? null,
    disabledReason: params.target.disabledReason ?? null,
    disabledDuringShift: params.target.disabledDuringShift ?? false,
    disabledEntireShift: params.target.disabledEntireShift ?? false,
    status: "occupied",
    occupancyId: primaryCandidate.occupancyId,
    doctorId: primaryCandidate.doctorId,
    doctorName: primaryCandidate.doctorName,
    displayName: primaryCandidate.displayName,
    doctorLabel: occupantLabels.join(" -> "),
    occupantLabels,
    occupancyIds: orderedCandidates.map((candidate) => candidate.occupancyId),
    occupancyCount: orderedCandidates.length,
    startedAt: primaryCandidate.startedAt,
    endedAt: primaryCandidate.endedAt,
    actualEndedAt: primaryCandidate.actualEndedAt,
    scheduledStartAt: primaryCandidate.scheduledStartAt,
    scheduledEndAt: primaryCandidate.scheduledEndAt,
    shiftLabel: primaryCandidate.shiftLabel,
    roleLabel: primaryCandidate.roleLabel,
    ramalLabel: primaryCandidate.ramalLabel,
    source: primaryCandidate.source,
    notes: primaryCandidate.notes,
    arrivalDelayMinutes: primaryCandidate.arrivalDelayMinutes,
    issues: resolveHistoricalOperationalIssues(orderedCandidates),
  };
}

function buildEmptyHistoricalOperationalPresenceRow(params: {
  target: PaymentAllocationTargetDefinition;
}): HistoricalOperationalPresenceRow {
  const disabledEntireShift = params.target.disabledEntireShift ?? false;
  const disabledDuringShift = params.target.disabledDuringShift ?? false;
  const status = disabledEntireShift ? "disabled" : "empty";
  const doctorLabel = status === "disabled"
    ? params.target.domain === "regulation"
      ? "Ramal desativado"
      : "Base desativada"
    : "Sem medico";

  return {
    domain: params.target.domain,
    targetId: params.target.targetId ?? null,
    targetCode: params.target.targetCode,
    targetLabel: params.target.targetLabel,
    sortOrder: params.target.sortOrder,
    defaultRole: params.target.defaultRole,
    disabledAt: params.target.disabledAt ?? null,
    disabledReason: params.target.disabledReason ?? null,
    disabledDuringShift,
    disabledEntireShift,
    status,
    occupancyId: null,
    doctorId: null,
    doctorName: null,
    displayName: null,
    doctorLabel,
    occupantLabels: [],
    occupancyIds: [],
    occupancyCount: 0,
    startedAt: null,
    endedAt: null,
    actualEndedAt: null,
    scheduledStartAt: null,
    scheduledEndAt: null,
    shiftLabel: null,
    roleLabel: null,
    ramalLabel: null,
    source: null,
    notes: null,
    arrivalDelayMinutes: null,
    issues: [],
  };
}

export function buildOperationalSlotPresenceBoardModel(params: {
  targets: PaymentAllocationTargetDefinition[];
  rawRows: PaymentAllocationRawRow[];
  operationalDate: string;
  shiftLabel: "SD" | "SN";
  startedAt: string;
  endedAt: string;
  generatedAt?: string;
}) {
  const cleanRows = params.rawRows.filter((row) => !isTrueZeroDurationPhantom(row));
  const successorStartMap = resolveSuccessorStartMap(cleanRows);
  const eligibleTargets = params.targets.filter((target) => shouldIncludePaymentAllocationTarget(target, params.shiftLabel));
  const logicalCandidates = collapseLogicalShiftCandidates(cleanRows
    .map(mapLogicalShiftCandidate)
    .map((candidate) => applyEffectiveEndedAt(candidate, successorStartMap.get(candidate.occupancyId) ?? null))
    .filter((candidate) => doesCandidateCoverPaymentSlot(candidate, params.startedAt))
  ).filter((candidate) => isEligiblePresenceCandidate(candidate))
    .filter((candidate) => !isMicroCoverage(candidate))
    .filter((candidate, _, all) => !shouldIgnoreDuplicateRestart(candidate, all));

  const candidatesByTarget = new Map<string, LogicalShiftCandidate[]>();
  for (const candidate of logicalCandidates) {
    const key = [candidate.domain, candidate.targetCode].join("|");
    const current = candidatesByTarget.get(key) ?? [];
    current.push(candidate);
    candidatesByTarget.set(key, current);
  }

  const rows = eligibleTargets
    .map((target) => {
      const key = [target.domain, target.targetCode].join("|");
      const candidates = candidatesByTarget.get(key) ?? [];
      if (candidates.length > 0) {
        return buildOccupiedSlotPresenceRow({
          target,
          candidates,
          slotStartIso: params.startedAt,
        });
      }

      return buildEmptySlotPresenceRow({ target });
    })
    .sort(comparePaymentAllocationRows);

  const regulation = rows.filter((row) => row.domain === "regulation");
  const intervention = rows.filter((row) => row.domain === "intervention");
  const occupiedCount = rows.filter((row) => row.status === "occupied").length;
  const emptyCount = rows.filter((row) => row.status === "empty").length;
  const disabledCount = rows.filter((row) => row.status === "disabled").length;

  return {
    generatedAt: params.generatedAt ?? new Date().toISOString(),
    operationalDate: params.operationalDate,
    shiftLabel: params.shiftLabel,
    startedAt: params.startedAt,
    endedAt: params.endedAt,
    summary: {
      totalTargets: rows.length,
      occupiedCount,
      emptyCount,
      disabledCount,
    },
    regulation,
    intervention,
  } satisfies OperationalSlotPresenceBoard;
}

export function buildHistoricalOperationalPresenceBoardModel(params: {
  targets: PaymentAllocationTargetDefinition[];
  rawRows: PaymentAllocationRawRow[];
  operationalDate: string;
  shiftLabel: "SD" | "SN";
  startedAt: string;
  endedAt: string;
  generatedAt?: string;
}) {
  const cleanRows = params.rawRows.filter((row) => !isTrueZeroDurationPhantom(row));
  const successorStartMap = resolveSuccessorStartMap(cleanRows);
  const eligibleTargets = params.targets.filter((target) => shouldIncludePaymentAllocationTarget(target, params.shiftLabel));
  const logicalCandidates = collapseLogicalShiftCandidates(cleanRows
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

  const rows = eligibleTargets
    .map((target) => {
      const key = [target.domain, target.targetCode].join("|");
      const candidates = candidatesByTarget.get(key) ?? [];
      if (candidates.length > 0) {
        return buildOccupiedHistoricalOperationalPresenceRow({
          target,
          candidates,
          slotStartIso: params.startedAt,
        });
      }

      return buildEmptyHistoricalOperationalPresenceRow({ target });
    })
    .sort(comparePaymentAllocationRows);

  const regulation = rows.filter((row) => row.domain === "regulation");
  const intervention = rows.filter((row) => row.domain === "intervention");
  const occupiedCount = rows.filter((row) => row.status === "occupied").length;
  const disabledCount = rows.filter((row) => row.status === "disabled").length;
  const emptyCount = rows.filter((row) => row.status === "empty").length;

  return {
    generatedAt: params.generatedAt ?? new Date().toISOString(),
    operationalDate: params.operationalDate,
    shiftLabel: params.shiftLabel,
    startedAt: params.startedAt,
    endedAt: params.endedAt,
    summary: {
      totalTargets: rows.length,
      occupiedCount,
      emptyCount,
      disabledCount,
    },
    regulation,
    intervention,
  } satisfies HistoricalOperationalPresenceBoard;
}

async function loadPaymentAllocationSourceData(
  db: ReturnType<typeof getDb>,
  request: ReturnType<typeof resolvePaymentAllocationRequest>,
) {
  await expireStaleShadowInterventionOccupancies(new Date(Math.min(Date.now(), new Date(request.endedAt).getTime())));
  const queryStart = new Date(new Date(request.startedAt).getTime() - 86400000).toISOString();
  const queryEnd = new Date(new Date(request.endedAt).getTime() + 86400000).toISOString();

  const targetResult = await db.execute(sql`
    select
      'regulation' as domain,
      rp.id as "targetId",
      rp.code as "targetCode",
      rp.label as "targetLabel",
      rp.sort_order as "sortOrder",
      rp.default_role as "defaultRole",
      rpd.deactivated_at as "disabledAt",
      rpd.reactivated_at as "reactivatedAt",
      rpd.notes as "disabledReason",
      case when rpd.post_id is not null then true else false end as "disabledDuringShift",
      case
        when rpd.post_id is not null
          and rpd.deactivated_at <= ${request.startedAt}::timestamptz
          and coalesce(rpd.reactivated_at, 'infinity'::timestamptz) >= ${request.endedAt}::timestamptz
        then true
        else false
      end as "disabledEntireShift"
    from operations_v2.regulation_posts rp
    left join lateral (
      select
        state.post_id,
        state.deactivated_at,
        state.reactivated_at,
        state.notes
      from operations_v2.regulation_post_deactivations state
      where state.post_id = rp.id
        and state.deactivated_at < ${request.endedAt}::timestamptz
        and coalesce(state.reactivated_at, 'infinity'::timestamptz) > ${request.startedAt}::timestamptz
      order by state.deactivated_at desc, state.created_at desc
      limit 1
    ) rpd on true
    where rp.is_active = true
    union all
    select
      'intervention' as domain,
      ib.id as "targetId",
      ib.code as "targetCode",
      ib.label as "targetLabel",
      ib.sort_order as "sortOrder",
      null::text as "defaultRole",
      ibd.deactivated_at as "disabledAt",
      ibd.reactivated_at as "reactivatedAt",
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
        ro.notes as notes,
        ro.created_at as "createdAt"
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
        io.notes as notes,
        io.created_at as "createdAt"
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

  return {
    request,
    targets: (targetResult as unknown as Record<string, unknown>[]).map(resolvePaymentAllocationTarget),
    rawRows,
  };
}

export async function getOperationalSlotPresenceBoard(params: {
  operationalDate?: string | Date | null;
  shiftLabel?: "SD" | "SN" | null;
  reference?: Date;
} = {}): Promise<OperationalSlotPresenceBoard> {
  const db = getDb();
  const request = resolvePaymentAllocationRequest(params);
  const sourceData = await loadPaymentAllocationSourceData(db, request);

  return buildOperationalSlotPresenceBoardModel({
    targets: sourceData.targets,
    rawRows: sourceData.rawRows,
    operationalDate: request.operationalDate,
    shiftLabel: request.shiftLabel,
    startedAt: request.startedAt,
    endedAt: request.endedAt,
  });
}

export async function getHistoricalOperationalPresenceBoard(params: {
  operationalDate?: string | Date | null;
  shiftLabel?: "SD" | "SN" | null;
  reference?: Date;
} = {}): Promise<HistoricalOperationalPresenceBoard> {
  const db = getDb();
  const request = resolvePaymentAllocationRequest(params);
  const sourceData = await loadPaymentAllocationSourceData(db, request);

  return buildHistoricalOperationalPresenceBoardModel({
    targets: sourceData.targets,
    rawRows: sourceData.rawRows,
    operationalDate: request.operationalDate,
    shiftLabel: request.shiftLabel,
    startedAt: request.startedAt,
    endedAt: request.endedAt,
  });
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
  expireDeactivations?: boolean;
} = {}): Promise<PaymentAllocationBoard> {
  const db = getDb();
  const request = resolvePaymentAllocationRequest(params);
  if (params.expireDeactivations !== false) {
    await expireInterventionBaseDeactivations(new Date(request.startedAt));
  }
  const sourceData = await loadPaymentAllocationSourceData(db, request);
  const rawRows = sourceData.rawRows;

  return buildPaymentAllocationBoardModel({
    targets: sourceData.targets,
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
