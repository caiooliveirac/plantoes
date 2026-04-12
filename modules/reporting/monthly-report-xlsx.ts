import ExcelJS from "exceljs";
import { formatMinutesForHumans, type MonthlyReportAuditEntry, type MonthlyReportDoctorGroup, type MonthlyReportModel, type MonthlyReportPaymentStatus, type MonthlyReportShift } from "@/modules/reporting/monthly-report";

function formatDateTime(value: string | null) {
    if (!value) {
        return "--";
    }

    return new Intl.DateTimeFormat("pt-BR", {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: "America/Sao_Paulo",
    }).format(new Date(value));
}

function formatDomain(domain: MonthlyReportShift["domain"]) {
    return domain === "regulation" ? "Regulação" : "Intervenção";
}

function formatPaymentStatus(status: MonthlyReportPaymentStatus) {
    return status === "ready_for_payment" ? "Pronto para pagar" : "Revisar";
}

function formatAuditAction(action: string) {
    const dictionary: Record<string, string> = {
        "intervention_occupancy.started": "Plantão aberto",
        "intervention_occupancy.ended": "Plantão encerrado",
        "intervention_occupancy.corrected": "Plantão corrigido",
        "intervention_occupancy.departure_reported": "Saída reportada",
        "intervention_occupancy.continuation_confirmed": "Continuidade confirmada",
        "regulation_occupancy.started": "Plantão aberto",
        "regulation_occupancy.ended": "Plantão encerrado",
        "regulation_occupancy.corrected": "Plantão corrigido",
    };

    return dictionary[action] ?? action;
}

function extractAuditNote(entry: MonthlyReportAuditEntry) {
    const notes = entry.details.notes;
    return typeof notes === "string" && notes.trim() ? notes.trim() : "";
}

function setHeaderStyle(row: ExcelJS.Row) {
    row.font = { bold: true, color: { argb: "FFF3F5F7" } };
    row.alignment = { vertical: "middle", horizontal: "center" };
    row.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF1C2530" },
    };
    row.border = {
        bottom: { style: "thin", color: { argb: "FF425164" } },
    };
}

function setKpiCard(cell: ExcelJS.Cell, tone: "neutral" | "ok" | "warn" | "danger") {
    const palette = {
        neutral: { fill: "FF14202D", font: "FFF3F5F7" },
        ok: { fill: "FF123122", font: "FFD8FFEB" },
        warn: { fill: "FF3A2814", font: "FFFFE2B5" },
        danger: { fill: "FF3A1820", font: "FFFFD8DD" },
    }[tone];

    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: palette.fill } };
    cell.font = { bold: true, size: 16, color: { argb: palette.font } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
    cell.border = {
        top: { style: "thin", color: { argb: "FF425164" } },
        left: { style: "thin", color: { argb: "FF425164" } },
        bottom: { style: "thin", color: { argb: "FF425164" } },
        right: { style: "thin", color: { argb: "FF425164" } },
    };
}

function applyStatusCellStyle(cell: ExcelJS.Cell, status: MonthlyReportPaymentStatus) {
    const isReady = status === "ready_for_payment";
    cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: isReady ? "FF123122" : "FF3A1820" },
    };
    cell.font = {
        bold: true,
        color: { argb: isReady ? "FFD8FFEB" : "FFFFD8DD" },
    };
    cell.alignment = { vertical: "middle", horizontal: "center" };
}

function autoSize(worksheet: ExcelJS.Worksheet, min = 12, max = 42) {
    worksheet.columns.forEach((column) => {
        let width = min;
        if (!column) {
            return;
        }

        column.eachCell?.({ includeEmpty: true }, (cell) => {
            width = Math.max(width, String(cell.value ?? "").length + 2);
        });
        column.width = Math.min(width, max);
    });
}

