// Botões inline das pendências de REGISTRO (Onda 2 da auditoria de comunicação §6):
// F6 sem turno (pending_shift_selection), candidatos de nome (pending_name_selection),
// PIAM SD/SN (pending_piam_shift) e COI 1367/1368 (pending_cru_coi_ramal).
//
// Aqui vivem apenas helpers PUROS (sem I/O), testáveis isoladamente — mesmo padrão
// de continuity-revert.ts: codificação/decodificação de callback_data, montagem de
// teclados, cópias dos prompts, validação de quem toca e decisão de reabertura de
// pendência por resposta curta. O handler com efeito (DB + Telegram) vive em
// modules/telegram/service.ts (dispatcher handleTelegramCallbackQuery).

import {
    buildInlineKeyboard,
    escapeTelegramMarkdown,
    type TelegramInlineKeyboardMarkup,
} from "@/modules/telegram/api";
import { computeLevenshteinDistance } from "@/modules/telegram/departure-flow";

// ── callback_data ──────────────────────────────────────────────────────────────────
// Formato geral: `<prefixo>:<valor>:<logId>`. O logId é o UUID da linha em
// telegram_ingested_messages que guarda a pendência (36 chars) — o total fica em
// ~42-46 bytes, abaixo do limite de 64 bytes do Telegram. O handler SEMPRE valida o
// id contra o registro (status + chat + autor) antes de aplicar qualquer coisa.

export const SHIFT_SELECTION_CALLBACK_PREFIX = "f6";
export const NAME_SELECTION_CALLBACK_PREFIX = "nm";
export const PIAM_SHIFT_CALLBACK_PREFIX = "pi";
export const COI_RAMAL_CALLBACK_PREFIX = "coi";
export const TAKEOVER_CALLBACK_PREFIX = "tk";
export const DEPARTURE_JUSTIFICATION_CALLBACK_PREFIX = "dj";
export const DESTINATION_SELECTION_CALLBACK_PREFIX = "dst";
export const RESET_ALL_CALLBACK_PREFIX = "rta";

export const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;

export type PendingShiftChoice = "SD" | "SN" | "P";

/** logId aceito no callback_data: UUID (ou fragmento hex) — nunca texto livre. */
const CALLBACK_LOG_ID_RE = /^[0-9a-fA-F-]{8,36}$/;

function isValidCallbackLogId(value: string | undefined): value is string {
    return Boolean(value && CALLBACK_LOG_ID_RE.test(value));
}

function fitsCallbackDataLimit(data: string) {
    // callback_data é medido em BYTES; os nossos payloads são ASCII puro, mas
    // medimos por Buffer para não depender disso.
    return Buffer.byteLength(data, "utf8") <= TELEGRAM_CALLBACK_DATA_MAX_BYTES;
}

/** `f6:SD:<logId>` — completa a chegada F6 que veio sem turno. */
export function buildShiftSelectionCallbackData(shift: PendingShiftChoice, logId: string) {
    const data = `${SHIFT_SELECTION_CALLBACK_PREFIX}:${shift}:${logId}`;
    if (!isValidCallbackLogId(logId) || !fitsCallbackDataLimit(data)) {
        throw new Error(`Invalid shift selection callback data: ${data}`);
    }
    return data;
}

export interface ParsedShiftSelectionCallback {
    shift: PendingShiftChoice;
    logId: string;
}

export function parseShiftSelectionCallbackData(data: string | null | undefined): ParsedShiftSelectionCallback | null {
    if (!data) return null;
    const parts = data.split(":");
    if (parts.length !== 3 || parts[0] !== SHIFT_SELECTION_CALLBACK_PREFIX) return null;
    const shift = parts[1];
    if (shift !== "SD" && shift !== "SN" && shift !== "P") return null;
    if (!isValidCallbackLogId(parts[2])) return null;
    return { shift, logId: parts[2] };
}

