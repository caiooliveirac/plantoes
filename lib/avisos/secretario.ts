/**
 * Aviso para o secretário (app `tom`), que entrega no WhatsApp da coordenação.
 *
 * Existe porque o autoatendimento do banco de horas mexe na FOLHA de alguém sem
 * passar por ninguém: o médico declara um extra de 12h ou tira um plantão da
 * própria folha, e hoje isso só chega ao Telegram do admin. Quem responde pela
 * escala precisa saber no minuto — qual médico, qual dia, e o que ele fez —
 * porque a conferência acontece dias depois, quando ninguém lembra mais.
 *
 * O `tom` é quem fala com aqueles dois números: ele já tem a allowlist, o
 * formato e o "para" que cala o canal. Mandar daqui direto para o gateway do
 * WhatsApp seria um segundo dono da mesma conversa.
 *
 * NUNCA levanta. Um aviso que falha não pode desfazer um lançamento que já
 * aconteceu — o registro no `audit_logs` é a verdade, isto aqui é cortesia.
 */

const TIMEOUT_MS = 5_000;

export async function avisarSecretario(texto: string): Promise<void> {
    const url = process.env.TOM_AVISO_URL?.trim();
    if (!url || !texto.trim()) {
        return;
    }

    try {
        const resposta = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(process.env.TOM_HOOK_SECRET?.trim()
                    ? { "x-tom-secret": process.env.TOM_HOOK_SECRET.trim() }
                    : {}),
            },
            body: JSON.stringify({ texto }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!resposta.ok) {
            console.warn(`[aviso] secretário respondeu ${resposta.status}`);
        }
    } catch (erro) {
        console.warn(`[aviso] secretário indisponível: ${erro instanceof Error ? erro.message : erro}`);
    }
}