function buildSummarySheet(workbook: ExcelJS.Workbook, model: MonthlyReportModel) {
    const sheet = workbook.addWorksheet("Resumo", {
        views: [{ state: "frozen", ySplit: 6 }],
    });

    sheet.mergeCells("A1:H1");
    sheet.getCell("A1").value = `Relatório mensal SAMU · ${model.monthLabel}`;
    sheet.getCell("A1").font = { bold: true, size: 18, color: { argb: "FFF3F5F7" } };
    sheet.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF10161F" } };
    sheet.getCell("A1").alignment = { vertical: "middle", horizontal: "left" };

    sheet.mergeCells("A2:H2");
    sheet.getCell("A2").value = `Janela: ${formatDateTime(model.range.startIso)} até ${formatDateTime(model.range.endIso)}`;
    sheet.getCell("A2").font = { color: { argb: "FFAEB8C6" } };

    const kpiLabels = [
        ["Plantões prontos", model.summary.readyForPaymentCount, "ok"],
        ["Plantões em revisão", model.summary.needsReviewCount, model.summary.needsReviewCount > 0 ? "danger" : "neutral"],
        ["Médicos prontos", model.summary.doctorsReadyForPaymentCount, "ok"],
        ["Médicos com pendência", model.summary.doctorsNeedsReviewCount, model.summary.doctorsNeedsReviewCount > 0 ? "warn" : "neutral"],
    ] as const;

    kpiLabels.forEach(([label, value, tone], index) => {
        const columnStart = index * 2 + 1;
        sheet.mergeCells(4, columnStart, 4, columnStart + 1);
        sheet.mergeCells(5, columnStart, 5, columnStart + 1);
        sheet.getCell(4, columnStart).value = label;
        sheet.getCell(4, columnStart).font = { bold: true, color: { argb: "FFAEB8C6" } };
        sheet.getCell(5, columnStart).value = value;
        setKpiCard(sheet.getCell(5, columnStart), tone);
    });

    const header = sheet.addRow([
        "Status",
        "Médico",
        "Plantões",
        "Pendências",
        "Corrigidos",
        "Manuais",
        "Trabalhado",
        "Saldo",
    ]);
    setHeaderStyle(header);

    for (const group of model.groups) {
        const row = sheet.addRow([
            formatPaymentStatus(group.paymentStatus),
            group.doctorName,
            group.shiftCount,
            group.inconsistentShiftCount,
            group.correctedShiftCount,
            group.manualShiftCount,
            formatMinutesForHumans(group.workedMinutes),
            formatMinutesForHumans(group.balanceMinutes),
        ]);
        applyStatusCellStyle(row.getCell(1), group.paymentStatus);
    }

    autoSize(sheet);
    return sheet;
}

function buildDoctorsSheet(workbook: ExcelJS.Workbook, groups: MonthlyReportDoctorGroup[]) {
    const sheet = workbook.addWorksheet("Médicos", {
        views: [{ state: "frozen", ySplit: 1 }],
    });

    const header = sheet.addRow([
        "Status",
        "Médico",
        "Nome completo",
        "Plantões",
        "Pendências",
        "Corrigidos",
        "Manuais",
        "Trabalhado",
        "Saldo",
    ]);
    setHeaderStyle(header);
    sheet.autoFilter = {
        from: "A1",
        to: "I1",
    };

    for (const group of groups) {
        const row = sheet.addRow([
            formatPaymentStatus(group.paymentStatus),
            group.doctorName,
            group.doctorName,
            group.shiftCount,
            group.inconsistentShiftCount,
            group.correctedShiftCount,
            group.manualShiftCount,
            formatMinutesForHumans(group.workedMinutes),
            formatMinutesForHumans(group.balanceMinutes),
        ]);
        applyStatusCellStyle(row.getCell(1), group.paymentStatus);
    }

    autoSize(sheet);
    return sheet;
}