/** `nm:<posição 1..3>:<logId>` — escolhe um candidato de nome da pendência. */
export function buildNameSelectionCallbackData(position: number, logId: string) {
    const data = `${NAME_SELECTION_CALLBACK_PREFIX}:${position}:${logId}`;
    if (!Number.isInteger(position) || position < 1 || position > 3
        || !isValidCallbackLogId(logId) || !fitsCallbackDataLimit(data)) {
        throw new Error(`Invalid name selection callback data: ${data}`);
    }
    return data;
}

export interface ParsedNameSelectionCallback {
    position: number;
    logId: string;
}

export function parseNameSelectionCallbackData(data: string | null | undefined): ParsedNameSelectionCallback | null {
    if (!data) return null;
    const parts = data.split(":");
    if (parts.length !== 3 || parts[0] !== NAME_SELECTION_CALLBACK_PREFIX) return null;
    const position = Number(parts[1]);
    if (!Number.isInteger(position) || position < 1 || position > 3) return null;
    if (!isValidCallbackLogId(parts[2])) return null;
    return { position, logId: parts[2] };
}

/** `pi:SD:<logId>` — responde a pergunta binária do PIAM. */
export function buildPiamShiftCallbackData(shift: "SD" | "SN", logId: string) {
    const data = `${PIAM_SHIFT_CALLBACK_PREFIX}:${shift}:${logId}`;
    if (!isValidCallbackLogId(logId) || !fitsCallbackDataLimit(data)) {
        throw new Error(`Invalid PIAM shift callback data: ${data}`);
    }
    return data;
}

export interface ParsedPiamShiftCallback {
    shift: "SD" | "SN";
    logId: string;
}

export function parsePiamShiftCallbackData(data: string | null | undefined): ParsedPiamShiftCallback | null {
    if (!data) return null;
    const parts = data.split(":");
    if (parts.length !== 3 || parts[0] !== PIAM_SHIFT_CALLBACK_PREFIX) return null;
    const shift = parts[1];
    if (shift !== "SD" && shift !== "SN") return null;
    if (!isValidCallbackLogId(parts[2])) return null;
    return { shift, logId: parts[2] };
}

/** Ramais do COI oferecidos como botão (escolha binária — CRU continua digitado). */
export const COI_RAMAL_CHOICES = ["1367", "1368"] as const;

/** `coi:1367:<logId>` — completa o pending_cru_coi_ramal existente. */
export function buildCoiRamalCallbackData(ramal: string, logId: string) {
    const data = `${COI_RAMAL_CALLBACK_PREFIX}:${ramal}:${logId}`;
    if (!/^\d{4}$/.test(ramal) || !isValidCallbackLogId(logId) || !fitsCallbackDataLimit(data)) {
        throw new Error(`Invalid COI ramal callback data: ${data}`);
    }
    return data;
}

export interface ParsedCoiRamalCallback {
    ramal: string;
    logId: string;
}

export function parseCoiRamalCallbackData(data: string | null | undefined): ParsedCoiRamalCallback | null {
    if (!data) return null;
    const parts = data.split(":");
    if (parts.length !== 3 || parts[0] !== COI_RAMAL_CALLBACK_PREFIX) return null;
    if (!/^\d{4}$/.test(parts[1])) return null;
    if (!isValidCallbackLogId(parts[2])) return null;
    return { ramal: parts[1], logId: parts[2] };
}

// ── Tomada de ramal/base ocupado (auditoria §3.1#4 / §5#8) ─────────────────────────

export type TakeoverDecision = "assume" | "reject";

/** `tk:ok:<logId>` confirma a tomada; `tk:no:<logId>` cancela ("era outro ramal"). */
export function buildTakeoverDecisionCallbackData(decision: TakeoverDecision, logId: string) {
    const data = `${TAKEOVER_CALLBACK_PREFIX}:${decision === "assume" ? "ok" : "no"}:${logId}`;
    if (!isValidCallbackLogId(logId) || !fitsCallbackDataLimit(data)) {
        throw new Error(`Invalid takeover callback data: ${data}`);
    }
    return data;
}

export interface ParsedTakeoverDecisionCallback {
    decision: TakeoverDecision;
    logId: string;
}

