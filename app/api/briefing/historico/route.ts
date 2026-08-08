/**
 * Histórico de um turno para o secretário (app `tom`).
 *
 * Responde "quem assumiu a CC70 anteontem" — pergunta que o briefing de agora
 * não alcança, porque ele só sabe do plantão em curso.
 *
 * Só LEITURA e nenhuma regra nova: sai de getHistoricalOperationalBoard, o
 * mesmo read model da tela de histórico. Aqui o payload é enxuto porque quem
 * consome entrega no WhatsApp: uma linha por posto/base, com quem estava,
 * quando entrou e quando saiu.
 *
 * TURNO É OBRIGATÓRIO junto com a data — regra do próprio serviço. Um dia tem
 * dois turnos (SD e SN) e "anteontem" não diz qual; quem pergunta é que decide,
 * e o `tom` pergunta de volta antes de chamar aqui.
 */
import { NextRequest, NextResponse } from "next/server";

import { guardBriefingRequest } from "@/lib/briefing/token";
import { getHistoricalOperationalBoard } from "@/services/operational-history.service";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
    const recusa = guardBriefingRequest(request);
    if (recusa) {
        return recusa;
    }

    const date = request.nextUrl.searchParams.get("date");
    const shift = request.nextUrl.searchParams.get("shift");

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return NextResponse.json({ error: "date must use YYYY-MM-DD." }, { status: 400 });
    }
    if (shift !== "SD" && shift !== "SN") {
        return NextResponse.json({ error: "shift must be SD or SN." }, { status: 400 });
    }

    try {
        const board = await getHistoricalOperationalBoard({ operationalDate: date, shiftLabel: shift });
        const linha = (dominio: "regulation" | "intervention") => (row: {
            targetCode: string;
            targetLabel: string;
            state: string;
            doctorName: string | null;
            displayName: string | null;
            roleLabel: string | null;
            arrivalAt: string | null;
            departureAt: string | null;
            arrivalDelayMinutes: number | null;
            disabledReason: string | null;
        }) => ({
            dominio,
            code: row.targetCode,
            label: row.targetLabel,
            estado: row.state,
            // O nome curto é como o coordenador conhece o médico; o completo fica
            // de reserva para quando o cadastro não tem o curto.
            doctorName: row.displayName ?? row.doctorName,
            roleLabel: row.roleLabel,
            arrivalAt: row.arrivalAt,
            departureAt: row.departureAt,
            atrasoMin: row.arrivalDelayMinutes,
            motivo: row.disabledReason,
        });

        return NextResponse.json({
            operationalDate: board.dateKey,
            shiftLabel: board.shiftLabel,
            linhas: [
                ...board.intervention.map(linha("intervention")),
                ...board.regulation.map(linha("regulation")),
            ],
        });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Unable to load historical operational board." },
            { status: 400 },
        );
    }
}
