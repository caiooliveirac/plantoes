/**
 * Menu do checklist no bot dos Plantões — fase 1 da aposentadoria do bot do
 * checklist (plano completo em docs/checklist-bot-migration.md).
 *
 * O que era menu do @samu_checklists_bot vira /checklist aqui, para a
 * coordenação (admin/chefia): status do dia, pendentes, faltas, observações,
 * detalhe por unidade, busca de material ("procura item") e faltas recentes
 * ("passado de checklist"). A fonte de verdade continua sendo o app checklist:
 * este módulo só fala com os endpoints internos `/api/internal/menu/*`
 * (mesmo token compartilhado da chave), que devolvem o TEXTO pronto em HTML do
 * Telegram — a lógica de compilação permanece no repo checklist, junto do dado.
 *
 * Enquanto os endpoints da migração não estiverem publicados lá, tudo aqui
 * degrada com resposta didática (o bot antigo continua respondendo) — nunca
 * silêncio nem erro seco.
 */

import type { TelegramInlineKeyboardButton } from "@/modules/telegram/api";
import { parseMessage } from "@/modules/telegram/parser";

const FETCH_TIMEOUT_MS = 4000;

// Margem sob o teto de 4096 chars do Telegram: um texto vindo do checklist
// nunca pode derrubar o envio por tamanho.
const MAX_TEXT_CHARS = 3900;

/* ------------------------------------------------------------------ */
/* Comando /checklist                                                  */
/* ------------------------------------------------------------------ */

export type ChecklistMenuView =
    | { view: "menu"; unknown?: string | null }
    | { view: "status" }
    | { view: "pendentes" }
    | { view: "faltas" }
    | { view: "obs" }
    | { view: "material" }
    | { view: "sumidos" }
    | { view: "unit"; baseCode: string };

const COMMAND_PATTERN = /^\/checklist(?:@\w+)?\b([\s\S]*)$/i;