function buildShiftsSheet(workbook: ExcelJS.Workbook, model: MonthlyReportModel) {
    const sheet = workbook.addWorksheet("Plantões", {
        views: [{ state: "frozen", ySplit: 1 }],
    });

    const header = sheet.addRow([
        "Status",
        "Médico",
        "Domínio",
        "Código",
        "Local",
        "Entrada",
        "Entrada quadro",
        "Saída",
        "Saída efetiva",
        "Previsto",
        "Trabalhado",
        "Saldo",
        "Origem",
        "Auditorias",
        "Pendências",
        "Observações",
    ]);
    setHeaderStyle(header);
    sheet.autoFilter = {
        from: "A1",
        to: "P1",
    };

    for (const group of model.groups) {
        for (const shift of group.shifts) {
            const row = sheet.addRow([
                formatPaymentStatus(shift.paymentStatus),
                group.doctorName,
                formatDomain(shift.domain),
                shift.targetCode,
                shift.targetLabel,
                formatDateTime(shift.startedAt),
                formatDateTime(shift.boardStartedAt),
                formatDateTime(shift.endedAt),
                formatDateTime(shift.actualEndedAt),
                `${formatDateTime(shift.scheduledStartAt)} até ${formatDateTime(shift.scheduledEndAt)}`,
                formatMinutesForHumans(shift.workedMinutes),
                formatMinutesForHumans(shift.balanceMinutes),
                shift.source,
                shift.auditTrail.length,
                shift.inconsistencies.join(" | "),
                shift.notes ?? "",
            ]);
            applyStatusCellStyle(row.getCell(1), shift.paymentStatus);
        }
    }

    autoSize(sheet);
    return sheet;
}

function buildPendingSheet(workbook: ExcelJS.Workbook, model: MonthlyReportModel) {
    const sheet = workbook.addWorksheet("Pendências", {
        views: [{ state: "frozen", ySplit: 1 }],
    });

    const header = sheet.addRow([
        "Médico",
        "Código",
        "Local",
        "Domínio",
        "Status",
        "Pendência",
        "Entrada",
        "Saída",
        "Saldo",
        "Obs",
    ]);
    setHeaderStyle(header);
    sheet.autoFilter = {
        from: "A1",
        to: "J1",
    };

    for (const group of model.groups) {
        for (const shift of group.shifts.filter((item) => item.paymentStatus === "needs_review")) {
            for (const issue of shift.inconsistencies) {
                const row = sheet.addRow([
                    group.doctorName,
                    shift.targetCode,
                    shift.targetLabel,
                    formatDomain(shift.domain),
                    formatPaymentStatus(shift.paymentStatus),
                    issue,
                    formatDateTime(shift.startedAt),
                    formatDateTime(shift.endedAt),
                    formatMinutesForHumans(shift.balanceMinutes),
                    shift.notes ?? "",
                ]);
                applyStatusCellStyle(row.getCell(5), shift.paymentStatus);
            }
        }
    }

    autoSize(sheet);
    return sheet;
}

function buildAuditSheet(workbook: ExcelJS.Workbook, model: MonthlyReportModel) {
    const sheet = workbook.addWorksheet("Auditoria", {
        views: [{ state: "frozen", ySplit: 1 }],
    });

    const header = sheet.addRow([
        "Médico",
        "Código",
        "Local",
        "Ação",
        "Quando",
        "Ator",
        "Observação",
    ]);
    setHeaderStyle(header);
    sheet.autoFilter = {
        from: "A1",
        to: "G1",
    };

    for (const group of model.groups) {
        for (const shift of group.shifts) {
            for (const entry of shift.auditTrail) {
                sheet.addRow([
                    group.doctorName,
                    shift.targetCode,
                    shift.targetLabel,
                    formatAuditAction(entry.action),
                    formatDateTime(entry.createdAt),
                    entry.actorEmail ?? "sistema",
                    extractAuditNote(entry),
                ]);
            }
        }
    }

    autoSize(sheet);
    return sheet;
}

export async function buildMonthlyReportWorkbook(model: MonthlyReportModel) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "GitHub Copilot";
    workbook.created = new Date();
    workbook.modified = new Date();
    workbook.subject = `Relatório mensal ${model.monthKey}`;
    workbook.title = `Relatório mensal ${model.monthLabel}`;

    buildSummarySheet(workbook, model);
    buildDoctorsSheet(workbook, model.groups);
    buildShiftsSheet(workbook, model);
    buildPendingSheet(workbook, model);
    buildAuditSheet(workbook, model);

    return workbook.xlsx.writeBuffer();
}