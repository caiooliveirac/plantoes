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

/** Monta o bloco de texto anexado à confirmação de chegada. Pura — testável. */
export function buildChecklistKeyHint(baseCode: string, key: string): string {
    if (!baseCode || !key) return "";
    return [
        "",
        "",
        `📋 Checklist da *${baseCode}* — chave de hoje: *${key}*`,
        `checklist.mnrs.com.br/b/${baseCode}`,
    ].join("\n");
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
