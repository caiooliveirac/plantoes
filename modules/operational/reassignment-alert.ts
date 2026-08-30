/**
 * Aviso de remanejamento feito pelo QUADRO (web) — o buraco que faltava na
 * entrega da chave do checklist: o remanejamento via bot já confirma no grupo
 * com a chave da base de destino, mas o remanejamento que a coordenação faz
 * pelo quadro não passava pelo Telegram — o médico mudava de base sem saber a
 * chave (pedido da coordenação, 2026-08-30).
 *
 * Só anuncia destino em BASE DE INTERVENÇÃO: chave é coisa de USA, e
 * transferOperationalOccupancy só aceita ocupação ATIVA, então todo anúncio é
 * de remanejamento vivo, nunca de correção retroativa. Remanejamento para
 * ramal segue silencioso (o quadro/SSE já mostra e não há chave a entregar).
 *
 * FAIL-SOFT por construção, igual ao displacement-alert: o remanejamento já
 * aconteceu no banco quando isto roda — gateway mudo, rede fora, nada disso
 * pode derrubar a operação. Toda falha vira log.
 */
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { doctors } from "@/db/schema";
import { escapeTelegramMarkdown, sendMessage } from "@/modules/telegram/api";
import { fetchChecklistKeyHint } from "@/modules/telegram/checklist-key";
import { getTelegramAnnouncementChatIds } from "@/modules/telegram/config";

export interface QuadroReassignmentAlertInput {
    /** Médico movido (movedSnapshot.doctorId ou displaced.createdSnapshot.doctorId). */
    doctorId: string;
    destination: { domain: "regulation" | "intervention"; code: string };
    /** De onde saiu, quando o chamador souber dizer (só entra na frase). */
    sourceCode?: string | null;
}

export function buildQuadroReassignmentMessage(params: {
    doctorName: string;
    destinationCode: string;
    sourceCode?: string | null;
}): string {
    const doctor = escapeTelegramMarkdown(params.doctorName);
    const origem = params.sourceCode ? ` de *${escapeTelegramMarkdown(params.sourceCode)}*` : "";
    return `🔀 *${doctor}* remanejado${origem} para a base *${params.destinationCode}* pela coordenação (quadro).`
        + `\nChegada original preservada — sem atraso.`;
}

/** Nunca lança: quem chama pode disparar com `void` com segurança. */
export async function avisarRemanejamentoQuadro(input: QuadroReassignmentAlertInput): Promise<void> {
    try {
        if (input.destination.domain !== "intervention") {
            return;
        }

        const chatIds = getTelegramAnnouncementChatIds();
        if (chatIds.length === 0) {
            return;
        }

        const doctor = await getDb().query.doctors.findFirst({ where: eq(doctors.id, input.doctorId) });
        const doctorName = doctor?.displayName?.trim() || doctor?.fullName?.trim() || "Médico";

        // Chave da base de DESTINO na variante de remanejamento; se o serviço do
        // checklist falhar, o próprio hint vira o fallback com o /chave no privado.
        const checklistHint = await fetchChecklistKeyHint(input.destination.code, { reassignment: true });

        const text = buildQuadroReassignmentMessage({
            doctorName,
            destinationCode: input.destination.code,
            sourceCode: input.sourceCode ?? null,
        }) + checklistHint;

        await Promise.all(chatIds.map(async (chatId) => {
            try {
                await sendMessage(chatId, text, undefined, undefined, { parseMode: "Markdown" });
            } catch (erro) {
                console.error(`[remanejamento-quadro] grupo ${chatId} falhou`, erro);
            }
        }));
    } catch (erro) {
        console.error("[remanejamento-quadro] aviso falhou", erro);
    }
}
