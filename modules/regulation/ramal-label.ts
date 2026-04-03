export function normalizeRegulationRamalLabel(params: {
    actualPostCode: string;
    requestedRamalLabel?: string | null;
}) {
    const actualPostCode = params.actualPostCode.trim();
    const requestedRamalLabel = params.requestedRamalLabel?.trim() ?? null;

    if (!requestedRamalLabel) {
        return actualPostCode;
    }

    if (requestedRamalLabel !== actualPostCode) {
        throw new Error("O ramal exibido precisa coincidir com o posto real. Atualize a tela e use remanejamento para trocar de ramal.");
    }

    return actualPostCode;
}