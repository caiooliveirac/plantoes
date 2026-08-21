/**
 * Chegada do chefe de plantão (ramal 2031) não se autoedita.
 *
 * O chefe é o único da regulação que só sai quando o substituto chega. O
 * substituto deveria avisar e frequentemente esquece — e quem estava lá tem o
 * poder de editar o próprio horário no quadro. Isso fecha o circuito: quem
 * ganha a hora é quem confirma a hora. Aqui a chegada em 2031 passa a exigir
 * login de admin; qualquer outra tentativa vira pedido registrado + aviso para
 * a coordenação (WhatsApp, via app `tom`).
 *
 * Módulo puro: decide e escreve o texto. Quem grava e quem envia são as rotas.
 */

import { isChiefRegulationPostCode } from "@/modules/operational/roles";

export const CHIEF_ARRIVAL_ADMIN_ONLY_CODE = "chief_arrival_admin_only";
export const CHIEF_ARRIVAL_ADMIN_ONLY_MESSAGE =
    "Chegada na 2031 (chefia de plantão) só pode ser alterada por admin. Seu pedido foi registrado e a coordenação avisada.";

export type ChiefArrivalChannel = "quadro" | "telegram";

function sameInstant(left: Date | null | undefined, right: Date | null | undefined) {
    return (left?.getTime() ?? null) === (right?.getTime() ?? null);
}

/** true quando o payload de correção move a chegada (startedAt ou o espelho do quadro). */
export function touchesArrival(params: {
    requestedStartedAt?: Date | null;
    requestedBoardStartedAt?: Date | null;
    existingStartedAt: Date;
    existingBoardStartedAt: Date | null;
}) {
    const startedChanged = params.requestedStartedAt
        ? !sameInstant(params.requestedStartedAt, params.existingStartedAt)
        : false;
    const boardChanged = params.requestedBoardStartedAt
        ? !sameInstant(params.requestedBoardStartedAt, params.existingBoardStartedAt)
        : false;
    return startedChanged || boardChanged;
}

/**
 * Barra a edição quando o posto é a chefia, a chegada muda e quem pede não é
 * admin. Não olha SE é a própria chegada: o chefe que altera a chegada do
 * colega da 2031 produz o mesmo efeito no banco de horas de quem ficou.
 */
export function shouldBlockChiefArrivalEdit(params: {
    postCode: string | null | undefined;
    isAdmin: boolean;
    arrivalChanged: boolean;
}) {
    return params.arrivalChanged && !params.isAdmin && isChiefRegulationPostCode(params.postCode);
}

function formatHour(value: Date | null | undefined) {
    if (!value) {
        return "--:--";
    }
    return new Intl.DateTimeFormat("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "America/Sao_Paulo",
    }).format(value);
}

/** Texto do aviso à coordenação. Sem e-mail, sem token — só o que decide a conversa. */
export function buildChiefArrivalBlockNotice(params: {
    doctorName: string | null;
    actorLabel: string | null;
    postCode: string;
    currentArrivalAt: Date;
    requestedArrivalAt: Date | null;
    note: string | null;
    channel: ChiefArrivalChannel;
}) {
    const quem = params.actorLabel?.trim() || "chefia de plantão";
    const medico = params.doctorName?.trim() || "ocupante";
    const via = params.channel === "telegram" ? "pelo Telegram" : "pelo quadro";
    const pedido = params.requestedArrivalAt
        ? `de ${formatHour(params.currentArrivalAt)} para ${formatHour(params.requestedArrivalAt)}`
        : `a partir de ${formatHour(params.currentArrivalAt)}`;
    const motivo = params.note?.trim() ? ` Motivo informado: "${params.note.trim()}".` : "";

    return `🚨 Plantões — chegada da chefia bloqueada\n`
        + `${quem} tentou alterar ${via} a chegada de ${medico} no ramal ${params.postCode} ${pedido}.\n`
        + `Bloqueado: só login de admin altera chegada de chefe. Pedido registrado para o admin aplicar.${motivo}`;
}

/** Texto do aviso quando ninguém soube dizer a que horas o chefe anterior saiu. */
export function buildChiefExitUnknownNotice(params: {
    doctorName: string | null;
    postCode: string;
    handoffAt: Date;
    actorLabel: string | null;
}) {
    const medico = params.doctorName?.trim() || "chefe anterior";
    const quem = params.actorLabel?.trim() || "quadro";
    return `⚠️ Plantões — saída da chefia sem horário\n`
        + `Ninguém soube dizer a que horas ${medico} saiu do ramal ${params.postCode} `
        + `(rendição registrada às ${formatHour(params.handoffAt)}). Reportado por ${quem}.\n`
        + `O banco de horas dele está travado até alguém informar o horário real.`;
}
