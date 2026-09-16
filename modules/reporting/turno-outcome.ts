/**
 * ADR-007 R4 (modo sombra): o desfecho de saída antecipada é do TURNO, não do
 * pedaço. Em 90 dias, 4 turnos com 10h+ presentes tiveram um pedaço curto
 * julgado como "só banco"/"meio" (Kêmylla 2154 1 min, João CB02 3 min, Vaner
 * 2154 37 min, Maria BR05). Aqui calculamos o que a régua diria olhando a
 * presença POSICIONADA somada do médico no slot (decisão 1 do ADR), para
 * comparar com o desfecho gravado no pedaço. Enquanto for sombra, só marca.
 */

export type TurnoOutcome = "full_shift" | "half_shift" | "bank_only";

export interface TurnoPiece {
    occupancyId: string;
    startedAt: string | Date | null;
    endedAt: string | Date | null;
}

const FULL_MIN = 10 * 60;
const HALF_MIN = 6 * 60;

function toMs(v: string | Date | null | undefined) {
    if (!v) return null;
    const ms = (v instanceof Date ? v : new Date(v)).getTime();
    return Number.isNaN(ms) ? null : ms;
}

/** Minutos de presença posicionada do médico dentro do slot, somando os pedaços. */
export function sumPositionedMinutesInSlot(pieces: TurnoPiece[], slotStartAt: string | Date, slotEndAt: string | Date) {
    const slotStart = toMs(slotStartAt)!;
    const slotEnd = toMs(slotEndAt)!;
    let total = 0;
    for (const piece of pieces) {
        const start = toMs(piece.startedAt);
        const end = toMs(piece.endedAt) ?? slotEnd;
        if (start === null) continue;
        const overlap = Math.min(end, slotEnd) - Math.max(start, slotStart);
        if (overlap > 0) total += overlap;
    }
    return Math.round(total / 60000);
}

export function classifyTurnoPresence(positionedMinutes: number): TurnoOutcome {
    if (positionedMinutes >= FULL_MIN) return "full_shift";
    if (positionedMinutes >= HALF_MIN) return "half_shift";
    return "bank_only";
}

export interface TurnoOutcomeShadow {
    positionedMinutes: number;
    turnoOutcome: TurnoOutcome;
    /** true quando esta linha é o último pedaço do médico no slot. */
    isTail: boolean;
    /** Texto para o fechamento quando a régua por turno divergiria do pedaço; nulo se concordam. */
    divergence: string | null;
}

/**
 * Compara o desfecho gravado no pedaço com o que a régua por turno diria.
 * Só aponta divergência onde o pagamento mudaria de fato:
 *   - pedaço com corte (bank_only/half) num turno que somou 10h+: o corte cairia;
 *   - pedaço com corte que não é o último do turno: o desfecho pertence ao fim;
 *   - turno com menos de 6h posicionadas sem corte gravado: viraria só banco.
 * A faixa de 6h–10h sem desfecho gravado não é apontada: hoje o chefe já
 * decide inteiro/meio ali, e apontar viraria ruído.
 */
export function resolveTurnoOutcomeShadow(params: {
    row: TurnoPiece & { earlyDepartureOutcome: string | null };
    pieces: TurnoPiece[];
    slotStartAt: string | Date;
    slotEndAt: string | Date;
}): TurnoOutcomeShadow {
    const positionedMinutes = sumPositionedMinutesInSlot(params.pieces, params.slotStartAt, params.slotEndAt);
    const turnoOutcome = classifyTurnoPresence(positionedMinutes);
    const rowEnd = toMs(params.row.endedAt) ?? Number.POSITIVE_INFINITY;
    const isTail = params.pieces.every((p) => (toMs(p.endedAt) ?? Number.POSITIVE_INFINITY) <= rowEnd);
    const rowCut = params.row.earlyDepartureOutcome === "bank_only" || params.row.earlyDepartureOutcome === "half_shift";
    const h = `${Math.floor(positionedMinutes / 60)}h${String(positionedMinutes % 60).padStart(2, "0")}`;

    let divergence: string | null = null;
    if (rowCut && turnoOutcome === "full_shift") {
        divergence = `Turno somou ${h} posicionadas em ${params.pieces.length} posições; por turno pagaria inteiro, não ${params.row.earlyDepartureOutcome}.`;
    } else if (rowCut && !isTail) {
        divergence = `Corte (${params.row.earlyDepartureOutcome}) gravado num pedaço que não é o fim do turno (${h} posicionadas).`;
    } else if (!rowCut && turnoOutcome === "bank_only" && positionedMinutes > 0) {
        divergence = `Turno somou só ${h} posicionadas; por turno seria só banco.`;
    }

    return { positionedMinutes, turnoOutcome, isTail, divergence };
}
