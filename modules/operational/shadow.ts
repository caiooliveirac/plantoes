/**
 * Sombra: o médico que acompanha o titular no mesmo ramal/base sem assumi-lo.
 *
 * Módulo folha, sem acesso a banco — é importado pelos dois domínios (regulação e
 * intervenção) e por modules/operational/corrections.ts. A detecção em todo o
 * sistema é por MARCADOR NAS NOTAS, não por coluna: uma ocupação é sombra quando as
 * notas trazem "[telegram sombra]", "[sombra]" ou a palavra solta.
 */

const ADMIN_SHADOW_MARKER = "[sombra]";

export function operationalNotesIndicateShadow(notes: string | null | undefined) {
    const normalized = (notes ?? "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toUpperCase();
    return normalized.includes("[TELEGRAM SOMBRA]") || /\bSOMBRA\b/.test(normalized);
}

// Ajusta as notas para refletir o status de sombra desejado, de forma idempotente.
// asShadow=true  garante um marcador de sombra; asShadow=false remove marcadores e
// o token "sombra"/"shadow" solto (a detecção em todo o sistema é por notas).
export function applyShadowMarkerToOccupancyNotes(notes: string | null | undefined, asShadow: boolean): string | null {
    const base = (notes ?? "").trim();
    if (asShadow) {
        return operationalNotesIndicateShadow(base) ? (base || null) : `${ADMIN_SHADOW_MARKER} ${base}`.trim();
    }
    const cleaned = base
        .replace(/\[telegram sombra\]/gi, "")
        .replace(/\[sombra\]/gi, "")
        .replace(/\bsombras?\b/gi, "")
        .replace(/\bshadow\b/gi, "")
        .replace(/[ \t]{2,}/g, " ")
        .replace(/^[\s\-–—]+|[\s\-–—]+$/g, "")
        .trim();
    return cleaned.length > 0 ? cleaned : null;
}

/**
 * A sombra assumiu de fato o posto/base e foi redeclarada sem a palavra "sombra":
 * ela vira titular NO LUGAR, sem ocupação nova — o quadro passa a ser dela, o
 * marcador sai das notas e a chegada original é preservada.
 *
 * Sem isto a sombra não tem saída pelo Telegram: como sombra nunca assume o quadro
 * (resolveRegulationArrivalBoardPolicy), redeclarar caía no caminho de re-chegada,
 * que preserva board nulo, e nada acontecia.
 *
 * As duas guardas que não podem cair:
 *   - deslocado NÃO é sombra promovível: quem perdeu o quadro numa tomada volta
 *     declarando uma posição nova, não reassumindo esta;
 *   - com outro titular no quadro, promover violaria o índice único de um board por
 *     alvo (23505 cru). Nesse caso a ocupação segue sombra, coexistindo.
 */
export function shouldPromoteShadowToBoardOnRearrival(params: {
    existingHasBoard: boolean;
    existingIsShadow: boolean;
    existingIsDisplaced: boolean;
    arrivingIsShadow: boolean;
    hasOtherBoardCarrier: boolean;
}) {
    return !params.existingHasBoard
        && params.existingIsShadow
        && !params.existingIsDisplaced
        && !params.arrivingIsShadow
        && !params.hasOtherBoardCarrier;
}

/**
 * Notas da re-chegada. O caminho normal anexa a mensagem nova às antigas. Na
 * promoção o resultado ainda precisa sair limpo: as notas antigas trazem o
 * marcador de sombra e é ele que o sistema inteiro consulta — se ficasse, a
 * ocupação promovida continuaria sendo lida como sombra no painel e no pagamento.
 */
export function resolveRearrivalNotes(params: {
    existingNotes: string | null | undefined;
    incomingNotes: string | null | undefined;
    promotingShadow: boolean;
}): string | null {
    const merged = params.incomingNotes
        ? `${params.existingNotes ?? ""}\n${params.incomingNotes}`.trim()
        : (params.existingNotes ?? null);
    return params.promotingShadow ? applyShadowMarkerToOccupancyNotes(merged, false) : merged;
}
