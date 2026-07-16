// Confirmação por botão dos dados fiscais (razão social + CNPJ) já conhecidos
// pela prefeitura, importados da planilha oficial de médicos PJ.
//
// Quando o médico chega no passo "razão social" do /pagamento cadastro e já
// existe uma sugestão importada, o bot oferece "Está certo" / "Corrigir" em vez
// de pedir para digitar do zero. Aqui ficam só os helpers PUROS (sem I/O); o
// handler com efeito (DB + Telegram) vive em modules/telegram/service.ts.

/** Prefixo curto do callback_data (limite de 64 bytes do Telegram). */
export const FISCAL_SUGGESTION_CALLBACK_PREFIX = "pjF";

export function buildFiscalSuggestionCallbackData(confirm: boolean) {
    return `${FISCAL_SUGGESTION_CALLBACK_PREFIX}:${confirm ? "y" : "n"}`;
}

/** Decodifica o callback_data; retorna null se não for um botão desta feature. */
export function parseFiscalSuggestionCallbackData(data: string | null | undefined): boolean | null {
    if (!data) {
        return null;
    }

    const parts = data.split(":");
    if (parts.length !== 2 || parts[0] !== FISCAL_SUGGESTION_CALLBACK_PREFIX) {
        return null;
    }

    if (parts[1] === "y") {
        return true;
    }
    if (parts[1] === "n") {
        return false;
    }
    return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export interface FiscalSuggestion {
    razaoSocial: string;
    cnpj: string;
}

/**
 * Sugestão só é oferecida se o médico ainda não confirmou dados fiscais (fluxo
 * de primeira vez) e a sugestão importada da planilha está completa.
 */
export function resolveFiscalSuggestion(metadata: unknown): FiscalSuggestion | null {
    if (!isPlainObject(metadata)) {
        return null;
    }

    const alreadyConfirmed = typeof metadata.razaoSocial === "string" && metadata.razaoSocial.trim().length > 0
        && typeof metadata.cnpj === "string" && metadata.cnpj.trim().length > 0;
    if (alreadyConfirmed) {
        return null;
    }

    const razaoSocial = typeof metadata.suggestedRazaoSocial === "string" ? metadata.suggestedRazaoSocial.trim() : "";
    const cnpj = typeof metadata.suggestedCnpj === "string" ? metadata.suggestedCnpj.trim() : "";
    if (!razaoSocial || !cnpj) {
        return null;
    }

    return { razaoSocial, cnpj };
}
