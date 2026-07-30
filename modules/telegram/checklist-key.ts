/**
 * Integração com o app checklist (checklist.mnrs.com.br): ao confirmar uma
 * chegada em base de intervenção (USA), anexamos a chave do dia do checklist
 * daquela ambulância — o plantonista já sai da confirmação com tudo que
 * precisa para registrar o checklist.
 *
 * Fail-soft por princípio: o checklist é serviço acessório — qualquer erro,
 * timeout ou config ausente devolve string vazia e a confirmação de chegada
 * segue normal, sem a chave.
 */

const FETCH_TIMEOUT_MS = 1500;

export interface ChecklistKeyResponse {
    ok?: boolean;
    baseCode?: string;
    key?: string;
}

/**
 * Monta o bloco de texto anexado à confirmação de chegada. Pura — testável.
 *
 * Duas linhas: chave e link. O convite para o @samu_checklists_bot virou sufixo
 * do link em vez de uma terceira linha de instrução — a chegada da USA já vinha
 * com bloco maior que a própria confirmação.
 */
export function buildChecklistKeyHint(baseCode: string, key: string): string {
    if (!baseCode || !key) return "";
    return [
        "",
        "",
        `📋 Checklist *${baseCode}* · chave de hoje *${key}*`,
        `checklist.mnrs.com.br/b/${baseCode} · avisos: @samu_checklists_bot`,
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
 * ou correção. Regra: TODO caminho que confirma chegada em USA entrega a chave.
 */
export async function checklistHintForConfirmation(
    parsed: { sector?: string | null; isDeparture?: boolean; baseCode?: string | null },
    replyKind: string,
): Promise<string> {
    if (parsed.sector === "REGULATION" || parsed.isDeparture) return "";
    if (!ARRIVAL_REPLY_KINDS.has(replyKind)) return "";
    return fetchChecklistKeyHint(parsed.baseCode);
}

/**
 * Busca a chave do dia no serviço do checklist (mesmo host, porta local).
 * Retorna o hint pronto ou "" (sem chave / serviço indisponível / não configurado).
 */
export async function fetchChecklistKeyHint(baseCode: string | null | undefined): Promise<string> {
    const apiUrl = process.env.CHECKLIST_API_URL;
    const token = process.env.CHECKLIST_INTERNAL_TOKEN;
    if (!apiUrl || !token || !baseCode) return "";
    try {
        const res = await fetch(`${apiUrl}/api/internal/keys/${encodeURIComponent(baseCode)}`, {
            headers: { "x-internal-token": token },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) return "";
        const data = (await res.json()) as ChecklistKeyResponse;
        if (!data.ok || !data.key || !data.baseCode) return "";
        return buildChecklistKeyHint(data.baseCode, data.key);
    } catch {
        return "";
    }
}
