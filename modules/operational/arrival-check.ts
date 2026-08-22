/**
 * Chegada × escala — NÍVEL A (agosto/2026): observar e avisar, sem interromper.
 *
 * Quem registra chegada num posto é comparado com quem a escala
 * (escala.mnrs.com.br) diz que era o titular daquele turno. Se a troca foi
 * oficializada no site, o esperado JÁ é o novo titular — então "chegou quem não
 * era esperado" é, por construção, o sinal de troca combinada por fora.
 *
 * O que este arquivo NÃO faz, de propósito, neste nível:
 *   - não bloqueia nada (isso é o nível C, previsto para outubro);
 *   - não pergunta nada a ninguém (nível B, setembro);
 *   - não acusa quando não tem certeza (ver `compararNome`).
 *
 * FAIL-SOFT em tudo: escala fora do ar, token errado, gateway de WhatsApp mudo
 * — nada disso pode derrubar o registro de uma chegada às 3h da manhã. Toda
 * falha vira log e a chegada segue.
 *
 * Só MEDICINA neste primeiro momento: o app é médico e a escala de enfermagem
 * não tem bot de chegada.
 */

import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs } from "@/db/schema";
import { getExpectedSchedule, type ExpectedDoctor } from "@/modules/operational/expected-schedule";
import { getTelegramAdminUserIds } from "@/modules/telegram/config";
import { sendMessage } from "@/modules/telegram/api";

export type VeredictoChegada = "confere" | "divergente" | "indeterminado" | "sem_escala";

export interface ResultadoChegada {
    veredicto: VeredictoChegada;
    /** Quem a escala esperava naquele posto (vazio = escala não sabia). */
    esperados: string[];
    /** 0..1 — o quanto o nome de quem chegou casa com algum esperado. */
    confianca: number;
}

/* --- Comparação de nome ---------------------------------------------------
   Não há id comum entre os dois sistemas: a chave é o nome. A régua tem três
   respostas, e a do meio é a que evita injustiça.

   - nome INTEIRO igual (ou um contido no outro, como "Ana Paula" dentro de
     "Ana Paula de Oliveira Mendes") → confere, confiança 1;
   - primeiro + último sobrenome iguais → confere, confiança 0,9. É o caso do
     médico que fala o nome curto no rádio;
   - só o primeiro nome batendo → INDETERMINADO. Existem cinco "Ana" na escala:
     afirmar divergência aqui seria acusar alguém por homonímia parcial;
   - nada em comum com nenhum esperado → divergente.
   -------------------------------------------------------------------------- */

export function normalizaNome(valor: string | null | undefined): string {
    return (valor ?? "")
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toUpperCase()
        .replace(/[^A-Z ]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

export function compararNome(chegou: string, esperados: string[]): { veredicto: VeredictoChegada; confianca: number } {
    const alvo = normalizaNome(chegou);
    if (!alvo) return { veredicto: "indeterminado", confianca: 0 };
    if (esperados.length === 0) return { veredicto: "sem_escala", confianca: 0 };

    let melhor = 0;
    for (const bruto of esperados) {
        const e = normalizaNome(bruto);
        if (!e) continue;
        if (e === alvo || e.includes(alvo) || alvo.includes(e)) return { veredicto: "confere", confianca: 1 };
        const pe = e.split(" ");
        const pa = alvo.split(" ");
        if (pe.length > 1 && pa.length > 1 && pe[0] === pa[0] && pe[pe.length - 1] === pa[pa.length - 1]) {
            return { veredicto: "confere", confianca: 0.9 };
        }
        if (pe[0] === pa[0]) melhor = Math.max(melhor, 0.5); // só o primeiro nome
    }
    // Primeiro nome bate com alguém esperado, o resto não: pode ser a mesma
    // pessoa dita pela metade, pode ser outra. Não se acusa no escuro.
    if (melhor >= 0.5) return { veredicto: "indeterminado", confianca: melhor };
    return { veredicto: "divergente", confianca: 0 };
}

function nomesEsperados(dados: Awaited<ReturnType<typeof getExpectedSchedule>>, posto: string): ExpectedDoctor[] {
    const board = dados?.current;
    if (!board) return [];
    const cod = posto.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (cod === "CRU" || cod === "REG") return board.regulation;
    if (cod === "COI") return board.coi;
    if (cod === "CH" || cod === "CP" || cod === "CHP") return board.chief;
    return board.intervention[cod] ?? [];
}

/** Texto do aviso — o mesmo nos dois canais, para não haver duas versões da
    verdade circulando entre coordenação e chefia. */
export function textoAviso(args: {
    medico: string;
    posto: string;
    turno: string;
    esperados: string[];
    indeterminado: boolean;
}): string {
    const quem = args.esperados.length ? args.esperados.join(", ") : "ninguém (posto sem titular na escala)";
    return args.indeterminado
        ? `⚠️ CONFERIR chegada\n\n${args.medico} registrou chegada em ${args.posto} (${args.turno}).\nA escala esperava: ${quem}.\nO nome bateu só em parte — pode ser a mesma pessoa dita pela metade. Vale conferir.`
        : `🔁 Chegada FORA da escala\n\n${args.medico} registrou chegada em ${args.posto} (${args.turno}).\nA escala esperava: ${quem}.\n\nSe houve troca, ela não está registrada no site. A partir de setembro o sistema vai pedir esclarecimento; de outubro em diante, a chegada não completa sem a troca registrada.`;
}

/* --- Canais de aviso ------------------------------------------------------- */

async function avisaTelegram(texto: string, chave: string): Promise<number> {
    if (!process.env.TELEGRAM_BOT_TOKEN?.trim()) return 0;
    const admins = [...new Set(getTelegramAdminUserIds().filter(Boolean))];
    let enviados = 0;
    for (const chatId of admins) {
        try {
            await sendMessage(chatId, texto);
            enviados += 1;
        } catch (erro) {
            console.error(`[chegada] telegram falhou ${chatId} (${chave})`, erro);
        }
    }
    return enviados;
}

/** whatsmeow-gw: POST /send/message {phone, message}, Basic auth. Desligado sem
    as variáveis — e desligado é o estado normal até a coordenação querer. */
async function avisaWhatsApp(texto: string, chave: string): Promise<number> {
    const url = process.env.WA_GATEWAY_URL?.trim();
    const auth = process.env.WA_GATEWAY_AUTH?.trim();
    const destinos = (process.env.WA_COORDENACAO_TO?.trim() ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!url || !auth || destinos.length === 0) return 0;

    let enviados = 0;
    for (const phone of destinos) {
        try {
            const resposta = await fetch(`${url.replace(/\/+$/, "")}/send/message`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    authorization: `Basic ${Buffer.from(auth).toString("base64")}`,
                },
                body: JSON.stringify({ phone, message: texto }),
                signal: AbortSignal.timeout(15_000),
            });
            if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
            enviados += 1;
        } catch (erro) {
            console.error(`[chegada] whatsapp falhou ${phone} (${chave})`, erro);
        }
    }
    return enviados;
}

