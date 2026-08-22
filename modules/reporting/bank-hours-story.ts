/**
 * O plantão contado em português, para quem vai decidir o bônus.
 *
 * A prova técnica (`buildBankHoursProof`) diz "a entrada considerada foi X para
 * uma janela prevista em Y" — está correta e é ilegível de relance. Quem recebe
 * o aviso no WhatsApp ou abre a tela precisa de outra coisa: o que a pessoa
 * falou ao chegar, o que falou ao sair, quem a rendeu, e por que aquilo virou
 * crédito. Se a história não fecha, o erro salta (foi assim que o caso Murilo
 * Damasceno na PR03, 21/08/2026, passou despercebido por um dia inteiro).
 *
 * Puro: recebe fatos, devolve frases. Sem I/O, sem "agora".
 */

import { describeLateDepartureReason, type BankHoursLateDeparture } from "@/modules/reporting/bank-hours-labels";

export interface BankHoursStoryInput {
    doctorName: string;
    targetCode: string;
    shiftLabel: string | null;
    /** Texto cru das mensagens do bot guardado na ocupação. */
    notes: string | null;
    /** Início previsto pela janela do banco. */
    scheduledStartAt: string | null;
    scheduledEndAt: string | null;
    /** Chegada avisada pelo médico. */
    startedAt: string | null;
    /** Saída física que ele declarou. */
    actualEndedAt: string | null;
    /** Rendição do quadro (quando outra pessoa assumiu antes da saída física). */
    handoffEndedAt: string | null;
    /** Fim usado no cálculo. */
    countedEndAt: string | null;
    arrivalDelayMinutes: number | null;
    overtimeMinutes: number | null;
    creditedOvertimeMinutes: number | null;
    balanceMinutes: number | null;
    lateDeparture?: BankHoursLateDeparture | null;
    successorDoctorName?: string | null;
    successorTookOverAt?: string | null;
    /** Rótulo curto da validação da chefia (BankHoursApproval.label). */
    approvalLabel?: string | null;
    approvalPending?: boolean;
}

export interface BankHoursStory {
    /** Uma linha: quem, onde, quando, quanto. Serve de assunto do aviso. */
    headline: string;
    /** A história em 2–4 frases curtas. */
    sentences: string[];
}

const HORA = new Intl.DateTimeFormat("pt-BR", {
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/Sao_Paulo",
});
const DIA = new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit", month: "2-digit", timeZone: "America/Sao_Paulo",
});

function hora(value: string | null | undefined) {
    return value ? HORA.format(new Date(value)) : null;
}

function dia(value: string | null | undefined) {
    return value ? DIA.format(new Date(value)) : null;
}

/** "1h20" / "40 min" — nunca "80 minutos", que ninguém lê rápido. */
export function duracaoHumana(minutes: number) {
    const total = Math.abs(Math.round(minutes));
    if (total < 60) {
        return `${total} min`;
    }

    const horas = Math.floor(total / 60);
    const resto = total % 60;
    return resto === 0 ? `${horas}h` : `${horas}h${String(resto).padStart(2, "0")}`;
}

function primeiroNome(fullName: string) {
    return fullName.trim().split(/\s+/)[0] ?? fullName;
}

