"use client";

import { PREFIXO_MENSAGEM_CHEFE_OUTRO } from "@/modules/operational/chefe-de-plantao";

export const EVENTO_CHEFE_OUTRO = "mesa:chefe-de-plantao-outro";

/**
 * fetch da Mesa: igual ao fetch, mas quando o servidor responde 409 "O chefe
 * de plantão agora é Fulano…" (requireMesaEscrita) dispara um evento global
 * que o ModalChefeOutro escuta. O chamador segue tratando a resposta como
 * sempre (a mensagem continua no corpo); o modal é a camada por cima.
 */
export async function fetchMesa(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const response = await fetch(input, init);
    if (response.status === 409 && typeof window !== "undefined") {
        try {
            const corpo = await response.clone().json() as { error?: unknown };
            const mensagem = typeof corpo?.error === "string" ? corpo.error : "";
            if (mensagem.startsWith(PREFIXO_MENSAGEM_CHEFE_OUTRO)) {
                window.dispatchEvent(new CustomEvent(EVENTO_CHEFE_OUTRO, { detail: { mensagem } }));
            }
        } catch {
            // corpo não é JSON: não é a trava
        }
    }
    return response;
}