/* --- Entrada pública ------------------------------------------------------- */

/**
 * Confere uma chegada contra a escala e avisa se divergir. NUNCA lança: quem
 * chama pode ignorar o retorno com segurança (e deve — a chegada já aconteceu).
 */
export async function conferirChegada(args: {
    ocupacaoId: string;
    doctorId: string;
    doctorName: string;
    posto: string;
    turno: string;
    quando?: Date;
    actorUserId?: string | null;
}): Promise<ResultadoChegada> {
    const vazio: ResultadoChegada = { veredicto: "sem_escala", esperados: [], confianca: 0 };
    try {
        const dados = await getExpectedSchedule(args.quando ?? new Date());
        const esperados = nomesEsperados(dados, args.posto);
        const nomes = esperados.map((e) => e.nome);
        const { veredicto, confianca } = compararNome(args.doctorName, nomes);
        if (veredicto === "confere" || veredicto === "sem_escala") {
            return { veredicto, esperados: nomes, confianca };
        }

        const chave = `${args.ocupacaoId}`;
        // A trilha é o registro que sobrevive ao aviso: WhatsApp e Telegram se
        // perdem no rolo da conversa, e em setembro/outubro é daqui que sai a
        // conta de quem chegou fora da escala.
        await getDb().insert(auditLogs).values({
            actorUserId: args.actorUserId ?? null,
            action: "chegada_fora_da_escala",
            entityType: "arrival_check",
            entityId: chave,
            details: {
                medico: args.doctorName,
                doctorId: args.doctorId,
                posto: args.posto,
                turno: args.turno,
                esperados: nomes,
                veredicto,
                confianca,
                nivel: "A",
            },
        });

        const texto = textoAviso({
            medico: args.doctorName,
            posto: args.posto,
            turno: args.turno,
            esperados: nomes,
            indeterminado: veredicto === "indeterminado",
        });
        const [tg, wa] = await Promise.all([avisaTelegram(texto, chave), avisaWhatsApp(texto, chave)]);
        console.log(
            `[chegada] ${veredicto} ${JSON.stringify({ medico: args.doctorName, posto: args.posto, telegram: tg, whatsapp: wa })}`,
        );
        return { veredicto, esperados: nomes, confianca };
    } catch (erro) {
        console.error("[chegada] conferência falhou (chegada segue normal)", erro);
        return vazio;
    }
}

/** Chegadas fora da escala do dia — insumo do painel da coordenação. */
export async function chegadasForaDaEscala(desde: Date) {
    return getDb()
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.action, "chegada_fora_da_escala"), eq(auditLogs.entityType, "arrival_check")))
        .then((linhas) => linhas.filter((l) => l.createdAt >= desde));
}
