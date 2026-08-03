/**
 * fetch que desiste em vez de pendurar a tela.
 *
 * Em 2026-08-03 o pool do banco (max=1) ficou preso numa transação e toda
 * requisição passou a enfileirar. O admin clicou em "Adicionar plantão" e o
 * botão ficou em "Adicionando..." indefinidamente — sem erro, sem retorno, sem
 * pista do que estava acontecendo. A causa foi corrigida, mas a tela não pode
 * depender disso: qualquer indisponibilidade futura tem que virar mensagem, não
 * um botão travado para sempre.
 */

/** Tempo de espera padrão. Acima disso, algo está errado do outro lado. */
export const LIMITE_PADRAO_MS = 20_000;

export class TempoEsgotadoError extends Error {
    constructor(ms: number) {
        super(
            `O servidor não respondeu em ${Math.round(ms / 1000)}s. A ação pode não ter sido aplicada —`
            + " recarregue a página e confira antes de tentar de novo.",
        );
        this.name = "TempoEsgotadoError";
    }
}

export async function fetchComLimite(
    input: string,
    init: RequestInit = {},
    limiteMs = LIMITE_PADRAO_MS,
): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limiteMs);
    try {
        return await fetch(input, { ...init, signal: controller.signal });
    } catch (error) {
        // A mensagem de abort do navegador não diz nada a quem está usando.
        if (error instanceof DOMException && error.name === "AbortError") {
            throw new TempoEsgotadoError(limiteMs);
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }
}
