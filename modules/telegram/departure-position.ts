/**
 * ADR-007 R5: o aviso de saída resolve pelo MÉDICO, não pelo alvo citado.
 *
 * Em 90 dias, 52 avisos de saída morreram em "No active occupancy found" porque
 * o médico citou o ramal/base de onde foi remanejado ou expulso. O aviso se
 * perdia e a saída ficava presumida. Aqui decidimos onde a saída se aplica:
 * o alvo citado, se o médico está (ou esteve há pouco) lá; senão, a posição
 * aberta dele; senão, a última posição fechada há pouco.
 */

export type DepartureSector = "REGULATION" | "INTERVENTION";

export interface DoctorPosition {
    sector: DepartureSector;
    code: string;
    startedAt: Date;
    /** Nulo = ainda aberta. */
    endedAt: Date | null;
}

/** Janela em que uma posição já fechada ainda aceita aviso de saída (mesma do bot). */
export const DEPARTURE_RECENT_CLOSED_WINDOW_MS = 18 * 60 * 60 * 1000;

export function pickDeparturePosition(params: {
    cited: { sector: DepartureSector; code: string };
    positions: DoctorPosition[];
    eventAt: Date;
}): { sector: DepartureSector; code: string; redirected: boolean } {
    const isCited = (p: DoctorPosition) => p.sector === params.cited.sector && p.code === params.cited.code;
    const recentlyClosed = (p: DoctorPosition) => p.endedAt !== null
        && Math.abs(params.eventAt.getTime() - p.endedAt.getTime()) <= DEPARTURE_RECENT_CLOSED_WINDOW_MS;

    // Citou onde está: nada a redirecionar.
    if (params.positions.some((p) => isCited(p) && p.endedAt === null)) {
        return { ...params.cited, redirected: false };
    }

    // Está em outro lugar (remanejado): a saída é de onde ele está, mesmo que
    // o alvo citado tenha fechado há pouco — fechou porque ele mudou.
    const open = params.positions
        .filter((p) => p.endedAt === null)
        .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
    if (open) {
        return { sector: open.sector, code: open.code, redirected: true };
    }

    // Sem posição aberta: o alvo citado fechado há pouco (rendição) vale, e o
    // fluxo existente trata como ajuste de saída.
    if (params.positions.some((p) => isCited(p) && recentlyClosed(p))) {
        return { ...params.cited, redirected: false };
    }

    const closed = params.positions
        .filter(recentlyClosed)
        .sort((a, b) => b.endedAt!.getTime() - a.endedAt!.getTime())[0];
    if (closed) {
        return { sector: closed.sector, code: closed.code, redirected: true };
    }

    return { ...params.cited, redirected: false };
}
