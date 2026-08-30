/**
 * Integração com o app checklist (checklist.mnrs.com.br): ao confirmar uma
 * chegada em base de intervenção (USA), anexamos a chave do dia do checklist
 * daquela ambulância — o plantonista já sai da confirmação com tudo que
 * precisa para registrar o checklist. Remanejamento ganha variante própria:
 * a chave mostrada é sempre a da BASE DE DESTINO, dita com todas as letras.
 *
 * O ponteiro de "consulte no privado" aponta para o PRÓPRIO bot dos Plantões
 * (deep link t.me/<bot>?start=chave): é este bot que conhece o quadro e sabe
 * quem é o médico — o atendimento do pedido vive em checklist-key-request.ts.
 *
 * Fail-soft por princípio: o checklist é serviço acessório — nenhuma falha
 * derruba a confirmação. Mas com a integração CONFIGURADA, falha de consulta
 * (timeout, rede, 5xx) não é mais silêncio total: sai o bloco sem a chave
 * apontando o /chave no privado. Sem config (dev/testes) ou com resposta
 * negativa deliberada (base sem checklist), continua tudo vazio como antes.
 */

import { getBotUsername } from "@/modules/telegram/api";

const FETCH_TIMEOUT_MS = 1500;

export interface ChecklistKeyResponse {
    ok?: boolean;
    baseCode?: string;
    key?: string;
}

/** Resultado da consulta ao serviço do checklist — nunca lança. */
export type ChecklistKeyLookup =
    | { status: "ok"; baseCode: string; key: string }
    /** Resposta deliberada do serviço: 4xx, ok:false ou sem chave para a base. */
    | { status: "no_key" }
    /** Falha de transporte: timeout, rede, 5xx, corpo ilegível. */
    | { status: "unavailable" }
    /** Sem CHECKLIST_API_URL/CHECKLIST_INTERNAL_TOKEN (dev/testes) ou sem base. */
    | { status: "unconfigured" };

export interface ChecklistHintOptions {
    /** Confirmação de remanejamento: enfatiza que a chave é da base de DESTINO. */
    reassignment?: boolean;
    /**
     * "plain" para mensagens enviadas SEM parse_mode (ex.: /corrigir, /ontem,
     * /hoje) — sem *negrito* nem [link](url), só texto e URL crua (o Telegram
     * auto-linka). O default "markdown" é para os balões de confirmação, que
     * saem com parseMode Markdown.
     */
    format?: "markdown" | "plain";
    /**
     * Deep link do privado do bot (t.me/<bot>?start=chave). null/ausente monta
     * a mesma instrução sem link ("manda /chave no privado do bot") — nunca
     * deixamos o médico sem saber ONDE pedir.
     */
    botUrl?: string | null;
}

/**
 * Deep link do privado deste bot já disparando o pedido de chave: tocar envia
 * "/start chave", que o webhook trata como /chave. Usa TELEGRAM_BOT_USERNAME
 * ou getMe (cacheado); sem username (dev/testes sem token) devolve null e os
 * blocos saem com a instrução em texto puro.
 */
export async function resolveChecklistKeyDeepLink(): Promise<string | null> {
    try {
        const username = await getBotUsername();
        return `https://t.me/${username}?start=chave`;
    } catch {
        return null;
    }
}

// Instrução do privado, com ou sem link. Em Markdown v1 o username do bot pode
// ter `_` — solto no texto ele viraria itálico e quebraria o link (aconteceu
// com o antigo "avisos: @samu_checklists_bot"); dentro da url de um [link](...)
// o parser não mexe, então o username só viaja ali.
function privateKeyInstruction(format: "markdown" | "plain", botUrl: string | null | undefined, label: string): string {
    if (!botUrl) {
        return `${label} no privado do bot: manda /chave`;
    }
    return format === "markdown"
        ? `${label} no privado: [manda /chave pra mim](${botUrl})`
        : `${label} no privado: /chave em ${botUrl}`;
}

/**
 * Monta o bloco de texto anexado à confirmação de chegada/remanejamento com a
 * chave em mãos. Pura — testável.
 *
 * Chegada: duas linhas (chave + link), como pediu a auditoria de UX — o bloco
 * não pode ficar maior que a própria confirmação. Remanejamento: três linhas,
 * porque é o momento em que o médico está indo para uma base NOVA — nomeia a
 * base de destino e enfatiza que o privado do bot entrega a chave sempre.
 */