function limpaFrase(value: string) {
    return value.replace(/\s+/g, " ").trim().replace(/^["'“”]+|["'“”]+$/g, "");
}

/**
 * O que o médico escreveu ao chegar: a primeira linha das notas, que é o texto
 * cru da mensagem do Telegram. Linhas entre colchetes são marcações do sistema
 * ([telegram saida ajustada], [NÃO SAIU], [DESLOCADO]…), não fala dele.
 */
export function extractArrivalPhrase(notes: string | null | undefined): string | null {
    for (const raw of (notes ?? "").split("\n")) {
        const line = limpaFrase(raw);
        if (!line || line.startsWith("[")) continue;
        if (/^remanejado de /i.test(line)) continue;
        return line;
    }
    return null;
}

/** O que ele escreveu ao sair — a linha marcada pelo bot como saída. */
export function extractDeparturePhrase(notes: string | null | undefined): string | null {
    for (const raw of (notes ?? "").split("\n")) {
        const match = raw.match(/\[telegram sa[ií]da ajustada\]\s*(.+)$/i);
        if (match?.[1]) {
            const phrase = limpaFrase(match[1]);
            if (phrase) return phrase;
        }
    }
    return null;
}

function descreveTurno(shiftLabel: string | null) {
    if (shiftLabel === "P") return "plantão de 24h (P)";
    if (shiftLabel === "SD") return "diurno (SD)";
    if (shiftLabel === "SN") return "noturno (SN)";
    return "plantão";
}

function frasePorQueFicou(input: BankHoursStoryInput) {
    const motivo = describeLateDepartureReason(input.lateDeparture ?? null);
    if (motivo) return `disse que ${motivo}`;

    const fala = extractDeparturePhrase(input.notes);
    if (!fala) return null;
    const ocorrencia = fala.match(/\boc(?:orr[eê]ncia)?\.?\s*n?º?\s*(\d{3,6})\b/i);
    if (ocorrencia) return `disse que estava na ocorrência ${ocorrencia[1]}`;
    if (/rendid|rendi[çc][aã]o/i.test(fala)) return "disse que esperou a rendição";
    if (/higieniza/i.test(fala)) return "disse que estava na higienização da viatura";
    return null;
}

/**
 * Monta a história do plantão. As frases saem na ordem em que a coisa aconteceu:
 * chegada → saída → o que isso virou no banco → o que falta decidir.
 */
export function buildBankHoursStory(input: BankHoursStoryInput): BankHoursStory {
    const nome = primeiroNome(input.doctorName);
    const atraso = input.arrivalDelayMinutes ?? 0;
    const credito = input.creditedOvertimeMinutes ?? 0;
    const excedente = input.overtimeMinutes ?? 0;
    const saldo = input.balanceMinutes ?? 0;
    const sentences: string[] = [];

    // 1. Chegada — hora que ele avisou, hora prevista, e o que ele escreveu.
    const chegou = hora(input.startedAt);
    const previstoInicio = hora(input.scheduledStartAt);
    const falaChegada = extractArrivalPhrase(input.notes);
    if (chegou) {
        const partes = [`${nome} avisou chegada às ${chegou} de ${dia(input.startedAt)}`];
        const minutosDepois = input.startedAt && input.scheduledStartAt
            ? Math.round((new Date(input.startedAt).getTime() - new Date(input.scheduledStartAt).getTime()) / 60000)
            : 0;
        if (previstoInicio && previstoInicio !== chegou) {
            if (atraso > 0) {
                partes.push(`${duracaoHumana(atraso)} depois das ${previstoInicio}`);
            } else if (minutosDepois > 0) {
                // Atrasou, mas dentro da tolerância: dizer isso evita a pergunta
                // "por que 19:14 não descontou nada?".
                partes.push(`${duracaoHumana(minutosDepois)} depois das ${previstoInicio} (dentro da tolerância)`);
            } else {
                partes.push(`para começar às ${previstoInicio}`);
            }
        }
        const frase = `${partes.join(", ")}${falaChegada ? ` ("${falaChegada}")` : ""}.`;
        sentences.push(frase);
    } else if (falaChegada) {
        sentences.push(`${nome} avisou a chegada assim: "${falaChegada}".`);
    }

    // 2. Saída — física, rendição, e o motivo declarado de ter ficado além.
    const saiu = hora(input.actualEndedAt);
    const previstoFim = hora(input.scheduledEndAt);
    const motivo = frasePorQueFicou(input);
    if (saiu) {
        const alem = excedente > 0 && previstoFim
            ? `, ${duracaoHumana(excedente)} além das ${previstoFim}`
            : previstoFim ? `, no horário previsto (${previstoFim})` : "";
        sentences.push(`Saiu às ${saiu} de ${dia(input.actualEndedAt)}${alem}${motivo ? ` e ${motivo}` : ""}.`);
    } else if (input.countedEndAt) {
        sentences.push(`Não houve saída declarada: o cálculo fechou em ${hora(input.countedEndAt)} de ${dia(input.countedEndAt)}.`);
    } else {
        sentences.push("O plantão está aberto — ninguém registrou a saída até agora.");
    }

    if (input.successorDoctorName && input.handoffEndedAt) {
        const rendeuAs = hora(input.successorTookOverAt ?? input.handoffEndedAt);
        sentences.push(`Quem rendeu foi ${primeiroNome(input.successorDoctorName)}, às ${rendeuAs} — o cálculo parou na rendição.`);
    }

    // 3. O que isso virou no banco, dito como conta e não como regra.
    if (credito > 0 && atraso === 0 && credito > excedente) {
        sentences.push(`Chegou no horário, então esse tempo conta em dobro: +${duracaoHumana(credito)}.`);
    } else if (credito > 0 && atraso > 0) {
        sentences.push(`Como chegou atrasado, o excedente conta simples: +${duracaoHumana(credito)}, menos ${duracaoHumana(atraso)} do atraso — fica ${saldo >= 0 ? "+" : "−"}${duracaoHumana(saldo)}.`);
    } else if (credito > 0) {
        sentences.push(`Crédito do plantão: +${duracaoHumana(credito)}.`);
    } else if (atraso > 0) {
        sentences.push(`Sem tempo excedente, só o atraso: −${duracaoHumana(atraso)}.`);
    } else if (saldo === 0) {
        sentences.push("Nada a creditar nem a descontar neste plantão.");
    }

    // 4. O que ainda depende de gente.
    if (input.approvalPending && input.approvalLabel) {
        sentences.push(`${input.approvalLabel}.`);
    }

    const sinal = saldo > 0 ? "+" : saldo < 0 ? "−" : "";
    const headline = `${nome} · ${input.targetCode} · ${descreveTurno(input.shiftLabel)} · ${dia(input.startedAt ?? input.countedEndAt) ?? "sem data"}`
        + (saldo === 0 ? " · sem saldo" : ` · ${sinal}${duracaoHumana(saldo)}`);

    return { headline, sentences };
}

/** A história em um parágrafo — formato do WhatsApp/Telegram. */
export function renderBankHoursStoryText(story: BankHoursStory) {
    return `${story.headline}\n${story.sentences.join(" ")}`;
}
