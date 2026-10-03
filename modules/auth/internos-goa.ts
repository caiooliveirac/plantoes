/* ==========================================================================
   Internos do GOA — regras puras (docs/internos-goa.md). Banco e ação em
   services/internos-goa.service.ts; rota em app/api/servicos/portal/federado.

   O SkyRescue (goa.mnrs.com.br) assina um handoff de 60 s para o porteiro do
   mnrs.com.br, que o confere e pergunta aqui QUEM é aquele usuário do GOA. A
   resposta tem o mesmo formato do verificar-escala: o porteiro emite o
   mnrs_sso como se a senha tivesse sido conferida aqui.

   Teto de privilégio: por esta via só sai conta que é SÓ `interno` (com ou
   sem `portal`). Quem administra o GOA cria usuário lá à vontade — não pode,
   por isso, virar médico, chefia ou admin daqui.
   ========================================================================== */
import { z } from "zod";
import { ehSoInterno } from "@/modules/auth/contracts";

export const PROVEDOR_GOA = "goa";

export const federadoSchema = z.object({
    provedor: z.literal(PROVEDOR_GOA),
    /** users.id do SkyRescue (BIGINT identity). */
    sujeito: z.string().regex(/^[1-9]\d{0,17}$/),
    /** users.username do SkyRescue. */
    login: z.string().trim().min(1).max(64),
    nome: z.string().trim().max(160).nullable().optional(),
});

export type PedidoFederado = z.infer<typeof federadoSchema>;

/** E-mail da conta nova: goa.<login>@samu.local (o porteiro lê login sem "@" como @samu.local). */
export function emailDoInterno(login: string): string | null {
    const limpo = login
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, ".")
        .replace(/\.{2,}/g, ".")
        .replace(/^[.\-_]+|[.\-_]+$/g, "");
    if (!limpo) return null;
    return `goa.${limpo.slice(0, 48)}@samu.local`;
}

export type RecusaFederada = "inactive_account" | "papel_nao_permitido" | "email_em_uso" | "login_invalido";

/** Conta vinculada pode sair por esta via? Ativa e só interno. */
export function contaVinculadaPode(conta: { isActive: boolean; roles: readonly string[] }): { ok: true } | { ok: false; motivo: RecusaFederada } {
    if (!conta.isActive) return { ok: false, motivo: "inactive_account" };
    if (!ehSoInterno(conta.roles)) return { ok: false, motivo: "papel_nao_permitido" };
    return { ok: true };
}
