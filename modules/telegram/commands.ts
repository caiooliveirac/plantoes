import { parseMessage } from "@/modules/telegram/parser";

export type TelegramCommandName = "corrigir" | "retirar" | "remover";

const DEPARTURE_COMMAND_ALIASES = new Set(["saiu", "saindo", "saida", "saída"]);

export interface ParsedTelegramCommand {
    name: TelegramCommandName;
    sector: "REGULATION" | "INTERVENTION";
    targetCode: string;
    doctorName: string | null;
    time: string | null;
    rawBody: string;
    isDeparture: boolean;
}

export function parseTelegramCommand(text: string): ParsedTelegramCommand | null {
    const match = text.trim().match(/^\/(corrigir|retirar|remover|saiu|saindo|saida|saída)\b\s*([\s\S]*)$/i);
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
        rawBody,
        isDeparture: parsed.isDeparture || DEPARTURE_COMMAND_ALIASES.has(rawCommandName),
    };
}