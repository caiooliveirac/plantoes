import type { EarlyDepartureClassification, StoredEarlyDepartureOutcome } from "@/modules/operational/early-departure";

/**
 * Textos oficiais dos desfechos de retirada/saída antecipada.
 *
 * FONTE ÚNICA para o painel (aviso antes do chefe confirmar) e para o anúncio
 * do bot no grupo. O tom é da COORDENAÇÃO, não do robô: alterar redação = editar
 * este arquivo, nada é gerado dinamicamente além das interpolações de nome/hora.
 */

// Descrevem a DECISÃO, não a faixa da régua: no Retirar a chefia escolhe o
// desfecho, e "saída antes de 6h de janela" num meio plantão pago acima da
// régua sairia falso no grupo.
const OUTCOME_SUMMARIES: Record<StoredEarlyDepartureOutcome, string> = {
    no_balance: "{name} foi retirado sem saldo: não assina este plantão e não gera banco de horas.",
    bank_only: "{name} não assina este plantão. As horas trabalhadas viram crédito no banco de horas.",
    half_shift: "{name} assina MEIO plantão. O que passar de 6h trabalhadas vira crédito no banco de horas.",
    full_shift: "{name} assina o plantão inteiro.",
};

function interpolate(template: string, params: Record<string, string>) {
    return template.replace(/\{(\w+)\}/g, (_, key: string) => params[key] ?? "");
}

export function buildEarlyDepartureSummary(outcome: StoredEarlyDepartureOutcome, params: { name: string }) {
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
