/**
 * Aviso de deslocamento — quem perde a posição não pode sumir calado.
 *
 * Deslocar tira a titularidade do quadro sem fechar a ocupação: o médico segue
 * ativo, fora do painel, até redeclarar onde está. Enquanto ninguém sabe disso,
 * ele desaparece da tela e ninguém toma atitude — e o plantão dele corre risco
 * de não virar pagamento. Foi o que aconteceu em agosto/2026 com Bruno Pedreira
 * (PIAM), Pollianna Roriz (PIAM) e Kêmylla Souza (2152).
 *
 * Dois destinos, porque servem a coisas diferentes:
 *   - o GRUPO da escala, onde o médico está: para ele declarar a nova posição;
 *   - a COORDENAÇÃO (Telegram + WhatsApp, via avisarCoordenacao): para alguém
 *     de fora reparar que a posição trocou de dono no meio do turno.
 *
 * FAIL-SOFT por construção: o deslocamento já aconteceu no banco quando esta
 * função roda. Gateway mudo, token errado, rede fora — nada disso pode derrubar
 * a operação. Toda falha vira log.
 */
import { avisarCoordenacao } from "@/modules/operational/arrival-check";
import { getTelegramAnnouncementChatIds } from "@/modules/telegram/config";
import { sendMessage } from "@/modules/telegram/api";

export interface DisplacementAlertInput {
    /** Quem perdeu a posição. */
    doctorName: string;
    /** Ramal (regulação) ou base (intervenção) de onde saiu. */
    targetCode: string;
    /** Quem assumiu, quando o registro soube dizer. */
    takenByDoctorName?: string | null;
    domain: "regulation" | "intervention";
}

export function buildDisplacementGroupMessage(input: DisplacementAlertInput): string {
    const posicao = input.domain === "regulation"
        ? `o ramal ${input.targetCode}`
        : `a base ${input.targetCode}`;
    const quem = input.takenByDoctorName?.trim()
        ? `${input.takenByDoctorName.trim()} assumiu`
        : "outro médico assumiu";

    return [
        `⚠️ ${input.doctorName}, ${quem} ${posicao}.`,
        "",
        "Seu plantão continua aberto e nada foi perdido — mas você está fora do quadro até dizer onde ficou.",
        "",
        "Responda com a nova posição (ex.: \"Fulano 2153 SD\"). Se você saiu, avise a saída normalmente.",
    ].join("\n");
}

export function buildDisplacementCoordinationMessage(input: DisplacementAlertInput): string {
    const posicao = input.domain === "regulation"
        ? `o ramal ${input.targetCode}`
        : `a base ${input.targetCode}`;
    const quem = input.takenByDoctorName?.trim() ?? "outro médico";

    return [
        "🔄 Deslocamento no quadro",
        "",
        `${input.doctorName} perdeu ${posicao} para ${quem}.`,
        "O plantão dele segue ATIVO fora do quadro até declarar nova posição.",
        "",
        "Se ele cumprir o plantão sem ser retirado, o plantão é pago — mas alguém precisa confirmar onde ele ficou.",
    ].join("\n");
}

/** Nunca lança: quem chama pode ignorar o retorno com segurança. */
export async function avisarDeslocamento(input: DisplacementAlertInput): Promise<void> {
    try {
        const chave = `deslocamento:${input.domain}:${input.targetCode}:${input.doctorName}`;

        await Promise.all([
            avisarCoordenacao(buildDisplacementCoordinationMessage(input), chave),
            ...getTelegramAnnouncementChatIds().map(async (chatId) => {
                try {
                    await sendMessage(chatId, buildDisplacementGroupMessage(input));
                } catch (erro) {
                    console.error(`[deslocamento] grupo ${chatId} falhou`, erro);
                }
            }),
        ]);
    } catch (erro) {
        console.error("[deslocamento] aviso falhou", erro);
    }
}
