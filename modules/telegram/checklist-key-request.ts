/**
 * Pedido de chave do checklist pelo médico — a ponta que faltava da integração:
 * o grupo recebe a chave junto da confirmação, mas quem perdia o balão (ou foi
 * remanejado pelo quadro) não tinha onde pedir. Agora tem: "/chave [BASE]" em
 * qualquer chat, e no PRIVADO também texto livre ("chave", "qual a chave?") e o
 * deep link t.me/<bot>?start=chave que os blocos de confirmação carregam.
 *
 * Princípios (pedido da coordenação, 2026-08-30):
 *   - ATENDER: quem pede recebe a chave — pela base dita na mensagem ou, sem
 *     base, pela posição do médico no quadro (nome do Telegram → médico →
 *     ocupação ativa).
 *   - ENSINAR: quando não dá, o bot diz exatamente por que não deu e qual é o
 *     próximo passo ("/chave SM01"), nunca silêncio nem erro seco.
 *   - AVISAR: todo pedido no privado gera aviso aos admins — quem pediu, qual
 *     base, o que o bot respondeu. A chave já circula aberta no grupo; o aviso
 *     é auditoria, não segredo.
 *
 * Aqui vivem só as partes puras (parse + copies + aviso); quem toca banco e
 * API é handleChecklistKeyRequest no service.ts.
 */

import { escapeTelegramMarkdown } from "@/modules/telegram/api";
import { parseMessage } from "@/modules/telegram/parser";

export type ChecklistKeyRequestVia = "command" | "start" | "text";

export interface ChecklistKeyRequest {
    via: ChecklistKeyRequestVia;
    baseCode: string | null;
    sector: "REGULATION" | "INTERVENTION" | null;
    /** Token tipo base (SM99/4 dígitos) que o parser NÃO reconheceu — só via command. */
    unknownTargetToken: string | null;
}

const COMMAND_PATTERN = /^\/chave(?:@\w+)?\b([\s\S]*)$/i;
const START_PATTERN = /^\/start(?:@\w+)?\s+chave\b/i;

// Texto livre só no privado e só frases curtas claramente sobre a chave — no
// grupo a palavra "chave" em conversa normal não pode virar resposta do bot, e
// no privado uma razão social com "Chave" no meio do cadastro de pagamento
// também não (o service ainda checa pendência de cadastro antes de responder).
const FREE_TEXT_MAX_LENGTH = 140;
const FREE_TEXT_PATTERNS = [
    /^CHAVE\b/,
    /\bQUAL (?:E |EH )?A CHAVE\b/,
    /\bCHAVE (?:DE HOJE|DO DIA|DO CHECKLIST|DA BASE|DA USA)\b/,
    /\b(?:PRECISO|PERDI|MANDA|ME PASSA|PASSA|PEGAR) (?:D?A )?CHAVE\b/,
];

