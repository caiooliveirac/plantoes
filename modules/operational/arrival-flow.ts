/**
 * Chegada × escala — NÍVEL B (setembro/2026): perguntar e registrar.
 *
 * O nível A (arrival-check.ts) observa e avisa. Aqui o bot passa a CONVERSAR:
 * diz por nome quem era esperado e quem chegou, e oferece dois botões —
 * "troquei com <esperado>" ou "peguei de outra pessoa". No segundo caso pede o
 * nome e sobrenome, casa com o cadastro de médicos e registra.
 *
 * PARA QUEM VAI A PERGUNTA. Não existe vínculo médico ↔ Telegram neste sistema
 * (o médico se identifica por codinome, que não persiste chat id). Então a
 * pergunta vai para quem ESTÁ no bot: chefes de plantão e admin. Na prática é
 * quem está no posto junto com o médico e pode responder na hora. Quando
 * houver vínculo por médico, muda só o destinatário — o resto do fluxo serve.
 *
 * ESTADO DA CONVERSA sem tabela nova: o pedido de nome vive numa linha de
 * audit_logs com action "chegada_pergunta" e entityId = id da mensagem do bot.
 * A resposta é reconhecida por ser um REPLY àquela mensagem — determinístico,
 * sem máquina de estado global e sem confundir duas perguntas simultâneas.
 */

import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, doctors } from "@/db/schema";
import { answerCallbackQuery, buildInlineKeyboard, sendMessage } from "@/modules/telegram/api";
import { getTelegramAdminUserIds, getTelegramChiefUserIds } from "@/modules/telegram/config";
import { avisarCoordenacao, normalizaNome } from "@/modules/operational/arrival-check";

const PREFIXO = "chg:";

export interface ContextoChegada {
    ocupacaoId: string;
    medico: string;
    posto: string;
    turno: string;
    esperados: string[];
}

/** "esperava FULANO, chegou BELTRANO" — dito com todas as letras, porque é a
    frase que faz a pessoa lembrar da troca que combinou por WhatsApp. */
export function textoPergunta(ctx: ContextoChegada): string {
    const esperado = ctx.esperados.length ? ctx.esperados.join(" ou ") : "ninguém (posto sem titular)";
    return [
        `🔁 Chegada diferente da escala — ${ctx.posto} · ${ctx.turno}`,
        "",
        `A escala esperava: ${esperado}`,
        `Quem registrou chegada: ${ctx.medico}`,
        "",
        "Foi troca? Toque abaixo. A partir de outubro, chegada sem troca registrada no site não completa.",
    ].join("\n");
}

export function tecladoPergunta(ocupacaoId: string, esperados: string[]) {
    const comQuem = esperados[0] ? esperados[0].split(" ").slice(0, 2).join(" ") : "o titular";
    return buildInlineKeyboard([
        [{ text: `✅ Troquei com ${comQuem}`, callback_data: `${PREFIXO}t:${ocupacaoId}`.slice(0, 64) }],
        [{ text: "👤 Peguei de OUTRA pessoa", callback_data: `${PREFIXO}o:${ocupacaoId}`.slice(0, 64) }],
        [{ text: "⚠️ Não é troca (erro de registro)", callback_data: `${PREFIXO}e:${ocupacaoId}`.slice(0, 64) }],
    ]);
}

/** Manda a pergunta para chefes e admins. Devolve quantos receberam. */
export async function perguntarSobreChegada(ctx: ContextoChegada): Promise<number> {
    if (!process.env.TELEGRAM_BOT_TOKEN?.trim()) return 0;
    const destinos = [...new Set([...getTelegramChiefUserIds(), ...getTelegramAdminUserIds()].filter(Boolean))];
    let enviados = 0;
    for (const chatId of destinos) {
        try {
            await sendMessage(chatId, textoPergunta(ctx), undefined, tecladoPergunta(ctx.ocupacaoId, ctx.esperados));
            enviados += 1;
        } catch (erro) {
            console.error(`[chegada-b] pergunta falhou ${chatId}`, erro);
        }
    }
    return enviados;
}

/* --- Resposta pelos botões -------------------------------------------------- */

export function parseCallbackChegada(data: string | undefined): { acao: "t" | "o" | "e"; ocupacaoId: string } | null {
    if (!data?.startsWith(PREFIXO)) return null;
    const [acao, ...resto] = data.slice(PREFIXO.length).split(":");
    if (acao !== "t" && acao !== "o" && acao !== "e") return null;
    const ocupacaoId = resto.join(":");
    return ocupacaoId ? { acao, ocupacaoId } : null;
}

export async function responderChegada(args: {
    callbackQueryId: string;
    chatId: number;
    quemRespondeu: string;
    acao: "t" | "o" | "e";
    ocupacaoId: string;
}): Promise<{ ok: true; pedeNome: boolean }> {
    const registrar = (detalhe: Record<string, unknown>) =>
        getDb().insert(auditLogs).values({
            action: "chegada_esclarecida",
            entityType: "arrival_check",
            entityId: args.ocupacaoId,
            details: { ...detalhe, respondidoPor: args.quemRespondeu, nivel: "B" },
        });

    if (args.acao === "t") {
        await registrar({ resposta: "trocou_com_o_titular" });
        await answerCallbackQuery(args.callbackQueryId, "Registrado: troca com o titular.");
        await sendMessage(
            args.chatId,
            "✅ Anotado: troca com o titular da escala.\n\nRegistre a troca no site para valer oficialmente — a partir de outubro é ela que libera a chegada: https://escala.mnrs.com.br",
        );
        return { ok: true, pedeNome: false };
    }

    if (args.acao === "e") {
        await registrar({ resposta: "erro_de_registro" });
        await answerCallbackQuery(args.callbackQueryId, "Anotado como erro de registro.");
        await sendMessage(args.chatId, "⚠️ Anotado como erro de registro. A coordenação vai conferir.");
        return { ok: true, pedeNome: false };
    }

    // "peguei de outra pessoa": pede o nome e deixa a pergunta pendurada na
    // MENSAGEM — a resposta é reconhecida por ser um reply a ela.
    await answerCallbackQuery(args.callbackQueryId, "De quem você pegou?");
    const enviada = await sendMessage(
        args.chatId,
        "👤 Responda a ESTA mensagem com o *nome e sobrenome* de quem passou o plantão.\n\nEx.: Ana Paula Mendes",
        undefined,
        { force_reply: true, selective: true } as never,
    );
    const messageId = (enviada as { result?: { message_id?: number } })?.result?.message_id;
    if (messageId) {
        await getDb().insert(auditLogs).values({
            action: "chegada_pergunta",
            entityType: "arrival_check",
            entityId: String(messageId),
            details: { ocupacaoId: args.ocupacaoId, chatId: args.chatId, quemRespondeu: args.quemRespondeu },
        });
    }
    return { ok: true, pedeNome: true };
}