export function parseTakeoverDecisionCallbackData(data: string | null | undefined): ParsedTakeoverDecisionCallback | null {
    if (!data) return null;
    const parts = data.split(":");
    if (parts.length !== 3 || parts[0] !== TAKEOVER_CALLBACK_PREFIX) return null;
    if (parts[1] !== "ok" && parts[1] !== "no") return null;
    if (!isValidCallbackLogId(parts[2])) return null;
    return { decision: parts[1] === "ok" ? "assume" : "reject", logId: parts[2] };
}

// ── Justificativa de saída tardia (auditoria §3.1#6) ───────────────────────────────

export type DepartureJustificationChoice = "occurrence" | "hygienization" | "none";

const DEPARTURE_JUSTIFICATION_CHOICE_TO_TOKEN: Record<DepartureJustificationChoice, string> = {
    occurrence: "occ",
    hygienization: "hyg",
    none: "none",
};

const DEPARTURE_JUSTIFICATION_TOKEN_TO_CHOICE: Record<string, DepartureJustificationChoice> = {
    occ: "occurrence",
    hyg: "hygienization",
    none: "none",
};

/** `dj:occ|hyg|none:<logId>` — escolha do motivo da saída tardia por botão. */
export function buildDepartureJustificationCallbackData(choice: DepartureJustificationChoice, logId: string) {
    const data = `${DEPARTURE_JUSTIFICATION_CALLBACK_PREFIX}:${DEPARTURE_JUSTIFICATION_CHOICE_TO_TOKEN[choice]}:${logId}`;
    if (!isValidCallbackLogId(logId) || !fitsCallbackDataLimit(data)) {
        throw new Error(`Invalid departure justification callback data: ${data}`);
    }
    return data;
}

export interface ParsedDepartureJustificationCallback {
    choice: DepartureJustificationChoice;
    logId: string;
}

export function parseDepartureJustificationCallbackData(
    data: string | null | undefined,
): ParsedDepartureJustificationCallback | null {
    if (!data) return null;
    const parts = data.split(":");
    if (parts.length !== 3 || parts[0] !== DEPARTURE_JUSTIFICATION_CALLBACK_PREFIX) return null;
    const choice = DEPARTURE_JUSTIFICATION_TOKEN_TO_CHOICE[parts[1]];
    if (!choice) return null;
    if (!isValidCallbackLogId(parts[2])) return null;
    return { choice, logId: parts[2] };
}

// ── Destino desconhecido (auditoria §3.1#9 / §5#7) ─────────────────────────────────

/** Código de posto/base aceito num botão de sugestão (2–6 alfanuméricos, ex.: 2377, PM04). */
const DESTINATION_CODE_RE = /^[A-Z0-9]{2,6}$/;

/** `dst:<CODE>:<logId>` — completa a chegada trocando o destino desconhecido pelo sugerido. */
export function buildDestinationSelectionCallbackData(code: string, logId: string) {
    const normalized = code.trim().toUpperCase();
    const data = `${DESTINATION_SELECTION_CALLBACK_PREFIX}:${normalized}:${logId}`;
    if (!DESTINATION_CODE_RE.test(normalized) || !isValidCallbackLogId(logId) || !fitsCallbackDataLimit(data)) {
        throw new Error(`Invalid destination selection callback data: ${data}`);
    }
    return data;
}

export interface ParsedDestinationSelectionCallback {
    code: string;
    logId: string;
}

export function parseDestinationSelectionCallbackData(
    data: string | null | undefined,
): ParsedDestinationSelectionCallback | null {
    if (!data) return null;
    const parts = data.split(":");
    if (parts.length !== 3 || parts[0] !== DESTINATION_SELECTION_CALLBACK_PREFIX) return null;
    if (!DESTINATION_CODE_RE.test(parts[1])) return null;
    if (!isValidCallbackLogId(parts[2])) return null;
    return { code: parts[1], logId: parts[2] };
}

