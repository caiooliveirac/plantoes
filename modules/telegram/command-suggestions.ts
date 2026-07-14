import { looksLikeDepartureMessage, MEAL_BREAK_KEYWORDS, parseMessage } from "@/modules/telegram/parser";

export interface TelegramRecentSenderMessage {
    rawText: string;
    parsedAction?: string | null;
    parsedTargetCode?: string | null;
    parsedDoctorName?: string | null;
    status?: string | null;
    errorMessage?: string | null;
}

export interface TelegramCommandSuggestion {
    label: string;
    usage: string;
}

export interface TelegramCommandSuggestionResult {
    kind: "recip" | "departure" | "correction" | "meal_break" | "short_reply";
    intro: string;
    suggestions: TelegramCommandSuggestion[];
}

// Detecta menção a jantar (JANTAR/JANTA/JANTANDO...) para escolher /jantar em vez
// de /almoço — mesma tolerância a typo do parser (MEAL_BREAK_KEYWORDS).
const DINNER_KEYWORD = /\bJANT\w{0,5}\b/;

const SHORT_REPLY_PATTERNS = new Set([
    "1",
    "2",
    "3",
    "CONFIRMO",
    "CONFIRMADO",
    "CONFIRMA",
    "OK",
    "CANCELAR",
    "CANCELA",
]);

function normalizeFreeText(value: string) {
    return value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toUpperCase()
        .replace(/\s+/g, " ")
        .trim();
}

function buildArrivalRoleExample(params: {
    doctorName?: string | null;
    target?: string | null;
    time?: string | null;
    shiftLabel?: string | null;
    roleLabel?: string | null;
}) {
    const doctorName = params.doctorName?.trim() || "Nome Sobrenome";
    const target = params.target?.trim() || "2153";
    const time = params.time?.trim() || "08:03";
    const shiftLabel = params.shiftLabel?.trim() || "SD";
    const roleLabel = params.roleLabel?.trim() || "RECIP";
    return `Chegada ${doctorName} ${target} às ${time} ${shiftLabel} ${roleLabel}`;
}

function buildDepartureExample(params: {
    doctorName?: string | null;
    target?: string | null;
    time?: string | null;
}) {
    const doctorName = params.doctorName?.trim() || "Nome Sobrenome";
    const target = params.target?.trim() || "IT30";
    const time = params.time?.trim() || "07:50";
    // Sem justificativa no exemplo genérico: saída normal não precisa de motivo
    // (auditoria comunicação §3.1#16).
    return `${doctorName} saindo ${target} ${time}`;
}

function resolveLatestContext(recentMessages: TelegramRecentSenderMessage[]) {
    for (const entry of recentMessages) {
        const normalized = normalizeFreeText(entry.rawText);
        if (normalized.includes("RECIP")) {
            return "recip" as const;
        }

        if ((entry.parsedAction ?? "").startsWith("meal_break") || MEAL_BREAK_KEYWORDS.test(normalized)) {
            return "meal_break" as const;
        }

        if ((entry.parsedAction ?? "").includes("departure") || looksLikeDepartureMessage(entry.rawText)) {
            return "departure" as const;
        }

        if (normalized.startsWith("/CORRIGIR")) {
            return "correction" as const;
        }
    }

    return null;
}

function resolveSeedFields(text: string, recentMessages: TelegramRecentSenderMessage[]) {
    const parsed = parseMessage(text);
    const latest = recentMessages[0] ?? null;
    const latestParsed = latest ? parseMessage(latest.rawText) : null;

    return {
        doctorName: parsed.extractedNames[0] ?? latest?.parsedDoctorName ?? latestParsed?.extractedNames[0] ?? "Nome Sobrenome",
        target: parsed.baseCode ?? latest?.parsedTargetCode ?? latestParsed?.baseCode ?? "2153",
        time: parsed.arrivalTime ?? latestParsed?.arrivalTime ?? null,
        shiftLabel: parsed.shiftType ?? latestParsed?.shiftType ?? null,
    };
}

function suggestRecip(text: string, recentMessages: TelegramRecentSenderMessage[]): TelegramCommandSuggestionResult {
    const seed = resolveSeedFields(text, recentMessages);
    return {
        kind: "recip",
        intro: "Parece que você quer declarar ou ajustar um recipiendário.",
        suggestions: [
            {
                label: "Declarar o RECIP já na chegada",
                usage: buildArrivalRoleExample({
                    doctorName: seed.doctorName,
                    target: seed.target,
                    time: seed.time,
                    shiftLabel: seed.shiftLabel,
                    roleLabel: "RECIP",
                }),
            },
            {
                label: "Trocar só a função do ramal já lançado",
                usage: `/ramal ${seed.doctorName} ${seed.target} RECIP`,
            },
        ],
    };
}