/* --- Resposta em texto (reply à pergunta) ----------------------------------- */

/** Casa o nome digitado com o cadastro de médicos. Devolve o melhor palpite e
    se ele é confiável — o mesmo critério do nível A: nome inteiro ou primeiro +
    último sobrenome é certeza; só o primeiro nome não basta para afirmar. */
export async function casarNomeDigitado(texto: string): Promise<{ nome: string | null; confiavel: boolean; candidatos: string[] }> {
    const alvo = normalizaNome(texto);
    if (alvo.length < 3) return { nome: null, confiavel: false, candidatos: [] };
    const lista = await getDb().select({ nome: doctors.fullName, ativo: doctors.isActive }).from(doctors);
    const ativos = lista.filter((d) => d.ativo);

    const exatos = ativos.filter((d) => {
        const n = normalizaNome(d.nome);
        return n === alvo || n.includes(alvo) || alvo.includes(n);
    });
    if (exatos.length === 1) return { nome: exatos[0].nome, confiavel: true, candidatos: [] };

    const partes = alvo.split(" ");
    const porPrimeiroEUltimo = ativos.filter((d) => {
        const p = normalizaNome(d.nome).split(" ");
        return partes.length > 1 && p[0] === partes[0] && p[p.length - 1] === partes[partes.length - 1];
    });
    if (porPrimeiroEUltimo.length === 1) return { nome: porPrimeiroEUltimo[0].nome, confiavel: true, candidatos: [] };

    const candidatos = [...new Set([...exatos, ...porPrimeiroEUltimo].map((d) => d.nome))];
    if (candidatos.length === 0) {
        const soPrimeiro = ativos.filter((d) => normalizaNome(d.nome).split(" ")[0] === partes[0]).map((d) => d.nome);
        return { nome: null, confiavel: false, candidatos: soPrimeiro.slice(0, 6) };
    }
    return { nome: null, confiavel: false, candidatos: candidatos.slice(0, 6) };
}

/** A mensagem é resposta a uma pergunta nossa? Devolve o contexto pendente. */
export async function pendenteDaResposta(replyToMessageId: number) {
    const [linha] = await getDb()
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.action, "chegada_pergunta"), eq(auditLogs.entityType, "arrival_check"), eq(auditLogs.entityId, String(replyToMessageId))))
        .orderBy(desc(auditLogs.createdAt))
        .limit(1);
    return linha ?? null;
}

/** Processa o nome digitado: casa, registra e avisa a coordenação. */
export async function registrarQuemPassou(args: {
    replyToMessageId: number;
    chatId: number;
    texto: string;
    quemRespondeu: string;
}): Promise<boolean> {
    const pendente = await pendenteDaResposta(args.replyToMessageId);
    if (!pendente) return false;

    const detalhes = pendente.details as { ocupacaoId?: string };
    const { nome, confiavel, candidatos } = await casarNomeDigitado(args.texto);

    if (!nome) {
        const dica = candidatos.length
            ? `\n\nQuis dizer: ${candidatos.join(" · ")}? Responda a esta mensagem com o nome completo.`
            : "\n\nNão achei esse nome no cadastro de médicos. Responda a esta mensagem com o nome completo.";
        await sendMessage(args.chatId, `❓ Não consegui identificar com segurança "${args.texto.trim()}".${dica}`);
        // a pendência continua de pé: a próxima resposta tenta de novo
        return true;
    }

    await getDb().insert(auditLogs).values({
        action: "chegada_esclarecida",
        entityType: "arrival_check",
        entityId: detalhes.ocupacaoId ?? String(args.replyToMessageId),
        details: {
            resposta: "pegou_de_outro",
            passouOPlantao: nome,
            textoDigitado: args.texto.trim(),
            confiavel,
            respondidoPor: args.quemRespondeu,
            nivel: "B",
        },
    });

    await sendMessage(
        args.chatId,
        `✅ Registrado: o plantão veio de ${nome}.\n\nPara valer oficialmente, a troca precisa estar no site — a partir de outubro é ela que libera a chegada: https://escala.mnrs.com.br`,
    );

    // e a coordenação fica sabendo pelos dois canais, como combinado
    await avisarCoordenacao(
        [
            "🔁 Troca informada no plantão",
            "",
            `Quem passou o plantão: ${nome}`,
            `Informado por: ${args.quemRespondeu}`,
            "",
            "A troca NÃO está registrada no site — é isso que precisa mudar até outubro.",
        ].join("\n"),
        `esclarecimento:${detalhes.ocupacaoId ?? args.replyToMessageId}`,
    );
    return true;
}
