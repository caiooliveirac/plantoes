import { isNucleoRegulationPost, isPiamRegulationPost } from "@/modules/operational/board-display";
import type { OperationalSlotAuditEntry, OperationalSlotAuditReport, OperationalSlotAuditSlot } from "@/services/slot-audit.service";

const TELEGRAM_MESSAGE_LIMIT = 3500;

function normalizeCode(value: string) {
    return value.trim().toUpperCase();
}

function extractNumericPortion(value: string) {
    const match = normalizeCode(value).match(/(\d+)/);
    return match ? Number(match[1]) : Number.NaN;
}

function formatDateLabel(operationalDate: string) {
    return new Intl.DateTimeFormat("pt-BR", {
        dateStyle: "short",
        timeZone: "America/Sao_Paulo",
    }).format(new Date(`${operationalDate}T12:00:00.000Z`));
}

function countEntries(entries: OperationalSlotAuditEntry[], status: OperationalSlotAuditEntry["status"]) {
    return entries.filter((entry) => entry.status === status).length;
}

function summarizeMissingCounts(report: OperationalSlotAuditReport) {
    return report.slots.reduce((accumulator, slot) => ({
        regulation: accumulator.regulation + countEntries(slot.regulation, "empty"),
        intervention: accumulator.intervention + countEntries(slot.intervention, "empty"),
    }), {
        regulation: 0,
        intervention: 0,
    });
}

function compareAuditRegulationCodes(left: string, right: string) {
    const normalizedLeft = normalizeCode(left);
    const normalizedRight = normalizeCode(right);
    const leftIsNucleo = isNucleoRegulationPost(normalizedLeft);
    const rightIsNucleo = isNucleoRegulationPost(normalizedRight);
    const leftIsPiam = isPiamRegulationPost(normalizedLeft);
    const rightIsPiam = isPiamRegulationPost(normalizedRight);

    const leftSpecialBucket = leftIsPiam ? 1 : leftIsNucleo ? 2 : 0;
    const rightSpecialBucket = rightIsPiam ? 1 : rightIsNucleo ? 2 : 0;

    if (leftSpecialBucket !== rightSpecialBucket) {
        return leftSpecialBucket - rightSpecialBucket;
    }

    if (leftSpecialBucket > 0 && rightSpecialBucket > 0) {
        return normalizedLeft.localeCompare(normalizedRight, "pt-BR", { numeric: true });
    }

    const leftNumeric = extractNumericPortion(normalizedLeft);
    const rightNumeric = extractNumericPortion(normalizedRight);
    const hasLeftNumeric = Number.isFinite(leftNumeric);
    const hasRightNumeric = Number.isFinite(rightNumeric);

    if (hasLeftNumeric && hasRightNumeric && leftNumeric !== rightNumeric) {
        return leftNumeric - rightNumeric;
    }

    if (hasLeftNumeric !== hasRightNumeric) {
        return hasLeftNumeric ? -1 : 1;
    }

    return normalizedLeft.localeCompare(normalizedRight, "pt-BR", { numeric: true });
}

function compareAuditInterventionCodes(left: string, right: string) {
    return normalizeCode(left).localeCompare(normalizeCode(right), "pt-BR", { numeric: true });
}

function sortAuditEntries(entries: OperationalSlotAuditEntry[]) {
    const compare = entries[0]?.domain === "regulation"
        ? compareAuditRegulationCodes
        : compareAuditInterventionCodes;

    return [...entries].sort((left, right) => compare(left.targetCode, right.targetCode));
}

function formatRegulationOccupiedLine(entry: OperationalSlotAuditEntry) {
    return `• ${entry.targetCode} | ${entry.doctorLabel}`;
}

function formatRegulationEmptyLine(entry: OperationalSlotAuditEntry) {
    return `• ${entry.targetCode}`;
}

function formatInterventionOccupiedLine(entry: OperationalSlotAuditEntry) {
    return `🚑✅ ${entry.targetCode} | ${entry.doctorLabel}`;
}

function formatInterventionEmptyLine(entry: OperationalSlotAuditEntry) {
    return `🚨🚑 ${entry.targetCode}`;
}

function formatInterventionDisabledLine(entry: OperationalSlotAuditEntry) {
    const reason = entry.disabledReason?.trim() ? ` (${entry.disabledReason.trim()})` : "";
    return `⚫ ${entry.targetCode} | DESATIVADA${reason}`;
}

