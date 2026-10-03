// Régua de certeza da chegada (out/2026). O parser monta o "nome" com TODA
// palavra que ele não conhece — então "Igor na PP20 P dese unidade em ocorrência"
// virava a consulta "Igor dese unidade", casava com o Igor e gravava um plantão.
// Aqui a regra é a inversa: toda palavra que sobrou como nome tem de ser, de
// fato, parte do nome do médico resolvido. Sobrou outra coisa → o bot não grava;
// diz o que entendeu e qual frase digitar (docs/chegada.md, seção 9).
//
// Puro, sem banco: a decisão de recusar e o texto da resposta moram aqui; quem
// chama é processTelegramUpdate, que grava a recusa como `error` com o médico
// resolvido para a frase redigitada herdar a hora deste primeiro aviso.

import { computeLevenshteinDistance } from "@/modules/telegram/departure-flow";

const NAME_PARTICLES = new Set(["DE", "DA", "DO", "DOS", "DAS", "E"]);

function normalizeWord(value: string) {
    return value.toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Z0-9]/g, "");
}

function tokenize(value: string | null | undefined) {
    return (value ?? "").split(/\s+/).map(normalizeWord).filter(Boolean);
}

function isNameWord(word: string, nameTokens: string[], joinedNames: string[]) {
    if (nameTokens.includes(word)) {
        return true;
    }
    // Erro de dedo no próprio nome ("Andradre", "Foeppel", "Bonfim").
    const tolerance = word.length >= 6 ? 2 : word.length >= 4 ? 1 : 0;
    if (tolerance > 0 && nameTokens.some((token) => Math.abs(token.length - word.length) <= tolerance
        && computeLevenshteinDistance(word, token) <= tolerance)) {
        return true;
    }
    // Apelido por prefixo ("Rafa") e nome digitado colado ("NadyjaElis").
    if (word.length >= 3 && nameTokens.some((token) => token.startsWith(word))) {
        return true;
    }
    return word.length >= 6 && joinedNames.some((joined) => joined.includes(word));
}

/**
 * Palavras da mensagem que o bot NÃO sabe o que são: sobraram como "nome" mas não
 * pertencem ao médico resolvido. Lista vazia = entendeu tudo.
 */
export function findUncertainArrivalWords(params: {
    doctorQuery: string | null | undefined;
    doctorNames: Array<string | null | undefined>;
}): string[] {
    const nameTokens = params.doctorNames.flatMap(tokenize);
    const joinedNames = params.doctorNames.map((name) => tokenize(name).join("")).filter(Boolean);
    const seen = new Set<string>();
    const uncertain: string[] = [];
    for (const raw of (params.doctorQuery ?? "").split(/\s+/)) {
        const word = normalizeWord(raw);
        if (word.length <= 1 || NAME_PARTICLES.has(word) || seen.has(word)) {
            continue;
        }
        seen.add(word);
        if (!isNameWord(word, nameTokens, joinedNames)) {
            uncertain.push(raw);
        }
    }
    return uncertain;
}

/** Resposta da recusa: o que entendi, o que não entendi, o que digitar. */
export function buildUncertainArrivalReply(params: {
    doctorName: string;
    targetCode: string | null;
    shiftLabel: string | null;
    isContinuation: boolean;
    uncertainWords: string[];
    hasQuestionMark: boolean;
    /** Hora deste aviso (HH:mm) — é a que vale quando a frase certa chegar. */
    noticeTime: string;
    /** Plantão aberto do médico em OUTRO alvo, se houver. */
    activeElsewhere: { targetCode: string; sinceTime: string } | null;
}) {
    const target = params.targetCode ?? "ramal/base";
    const understood = [params.doctorName, target, params.shiftLabel].filter(Boolean).join(", ");
    const reason = params.uncertainWords.length > 0
        ? `Não reconheci: ${params.uncertainWords.join(", ")}.`
        : params.hasQuestionMark
            ? "A mensagem tem pergunta (?), e eu só registro afirmação."
            : "Sobrou texto que eu não reconheço.";
    const phrase = params.activeElsewhere
        ? `${params.doctorName} mudou para ${target}`
        : params.isContinuation
            ? `${params.doctorName} continua ${target}${params.shiftLabel ? ` ${params.shiftLabel}` : ""}`
            : `${params.doctorName} ${target} ${params.shiftLabel ?? "SD"}`;
    const lines = [
        "⚠️ Não entendi com certeza, então NÃO registrei.",
        `Entendi: ${understood}. ${reason}`,
    ];
    if (params.activeElsewhere) {
        lines.push(`No meu registro ${params.doctorName} já está em ${params.activeElsewhere.targetCode} desde ${params.activeElsewhere.sinceTime}. Se mudou ou errou o local, digite só:`);
    } else {
        lines.push(`Sou um robô, não uma IA: preciso do padrão. Se é mesmo ${params.doctorName}, digite só:`);
    }
    lines.push(phrase);
    if (params.uncertainWords.length > 0) {
        lines.push("Se é outro médico, digite nome e sobrenome dele como no cadastro, local e turno.");
    }
    lines.push(params.activeElsewhere
        ? "A sua chegada do turno é mantida."
        : `Sua hora está guardada: vale a deste aviso (${params.noticeTime}).`);
    return lines.join("\n");
}

