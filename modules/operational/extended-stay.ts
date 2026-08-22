import {
    EARLY_DEPARTURE_FULL_REMAINING_MINUTES,
    EARLY_DEPARTURE_HALF_THRESHOLD_MINUTES,
} from "@/modules/operational/early-departure";

/**
 * Permanência além do previsto — o espelho de classifyEarlyDeparture.
 *
 * A régua da chefia já decide a FALTA sem subjetividade: menos de 6h de janela
 * cumprida não assina plantão (vira crédito de banco); de 6h em diante assina
 * MEIO; faltando 2h ou menos para o fim assina INTEIRO. Faltava o mesmo para a
 * SOBRA, e essa ausência custou caro: quem ficava um turno inteiro a mais na
 * posição não tinha para onde ir a não ser o banco de horas, que devolvia a
 * permanência como crédito — em dobro, quando a chegada fora no horário.
 *
 * Aqui vale a mesma régua, no outro sentido. O que ela produz não é dinheiro
 * lançado sozinho: é a proposta objetiva de quantos plantões (inteiros e meios)
 * aquela permanência vale, para a chefia assinar na posição em que aconteceu.
 *
 * Consequência estrutural: o banco de horas ganha teto de 6h BRUTAS por plantão.
 * Acima disso a saída é a folha, nunca o crédito — o que torna irrepresentável
 * um bônus de 12h ou 23h nascido de uma janela agendada torta.
 */

/** Turno operacional: 07:00–19:00 / 19:00–07:00. */
export const OPERATIONAL_SHIFT_MINUTES = 12 * 60;

/**
 * Sobra a partir da qual a permanência deixa de ser banco e vira plantão.
 * É o mesmo 6h de EARLY_DEPARTURE_HALF_THRESHOLD_MINUTES: o que assina meio
 * plantão quando falta é o que assina meio plantão quando sobra.
 */
export const EXTENDED_STAY_HALF_THRESHOLD_MINUTES = EARLY_DEPARTURE_HALF_THRESHOLD_MINUTES;

/**
 * Sobra a partir da qual o plantão é inteiro: o turno completo menos a mesma
 * tolerância de 2h que a régua da falta usa para assinar inteiro (10h).
 */
export const EXTENDED_STAY_FULL_THRESHOLD_MINUTES =
    OPERATIONAL_SHIFT_MINUTES - EARLY_DEPARTURE_FULL_REMAINING_MINUTES;

export interface ExtendedStayClassification {
    /** Minutos além do fim previsto (0 quando saiu antes ou no horário). */
    overtimeMinutes: number;
    /** Plantões inteiros que a permanência sustenta. */
    fullShifts: number;
    /** 1 quando o resto chega a 6h sem chegar a 10h; senão 0. */
    halfShifts: number;
    /** Sobra que continua no banco de horas — sempre menor que 6h. */
    bankMinutes: number;
}

/**
 * Reparte a permanência entre folha e banco. Um turno inteiro de sobra vira um
 * plantão inteiro; o resto segue a régua dos 6h/10h; o que sobrar dela — sempre
 * abaixo de 6h — é a única parcela que o banco de horas ainda pode creditar.
 */
export function classifyExtendedStay(overtimeMinutes: number): ExtendedStayClassification {
    const overtime = Math.max(0, Math.trunc(overtimeMinutes));

    const fullShifts = Math.floor(overtime / OPERATIONAL_SHIFT_MINUTES);
    const rest = overtime - (fullShifts * OPERATIONAL_SHIFT_MINUTES);

    if (rest >= EXTENDED_STAY_FULL_THRESHOLD_MINUTES) {
        return { overtimeMinutes: overtime, fullShifts: fullShifts + 1, halfShifts: 0, bankMinutes: 0 };
    }

    if (rest >= EXTENDED_STAY_HALF_THRESHOLD_MINUTES) {
        return { overtimeMinutes: overtime, fullShifts, halfShifts: 1, bankMinutes: 0 };
    }

    return { overtimeMinutes: overtime, fullShifts, halfShifts: 0, bankMinutes: rest };
}

/** A permanência gera plantão a assinar (e portanto sai do banco de horas). */
export function isPayableExtendedStay(classification: ExtendedStayClassification) {
    return classification.fullShifts > 0 || classification.halfShifts > 0;
}

function formatShiftCount(count: number, singular: string, plural: string) {
    return `${count} ${count === 1 ? singular : plural}`;
}

/** Frase pronta para a tela e para o aviso: o que a chefia precisa assinar. */
export function describeExtendedStay(classification: ExtendedStayClassification) {
    const parts: string[] = [];
    if (classification.fullShifts > 0) {
        parts.push(formatShiftCount(classification.fullShifts, "plantão INTEIRO", "plantões INTEIROS"));
    }
    if (classification.halfShifts > 0) {
        parts.push(formatShiftCount(classification.halfShifts, "MEIO plantão", "MEIOS plantões"));
    }

    if (parts.length === 0) {
        return null;
    }

    return parts.join(" e ");
}
