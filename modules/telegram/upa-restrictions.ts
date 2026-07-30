/**
 * UPAs restritas pela chefia — leitura do app `tabela` (mnrs.com.br/tabela).
 *
 * A chefia restringe a célula da UPA no painel (com PIN); aqui só LEMOS. O
 * regulador que acabou de assumir um ramal recebe a lista junto da confirmação
 * de chegada, e qualquer um pode consultar com /upas.
 *
 * ATENÇÃO à topologia dos bots: o aviso PERIÓDICO dessas restrições sai no
 * grupo dos reguladores pelo BOT REGULADOR (que vive no repo `tabela`). Este
 * arquivo é do bot Plantões SAMU — outro token, outro grupo. Ver
 * docs/upas-restritas.md.
 *
 * Fail-soft por princípio, igual ao checklist: erro, timeout ou config ausente
 * devolve string vazia e a chegada é confirmada normalmente.
 */

import { ARRIVAL_REPLY_KINDS } from "@/modules/telegram/checklist-key";

const FETCH_TIMEOUT_MS = 1500;
// Teto de linhas no balão de chegada — a lista não pode virar o assunto
// principal da confirmação.
const MAX_LINES = 6;

export interface UpaRestrictionEntry {
    unitName: string;
    untilLabel: string;
}

interface UpaRestrictionsResponse {
    ok?: boolean;
    restrictions?: Array<{ unitName?: string; untilLabel?: string }>;
}

/** Bloco anexado à confirmação de chegada. Vazio quando não há restrição. */
export function buildUpaRestrictionsHint(entries: UpaRestrictionEntry[]): string {
    if (entries.length === 0) return "";

    const shown = entries.slice(0, MAX_LINES);
    const rest = entries.length - shown.length;
    const lines = shown.map((e) => `• ${e.unitName} — até ${e.untilLabel}`);
    if (rest > 0) lines.push(`• ... e mais ${rest}`);

    return ["", "", "🚫 *UPAs restritas pela chefia*", ...lines].join("\n");
}

/** Resposta do /upas — diz explicitamente quando não há nenhuma. */
export function buildUpaRestrictionsCommandReply(entries: UpaRestrictionEntry[] | null): string {
    if (entries === null) {
        return "⚠️ Não consegui consultar as restrições agora. Veja em mnrs.com.br/tabela (aba UPAs).";
    }
    if (entries.length === 0) {
        return "✅ *Nenhuma UPA restrita agora.*\nA chefia restringe em mnrs.com.br/tabela (aba UPAs).";
    }
    return [
        `🚫 *${entries.length} UPA${entries.length === 1 ? "" : "s"} restrita${entries.length === 1 ? "" : "s"} pela chefia*`,
        ...entries.map((e) => `• ${e.unitName} — até ${e.untilLabel}`),
    ].join("\n");
}

/**
 * Busca as restrições vigentes no `tabela`. Retorna null quando não deu para
 * consultar (sem config, fora do ar, timeout) — quem chama decide se silencia
 * (chegada) ou avisa (comando).
 */
export async function fetchUpaRestrictions(): Promise<UpaRestrictionEntry[] | null> {
    const apiUrl = process.env.TABELA_API_URL?.trim();
    if (!apiUrl) return null;

    try {
        const res = await fetch(`${apiUrl.replace(/\/$/, "")}/upas/restrictions`, {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) return null;

        const data = (await res.json()) as UpaRestrictionsResponse;
        if (!data.ok || !Array.isArray(data.restrictions)) return null;

        return data.restrictions
            .map((row) => ({
                unitName: String(row.unitName ?? "").trim(),
                untilLabel: String(row.untilLabel ?? "").trim(),
            }))
            .filter((row) => row.unitName && row.untilLabel);
    } catch {
        return null;
    }
}

/**
 * Decide + busca o bloco para a confirmação de chegada. Regra: só REGULAÇÃO.
 * Quem assume ramal é quem decide para onde o paciente vai — o intervencionista
 * recebe a chave do checklist, não a lista de UPAs.
 */
export async function upaRestrictionsHintForConfirmation(
    parsed: { sector?: string | null; isDeparture?: boolean },
    replyKind: string,
): Promise<string> {
    if (parsed.sector !== "REGULATION" || parsed.isDeparture) return "";
    if (!ARRIVAL_REPLY_KINDS.has(replyKind)) return "";

    const entries = await fetchUpaRestrictions();
    if (!entries) return "";
    return buildUpaRestrictionsHint(entries);
}
