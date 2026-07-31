// Comandos de admin que gravam o papel preferido do medico
// (doctors.metadata.preferredOperationalRole): /piam e /psiq.
// Mesmo fluxo, textos diferentes — PIAM ainda tem auto-alocacao de ramal na
// chegada; PSIQ so carimba a funcao (painel, refeicao e perfil de pagamento).

export interface TelegramRoleCommandConfig {
    command: "piam" | "psiq";
    role: "PIAM" | "PSIQ";
    usage: string;
    listEmptyText: string;
    listHeading: (count: number) => string;
    assignReply: (fullName: string) => string;
    unassignReply: (fullName: string) => string;
    alreadyAssignedText: (fullName: string) => string;
    alreadyUnassignedText: (fullName: string) => string;
}

export const TELEGRAM_ROLE_COMMANDS: Record<"piam" | "psiq", TelegramRoleCommandConfig> = {
    piam: {
        command: "piam",
        role: "PIAM",
        usage: "/piam Nome do medico  |  /piam remover Nome do medico  |  /piam listar",
        listEmptyText: "Nenhum cardiologista PIAM cadastrado. Use `/piam Nome` para marcar.",
        listHeading: (count) => `🩺 Cardiologistas PIAM (${count}):`,
        assignReply: (fullName) =>
            `✅ ${fullName} marcado como cardiologista PIAM. A partir de agora, ao avisar SD/SN/dia/noite, o bot aloca automaticamente no ramal PIAM (07:00 às 19:00 ou 19:00 às 07:00).`,
        unassignReply: (fullName) => `✅ ${fullName} desmarcado de PIAM. Volta a ser lançado normalmente.`,
        alreadyAssignedText: (fullName) => `${fullName} ja estava marcado como PIAM.`,
        alreadyUnassignedText: (fullName) => `${fullName} ja nao tinha role PIAM.`,
    },
    psiq: {
        command: "psiq",
        role: "PSIQ",
        usage: "/psiq Nome do medico  |  /psiq remover Nome do medico  |  /psiq listar",
        listEmptyText: "Nenhum psiquiatra cadastrado. Use `/psiq Nome` para marcar.",
        listHeading: (count) => `🧠 Psiquiatras (${count}):`,
        assignReply: (fullName) =>
            `✅ ${fullName} marcado como psiquiatra (PSIQ). A partir de agora a chegada dela(e) já entra com a função PSIQ, o pagamento usa a tabela de psiquiatria e ela(e) fica fora da divisão automática do almoço (12:30 e 18:00 fixos). O ramal continua sendo o que for informado na chegada.`,
        unassignReply: (fullName) => `✅ ${fullName} desmarcado de PSIQ. Volta a ser lançado normalmente.`,
        alreadyAssignedText: (fullName) => `${fullName} ja estava marcado como PSIQ.`,
        alreadyUnassignedText: (fullName) => `${fullName} ja nao tinha role PSIQ.`,
    },
};

const TELEGRAM_ROLE_COMMAND_PREFIX = /^\/(piam|psiq)(?:@\w+)?\b/i;

export type ParsedTelegramRoleCommand = {
    config: TelegramRoleCommandConfig;
    rawBody: string;
} & (
    | { action: "assign"; lookup: string }
    | { action: "unassign"; lookup: string }
    | { action: "list" }
);

export function isTelegramRoleCommandText(text: string) {
    return TELEGRAM_ROLE_COMMAND_PREFIX.test(text.trim());
}

export function resolveTelegramRoleCommandConfig(text: string) {
    const match = text.trim().match(TELEGRAM_ROLE_COMMAND_PREFIX);
    if (!match) {
        return null;
    }
    return TELEGRAM_ROLE_COMMANDS[match[1].toLowerCase() as "piam" | "psiq"];
}

export function parseTelegramRoleCommand(text: string): ParsedTelegramRoleCommand | null {
    const match = text.trim().match(/^\/(piam|psiq)(?:@\w+)?\s*([\s\S]*)$/i);
    if (!match) {
        return null;
    }

    const config = TELEGRAM_ROLE_COMMANDS[match[1].toLowerCase() as "piam" | "psiq"];
    const rawBody = match[2]?.trim() ?? "";
    if (!rawBody) {
        return null;
    }

    const lowered = rawBody.toLowerCase();
    if (lowered === "listar" || lowered === "list" || lowered === "ls") {
        return { config, action: "list", rawBody };
    }

    const removeMatch = rawBody.match(/^(?:remover|remove|rm|tirar|desmarcar)\s+([\s\S]+)$/i);
    if (removeMatch) {
        const lookup = removeMatch[1].trim();
        if (!lookup) {
            return null;
        }
        return { config, action: "unassign", lookup, rawBody };
    }

    return { config, action: "assign", lookup: rawBody, rawBody };
}
