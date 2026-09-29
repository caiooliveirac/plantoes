// Madrugada: médico que cobre temporariamente o horário de outro na noite.
// Regra e cenários em docs/madrugada.md.
//
// "Fulano 2266 madrugada" → o bot pergunta "por quem você está?" com botões dos
// médicos daquele horário; o tocado some do quadro (mas segue no pagamento e no
// banco de horas dele) e quem cobre aparece no ramal declarado, de plantão
// (Mesa/Tabela), sem pagamento nem banco de horas.
//
// Aqui só helpers PUROS (sem I/O) — o handler com efeito vive em service.ts e a
// gravação em modules/regulation/madrugada-cobertura.ts.

import { BAHIA_OFFSET_MINUTES } from "@/lib/time";
import {
    buildInlineKeyboard,
    escapeTelegramMarkdown,
    type TelegramInlineKeyboardMarkup,
} from "@/modules/telegram/api";

export const MADRUGADA_CALLBACK_PREFIX = "mad";
export const MADRUGADA_PENDING_STATUS = "pending_madrugada_cover";
export const MADRUGADA_MAX_CANDIDATES = 8;

/** Horário da madrugada: quem trabalha 23:00–03:00 ou 03:00–07:00. */
export type MadrugadaSlot = "23:00" | "03:00";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MINUTES = 24 * 60;

function normalize(text: string) {
    return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
}

/** A mensagem traz a palavra "madrugada" (com ou sem acento/caixa). */
export function isMadrugadaMessage(text: string | null | undefined) {
    return Boolean(text) && /\bMADRUGADA\b/.test(normalize(text!));
}

/** Tira a palavra "madrugada" para o parser comum extrair nome e ramal. */
export function stripMadrugadaWord(text: string) {
    return text.replace(/\bmadrugada\b/gi, " ").replace(/\s{2,}/g, " ").trim();
}

export interface MadrugadaWindow {
    slot: MadrugadaSlot;
    scheduledStartAt: Date;
    scheduledEndAt: Date;
}

/**
 * Janela pela hora do aviso (horário local, UTC-3):
 *   - 20:00–00:59 → em torno das 23h → fica de 23:00 às 03:00;
 *   - 01:00–05:59 → em torno das 03h → fica de 03:00 às 07:00;
 *   - fora disso não é madrugada (null).
 */
export function resolveMadrugadaWindow(referenceAt: Date): MadrugadaWindow | null {
    const localMs = referenceAt.getTime() + BAHIA_OFFSET_MINUTES * MINUTE_MS;
    const local = new Date(localMs);
    const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
    // Meia-noite local do dia do aviso, expressa em UTC.
    const localMidnightUtcMs = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate())
        - BAHIA_OFFSET_MINUTES * MINUTE_MS;

    if (minutes >= 20 * 60 || minutes < 60) {
        const nightStartDayMs = minutes >= 20 * 60 ? localMidnightUtcMs : localMidnightUtcMs - DAY_MINUTES * MINUTE_MS;
        const start = new Date(nightStartDayMs + 23 * HOUR_MS);
        return { slot: "23:00", scheduledStartAt: start, scheduledEndAt: new Date(start.getTime() + 4 * HOUR_MS) };
    }
    if (minutes < 6 * 60) {
        const start = new Date(localMidnightUtcMs + 3 * HOUR_MS);
        return { slot: "03:00", scheduledStartAt: start, scheduledEndAt: new Date(start.getTime() + 4 * HOUR_MS) };
    }
    return null;
}

export function describeMadrugadaSlot(slot: MadrugadaSlot) {
    return slot === "23:00" ? "23:00 às 03:00" : "03:00 às 07:00";
}

export interface MadrugadaBoardRow {
    occupancyId: string | null;
    doctorId: string | null;
    doctorName: string | null;
    displayName?: string | null;
    postCode: string;
    status: string;
    madrugadaCobertura?: boolean;
}

export interface MadrugadaCandidate {
    occupancyId: string;
    doctorId: string;
    name: string;
    ramal: string;
}

/**
 * Médicos oferecidos como botão: os do quadro que a divisão da noite pôs para
 * trabalhar no mesmo horário (ramal → "23:00"/"03:00"). Sem divisão da noite, ou
 * sem ninguém naquele horário, oferece todos os ativos da regulação. Nunca quem
 * já é cobertura nem o próprio médico que avisou.
 */
export function selectMadrugadaCandidates(params: {
    rows: MadrugadaBoardRow[];
    slot: MadrugadaSlot;
    nightWorkAssignments: Record<string, string> | null;
    covererDoctorId: string;
    max?: number;
}): MadrugadaCandidate[] {
    const max = params.max ?? MADRUGADA_MAX_CANDIDATES;
    const eligible = params.rows
        .filter((row) => row.status === "active" && row.occupancyId && row.doctorId)
        .filter((row) => !row.madrugadaCobertura && row.doctorId !== params.covererDoctorId)
        .map((row) => ({
            occupancyId: row.occupancyId!,
            doctorId: row.doctorId!,
            name: (row.displayName || row.doctorName || "").trim() || row.postCode,
            ramal: row.postCode,
        }));
    const assignments = params.nightWorkAssignments ?? {};
    const inSlot = eligible.filter((candidate) => assignments[candidate.ramal] === params.slot);
    return (inSlot.length > 0 ? inSlot : eligible).slice(0, max);
}