function normalizeSubcommand(value: string) {
    return value.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

/** Reconhece "/checklist [subcomando|BASE]". Null = não é o comando. */
export function parseChecklistMenuCommand(text: string): ChecklistMenuView | null {
    const match = (text ?? "").trim().match(COMMAND_PATTERN);
    if (!match) return null;

    const body = match[1]?.trim() ?? "";
    if (!body) return { view: "menu" };

    const sub = normalizeSubcommand(body);
    if (sub === "STATUS" || sub === "HOJE") return { view: "status" };
    if (sub === "PENDENTES") return { view: "pendentes" };
    if (sub === "FALTAS") return { view: "faltas" };
    if (sub === "OBS" || sub === "OBSERVACOES") return { view: "obs" };
    if (sub === "MATERIAL" || sub === "MATERIAIS" || sub === "BUSCAR") return { view: "material" };
    if (sub === "SUMIDOS" || sub === "RECENTES") return { view: "sumidos" };

    const parsed = parseMessage(body);
    if (parsed.sector === "INTERVENTION" && parsed.baseCode) {
        return { view: "unit", baseCode: parsed.baseCode };
    }
    return { view: "menu", unknown: body };
}

/* ------------------------------------------------------------------ */
/* Callbacks (prefixo clm:) — tudo cabe folgado nos 64 bytes           */
/* ------------------------------------------------------------------ */

export type ChecklistMenuCallbackAction =
    | { kind: "root" }
    | { kind: "view"; view: "status" | "pendentes" | "faltas" | "obs" }
    | { kind: "units"; flow: "unit" | "material" | "sumidos" }
    | { kind: "unit"; code: string }
    | { kind: "materials"; code: string }
    | { kind: "material"; code: string; key: string }
    | { kind: "sumidos"; code: string };

const VIEW_CODES = { status: "st", pendentes: "pe", faltas: "fa", obs: "ob" } as const;
const FLOW_CODES = { unit: "u", material: "m", sumidos: "s" } as const;

export function encodeChecklistMenuCallback(action: ChecklistMenuCallbackAction): string {
    switch (action.kind) {
        case "root": return "clm:root";
        case "view": return `clm:v:${VIEW_CODES[action.view]}`;
        case "units": return `clm:l:${FLOW_CODES[action.flow]}`;
        case "unit": return `clm:u:${action.code}`;
        case "materials": return `clm:mu:${action.code}`;
        case "material": return `clm:mh:${action.code}:${action.key}`;
        case "sumidos": return `clm:su:${action.code}`;
    }
}

export function parseChecklistMenuCallbackData(data: string | undefined): ChecklistMenuCallbackAction | null {
    if (!data?.startsWith("clm:")) return null;
    const rest = data.slice(4);
    if (rest === "root") return { kind: "root" };

    const view = rest.match(/^v:(st|pe|fa|ob)$/);
    if (view) {
        const entry = (Object.entries(VIEW_CODES) as Array<[keyof typeof VIEW_CODES, string]>)
            .find(([, code]) => code === view[1]);
        return entry ? { kind: "view", view: entry[0] } : null;
    }

    const list = rest.match(/^l:(u|m|s)$/);
    if (list) {
        const entry = (Object.entries(FLOW_CODES) as Array<[keyof typeof FLOW_CODES, string]>)
            .find(([, code]) => code === list[1]);
        return entry ? { kind: "units", flow: entry[0] } : null;
    }

    const unit = rest.match(/^u:([A-Z0-9]{2,8})$/);
    if (unit) return { kind: "unit", code: unit[1] };

    const materials = rest.match(/^mu:([A-Z0-9]{2,8})$/);
    if (materials) return { kind: "materials", code: materials[1] };

    const material = rest.match(/^mh:([A-Z0-9]{2,8}):([\w.]{1,24})$/);
    if (material) return { kind: "material", code: material[1], key: material[2] };

    const sumidos = rest.match(/^su:([A-Z0-9]{2,8})$/);
    if (sumidos) return { kind: "sumidos", code: sumidos[1] };

    return null;
}

/* ------------------------------------------------------------------ */
/* Teclados e textos do menu                                           */
/* ------------------------------------------------------------------ */

export function buildChecklistMenuText(unknown?: string | null): string {
    const lines = [
        "📋 <b>Menu do checklist USA</b> — checklist.mnrs.com.br",
    ];
    if (unknown) {
        lines.push("", `Não entendi "${escapeHtml(unknown)}" — escolha abaixo ou use /checklist SM01.`);
    }
    lines.push("", "Escolha uma consulta:");
    return lines.join("\n");
}

export function buildChecklistMenuKeyboard(): TelegramInlineKeyboardButton[][] {
    return [
        [{ text: "📋 Status de hoje", callback_data: encodeChecklistMenuCallback({ kind: "view", view: "status" }) }],
        [
            { text: "⚠️ Pendentes", callback_data: encodeChecklistMenuCallback({ kind: "view", view: "pendentes" }) },
            { text: "🚫 Faltas", callback_data: encodeChecklistMenuCallback({ kind: "view", view: "faltas" }) },
        ],
        [
            { text: "📝 Observações", callback_data: encodeChecklistMenuCallback({ kind: "view", view: "obs" }) },
            { text: "🚑 Por unidade", callback_data: encodeChecklistMenuCallback({ kind: "units", flow: "unit" }) },
        ],
        [
            { text: "🔎 Buscar material", callback_data: encodeChecklistMenuCallback({ kind: "units", flow: "material" }) },
            { text: "📉 Faltas recentes", callback_data: encodeChecklistMenuCallback({ kind: "units", flow: "sumidos" }) },
        ],
    ];
}

/** Grade de unidades (✅ fez · ⚠️ pendente), 3 por linha, roteando pelo fluxo. */
export function buildChecklistUnitsKeyboard(
    units: Array<{ code: string; done: boolean }>,
    flow: "unit" | "material" | "sumidos",
): TelegramInlineKeyboardButton[][] {
    const action = (code: string): ChecklistMenuCallbackAction =>
        flow === "unit" ? { kind: "unit", code } : flow === "material" ? { kind: "materials", code } : { kind: "sumidos", code };
    const rows: TelegramInlineKeyboardButton[][] = [];
    units.forEach((unit, index) => {
        if (index % 3 === 0) rows.push([]);
        rows[rows.length - 1].push({
            text: `${unit.done ? "✅" : "⚠️"} ${unit.code}`,
            callback_data: encodeChecklistMenuCallback(action(unit.code)),
        });
    });
    rows.push([{ text: "« Menu", callback_data: encodeChecklistMenuCallback({ kind: "root" }) }]);
    return rows;
}

/** Grade de materiais (2 por linha) para o histórico de um item na unidade. */
export function buildChecklistMaterialsKeyboard(
    materials: Array<{ key: string; label: string }>,
    code: string,
): TelegramInlineKeyboardButton[][] {
    const rows: TelegramInlineKeyboardButton[][] = [];
    materials.forEach((material, index) => {
        if (index % 2 === 0) rows.push([]);
        rows[rows.length - 1].push({
            text: material.label,
            callback_data: encodeChecklistMenuCallback({ kind: "material", code, key: material.key }),
        });
    });
    rows.push([{ text: "« Menu", callback_data: encodeChecklistMenuCallback({ kind: "root" }) }]);
    return rows;
}

/** Itens que faltaram recentemente, clicáveis para o histórico de cada um. */
export function buildChecklistSumidosKeyboard(
    missing: Array<{ key: string; label: string }>,
    code: string,
): TelegramInlineKeyboardButton[][] {
    const rows: TelegramInlineKeyboardButton[][] = [];
    missing.forEach((item, index) => {
        if (index % 2 === 0) rows.push([]);
        rows[rows.length - 1].push({
            text: `🚫 ${item.label}`,
            callback_data: encodeChecklistMenuCallback({ kind: "material", code, key: item.key }),
        });
    });
    rows.push([{ text: "« Menu", callback_data: encodeChecklistMenuCallback({ kind: "root" }) }]);
    return rows;
}

function escapeHtml(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Nunca deixa um texto do checklist estourar o teto de 4096 chars do Telegram. */
export function clampChecklistMenuText(text: string): string {
    if (text.length <= MAX_TEXT_CHARS) return text;
    return `${text.slice(0, MAX_TEXT_CHARS)}\n…`;
}

/* ------------------------------------------------------------------ */
/* Replies didáticas de indisponibilidade                              */
/* ------------------------------------------------------------------ */

/** Integração configurada mas o app/endpoint não respondeu. HTML. */
export function buildChecklistMenuUnavailableReply(): string {
    return [
        "⚠️ Não consegui puxar isso do app do checklist agora.",
        "Pode ser o app fora do ar — ou os endpoints desta migração ainda não publicados lá.",
        "",
        "Enquanto isso, o bot antigo do checklist continua respondendo, e o painel vive em checklist.mnrs.com.br.",
    ].join("\n");
}

/** Ambiente sem CHECKLIST_API_URL/CHECKLIST_INTERNAL_TOKEN. HTML. */
export function buildChecklistMenuUnconfiguredReply(): string {
    return "⚠️ A integração com o app do checklist não está configurada neste ambiente — o menu /checklist não tem de onde ler.";
}

/** Base/material que o app do checklist não reconheceu. HTML. */
export function buildChecklistMenuNotFoundReply(): string {
    return "🤔 O app do checklist não reconheceu esse alvo. Use os botões do /checklist para navegar pelas opções válidas.";
}

/** Médico comum pedindo o menu no privado: aponta o que é dele (/chave). HTML. */
export function buildChecklistMenuForbiddenReply(): string {
    return [
        "🔐 O menu /checklist é da coordenação (status, pendências e histórico das USAs).",
        "",
        "O que você precisa como plantonista é a <b>chave do dia</b> — manda /chave que eu te entrego na hora.",
    ].join("\n");
}

/* ------------------------------------------------------------------ */
/* Cliente da API interna do app checklist                             */
/* ------------------------------------------------------------------ */

export type ChecklistMenuTextResult =
    | { status: "ok"; text: string }
    | { status: "not_found" }
    | { status: "unavailable" }
    | { status: "unconfigured" };

function checklistMenuConfig() {
    const apiUrl = process.env.CHECKLIST_API_URL;
    const token = process.env.CHECKLIST_INTERNAL_TOKEN;
    return apiUrl && token ? { apiUrl, token } : null;
}

async function fetchChecklistMenuJson(path: string): Promise<
    | { status: "ok"; data: Record<string, unknown> }
    | { status: "not_found" }
    | { status: "unavailable" }
    | { status: "unconfigured" }
> {
    const config = checklistMenuConfig();
    if (!config) return { status: "unconfigured" };
    try {
        const res = await fetch(`${config.apiUrl}/api/internal/menu/${path}`, {
            headers: { "x-internal-token": config.token },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        // 404 aqui cobre dois mundos durante a migração: alvo desconhecido E
        // endpoint ainda não publicado no app checklist. O texto de not_found
        // só é usado para alvos (unit/material); rota inexistente responde
        // igual, e o chamador de listas trata 404 como indisponível.
        if (res.status === 404) return { status: "not_found" };
        if (!res.ok) return { status: "unavailable" };
        const data = (await res.json()) as Record<string, unknown>;
        if (!data || data.ok !== true) return { status: "unavailable" };
        return { status: "ok", data };
    } catch {
        return { status: "unavailable" };
    }
}

/**
 * Texto pronto (HTML do Telegram) de uma visão do menu:
 * status · pendentes · faltas · obs · unit/SM01 · material/SM01/g5i2 · sumidos/SM01
 */
export async function fetchChecklistMenuText(path: string): Promise<ChecklistMenuTextResult> {
    const result = await fetchChecklistMenuJson(path);
    if (result.status !== "ok") return result;
    const text = typeof result.data.text === "string" ? result.data.text.trim() : "";
    if (!text) return { status: "unavailable" };
    return { status: "ok", text: clampChecklistMenuText(text) };
}

export type ChecklistMenuUnitsResult =
    | { status: "ok"; units: Array<{ code: string; done: boolean }> }
    | { status: "unavailable" }
    | { status: "unconfigured" };

export async function fetchChecklistMenuUnits(): Promise<ChecklistMenuUnitsResult> {
    const result = await fetchChecklistMenuJson("units");
    if (result.status === "unconfigured") return { status: "unconfigured" };
    if (result.status !== "ok") return { status: "unavailable" };
    const units = Array.isArray(result.data.units)
        ? (result.data.units as Array<{ code?: unknown; done?: unknown }>)
            .map((row) => ({ code: String(row.code ?? "").trim(), done: Boolean(row.done) }))
            .filter((row) => row.code)
        : [];
    if (units.length === 0) return { status: "unavailable" };
    return { status: "ok", units };
}

export type ChecklistMenuMaterialsResult =
    | { status: "ok"; materials: Array<{ key: string; label: string }> }
    | { status: "unavailable" }
    | { status: "unconfigured" };

export async function fetchChecklistMenuMaterials(): Promise<ChecklistMenuMaterialsResult> {
    const result = await fetchChecklistMenuJson("materials");
    if (result.status === "unconfigured") return { status: "unconfigured" };
    if (result.status !== "ok") return { status: "unavailable" };
    const materials = Array.isArray(result.data.materials)
        ? (result.data.materials as Array<{ key?: unknown; label?: unknown }>)
            .map((row) => ({ key: String(row.key ?? "").trim(), label: String(row.label ?? "").trim() }))
            .filter((row) => row.key && row.label)
        : [];
    if (materials.length === 0) return { status: "unavailable" };
    return { status: "ok", materials };
}

export type ChecklistMenuSumidosResult =
    | { status: "ok"; text: string; missing: Array<{ key: string; label: string }> }
    | { status: "not_found" }
    | { status: "unavailable" }
    | { status: "unconfigured" };

export async function fetchChecklistMenuSumidos(code: string): Promise<ChecklistMenuSumidosResult> {
    const result = await fetchChecklistMenuJson(`sumidos/${encodeURIComponent(code)}`);
    if (result.status !== "ok") return result;
    const text = typeof result.data.text === "string" ? result.data.text.trim() : "";
    if (!text) return { status: "unavailable" };
    const missing = Array.isArray(result.data.missing)
        ? (result.data.missing as Array<{ key?: unknown; label?: unknown }>)
            .map((row) => ({ key: String(row.key ?? "").trim(), label: String(row.label ?? "").trim() }))
            .filter((row) => row.key && row.label)
        : [];
    return { status: "ok", text: clampChecklistMenuText(text), missing };
}
