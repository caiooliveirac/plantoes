/**
 * Portão e validação de POST /api/servicos/contas-portal (puro, sem banco —
 * testado em tests/contas-portal.test.ts). A regra de negócio está em
 * services/portal-accounts.service.ts.
 */
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

/** Corpo esperado cabe folgado em 1 KB; acima de 4 KB nem se lê. */
export const CONTAS_PORTAL_MAX_BYTES = 4 * 1024;

// Nome e origem vão para o texto do e-mail: sem caractere de controle (quebra de linha etc.).
const SEM_CONTROLE = /^[^\p{Cc}]+$/u;

export const contasPortalSchema = z.strictObject({
    email: z.string().trim().toLowerCase().pipe(z.email().max(255)),
    nome: z.string().trim().min(2).max(160).regex(SEM_CONTROLE),
    origem: z.string().trim().min(2).max(40).regex(/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u),
    consultar: z.boolean().optional(),
});

/** PORTAL_CONTAS_TOKEN; ausente, vazio ou o "CHANGE_ME" do exemplo = rota desligada (null). */
export function tokenDeContasPortal(env: Record<string, string | undefined> = process.env): string | null {
    const valor = env.PORTAL_CONTAS_TOKEN?.trim();
    if (!valor || valor === "CHANGE_ME") return null;
    return valor;
}

/** Comparação em tempo constante do header x-portal-token. */
export function tokenDeContasPortalConfere(recebido: string | null, esperado: string): boolean {
    if (!recebido) return false;
    const a = Buffer.from(recebido, "utf8");
    const b = Buffer.from(esperado, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
}
