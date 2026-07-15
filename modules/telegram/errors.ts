// Tradução de erros técnicos para o chat (auditoria comunicação §3.1#11 / §5#10):
// o grupo nunca deve receber `error.message` cru (às vezes em inglês). Três camadas:
//
//   1. TelegramUserFacingError — marcador para erros de negócio JÁ escritos para o
//      usuário (pt-BR, com ação). A instância passa direto para o chat.
//   2. Tabela de tradução — mensagens técnicas CONHECIDAS (inglês/sentinelas) viram
//      pt-BR com ação.
//   3. Allowlist — erros de negócio legados lançados como `Error` cru em outros
//      módulos (correções/remanejamento/pagamento) que já são user-facing em pt.
//      Comparação EXATA (ou prefixo curado para mensagens com interpolação), nunca
//      substring solta.
//
// Qualquer outra coisa vira uma mensagem curta fixa — o detalhe técnico já fica
// persistido em telegram_ingested_messages.error_message (e no log do processo).

/** Erro de negócio já escrito para o usuário final (pt-BR, com ação). */
export class TelegramUserFacingError extends Error {
    readonly telegramUserFacing = true;

    constructor(message: string) {
        super(message);
        this.name = "TelegramUserFacingError";
    }
}

export function isTelegramUserFacingError(error: unknown): error is TelegramUserFacingError {
    return error instanceof TelegramUserFacingError
        || Boolean(
            error
            && typeof error === "object"
            && (error as { telegramUserFacing?: unknown }).telegramUserFacing === true
            && typeof (error as { message?: unknown }).message === "string",
        );
}

/** Mensagem curta fixa para erro desconhecido (o técnico fica só no log). */
export const TELEGRAM_GENERIC_ERROR_TEXT =
    "Algo falhou do meu lado — o detalhe técnico ficou registrado. Tente de novo em instantes; se repetir, chame a chefia.";

// Mensagens técnicas conhecidas → pt-BR com ação.
const TELEGRAM_TECHNICAL_ERROR_TRANSLATIONS: Record<string, string> = {
    "Regulation post not found.": "Não encontrei esse ramal no cadastro. Confira o código e reenvie.",
    "Intervention base not found.": "Não encontrei essa base no cadastro. Confira o código e reenvie.",
    "Regulation occupancy not found.": "Não achei esse plantão — ele pode já ter sido removido. Atualize e tente de novo.",
    "Intervention occupancy not found.": "Não achei esse plantão — ele pode já ter sido removido. Atualize e tente de novo.",
    "No active regulation occupancy found for this doctor/post.":
        "Não achei plantão ativo desse médico nesse ramal. Confira o código e o nome antes de reenviar.",
    "No active intervention occupancy found for this doctor/base.":
        "Não achei plantão ativo desse médico nessa base. Confira o código e o nome antes de reenviar.",
    "Actual end cannot be before the recorded arrival.":
        "A saída informada ficou antes da chegada registrada. Reenvie com o horário certo.",
    "Only active regulation occupancies can be continued.":
        "Esse plantão já foi encerrado — registre uma chegada nova em vez de continuar.",
    "Only active intervention occupancies can be continued.":
        "Esse plantão já foi encerrado — registre uma chegada nova em vez de continuar.",
    "Only active regulation occupancies can be displaced.":
        "Esse plantão já foi encerrado — não há ninguém para deslocar nesse ramal.",
    "Only active intervention occupancies can be displaced.":
        "Esse plantão já foi encerrado — não há ninguém para deslocar nessa base.",
    "Board start cannot be before the recorded arrival.":
        "O horário do quadro entrou em conflito com a chegada registrada. Chame a chefia para ajustar.",
    "Board end cannot be before the board start.":
        "O horário final ficou antes do inicial. Confira os horários e reenvie.",
    "Board end cannot be before the recorded arrival.":
        "O horário final ficou antes da chegada registrada. Confira os horários e reenvie.",
    telegram_processing_failed: TELEGRAM_GENERIC_ERROR_TEXT,
};

// Erros de negócio legados (Error cru, pt) que JÁ são user-facing — passam direto.
const TELEGRAM_USER_FACING_MESSAGE_ALLOWLIST = new Set<string>([
    // Remanejamento / transferências (modules/operational + service.ts)
    "Medico nao tem ocupacao ativa para remanejar. Registre a chegada normalmente.",
    "Ramal de destino nao encontrado.",
    "Base de destino nao encontrada.",
    "Ramal PIAM nao cadastrado no sistema.",
    "Base de destino indisponivel para este remanejamento.",
    "Ramal de destino indisponivel para este remanejamento.",
    "Ramal de destino indisponivel para esta troca.",
    "Ramal de destino indisponivel para esta abertura.",
    "Escolha para onde o ocupante do destino deve ser remanejado.",
    "Escolha um destino diferente do posto/base atual para remanejar.",
    "O novo destino do ocupante atual nao pode ser o mesmo destino principal do remanejamento.",
    "So ocupacoes ativas podem ser remanejadas.",
    "Ocupação não encontrada — pode já ter sido removida.",
    "O ramal exibido precisa coincidir com o posto real. Atualize a tela e use remanejamento para trocar de ramal.",
    // Ativação/desativação de postos e bases
    "A reativacao nao pode ser anterior a desativacao.",
    "A reativação não pode ser anterior à desativação.",
    "Esta base já está desativada.",
    "Esta base não está desativada.",
    "Este ramal ja esta desativado.",
    "Este ramal nao esta desativado.",
    // Banco de horas / fechamento
    "Esse plantao ainda nao tem fechamento suficiente para ajuste manual do banco.",
    "Nao encontrei o grupo de continuidade desse plantao.",
    // Cadastro de médicos
    "Nome completo do medico invalido.",
]);

// Mensagens user-facing com interpolação (não dá comparação exata): prefixos curados.
const TELEGRAM_USER_FACING_MESSAGE_PREFIXES = [
    "Ja existe outro medico ativo com o nome ",
    "Nao encontrei um plantao ",
];

/** Tradução exata de uma mensagem técnica conhecida, ou null. */
export function translateTelegramErrorMessage(errorMessage: string | null | undefined): string | null {
    const trimmed = errorMessage?.trim();
    if (!trimmed) {
        return null;
    }
    return TELEGRAM_TECHNICAL_ERROR_TRANSLATIONS[trimmed] ?? null;
}

function isAllowlistedUserFacingMessage(message: string) {
    return TELEGRAM_USER_FACING_MESSAGE_ALLOWLIST.has(message)
        || TELEGRAM_USER_FACING_MESSAGE_PREFIXES.some((prefix) => message.startsWith(prefix));
}

/**
 * Converte um errorMessage (string) no texto que PODE ir para o chat:
 * tradução conhecida → allowlist pt → mensagem curta fixa. Nunca devolve o cru
 * de erro desconhecido.
 */
export function formatTelegramErrorForUser(errorMessage: string | null | undefined): string {
    const trimmed = errorMessage?.trim();
    if (!trimmed) {
        return TELEGRAM_GENERIC_ERROR_TEXT;
    }
    const translated = translateTelegramErrorMessage(trimmed);
    if (translated) {
        return translated;
    }
    if (isAllowlistedUserFacingMessage(trimmed)) {
        return trimmed;
    }
    return TELEGRAM_GENERIC_ERROR_TEXT;
}

/** Versão para catch sites que ainda têm a instância do erro em mãos. */
export function resolveTelegramErrorText(error: unknown): string {
    if (isTelegramUserFacingError(error)) {
        return error.message;
    }
    return formatTelegramErrorForUser(error instanceof Error ? error.message : null);
}