/**
 * Sugere até `max` códigos REAIS próximos do token rejeitado, por distância de
 * edição (≤ 2), desempatando pelo próprio código. Os códigos vêm do banco
 * (regulation_posts/intervention_bases ativos) — nunca hardcode na copy.
 * Token idêntico a um código real não é sugerido (não há diagnóstico a dar).
 */
export function suggestNearestTargetCodes(token: string, codes: string[], max = 3): string[] {
    const normalized = token.trim().toUpperCase().replace(/[\s-]/g, "");
    if (!normalized) {
        return [];
    }
    const seen = new Set<string>();
    const scored: Array<{ code: string; distance: number }> = [];
    for (const raw of codes) {
        const code = raw.trim().toUpperCase();
        if (!code || seen.has(code)) continue;
        seen.add(code);
        const distance = computeLevenshteinDistance(normalized, code);
        if (distance > 0 && distance <= 2) {
            scored.push({ code, distance });
        }
    }
    return scored
        .sort((a, b) => a.distance - b.distance || a.code.localeCompare(b.code))
        .slice(0, max)
        .map((entry) => entry.code);
}

/**
 * Substitui o token de destino rejeitado pelo código escolhido, tolerando a grafia
 * original ("PM 14" / "pm-14" para o token normalizado "PM14"). Null quando o token
 * não é encontrado no texto (não dá para reconstruir com segurança).
 */
export function replaceUnknownTargetToken(text: string, token: string, code: string): string | null {
    const normalized = token.trim().toUpperCase();
    const letterDigit = /^([A-Z]{2})(\d{2})$/.exec(normalized);
    const pattern = letterDigit
        ? new RegExp(`\\b${letterDigit[1]}[\\s-]?${letterDigit[2]}\\b`, "i")
        : /^\d+$/.test(normalized)
            ? new RegExp(`\\b${normalized}\\b`)
            : null;
    if (!pattern || !pattern.test(text)) {
        return null;
    }
    return text.replace(pattern, code);
}

// ── Reset geral de codinomes (auditoria §3.4#15) ───────────────────────────────────

export type ResetAllDecision = "confirm" | "cancel";

/** Confirmação destrutiva expira rápido: 5 minutos (timestamp fica na pendência). */
export const RESET_ALL_CONFIRM_TTL_MS = 5 * 60 * 1000;

/** `rta:go:<logId>` executa o reset geral; `rta:no:<logId>` cancela. */
export function buildResetAllCallbackData(decision: ResetAllDecision, logId: string) {
    const data = `${RESET_ALL_CALLBACK_PREFIX}:${decision === "confirm" ? "go" : "no"}:${logId}`;
    if (!isValidCallbackLogId(logId) || !fitsCallbackDataLimit(data)) {
        throw new Error(`Invalid reset-all callback data: ${data}`);
    }
    return data;
}

export interface ParsedResetAllCallback {
    decision: ResetAllDecision;
    logId: string;
}

export function parseResetAllCallbackData(data: string | null | undefined): ParsedResetAllCallback | null {
    if (!data) return null;
    const parts = data.split(":");
    if (parts.length !== 3 || parts[0] !== RESET_ALL_CALLBACK_PREFIX) return null;
    if (parts[1] !== "go" && parts[1] !== "no") return null;
    if (!isValidCallbackLogId(parts[2])) return null;
    return { decision: parts[1] === "go" ? "confirm" : "cancel", logId: parts[2] };
}

// ── Teclados ───────────────────────────────────────────────────────────────────────

export function buildShiftSelectionKeyboard(logId: string): TelegramInlineKeyboardMarkup {
    return buildInlineKeyboard([[
        { text: "☀️ SD", callback_data: buildShiftSelectionCallbackData("SD", logId) },
        { text: "🌙 SN", callback_data: buildShiftSelectionCallbackData("SN", logId) },
        { text: "🕐 P 24h", callback_data: buildShiftSelectionCallbackData("P", logId) },
    ]]);
}

