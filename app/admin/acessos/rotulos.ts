/* Rótulos em português das telas do monitor de acessos (lista e relatório). */

const NOME_DO_PAPEL: Record<string, string> = {
    admin: "admin",
    chief: "chefe",
    doctor: "médico",
    payment_closing_limited: "fechamento",
    portal: "só portal",
    radio_operador: "rádio-operador",
};

export const NOME_DO_NIVEL = { forte: "Forte", atencao: "Atenção", normal: "Normal" } as const;
export const NOME_DA_FORCA = { forte: "Forte", moderado: "Moderado", fraco: "Fraco" } as const;
export const NOME_DO_ACHADO = { forte: "Forte", atencao: "Atenção", info: "Informação" } as const;

export const NOME_DA_ORIGEM: Record<string, string> = {
    login: "e-mail e senha no Plantões",
    portal: "portal mnrs.com.br",
    escala: "app Escalas",
    cadastro: "cadastro de médico",
    anterior: "login anterior ao monitor",
    portal_cookie: "login do portal (Tabela e outros)",
};

export const NOME_DA_SITUACAO = { aberta: "aberta agora", inativa: "parada", encerrada: "encerrada" } as const;

export function papeisDaConta(papeis: string[]) {
    return papeis.map((papel) => NOME_DO_PAPEL[papel] ?? papel).join(", ") || "sem papel";
}

/** Classe de cor do chip do aparelho: A, B, C… em 6 cores. */
export function classeDoLado(lado: string | null) {
    return lado ? `ac-lado l${(lado.charCodeAt(0) - 65) % 6}` : "ac-lado l5";
}
