/**
 * Integração com o app checklist (checklist.mnrs.com.br): ao confirmar uma
 * chegada em base de intervenção (USA), anexamos a chave do dia do checklist
 * daquela ambulância — o plantonista já sai da confirmação com tudo que
 * precisa para registrar o checklist. Remanejamento ganha variante própria:
 * a chave mostrada é sempre a da BASE DE DESTINO, dita com todas as letras.
 *
 * Fail-soft por princípio: o checklist é serviço acessório — nenhuma falha
 * derruba a confirmação. Mas com a integração CONFIGURADA, falha de consulta
 * (timeout, rede, 5xx) não é mais silêncio total: sai o bloco sem a chave
 * apontando o privado do bot do checklist, onde o médico consulta a chave a
 * qualquer momento. Sem config (dev/testes) ou com resposta negativa
 * deliberada (base sem checklist), continua tudo vazio como antes.
 */

const FETCH_TIMEOUT_MS = 1500;

const CHECKLIST_BOT_USERNAME = "samu_checklists_bot";
export const CHECKLIST_BOT_URL = `https://t.me/${CHECKLIST_BOT_USERNAME}`;

export interface ChecklistKeyResponse {
    ok?: boolean;
    baseCode?: string;
    key?: string;
}

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
}

// O username do bot tem `_` — em Markdown v1 do Telegram, solto no texto,
// `_checklists_` vira itálico e a menção sai quebrada e sem link (era o que
// acontecia com o antigo "avisos: @samu_checklists_bot"). A url dentro de um
// [link](...) não é parseada, então o username só viaja ali.
function botPrivateLink(format: "markdown" | "plain"): string {
    return format === "markdown" ? `[falar com o bot](${CHECKLIST_BOT_URL})` : CHECKLIST_BOT_URL;
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
    const { reassignment = false, format = "markdown" } = opts ?? {};
    const b = (value: string) => (format === "markdown" ? `*${value}*` : value);

    if (reassignment) {
        return [
            "",
            "",
            `📋 Checklist da nova base ${b(baseCode)} · chave de hoje ${b(key)}`,
            `checklist.mnrs.com.br/b/${baseCode}`,
            `🔑 Você sempre pode consultar a chave no privado: ${botPrivateLink(format)}`,
        ].join("\n");
    }

    return [
        "",
        "",
        `📋 Checklist ${b(baseCode)} · chave de hoje ${b(key)}`,
        `checklist.mnrs.com.br/b/${baseCode} · 🔑 chave no privado: ${botPrivateLink(format)}`,
    ].join("\n");
}

/**
 * Bloco usado quando a integração está configurada mas a consulta falhou
 * (timeout, rede, 5xx): sem a chave, mas nunca sem saída — o médico fica com o
 * link da base e o privado do bot, que responde a chave a qualquer momento.
 */
export function buildChecklistKeyUnavailableHint(baseCode: string, opts?: ChecklistHintOptions): string {
    if (!baseCode) return "";
    const { reassignment = false, format = "markdown" } = opts ?? {};
    const b = (value: string) => (format === "markdown" ? `*${value}*` : value);
    const baseLabel = reassignment ? `da nova base ${b(baseCode)}` : b(baseCode);

    return [
        "",
        "",
        `📋 Checklist ${baseLabel} — não consegui buscar a chave de hoje agora.`,
        `🔑 Pegue a chave no privado: ${botPrivateLink(format)} · checklist.mnrs.com.br/b/${baseCode}`,
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
 * Busca a chave do dia no serviço do checklist (mesmo host, porta local).
 * Nunca lança. Retorna:
 *   - o hint com a chave, quando o serviço respondeu;
 *   - "" quando a integração não está configurada, sem baseCode, ou o serviço
 *     respondeu deliberadamente que não há chave (4xx / ok:false) — base sem
 *     checklist não merece ruído;
 *   - o hint SEM chave (privado do bot) quando a consulta falhou por
 *     transporte: timeout, rede, 5xx, corpo ilegível.
 */
export async function fetchChecklistKeyHint(
    baseCode: string | null | undefined,
    opts?: ChecklistHintOptions,
): Promise<string> {
    const apiUrl = process.env.CHECKLIST_API_URL;
    const token = process.env.CHECKLIST_INTERNAL_TOKEN;
    if (!apiUrl || !token || !baseCode) return "";
    try {
        const res = await fetch(`${apiUrl}/api/internal/keys/${encodeURIComponent(baseCode)}`, {
            headers: { "x-internal-token": token },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) {
            return res.status >= 500 ? buildChecklistKeyUnavailableHint(baseCode, opts) : "";
        }
        const data = (await res.json()) as ChecklistKeyResponse;
        if (!data.ok || !data.key || !data.baseCode) return "";
        return buildChecklistKeyHint(data.baseCode, data.key, opts);
    } catch {
        return buildChecklistKeyUnavailableHint(baseCode, opts);
    }
}
