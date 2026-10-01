/** Listas prontas e validação do MotivoChips — sem React, testável em node:test. */

export const MOTIVOS_ATRASO = ["Avisou antes da chegada", "Ficou na ocorrência", "Erro de registro"];
export const MOTIVOS_REMANEJO = ["Pedido da regulação", "Reforço na base", "Troca combinada"];
export const MOTIVOS_HORARIO = ["Horário informado errado", "Chegou antes e não avisou", "Saiu depois e não avisou"];

/** Motivo aceito: texto com pelo menos `minimo` caracteres úteis (padrão 8). */
export function motivoValido(valor: string, minimo = 8): boolean {
    return valor.trim().length >= minimo;
}