function formatSection(title: string, count: number, lines: string[]) {
    if (count === 0) {
        return `${title} (0)`;
    }

    return [`${title} (${count})`, lines.join("\n")].join("\n");
}

function formatRegulationBlock(entries: OperationalSlotAuditEntry[]) {
    const occupied = sortAuditEntries(entries.filter((entry) => entry.status === "occupied"));
    const empty = sortAuditEntries(entries.filter((entry) => entry.status === "empty"));

    return [
        "☎️ Regulação",
        formatSection("✅ Com médico", occupied.length, occupied.map(formatRegulationOccupiedLine)),
        "",
        formatSection("⚪ Sem médico", empty.length, empty.map(formatRegulationEmptyLine)),
    ].join("\n");
}

function formatInterventionBlock(entries: OperationalSlotAuditEntry[]) {
    const occupied = sortAuditEntries(entries.filter((entry) => entry.status === "occupied"));
    const empty = sortAuditEntries(entries.filter((entry) => entry.status === "empty"));
    const disabled = sortAuditEntries(entries.filter((entry) => entry.status === "disabled"));

    return [
        "🚑 Intervenção",
        formatSection("✅ Com médico", occupied.length, occupied.map(formatInterventionOccupiedLine)),
        "",
        formatSection("🚨 Sem médico", empty.length, empty.map(formatInterventionEmptyLine)),
        ...(disabled.length > 0 ? ["", formatSection("⚫ DESATIVADAS", disabled.length, disabled.map(formatInterventionDisabledLine))] : []),
    ].join("\n");
}

function formatTurnSummary(slot: OperationalSlotAuditSlot) {
    const regulationOccupied = countEntries(slot.regulation, "occupied");
    const regulationEmpty = countEntries(slot.regulation, "empty");
    const interventionOccupied = countEntries(slot.intervention, "occupied");
    const interventionEmpty = countEntries(slot.intervention, "empty");

    return [
        `Resumo ${slot.shiftLabel}:`,
        `- Regulação ocupados: ${regulationOccupied}`,
        `- Regulação vazios: ${regulationEmpty}`,
        `- Intervenção ocupados: ${interventionOccupied}`,
        `- Intervenção vazios: ${interventionEmpty}`,
    ].join("\n");
}

function formatSlotBlock(slot: OperationalSlotAuditSlot) {
    const regulationEmpty = countEntries(slot.regulation, "empty");
    const interventionEmpty = countEntries(slot.intervention, "empty");

    return [
        `🕐 ${slot.shiftLabel} | ${formatDateLabel(slot.operationalDate)}`,
        `Postos ${slot.totalTargets} | alocados ${slot.occupiedCount} | vazios ${slot.emptyCount}`,
        ...(regulationEmpty > 0 || interventionEmpty > 0
            ? [[
                "🚨 Lacunas do turno:",
                `regulação ${regulationEmpty}`,
                `intervenção ${interventionEmpty}`,
            ].join(" ")]
            : []),
        "",
        formatRegulationBlock(slot.regulation),
        "",
        formatInterventionBlock(slot.intervention),
        "",
        formatTurnSummary(slot),
    ].join("\n");
}

export function buildTelegramSlotAuditMessages(report: OperationalSlotAuditReport) {
    const missing = summarizeMissingCounts(report);
    const header = report.startDate === report.endDate
        ? `🧭 Slots ${formatDateLabel(report.startDate)}${report.shiftLabel ? ` ${report.shiftLabel}` : ""}.`
        : `🧭 Slots ${formatDateLabel(report.startDate)} a ${formatDateLabel(report.endDate)}${report.shiftLabel ? ` ${report.shiftLabel}` : ""}.`;
    const summaryLines = [
        `Turnos ${report.summary.slotCount} | postos ${report.summary.totalTargets} | alocados ${report.summary.occupiedCount} | vazios ${report.summary.emptyCount}`,
        `☎️ Vazios Regulação: ${missing.regulation}`,
        `🚑 Vazios Intervenção: ${missing.intervention}`,
    ];

    const messages: string[] = [];
    let current = [header, ...summaryLines].join("\n");

    for (const slot of report.slots) {
        const block = formatSlotBlock(slot);
        const candidate = `${current}\n\n${block}`;
        if (candidate.length > TELEGRAM_MESSAGE_LIMIT) {
            messages.push(current);
            current = block;
            continue;
        }

        current = candidate;
    }

    if (current) {
        messages.push(current);
    }

    return messages;
}