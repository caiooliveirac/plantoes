// Textos do bot para a passagem de ocorrências (Markdown legado do Telegram).
// Puro: quem chama resolve menções e decide quando enviar.
//
// Três mensagens por saída:
// - aviso: 15 min antes — quem sai, quem volta, link para informar;
// - cobranca: a partir de 10 min antes, repetida enquanto faltar contagem, com
//   @ de quem falta;
// - divisao: a divisão calculada, assim que todos informam (ou na hora da saída,
//   marcando quem ficou de fora).

import { escapeTelegramMarkdown } from "./api";
import { handoffKindLabel, type OccurrenceHandoffPlan } from "../operational/occurrence-handoff";

export interface HandoffMessageContext {
    plan: OccurrenceHandoffPlan;
    /** Link público para informar a contagem. */
    link: string;
    /** Menção pronta (formatMealBreakTelegramMention) ou null para cair no nome. */
    mention?: (ramal: string) => string | null;
}

function minusMinutes(hhmm: string, minutes: number) {
    const [h, m] = hhmm.split(":").map(Number);
    const total = h * 60 + m - minutes;
    return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function nameOf(plan: OccurrenceHandoffPlan, ramal: string) {
    const all = [...plan.givers, ...plan.returning, ...plan.pools.aguardando, ...plan.pools.regulado, ...(plan.recip ? [plan.recip] : [])];
    return all.find((p) => p.ramal === ramal)?.name ?? ramal;
}

function who(ctx: HandoffMessageContext, ramal: string) {
    return ctx.mention?.(ramal) ?? `*${escapeTelegramMarkdown(nameOf(ctx.plan, ramal))}*`;
}

function list(names: string[]) {
    return names.length ? names.join(", ") : "ninguém";
}

export function buildHandoffNoticeMessage(ctx: HandoffMessageContext): string {
    const { plan } = ctx;
    const esc = (ramal: string) => escapeTelegramMarkdown(nameOf(plan, ramal));
    const lines = [
        `🍽 *Saída das ${plan.slot} em 15 min — passagem de ocorrências*`,
        `Saem: ${list(plan.givers.map((g) => `${esc(g.ramal)} (${g.ramal})`))}`,
        `Voltam: ${list(plan.returning.map((p) => esc(p.ramal)))}`,
        plan.recip
            ? `RECIP (${esc(plan.recip.ramal)}) recebe até 15, Aguardando primeiro.`
            : "Sem RECIP: Regulado vai para quem sai 12:30, Aguardando para quem sai 13:30.",
        ...(plan.recip && plan.givers.some((g) => g.role === "PSIQ")
            ? ["PSIQ distribui entre os colegas, só para equilibrar — nada para o RECIP."]
            : []),
        "",
        `A partir das ${minusMinutes(plan.slot, 10)}, quem sai informa quantas tem em *Aguardando* e *Regulado*${plan.givers.some((g) => g.role === "MRV") ? " (MRV: só amarelas)" : ""}:`,
        ctx.link,
    ];
    return lines.join("\n");
}

export function buildHandoffPendingMessage(ctx: HandoffMessageContext): string | null {
    const { plan } = ctx;
    if (plan.pendingGivers.length === 0) return null;
    return [
        `⚠️ *Falta contagem — saída das ${plan.slot}*`,
        plan.pendingGivers.map((ramal) => who(ctx, ramal)).join(" "),
        "Informem Aguardando e Regulado para o sistema dividir:",
        ctx.link,
    ].join("\n");
}

export function buildHandoffDivisionMessage(ctx: HandoffMessageContext): string {
    const { plan } = ctx;
    const esc = (ramal: string) => escapeTelegramMarkdown(nameOf(plan, ramal));
    const lines = [`📋 *Passagem de ocorrências — ${plan.slot}*`];
    for (const giver of plan.givers) {
        const out = plan.transfers.filter((t) => t.from === giver.ramal);
        if (out.length === 0) continue;
        lines.push("", `${who(ctx, giver.ramal)} passa:`);
        for (const t of out) {
            const recip = plan.recip?.ramal === t.to ? " (RECIP)" : "";
            lines.push(`  • ${t.count} ${handoffKindLabel(t.kind, t.count)} → ${esc(t.to)}${recip}`);
        }
    }
    if (plan.recip) lines.push("", `RECIP: ${plan.recipLoad}/15`);
    lines.push(`Correções no painel até ${minusMinutes(plan.slot, -10)}; a divisão refaz sozinha.`);
    if (plan.pendingGivers.length) {
        lines.push("", `Sem contagem, fora da divisão: ${plan.pendingGivers.map((r) => who(ctx, r)).join(" ")}`);
    }
    if (plan.unassigned > 0) lines.push("", `${plan.unassigned} sem destino — chefia decide.`);
    return lines.join("\n");
}
