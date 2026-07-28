/**
 * Traduções puras (sem dependência de banco) usadas pela view do banco de horas
 * e pelo modelo de histórico. Mantido separado de bank-hours-history.ts para que
 * componentes client possam importar sem arrastar o grafo do servidor (@/db).
 */

/** Justificativa de saída tardia vinda do bot (ocorrência, higienização, etc.). */
export interface BankHoursLateDeparture {
    reasonCode: "occurrence" | "hygienization" | "chief_release" | "handoff" | string;
    occurrenceNumber: string | null;
}

const BANK_HOURS_RULE_LABELS: Record<string, string> = {
    ON_TIME_NO_OVERTIME: "Chegada no horário, sem tempo excedente",
    ON_TIME_DOUBLE_OVERTIME: "Chegada no horário — tempo excedente vale em dobro",
    LATE_SIMPLE_OVERTIME: "Chegada atrasada — tempo excedente vale simples",
    LATE_NO_OVERTIME: "Chegada atrasada, sem tempo excedente",
    LATE_HALF_SHIFT_CARRYOVER: "Meio plantão reconhecido (13h–19h); tempo antes das 13h vira crédito",
    MANUAL_BANK_OVERRIDE: "Saldo fixado manualmente pela administração",
    ANOMALY_EXCESSIVE_DELAY: "Janela do plantão inconsistente (atraso improvável) — saldo zerado por segurança",
    ANOMALY_EXCESSIVE_OVERTIME: "Janela do plantão inconsistente (excedente improvável) — saldo zerado por segurança",
    ANOMALY_DELAY_AND_OVERTIME: "Janela do plantão inconsistente (atraso e excedente improváveis) — saldo zerado por segurança",
    UNSPECIFIED_RULE: "Sem regra registrada",
};

/** Traduz o código técnico da regra do banco para português legível. */
export function translateBankHoursRuleCode(ruleCode: string | null | undefined) {
    if (!ruleCode) {
        return "Sem regra registrada";
    }

    return BANK_HOURS_RULE_LABELS[ruleCode] ?? ruleCode.replaceAll("_", " ").toLowerCase();
}

const LATE_DEPARTURE_REASON_LABELS: Record<string, string> = {
    occurrence: "estava em ocorrência",
    hygienization: "estava na higienização da viatura",
    chief_release: "segurou o posto até a liberação da chefia",
    handoff: "aguardou a rendição chegar",
};

/** Frase curta em português para a justificativa de saída tardia registrada no bot. */
export function describeLateDepartureReason(lateDeparture: BankHoursLateDeparture | null | undefined) {
    if (!lateDeparture) {
        return null;
    }

    const base = LATE_DEPARTURE_REASON_LABELS[lateDeparture.reasonCode] ?? null;
    if (!base) {
        return null;
    }

    if (lateDeparture.reasonCode === "occurrence" && lateDeparture.occurrenceNumber) {
        return `estava na ocorrência ${lateDeparture.occurrenceNumber}`;
    }

    return base;
}

const AUDIT_ACTION_LABELS: Record<string, string> = {
    started: "Plantão registrado",
    "started.undone": "Registro de chegada desfeito",
    corrected: "Correção administrativa",
    "corrected.undone": "Correção desfeita",
    deleted: "Registro excluído",
    "deleted.undone": "Exclusão desfeita",
    ended: "Saída registrada",
    departure_reported: "Saída informada",
    departure_confirmed: "Saída confirmada pela chefia",
    continuation_confirmed: "Continuidade confirmada",
    "late_arrival.acknowledged": "Atraso reconhecido pela chefia (meio plantão)",
    "late_arrival.reverted": "Reconhecimento de atraso revertido",
    transferred: "Remanejado de posto/base",
    "transferred.undone": "Remanejo desfeito",
};

/** Traduz o nome técnico da ação da trilha de auditoria para português. */
export function translateOccupancyAuditAction(action: string) {
    const suffix = action.replace(/^(regulation_occupancy|intervention_occupancy|operational_occupancy)\./, "");
    return AUDIT_ACTION_LABELS[suffix] ?? suffix.replaceAll("_", " ").replaceAll(".", " · ");
}
