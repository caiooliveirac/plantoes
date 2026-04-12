import { parseMessage } from "@/modules/telegram/parser";

export type TelegramCommandName = "corrigir" | "retirar" | "remover" | "ramal" | "ativar" | "desativar" | "ontem" | "hoje" | "corrigirsaida";

const DEPARTURE_COMMAND_ALIASES = new Set(["saiu", "saindo", "saida", "saída"]);
const TELEGRAM_DEPARTURE_CORRECTION_COMMAND_PREFIX = /^\/corrigirsaida(?:@\w+)?\b\s*([\s\S]*)$/i;

export interface ParsedTelegramCommand {
    name: TelegramCommandName;
    sector: "REGULATION" | "INTERVENTION";
    targetCode: string;
    doctorName: string | null;
    time: string | null;
    shiftLabel: "SD" | "SN" | "P" | null;
    roleLabel: string | null;
    rawBody: string;
    isDeparture: boolean;
}

export interface ParsedTelegramDepartureCorrectionCommand {
    name: "corrigirsaida";
    doctorName: string | null;
    targetCode: string | null;
    sector: "REGULATION" | "INTERVENTION" | null;
    rawBody: string;
}

export function isTelegramAdminOnlyCommand(name: TelegramCommandName) {
    return name === "remover" || name === "ativar" || name === "desativar";
}

export function isTelegramDepartureCorrectionCommandText(text: string) {
    return TELEGRAM_DEPARTURE_CORRECTION_COMMAND_PREFIX.test(text.trim());
}

export function parseTelegramDepartureCorrectionCommand(text: string): ParsedTelegramDepartureCorrectionCommand | null {
    const match = text.trim().match(TELEGRAM_DEPARTURE_CORRECTION_COMMAND_PREFIX);
    if (!match) {
        return null;
    }

    const rawBody = match[1]?.trim() ?? "";
    if (!rawBody) {
        return null;
    }

    const parsed = parseMessage(rawBody);
    const targetCode = parsed.baseCode ?? null;
    const doctorName = parsed.extractedNames[0]
        ?? (targetCode
            ? rawBody.replace(new RegExp(`\\b${targetCode}\\b`, "i"), " ").trim() || null
            : rawBody.trim() || null);

    if (!doctorName) {
        return null;
    }

    return {
        name: "corrigirsaida",
        doctorName,
        targetCode,
        sector: parsed.sector,
        rawBody,
    };
}

export function parseTelegramCommand(text: string): ParsedTelegramCommand | null {
    const match = text.trim().match(/^\/(corrigir|retirar|remover|ramal|ativar|desativar|saiu|saindo|saida|saída|ontem|hoje)\b\s*([\s\S]*)$/i);
    if (!match) {
        return null;
    }

    const rawCommandName = match[1].toLowerCase();
    const name = DEPARTURE_COMMAND_ALIASES.has(rawCommandName) ? "retirar" : rawCommandName as TelegramCommandName;
    const rawBody = match[2]?.trim() ?? "";
    const parsed = parseMessage(rawBody);

    if (!parsed.sector || !parsed.baseCode) {
        return null;
    }

    return {
        name,
        sector: parsed.sector,
        targetCode: parsed.baseCode,
        doctorName: parsed.extractedNames[0] ?? null,
        time: parsed.arrivalTime,
        shiftLabel: parsed.shiftType,
        roleLabel: parsed.roleFunction,
        rawBody,
        isDeparture: parsed.isDeparture || DEPARTURE_COMMAND_ALIASES.has(rawCommandName),
    };
}