function normalizeForKeyRequest(value: string) {
    return value.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

/**
 * Reconhece um pedido de chave. Comando "/chave [BASE]" vale em qualquer chat;
 * "/start chave" (deep link) e texto livre valem só no privado. Null = não é
 * pedido de chave, segue o fluxo normal.
 */
export function parseChecklistKeyRequest(text: string, chatType: string): ChecklistKeyRequest | null {
    const trimmed = (text ?? "").trim();
    if (!trimmed) return null;

    const commandMatch = trimmed.match(COMMAND_PATTERN);
    if (commandMatch) {
        const body = commandMatch[1]?.trim() ?? "";
        const parsed = body ? parseMessage(body) : null;
        return {
            via: "command",
            baseCode: parsed?.baseCode ?? null,
            sector: parsed?.sector ?? null,
            unknownTargetToken: parsed?.baseCode ? null : parsed?.unknownTargetToken ?? null,
        };
    }

    if (chatType !== "private") return null;

    if (START_PATTERN.test(trimmed)) {
        return { via: "start", baseCode: null, sector: null, unknownTargetToken: null };
    }

    if (trimmed.length > FREE_TEXT_MAX_LENGTH) return null;
    const normalized = normalizeForKeyRequest(trimmed);
    if (!FREE_TEXT_PATTERNS.some((re) => re.test(normalized))) return null;

    const parsed = parseMessage(trimmed);
    return {
        via: "text",
        baseCode: parsed.baseCode,
        sector: parsed.sector,
        unknownTargetToken: null,
    };
}

/** Como o bot descobriu (ou não) a base quando o pedido veio sem uma. */
export type ChecklistKeyIdentification =
    | { kind: "explicit" }
    | { kind: "board"; doctorName: string }
    | { kind: "no_doctor" }
    | { kind: "no_occupancy"; doctorName: string }
    | { kind: "regulation_occupancy"; doctorName: string; ramal: string };

function formatBaseList(knownBases: string[]) {
    return knownBases.join(" · ");
}

/** Chave em mãos: entrega + de onde veio a base + como pedir de novo. */
export function buildChecklistKeyDeliveryReply(params: {
    baseCode: string;
    key: string;
    identification: ChecklistKeyIdentification;
}): string {
    const lines: string[] = [];
    if (params.identification.kind === "board") {
        lines.push(`🧭 Te achei no quadro: *${escapeTelegramMarkdown(params.identification.doctorName)}* está em *${params.baseCode}*.`);
    }
    lines.push(
        `🔑 Chave de hoje de *${params.baseCode}*: *${params.key}*`,
        `📋 Registre o checklist em checklist.mnrs.com.br/b/${params.baseCode}`,
        "",
        `Precisou de novo, é só mandar */chave* (ou */chave ${params.baseCode}*) aqui, a qualquer hora.`,
    );
    return lines.join("\n");
}

/**
 * Sem base e sem como descobrir sozinho: pergunta a base ENSINANDO o formato e
 * dizendo por que não deu — nunca a recusa seca que deixava todo mundo sem
 * saber onde pedir.
 */
export function buildChecklistKeyAskBaseReply(params: {
    identification: ChecklistKeyIdentification;
    knownBases: string[];
    unknownToken?: string | null;
}): string {
    const lines: string[] = [];
    if (params.unknownToken) {
        lines.push(`🤔 Não reconheci *${escapeTelegramMarkdown(params.unknownToken)}* como base de intervenção.`);
    } else if (params.identification.kind === "no_occupancy") {
        lines.push(`🤔 *${escapeTelegramMarkdown(params.identification.doctorName)}*, não te encontrei em nenhuma base no quadro agora.`);
    } else if (params.identification.kind === "regulation_occupancy") {
        lines.push(
            `ℹ️ *${escapeTelegramMarkdown(params.identification.doctorName)}*, você está no ramal *${escapeTelegramMarkdown(params.identification.ramal)}* (regulação) — chave de checklist é das bases de intervenção (USA).`,
        );
    } else {
        lines.push("🤔 Não consegui te reconhecer pelo nome do Telegram para descobrir sua base.");
    }
    lines.push(
        "",
        "Me diga a base e eu te devolvo a chave na hora:",
        "*/chave SM01*",
        "",
        `Bases: ${formatBaseList(params.knownBases)}`,
    );
    return lines.join("\n");
}

/** Pediu chave de RAMAL: explica o escopo (chave é de USA) e ensina o certo. */
export function buildChecklistKeyRegulationTargetReply(ramal: string, knownBases: string[]): string {
    return [
        `ℹ️ *${escapeTelegramMarkdown(ramal)}* é ramal de regulação — o checklist (e a chave do dia) é das bases de intervenção (USA).`,
        "",
        "Se você está numa USA, manda: */chave SM01*",
        `Bases: ${formatBaseList(knownBases)}`,
    ].join("\n");
}

/** Serviço do checklist fora do ar: diz o que falhou, o que fazer e que a coordenação já sabe. */
export function buildChecklistKeyServiceDownReply(baseCode: string): string {
    return [
        `⚠️ O serviço do checklist não respondeu agora — não consegui puxar a chave de *${baseCode}*.`,
        "Não é nada que você fez: o app do checklist está fora do ar ou lento. Já avisei a coordenação.",
        "",
        `Tente de novo em instantes (*/chave ${baseCode}*) ou abra direto: checklist.mnrs.com.br/b/${baseCode}`,
    ].join("\n");
}

/** O app respondeu que não há chave hoje para a base: provável falha de cadastro lá. */
export function buildChecklistKeyMissingReply(baseCode: string): string {
    return [
        `⚠️ O app do checklist respondeu que *não há chave de hoje* para *${baseCode}*.`,
        "Avisei a coordenação para verificar o cadastro da base.",
        "",
        `Enquanto isso: checklist.mnrs.com.br/b/${baseCode}`,
    ].join("\n");
}

/** Ambiente sem a integração configurada (dev): honestidade em vez de silêncio. */
export function buildChecklistKeyUnconfiguredReply(): string {
    return "⚠️ A integração com o app do checklist não está configurada neste ambiente — aqui eu não tenho como buscar chaves.";
}

export type ChecklistKeyRequestOutcome =
    | "delivered"
    | "service_down"
    | "no_key"
    | "asked_base"
    | "regulation_target"
    | "unconfigured";

/**
 * Aviso aos admins (privado, texto puro — sendPrivateAdminAlert não usa
 * parse_mode): quem pediu, qual base, o que o bot respondeu. É a auditoria que
 * a coordenação pediu para o autoatendimento de chave.
 */
export function buildChecklistKeyAdminNotice(params: {
    senderName: string | null;
    senderUsername: string | null;
    senderTelegramId: string;
    requestText: string;
    baseCode: string | null;
    resolvedDoctorName: string | null;
    outcome: ChecklistKeyRequestOutcome;
}): string {
    const who = [
        params.senderName?.trim() || "(sem nome no Telegram)",
        params.senderUsername ? `@${params.senderUsername}` : null,
        `id ${params.senderTelegramId}`,
    ].filter(Boolean).join(" · ");

    const outcomeLine = {
        delivered: `entreguei a chave de hoje de ${params.baseCode}.`,
        service_down: `serviço do checklist FORA DO AR — não entreguei a chave de ${params.baseCode}.`,
        no_key: `app do checklist SEM chave de hoje para ${params.baseCode} — verificar o cadastro lá.`,
        asked_base: "não descobri a base; pedi para a pessoa informar (/chave BASE).",
        regulation_target: `o alvo era ramal de regulação (${params.baseCode}) — expliquei que chave é das USAs.`,
        unconfigured: "integração do checklist não configurada neste ambiente.",
    }[params.outcome];

    return [
        "🔑 Pedido de chave no privado do bot",
        `Quem: ${who}`,
        `Médico no cadastro: ${params.resolvedDoctorName ?? "não reconhecido pelo nome do Telegram"}`,
        `Resultado: ${outcomeLine}`,
        `Mensagem: "${params.requestText}"`,
    ].join("\n");
}
