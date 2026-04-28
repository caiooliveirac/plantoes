import { NextRequest } from "next/server";
import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { exportMonthlyAdminReportCsv } from "@/services/monthly-report.service";
import { exportChiefPayableShiftsXlsx } from "@/services/payable-shifts.service";

export async function GET(request: NextRequest) {
    if (!hasDatabaseUrl()) {
        return new Response("DATABASE_URL is not configured for operations-v2.", { status: 503 });
    }

    try {
        await requireAuthenticatedSession(["admin"]);
    } catch (error) {
        const status = error instanceof AuthError ? error.status : 500;
        return new Response(error instanceof Error ? error.message : "Unauthorized.", { status });
    }

    const month = request.nextUrl.searchParams.get("month");
    const format = request.nextUrl.searchParams.get("format") === "csv" ? "csv" : "xlsx";
    const fileName = `relatorio-mensal-${month || "atual"}.${format}`;

    if (format === "csv") {
        const csv = await exportMonthlyAdminReportCsv(month);

        return new Response(csv, {
            status: 200,
            headers: {
                "content-type": "text/csv; charset=utf-8",
                "content-disposition": `attachment; filename="${fileName}"`,
            },
        });
    }

    const workbook = await exportChiefPayableShiftsXlsx(month);

    return new Response(workbook, {
        status: 200,
        headers: {
            "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "content-disposition": `attachment; filename="${fileName}"`,
        },
    });
}