const LOOSE_COMPLEMENT_WORDS = new Set([
    "SD", "SN", "P", "DESDE", "AS", "A", "DE", "DO", "DA", "NA", "NO", "PA", "CANCELA", "CANCELAR", "CANCELE",
    "CORRIGINDO", "CORRIGIR", "CORRIGE", "CORRECAO", "ERRADO", "ERRADA", "ERREI", "MEIO", "PLANTAO", "TURNO",
    "TARDE", "CONTINUA", "CONTINUO", "CONTINUANDO", "SOMBRA", "CHEGADA", "ENTRADA", "HOJE", "AGORA",
]);

/**
 * Fragmento que só faz sentido junto de um aviso anterior ("SD", "Desde 07:12",
 * "Cancela", "Corrigindo PA 2032"): até 4 palavras, todas operacionais, sem nome.
 * Conversa ("pessoal, bom dia") não é complemento — segue em silêncio.
 */
export function isLooseOperationalComplement(text: string) {
    const words = text
        .replace(/\b\d{1,2}\s*[:h.]\s*\d{0,2}\s*(?:min\w*|hrs?|hs|horas?)?/gi, " HORA ")
        .split(/[\s,.;:!/-]+/)
        .map(normalizeWord)
        .filter(Boolean);
    if (words.length === 0 || words.length > 4) {
        return false;
    }
    return words.every((word) => word === "HORA" || LOOSE_COMPLEMENT_WORDS.has(word) || /^\d{2,4}$/.test(word)
        || /^[A-Z]{2}\d{2}$/.test(word));
}

/** Resposta ao complemento solto: o aviso que está gravado + três frases completas. */
export function buildLooseComplementReply(params: {
    doctorName: string;
    targetCode: string;
    previousText: string;
}) {
    return [
        "⚠️ Complemento solto demais para um robô: não mudei nada.",
        `Seu último aviso gravado: "${params.previousText.replace(/\s+/g, " ").trim().slice(0, 80)}".`,
        "Para mudar, mande a frase inteira. Exemplos:",
        `${params.doctorName} ${params.targetCode} SN`,
        `${params.doctorName} continua ${params.targetCode}`,
        `${params.doctorName} saindo ${params.targetCode}`,
        "Hora escrita não muda a chegada: vale a hora do primeiro aviso.",
    ].join("\n");
}

function formatLastShift(last: { targetCode: string; shiftLabel: string | null; startedLabel: string; endedLabel: string | null }) {
    const label = [last.shiftLabel, last.targetCode].filter(Boolean).join(" ");
    return `${label}, chegada ${last.startedLabel}, ${last.endedLabel ? `saída ${last.endedLabel}` : "sem saída registrada"}`;
}

/**
 * Saída que não achou plantão para fechar: diz o que o registro mostra em vez de
 * "confira o código e reenvie" (que fazia o médico repetir a mesma frase).
 */
export function buildDepartureNotFoundReply(params: {
    doctorName: string;
    declaredTarget: string | null;
    active: { targetCode: string; sinceTime: string } | null;
    last: { targetCode: string; shiftLabel: string | null; startedLabel: string; endedLabel: string | null } | null;
}) {
    const declared = params.declaredTarget ?? "local não informado";
    if (params.active && params.active.targetCode !== params.declaredTarget) {
        return [
            "⛔ Não entendi com certeza, então NÃO registrei a saída.",
            `Você escreveu saída de ${declared}, mas no meu registro ${params.doctorName} está em ${params.active.targetCode} desde ${params.active.sinceTime}.`,
            "Se a saída é de lá, digite só:",
            `${params.doctorName} saindo ${params.active.targetCode}`,
            `Se esteve mesmo em ${declared}, procure o chefe de plantão.`,
        ].join("\n");
    }
    const lines = [
        `⛔ Não achei plantão aberto de ${params.doctorName} em ${declared}, então NÃO registrei a saída.`,
    ];
    if (params.last) {
        lines.push(`Último plantão registrado: ${formatLastShift(params.last)}.`);
        lines.push(params.last.endedLabel
            ? "Se é esse, já está fechado: não precisa avisar de novo."
            : "Se é esse, digite a saída com o local dele.");
    } else {
        lines.push("Não tenho nenhum plantão recente seu registrado.");
    }
    lines.push("Se você fez um plantão que não aparece aqui, procure o chefe de plantão (ou o desenvolvedor) para lançar.");
    return lines.join("\n");
}