// ── callback_data ──────────────────────────────────────────────────────────────
// `mad:<posição 1..8>:<logId>` escolhe quem é coberto; `mad:0:<logId>` cancela.

const CALLBACK_LOG_ID_RE = /^[0-9a-fA-F-]{8,36}$/;

export function buildMadrugadaCallbackData(position: number, logId: string) {
    const data = `${MADRUGADA_CALLBACK_PREFIX}:${position}:${logId}`;
    if (!Number.isInteger(position) || position < 0 || position > MADRUGADA_MAX_CANDIDATES
        || !CALLBACK_LOG_ID_RE.test(logId) || Buffer.byteLength(data, "utf8") > 64) {
        throw new Error(`Invalid madrugada callback data: ${data}`);
    }
    return data;
}

export interface ParsedMadrugadaCallback {
    /** 0 = cancelar; 1..N = candidato. */
    position: number;
    logId: string;
}

export function parseMadrugadaCallbackData(data: string | null | undefined): ParsedMadrugadaCallback | null {
    if (!data) return null;
    const parts = data.split(":");
    if (parts.length !== 3 || parts[0] !== MADRUGADA_CALLBACK_PREFIX) return null;
    const position = Number(parts[1]);
    if (!Number.isInteger(position) || position < 0 || position > MADRUGADA_MAX_CANDIDATES) return null;
    if (!CALLBACK_LOG_ID_RE.test(parts[2])) return null;
    return { position, logId: parts[2] };
}

// ── pendência ────────────────────────────────────────────────────────────────

export interface MadrugadaPendingData {
    kind: "madrugada_cover";
    coverer: { id: string; fullName: string; displayName: string | null };
    postCode: string;
    slot: MadrugadaSlot;
    startedAt: string;
    scheduledStartAt: string;
    scheduledEndAt: string;
    candidates: MadrugadaCandidate[];
    originalText: string;
}

export function isMadrugadaPendingData(value: unknown): value is MadrugadaPendingData {
    const data = value as Partial<MadrugadaPendingData> | null;
    return Boolean(data)
        && data!.kind === "madrugada_cover"
        && typeof data!.postCode === "string"
        && (data!.slot === "23:00" || data!.slot === "03:00")
        && Array.isArray(data!.candidates)
        && typeof data!.coverer?.id === "string";
}

// ── textos ───────────────────────────────────────────────────────────────────

export function buildMadrugadaQuestion(params: {
    covererName: string;
    postCode: string;
    slot: MadrugadaSlot;
    candidates: MadrugadaCandidate[];
}) {
    return [
        `🌙 *${escapeTelegramMarkdown(params.covererName)}* na madrugada, ramal *${escapeTelegramMarkdown(params.postCode)}* (${describeMadrugadaSlot(params.slot)}).`,
        "Por quem você está? Toque no nome.",
        "_Quem você cobre sai do quadro, mas não perde pagamento nem banco de horas._",
    ].join("\n");
}

export function buildMadrugadaKeyboard(candidates: MadrugadaCandidate[], logId: string): TelegramInlineKeyboardMarkup {
    const buttons = candidates.map((candidate, index) => ({
        text: `${candidate.name} · ${candidate.ramal}`,
        callback_data: buildMadrugadaCallbackData(index + 1, logId),
    }));
    const rows = [];
    for (let i = 0; i < buttons.length; i += 2) {
        rows.push(buttons.slice(i, i + 2));
    }
    rows.push([{ text: "❌ Cancelar", callback_data: buildMadrugadaCallbackData(0, logId) }]);
    return buildInlineKeyboard(rows);
}

export function buildMadrugadaConfirmation(params: {
    covererName: string;
    coveredName: string;
    postCode: string;
    slot: MadrugadaSlot;
}) {
    return [
        `✅ 🌙 *${escapeTelegramMarkdown(params.covererName)}* no ramal *${escapeTelegramMarkdown(params.postCode)}* por *${escapeTelegramMarkdown(params.coveredName)}* (${describeMadrugadaSlot(params.slot)}).`,
        `${escapeTelegramMarkdown(params.coveredName)} sai do quadro até o fim da madrugada; pagamento e banco de horas seguem com ele(a).`,
    ].join("\n");
}

export function buildMadrugadaOutsideWindowReply() {
    return "🌙 Madrugada só vale entre 20h e 6h: perto das 23h fica de 23:00 às 03:00; perto das 3h, de 03:00 às 07:00. Fora disso, avise a chegada normal.";
}

export function buildMadrugadaMissingPartsReply(params: { hasName: boolean; hasRamal: boolean }) {
    const missing = [
        ...(params.hasName ? [] : ["o *nome*"]),
        ...(params.hasRamal ? [] : ["o *ramal*"]),
    ];
    return `🌙 Faltou ${missing.join(" e ")}. Ex.: _Maria Souza 2266 madrugada_`;
}