function suggestDeparture(text: string, recentMessages: TelegramRecentSenderMessage[]): TelegramCommandSuggestionResult {
    const seed = resolveSeedFields(text, recentMessages);
    return {
        kind: "departure",
        intro: "Parece que você quer registrar ou corrigir uma saída.",
        suggestions: [
            {
                label: "Registrar a saída real com justificativa escrita",
                usage: buildDepartureExample({
                    doctorName: seed.doctorName,
                    target: seed.target,
                    time: seed.time,
                }),
            },
            {
                label: "Se a saída já existe e você quer revisar o plantão certo",
                usage: `/corrigirsaida ${seed.doctorName} ${seed.target}`,
            },
        ],
    };
}

function suggestCorrection(text: string, recentMessages: TelegramRecentSenderMessage[]): TelegramCommandSuggestionResult {
    const seed = resolveSeedFields(text, recentMessages);
    return {
        kind: "correction",
        intro: "Parece que você quer corrigir um lançamento já feito.",
        suggestions: [
            {
                label: "Corrigir só o horário do plantão já ativo",
                usage: `/corrigir ${seed.target} ${seed.time ?? "16:30"}`,
            },
            {
                label: "Corrigir médico e horário no mesmo alvo",
                usage: `/corrigir ${seed.target} ${seed.doctorName} ${seed.time ?? "16:30"}`,
            },
        ],
    };
}

function suggestMealBreak(text: string, recentMessages: TelegramRecentSenderMessage[]): TelegramCommandSuggestionResult {
    const normalized = normalizeFreeText(text);
    const recentText = recentMessages.map((entry) => normalizeFreeText(entry.rawText)).join(" ");
    const isNight = DINNER_KEYWORD.test(normalized) || DINNER_KEYWORD.test(recentText);
    const command = isNight ? "/jantar" : "/almoço";
    return {
        kind: "meal_break",
        intro: "Parece resposta da divisão de refeição, mas fora do formato.",
        suggestions: [
            {
                label: "Abrir novamente a divisão atual",
                usage: command,
            },
            {
                label: "Reiniciar a divisão e começar do zero",
                usage: `${command} reiniciar`,
            },
        ],
    };
}

function suggestShortReply(text: string, recentMessages: TelegramRecentSenderMessage[]): TelegramCommandSuggestionResult {
    const context = resolveLatestContext(recentMessages);
    if (context === "recip") {
        return suggestRecip(text, recentMessages);
    }
    if (context === "departure") {
        return suggestDeparture(text, recentMessages);
    }
    if (context === "correction") {
        return suggestCorrection(text, recentMessages);
    }
    if (context === "meal_break") {
        return suggestMealBreak(text, recentMessages);
    }

    return {
        kind: "short_reply",
        intro: "Parece resposta a uma pergunta minha, mas não encontrei pendência aberta agora.",
        suggestions: [
            {
                label: "Ver o relato do turno atual",
                usage: "/plantao",
            },
            {
                label: "Ver um resumo rápido da operação",
                usage: "/resumo",
            },
        ],
    };
}

export function suggestTelegramCommandHelp(params: {
    text: string;
    recentMessages?: TelegramRecentSenderMessage[];
}): TelegramCommandSuggestionResult | null {
    const text = params.text.trim();
    const normalized = normalizeFreeText(text);
    const recentMessages = params.recentMessages ?? [];
    const partial = parseMessage(text);

    if (!text) {
        return null;
    }

    if (normalized.includes("RECIP")) {
        return suggestRecip(text, recentMessages);
    }

    if (normalized.startsWith("/CORRIGIR") && normalized !== "/CORRIGIRSAIDA" && !partial.baseCode) {
        return suggestCorrection(text, recentMessages);
    }

    if (
        normalized.startsWith("/SAIDA")
        || normalized.startsWith("/SAIU")
        || normalized.startsWith("/RETIRAR")
        || normalized.includes("LIBERADO CHEFIA")
        || normalized.includes("LIBERADO PELA CHEFIA")
        || (looksLikeDepartureMessage(text) && Boolean(partial.baseCode || recentMessages[0]?.parsedTargetCode))
    ) {
        return suggestDeparture(text, recentMessages);
    }

    if (MEAL_BREAK_KEYWORDS.test(normalized) || normalized.startsWith("/CANCELAR")) {
        return suggestMealBreak(text, recentMessages);
    }

    if (SHORT_REPLY_PATTERNS.has(normalized)) {
        return suggestShortReply(text, recentMessages);
    }

    return null;
}

// Emoji semântico por tipo de sugestão (auditoria §2): 🍽️ refeição, ⚠️ ação do usuário.
const SUGGESTION_PREFIX: Record<TelegramCommandSuggestionResult["kind"], string> = {
    recip: "⚠️",
    departure: "⚠️",
    correction: "⚠️",
    meal_break: "🍽️",
    short_reply: "⚠️",
};

export function buildTelegramCommandSuggestionReply(result: TelegramCommandSuggestionResult) {
    const lines = [
        `${SUGGESTION_PREFIX[result.kind] ?? "⚠️"} ${result.intro}`,
        "",
        "Se era isso que você quis dizer, use um destes formatos:",
    ];

    for (const [index, suggestion] of result.suggestions.slice(0, 2).entries()) {
        lines.push(`${index + 1}. ${suggestion.label}`);
        lines.push(`   ${suggestion.usage}`);
    }

    return lines.join("\n");
}