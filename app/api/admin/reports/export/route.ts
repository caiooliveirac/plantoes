import { NextRequest } from "next/server";
import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
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
    // O CSV da antiga tela "Relatório mensal" saiu com ela; fica o XLSX do fechamento.
    const fileName = `relatorio-mensal-${month || "atual"}.xlsx`;

    const workbook = await exportChiefPayableShiftsXlsx(month);

    return new Response(workbook, {
        status: 200,
        headers: {
            "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "content-disposition": `attachment; filename="${fileName}"`,
        },
    });
}