export function buildChecklistKeyHint(baseCode: string, key: string, opts?: ChecklistHintOptions): string {
    if (!baseCode || !key) return "";
    const { reassignment = false, format = "markdown", botUrl = null } = opts ?? {};
    const b = (value: string) => (format === "markdown" ? `*${value}*` : value);

    if (reassignment) {
        return [
            "",
            "",
            `📋 Checklist da nova base ${b(baseCode)} · chave de hoje ${b(key)}`,
            `checklist.mnrs.com.br/b/${baseCode}`,
            `🔑 ${privateKeyInstruction(format, botUrl, "Você sempre pode pedir a chave")}`,
        ].join("\n");
    }

    return [
        "",
        "",
        `📋 Checklist ${b(baseCode)} · chave de hoje ${b(key)}`,
        `checklist.mnrs.com.br/b/${baseCode} · 🔑 ${privateKeyInstruction(format, botUrl, "a qualquer hora")}`,
    ].join("\n");
}

/**
 * Bloco usado quando a integração está configurada mas a consulta falhou
 * (timeout, rede, 5xx): sem a chave, mas nunca sem saída — o médico fica com o
 * /chave no privado (onde o pedido é reprocessado na hora) e o link da base.
 */
export function buildChecklistKeyUnavailableHint(baseCode: string, opts?: ChecklistHintOptions): string {
    if (!baseCode) return "";
    const { reassignment = false, format = "markdown", botUrl = null } = opts ?? {};
    const b = (value: string) => (format === "markdown" ? `*${value}*` : value);
    const baseLabel = reassignment ? `da nova base ${b(baseCode)}` : b(baseCode);

    return [
        "",
        "",
        `📋 Checklist ${baseLabel} — não consegui buscar a chave de hoje agora.`,
        `🔑 ${privateKeyInstruction(format, botUrl, "Pegue a chave")} · checklist.mnrs.com.br/b/${baseCode}`,
    ].join("\n");
}

/** Confirmações que registram ocupação — as que ganham anexos de chegada. */
export const ARRIVAL_REPLY_KINDS = new Set([
    "arrival_recorded",
    "arrival_p_recorded",
    "continuation_recorded",
    "half_shift_assumed",
    "reassignment_recorded",
]);

/**
 * Decide + busca o hint para QUALQUER confirmação que registre ocupação de
 * intervenção — fluxo normal, completação por botão (turno/destino/candidato)
 * ou correção. Regra: TODO caminho que confirma chegada em USA entrega a chave;
 * remanejamento entrega a chave da base de DESTINO com a variante enfática.
 */
export async function checklistHintForConfirmation(
    parsed: { sector?: string | null; isDeparture?: boolean; baseCode?: string | null },
    replyKind: string,
): Promise<string> {
    if (parsed.sector === "REGULATION" || parsed.isDeparture) return "";
    if (!ARRIVAL_REPLY_KINDS.has(replyKind)) return "";
    return fetchChecklistKeyHint(parsed.baseCode, { reassignment: replyKind === "reassignment_recorded" });
}

/**
 * Consulta crua da chave do dia no serviço do checklist. Nunca lança — todo
 * desfecho vira um status que o chamador transforma em texto (hint de chegada
 * aqui embaixo, ou as replies didáticas do /chave em checklist-key-request.ts).
 */
export async function fetchChecklistKey(baseCode: string | null | undefined): Promise<ChecklistKeyLookup> {
    const apiUrl = process.env.CHECKLIST_API_URL;
    const token = process.env.CHECKLIST_INTERNAL_TOKEN;
    if (!apiUrl || !token || !baseCode) return { status: "unconfigured" };
    try {
        const res = await fetch(`${apiUrl}/api/internal/keys/${encodeURIComponent(baseCode)}`, {
            headers: { "x-internal-token": token },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) {
            return res.status >= 500 ? { status: "unavailable" } : { status: "no_key" };
        }
        const data = (await res.json()) as ChecklistKeyResponse;
        if (!data.ok || !data.key || !data.baseCode) return { status: "no_key" };
        return { status: "ok", baseCode: data.baseCode, key: data.key };
    } catch {
        return { status: "unavailable" };
    }
}

/**
 * Busca a chave e devolve o bloco pronto para anexar a uma confirmação:
 *   - hint com a chave, quando o serviço respondeu;
 *   - "" quando a integração não está configurada, sem baseCode, ou o serviço
 *     respondeu deliberadamente que não há chave (4xx / ok:false) — base sem
 *     checklist não merece ruído;
 *   - hint SEM chave (aponta o /chave no privado) quando a consulta falhou por
 *     transporte: timeout, rede, 5xx, corpo ilegível.
 */
export async function fetchChecklistKeyHint(
    baseCode: string | null | undefined,
    opts?: ChecklistHintOptions,
): Promise<string> {
    const lookup = await fetchChecklistKey(baseCode);
    if (lookup.status === "unconfigured" || lookup.status === "no_key") return "";

    const botUrl = opts?.botUrl !== undefined ? opts.botUrl : await resolveChecklistKeyDeepLink();
    if (lookup.status === "unavailable") {
        return buildChecklistKeyUnavailableHint(baseCode as string, { ...opts, botUrl });
    }
    return buildChecklistKeyHint(lookup.baseCode, lookup.key, { ...opts, botUrl });
}