export function buildNameSelectionKeyboard(
    candidates: Array<{ fullName: string; displayName?: string | null }>,
    logId: string,
): TelegramInlineKeyboardMarkup {
    // Um botão por linha, com o NOME COMPLETO (auditoria §3.1#5): o rótulo longo
    // não cabe lado a lado no mobile.
    return buildInlineKeyboard(
        candidates.slice(0, 3).map((candidate, index) => [{
            text: `${index + 1}. ${candidate.fullName}`.slice(0, 64),
            callback_data: buildNameSelectionCallbackData(index + 1, logId),
        }]),
    );
}

export function buildPiamShiftKeyboard(logId: string): TelegramInlineKeyboardMarkup {
    return buildInlineKeyboard([[
        { text: "☀️ SD 07h–19h", callback_data: buildPiamShiftCallbackData("SD", logId) },
        { text: "🌙 SN 19h–07h", callback_data: buildPiamShiftCallbackData("SN", logId) },
    ]]);
}

export function buildCoiRamalKeyboard(logId: string): TelegramInlineKeyboardMarkup {
    return buildInlineKeyboard([
        COI_RAMAL_CHOICES.map((ramal) => ({
            text: ramal,
            callback_data: buildCoiRamalCallbackData(ramal, logId),
        })),
    ]);
}

export function buildTakeoverDecisionKeyboard(targetLabel: string, logId: string): TelegramInlineKeyboardMarkup {
    return buildInlineKeyboard([[
        { text: `✅ Assumir ${targetLabel}`.slice(0, 64), callback_data: buildTakeoverDecisionCallbackData("assume", logId) },
        { text: "❌ Era outro ramal", callback_data: buildTakeoverDecisionCallbackData("reject", logId) },
    ]]);
}

export function buildDepartureJustificationKeyboard(logId: string): TelegramInlineKeyboardMarkup {
    return buildInlineKeyboard([
        [
            { text: "🚑 Ocorrência", callback_data: buildDepartureJustificationCallbackData("occurrence", logId) },
            { text: "🧼 Higienização", callback_data: buildDepartureJustificationCallbackData("hygienization", logId) },
        ],
        [
            { text: "Sem motivo", callback_data: buildDepartureJustificationCallbackData("none", logId) },
        ],
    ]);
}

export function buildDestinationSelectionKeyboard(codes: string[], logId: string): TelegramInlineKeyboardMarkup {
    return buildInlineKeyboard([
        codes.slice(0, 3).map((code) => ({
            text: code.trim().toUpperCase(),
            callback_data: buildDestinationSelectionCallbackData(code, logId),
        })),
    ]);
}

export function buildResetAllConfirmationKeyboard(count: number, logId: string): TelegramInlineKeyboardMarkup {
    return buildInlineKeyboard([
        [{ text: `🔐 Confirmar reset de ${count} codinomes`.slice(0, 64), callback_data: buildResetAllCallbackData("confirm", logId) }],
        [{ text: "Cancelar", callback_data: buildResetAllCallbackData("cancel", logId) }],
    ]);
}

// ── Cópias dos prompts (parseMode Markdown — interpolações escapadas aqui) ─────────

/**
 * Sanitiza valor interpolado DENTRO de `crase` (code span): no Markdown v1 do
 * Telegram não existe escape dentro de código, então crases e quebras de linha
 * são removidas em vez de escapadas.
 */
