import type { EarlyDepartureClassification, EarlyDepartureOutcome } from "@/modules/operational/early-departure";

/**
 * Textos oficiais dos desfechos de retirada/saída antecipada.
 *
 * FONTE ÚNICA para o painel (aviso antes do chefe confirmar) e para o anúncio
 * do bot no grupo. O tom é da COORDENAÇÃO, não do robô: alterar redação = editar
 * este arquivo, nada é gerado dinamicamente além das interpolações de nome/hora.
 */

const OUTCOME_SUMMARIES: Record<EarlyDepartureOutcome, string> = {
    bank_only: "Saída antes de 6h de janela: {name} não assina este plantão. As horas trabalhadas viram crédito no banco de horas.",
    half_shift: "Saída entre 6h e 10h de janela: {name} assina MEIO plantão. O que passar de 6h vira crédito no banco de horas.",
    full_shift: "Faltam menos de 2h para o fim da janela: {name} assina o plantão inteiro.",
};

function interpolate(template: string, params: Record<string, string>) {
    return template.replace(/\{(\w+)\}/g, (_, key: string) => params[key] ?? "");
}

export function buildEarlyDepartureSummary(outcome: EarlyDepartureOutcome, params: { name: string }) {
    return interpolate(OUTCOME_SUMMARIES[outcome], params);
}

function formatHoursShort(minutes: number) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours === 0) {
        return `${rest}min`;
    }
    return rest === 0 ? `${hours}h` : `${hours}h${String(rest).padStart(2, "0")}`;
}

/** Complemento numérico curto ("crédito de 2h no banco") quando houver crédito. */
export function buildEarlyDepartureCreditNote(classification: EarlyDepartureClassification) {
    if (classification.outcome === "full_shift" || classification.bankCreditMinutes <= 0) {
        return null;
    }
    return `Crédito de ${formatHoursShort(classification.bankCreditMinutes)} no banco de horas.`;
}
