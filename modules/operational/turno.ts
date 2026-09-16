import { resolveOperationalShiftWindow } from "@/modules/operational/board-rules";

/**
 * ADR-007 R1: o turno do médico (médico × slot SD/SN) é a unidade. Toda
 * chegada dele dentro do mesmo turno, ou encostada na virada, entra no grupo
 * de continuidade aberto dele — em qualquer ramal, base ou domínio.
 *
 * Duas portas de entrada:
 *   - mesmo slot: a chegada anterior e esta caem na mesma janela de 12h.
 *     Chegada até 60 min antes da virada conta como o turno seguinte (decisão
 *     2 do ADR: 06:4x no ramal errado é posição do SD);
 *   - contiguidade: a posição anterior ainda está aberta ou fechou há no
 *     máximo 30 min (a tolerância do P na virada). Cobre o "continua na SM01
 *     SN" às 19:09 que hoje quebra o grupo.
 */
export const TURNO_EARLY_ARRIVAL_TOLERANCE_MS = 60 * 60 * 1000;
export const TURNO_CONTIGUITY_TOLERANCE_MS = 30 * 60 * 1000;

/** Janela de 12h em que uma chegada "pertence", com a tolerância de chegada antecipada. */
export function resolveTurnoWindowStart(at: Date): number {
    const window = resolveOperationalShiftWindow(at);
    if (window.nextBoundaryAt.getTime() - at.getTime() <= TURNO_EARLY_ARRIVAL_TOLERANCE_MS) {
        return window.nextBoundaryAt.getTime();
    }
    return window.startedAt.getTime();
}

export function shouldJoinDoctorTurnoGroup(params: {
    previousStartedAt: Date;
    /** Nulo = posição ainda aberta. */
    previousEndedAt: Date | null;
    arrivalAt: Date;
}): boolean {
    if (params.arrivalAt.getTime() < params.previousStartedAt.getTime()) {
        return false;
    }
    if (params.previousEndedAt === null) {
        return true;
    }
    if (params.arrivalAt.getTime() - params.previousEndedAt.getTime() <= TURNO_CONTIGUITY_TOLERANCE_MS) {
        return true;
    }
    return resolveTurnoWindowStart(params.previousStartedAt) === resolveTurnoWindowStart(params.arrivalAt);
}