export function sanitizeTelegramCodeSpan(value: string) {
    return value.replace(/[`\n\r]/g, " ").replace(/\s+/g, " ").trim();
}

/** F6 sem turno (auditoria §3.1#1): ≤200 chars, dado-chave em negrito, exemplo copiável. */
export function buildShiftSelectionPromptText(params: {
    doctorLabel: string;
    targetLabel: string;
}) {
    const name = escapeTelegramMarkdown(params.doctorLabel);
    const target = escapeTelegramMarkdown(params.targetLabel);
    const example = sanitizeTelegramCodeSpan(`${params.doctorLabel} ${params.targetLabel} SD 07:00`);
    return `⚠️ Falta só o *turno* para registrar *${name}* em *${target}*.`
        + `\nToque abaixo — ou reenvie: \`${example}\``;
}

/** PIAM SD/SN (auditoria §3.1#12): pergunta binária com botões + fallback textual. */
export function buildPiamShiftPromptText(doctorLabel: string) {
    const name = escapeTelegramMarkdown(doctorLabel);
    return `⚠️ *${name}* está no *PIAM* — falta só o turno.`
        + `\nToque abaixo — ou responda *SD* (dia) ou *SN* (noite).`;
}

/** COI sem ramal (auditoria §3.1#10): ≤200 chars + botões [1367] [1368]. */
export function buildCoiRamalPromptText() {
    return `⚠️ O *COI* tem dois ramais — em qual deles?`
        + `\nToque abaixo — ou responda só o número (ex.: \`${COI_RAMAL_CHOICES[0]}\`).`;
}

/** Destino desconhecido (auditoria §3.1#9): nomeia o token e sugere códigos reais. */
export function buildUnknownDestinationReplyText(params: {
    token: string;
    suggestions: string[];
    interactive: boolean;
}) {
    const token = escapeTelegramMarkdown(params.token.trim().toUpperCase());
    const suggestionsPart = params.suggestions.length > 0
        ? ` Parecidos: ${params.suggestions.map((code) => `*${escapeTelegramMarkdown(code)}*`).join(", ")}.`
        : "";
    const action = params.interactive
        ? "\nToque no código certo abaixo — ou confira o número e reenvie a mensagem completa."
        : "\nConfira o número e reenvie a mensagem completa.";
    return `⛔ Não conheço *${token}* como ramal ou base.${suggestionsPart}${action}`;
}

/** Confirmação destrutiva do reset geral de codinomes (auditoria §3.4#15). */
export function buildResetAllConfirmationPromptText(count: number) {
    return `⚠️ Isso gera codinomes *novos* para *${count}* médicos ativos e invalida TODOS os atuais de uma vez.`
        + `\nToque para confirmar (vale por *5 min*) — ou envie: \`/pagamento resetar-todos CONFIRMO\``;
}

export type ExpiredPendingKind =
    | "shift_selection"
    | "name_selection"
    | "piam_shift"
    | "coi_ramal"
    | "takeover"
    | "departure_justification"
    | "destination_selection"
    | "reset_all";

/** Alert de expiração (toque em botão de pendência morta). */
export function buildExpiredPendingAlertText(kind: ExpiredPendingKind) {
    switch (kind) {
        case "shift_selection":
            return "⏰ Esse pedido expirou. Reenvie a chegada completa: nome + local + turno + horário.";
        case "name_selection":
            return "⏰ Essa confirmação expirou. Reenvie a mensagem com nome e sobrenome do médico.";
        case "piam_shift":
            return "⏰ Essa pergunta expirou. Reenvie a chegada com o turno (SD ou SN).";
        case "coi_ramal":
            return "⏰ Esse pedido expirou. Reenvie a mensagem completa com o número do ramal.";
        case "takeover":
            return "⏰ Essa confirmação de tomada expirou (30 min). Reenvie a chegada para eu perguntar de novo.";
        case "departure_justification":
            return "⏰ Essa pendência de justificativa expirou. Reenvie a saída completa para reabrir.";
        case "destination_selection":
            return "⏰ Esse pedido expirou. Reenvie a chegada com o código correto do ramal ou base.";
        case "reset_all":
            return "⏰ Essa confirmação expirou (5 min). Envie /pagamento resetar-todos de novo.";
    }
}

/** Alert para terceiro tocando botão de pendência alheia. */
export function buildThirdPartyPressAlertText() {
    return "⚠️ Só quem enviou a mensagem original (ou a chefia) pode usar estes botões.";
}

// ── Validação de quem toca ─────────────────────────────────────────────────────────

export type PendingPresserPermission = "author" | "privileged" | "denied";

/**
 * Quem pode agir numa pendência: o AUTOR da mensagem original, ou chefia/admin
 * (TELEGRAM_CHIEF_IDS / TELEGRAM_ADMIN_IDS). Terceiros recebem alert curto.
 */
export function resolvePendingPresserPermission(params: {
    presserTelegramId: string | null | undefined;
    pendingSenderTelegramId: string | null | undefined;
    chiefTelegramIds: string[];
    adminTelegramIds: string[];
}): PendingPresserPermission {
    const presser = params.presserTelegramId?.trim();
    if (!presser) {
        return "denied";
    }
    if (params.adminTelegramIds.includes(presser) || params.chiefTelegramIds.includes(presser)) {
        return "privileged";
    }
    if (params.pendingSenderTelegramId && presser === params.pendingSenderTelegramId.trim()) {
        return "author";
    }
    return "denied";
}

// ── Reabertura de pendência por resposta curta (auditoria §5#6) ────────────────────

/** Janela em que uma pendência (ativa ou já expirada) ainda aceita resposta curta. */
export const PENDING_REOPEN_WINDOW_MS = 2 * 60 * 60 * 1000;

export type PendingShortReply =
    | { kind: "shift"; shift: PendingShiftChoice }
    | { kind: "option"; option: 1 | 2 | 3 }
    | { kind: "ramal"; ramal: string }
    | { kind: "time"; time: string };

/**
 * Classifica uma resposta curta órfã que pode pertencer a uma pendência recente:
 * "SD"/"SN"/"P" (turno), "1"/"2"/"3" (candidato de nome), "NNNN" (ramal CRU/COI)
 * e "HH:MM" (hora de correção de saída). Qualquer outro texto → null (segue o
 * fluxo normal). "NNNN HH:MM" NÃO é classificado aqui: é payload do teclado de
 * refeição e já foi tratado antes no pipeline.
 */
export function classifyPendingShortReply(text: string | null | undefined): PendingShortReply | null {
    if (!text) return null;
    const trimmed = text.trim();
    if (!trimmed || /\s/.test(trimmed)) return null;

    const upper = trimmed.toUpperCase();
    if (upper === "SD" || upper === "SN" || upper === "P") {
        return { kind: "shift", shift: upper };
    }

    if (/^[123]$/.test(trimmed)) {
        return { kind: "option", option: Number(trimmed) as 1 | 2 | 3 };
    }

    if (/^\d{4}$/.test(trimmed)) {
        return { kind: "ramal", ramal: trimmed };
    }

    const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
    if (timeMatch && Number(timeMatch[1]) < 24 && Number(timeMatch[2]) < 60) {
        return { kind: "time", time: trimmed };
    }

    return null;
}

/**
 * Resposta textual da pergunta PIAM: aceita SD/SN e as palavras que a copy
 * original já ensinava ("dia"/"noite", com ou sem acento/variação).
 */
export function classifyPiamShiftTextReply(text: string | null | undefined): "SD" | "SN" | null {
    if (!text) return null;
    const normalized = text
        .trim()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toUpperCase();
    if (/^(SD|DIA|DIURNO)$/.test(normalized)) return "SD";
    if (/^(SN|NOITE|NOTURNO)$/.test(normalized)) return "SN";
    return null;
}

/**
 * Estado de uma pendência para fins de resposta curta:
 * - "active": dentro do TTL (30 min) — resposta vale normalmente.
 * - "reopenable": TTL vencido mas dentro da janela de 2h — reabre REVALIDANDO
 *   contra o estado atual do quadro (a aplicação passa pelo mesmo caminho do
 *   fluxo normal, que reconfere conflito/tomada).
 * - "stale": velha demais — segue para o fluxo normal (no_operational_match etc).
 */
export function resolvePendingReopenState(params: {
    createdAt: Date;
    now: Date;
    ttlMs: number;
    reopenWindowMs?: number;
}): "active" | "reopenable" | "stale" {
    const ageMs = params.now.getTime() - params.createdAt.getTime();
    if (ageMs <= params.ttlMs) {
        return "active";
    }
    if (ageMs <= (params.reopenWindowMs ?? PENDING_REOPEN_WINDOW_MS)) {
        return "reopenable";
    }
    return "stale";
}
