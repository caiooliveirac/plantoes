import ExcelJS from "exceljs";
import type { ChiefPayableBoardModel } from "@/modules/reporting/payable-shifts";

function setHeaderStyle(row: ExcelJS.Row) {
    row.font = { bold: true, color: { argb: "FFF3F5F7" } };
    row.alignment = { vertical: "middle", horizontal: "center" };
    row.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF1A2532" },
    };
    row.border = {
        bottom: { style: "thin", color: { argb: "FF45586D" } },
    };
}

function autoSize(worksheet: ExcelJS.Worksheet, min = 10, max = 42) {
    worksheet.columns.forEach((column) => {
        let width = min;
        column.eachCell?.({ includeEmpty: true }, (cell) => {
            width = Math.max(width, String(cell.value ?? "").length + 2);
        });
        column.width = Math.min(width, max);
    });
}

function encodeCellShifts(tags: Array<{ tagCode: string; shiftLabel: "SD" | "SN" }>) {
    if (tags.length === 0) {
        return "";
    }

    return tags.map((tag) => `${tag.tagCode}${tag.shiftLabel}`).join(" | ");
}

function buildMainSheet(workbook: ExcelJS.Workbook, board: ChiefPayableBoardModel) {
    const sheet = workbook.addWorksheet("Pagamento", {
        views: [{ state: "frozen", xSplit: 2, ySplit: 1 }],
    });

    const baseHeader = ["Médico", "Status"];
    const dayHeaders = board.days.map((day) => day);
    const tailHeader = ["Total SD", "Total SN", "Total", "Pendências", "Observações"];
    const header = sheet.addRow([...baseHeader, ...dayHeaders, ...tailHeader]);
    setHeaderStyle(header);

    for (const doctor of board.doctors) {
        // O board carrega o quadro inteiro para a tela; a planilha do mês só
        // quer quem deu plantão.
        if (doctor.cells.every((cell) => cell.shifts.length === 0)) {
            continue;
        }

        const encodedDays = doctor.cells.map((cell) => encodeCellShifts(cell.shifts));
        const row = sheet.addRow([
            doctor.doctorName,
            doctor.paymentStatus === "ready_for_payment" ? "Pronto" : "Revisar",
            ...encodedDays,
            doctor.totalSD,
            doctor.totalSN,
            doctor.total,
            doctor.pendingCount,
            doctor.pendingCount > 0 ? "Conferir auditoria técnica" : "",
        ]);

        const statusCell = row.getCell(2);
        if (doctor.paymentStatus === "ready_for_payment") {
            statusCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF123122" } };
            statusCell.font = { bold: true, color: { argb: "FFD8FFEB" } };
        } else {
            statusCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF3A1820" } };
            statusCell.font = { bold: true, color: { argb: "FFFFD8DD" } };
        }

        row.eachCell((cell, col) => {
            if (col <= 2 || col > (2 + board.days.length)) {
                return;
            }
            cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
        });
    }

    autoSize(sheet, 10, 34);
}

function buildLegendSheet(workbook: ExcelJS.Workbook) {
    const sheet = workbook.addWorksheet("Legenda");
    sheet.addRow(["Formato célula", "Significado"]);
    setHeaderStyle(sheet.getRow(1));
    sheet.addRow(["PM04SD", "Base PM04 no turno diurno"]);
    sheet.addRow(["BR60SN", "Base BR60 no turno noturno"]);
    sheet.addRow(["CRUSD", "Ramal/regulação no turno diurno"]);
    sheet.addRow(["PM04SD | BR05SN", "Dois plantões no mesmo dia"]);
    autoSize(sheet, 14, 46);
}

export async function buildChiefMonthlyPayableWorkbook(board: ChiefPayableBoardModel) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "GitHub Copilot";
    workbook.created = new Date();
    workbook.modified = new Date();
    workbook.subject = `Pagamento mensal ${board.monthKey}`;
    workbook.title = `Pagamento mensal ${board.monthLabel}`;

    buildMainSheet(workbook, board);
    buildLegendSheet(workbook);

    return workbook.xlsx.writeBuffer();
}
