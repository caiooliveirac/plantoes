/**
 * Corte da virada: sessão aberta antes da virada do plantão (07:00 / 19:00,
 * fuso operacional UTC-3) morre 15 min depois dela (07:15 / 19:15). Fecha a
 * Mesa deixada aberta pelo chefe que saiu; o chefe novo entra com a conta
 * dele. Quem entrou DEPOIS da virada vive até o corte seguinte. Admin isento.
 * A mesma regra vale no porteiro do portal (mnrs-portal, `porteiro/virada.mjs`).
 * Decisão do Caio, 01/10/2026 — docs/plano-mesa-chefe-plantonista.md.
 */
import { BAHIA_OFFSET_MINUTES } from "@/lib/time";

const HORA_MS = 3_600_000;
const OFFSET_MS = BAHIA_OFFSET_MINUTES * 60_000;
export const CORTE_APOS_VIRADA_MS = 15 * 60_000;

/** Primeira virada (07:00 ou 19:00 locais) estritamente depois do instante. */
export function proximaVirada(instante: Date): Date {
    const local = instante.getTime() + OFFSET_MS;
    const dia = Math.floor(local / (24 * HORA_MS)) * 24 * HORA_MS;
    const candidatas = [dia + 7 * HORA_MS, dia + 19 * HORA_MS, dia + 31 * HORA_MS];
    const proxima = candidatas.find((v) => v > local)!;
    return new Date(proxima - OFFSET_MS);
}

/** Instante em que uma sessão aberta em `login` deve cair. */
export function proximoCorte(login: Date): Date {
    return new Date(proximaVirada(login).getTime() + CORTE_APOS_VIRADA_MS);
}

export function corteLigado(env: Record<string, string | undefined> = process.env) {
    return env.SESSAO_CORTE_VIRADA !== "0";
}
