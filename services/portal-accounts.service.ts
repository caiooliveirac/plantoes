/* ==========================================================================
   Contas de portal — gente que entra no mnrs.com.br mas não opera o Plantões.

   O porteiro do mnrs.com.br autentica SÓ por aqui (verificar-escala). Médico
   ganha conta pelo cadastro por codinome e chefia pelo fluxo de convite; a
   equipe não médica cadastrada no Huddle não tinha caminho nenhum. O Huddle
   (servidor↔servidor, POST /api/servicos/contas-portal) pede a conta, e ela
   nasce com o papel `portal`: login no portal sim, app Plantões não
   (modules/auth/contracts.ts).

   A senha inicial é aleatória e ninguém a conhece; a pessoa recebe por e-mail
   um link de /redefinir-senha/<token> (mesma tabela do "esqueci a senha", com
   prazo de 7 dias) e escolhe a dela.

   Conta que já existe — de qualquer tipo — NUNCA é alterada aqui: nem papel,
   nem senha, nem ativação. A resposta só conta o que há.
   ========================================================================== */

import { randomBytes } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, userRoles, users } from "@/db/schema";
import { isEmailConfigured, sendEmail } from "@/lib/email";
import { PORTAL_ROLE, type OperadorDaCentral } from "@/modules/auth/contracts";
import { createPasswordResetTokenForUser, hashPassword } from "@/services/auth.service";
import { getPasswordPolicyError } from "@/modules/auth/password-policy";

/** Prazo do link de boas-vindas (o "esqueci a senha" vale 2 h). */
export const PORTAL_WELCOME_TTL_MS = 1000 * 60 * 60 * 24 * 7;
export const PORTAL_URL = "https://mnrs.com.br";

export type SituacaoContaPortal =
    | { ok: true; situacao: "existente"; ativa: boolean; acessoPortal: boolean }
    | { ok: true; situacao: "inexistente" }
    | { ok: true; situacao: "criada"; emailEnviado: boolean };

export interface PedidoContaPortal {
    email: string;
    nome: string;
    origem: string;
    consultar?: boolean;
}

function baseUrl() {
    return process.env.AUTH_URL?.trim()?.replace(/\/+$/, "") || "https://plantoes.mnrs.com.br";
}

/** "huddle" → "Huddle": a origem vem em minúsculas do chamador. */
function nomeDaOrigem(origem: string) {
    return origem.charAt(0).toLocaleUpperCase("pt-BR") + origem.slice(1);
}

export function buildPortalWelcomeEmail(params: { nome: string; origem: string; email: string; link: string }) {
    return {
        subject: "Seu acesso ao portal mnrs.com.br",
        text: [
            `Olá, ${params.nome}!`,
            "",
            `A administração do ${nomeDaOrigem(params.origem)} criou um acesso para você no portal mnrs.com.br.`,
            "",
            "Para começar, defina a sua senha neste link (vale por 7 dias):",
            params.link,
            "",
            `Depois, entre em ${PORTAL_URL} com este e-mail (${params.email}) e a senha que você escolheu.`,
            "",
            "Se você não esperava este acesso, ignore esta mensagem — sem a senha definida, ninguém entra com esta conta.",
        ].join("\n"),
    };
}

async function situacaoExistente(email: string) {
    const db = getDb();
    const [user] = await db
        .select({ id: users.id, isActive: users.isActive })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
    if (!user) return null;
    const roles = await db.select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, user.id));
    // Mesmo critério do verificar-escala (escopo "portal"): ativa e com algum papel.
    return {
        ok: true as const,
        situacao: "existente" as const,
        ativa: user.isActive,
        acessoPortal: user.isActive && roles.length > 0,
    };
}

function isUniqueViolation(error: unknown) {
    const code = (error as { code?: unknown; cause?: { code?: unknown } } | null);
    return code?.code === "23505" || code?.cause?.code === "23505";
}

export async function provisionarContaPortal(pedido: PedidoContaPortal): Promise<SituacaoContaPortal> {
    const email = pedido.email.trim().toLowerCase();

    const existente = await situacaoExistente(email);
    if (existente) return existente;
    if (pedido.consultar) return { ok: true, situacao: "inexistente" };

    // Senha que ninguém conhece: a conta só ganha senha utilizável pelo link.
    const passwordHash = await hashPassword(randomBytes(32).toString("base64url"));

    let criado: { userId: string; token: string };
    try {
        criado = await getDb().transaction(async (tx) => {
            const [user] = await tx
                .insert(users)
                .values({ email, passwordHash, mustChangePassword: false, isActive: true, doctorId: null })
                .returning({ id: users.id });
            await tx.insert(userRoles).values({ userId: user.id, role: PORTAL_ROLE });
            await tx.insert(auditLogs).values({
                actorUserId: null, // sistema: pedido servidor↔servidor, não há usuário daqui agindo
                action: "portal_account.created",
                entityType: "user",
                entityId: user.id,
                details: { email, nome: pedido.nome, origem: pedido.origem },
            });
            const token = await createPasswordResetTokenForUser(user.id, PORTAL_WELCOME_TTL_MS, tx);
            return { userId: user.id, token };
        });
    } catch (error) {
        // Corrida: dois pedidos para o mesmo e-mail. O índice único users_email_idx
        // barra o segundo, que responde como "existente" sem tocar em nada.
        if (isUniqueViolation(error)) {
            const corrida = await situacaoExistente(email);
            if (corrida) return corrida;
        }
        throw error;
    }

    // O e-mail sai DEPOIS do commit: falhar aqui não desfaz a conta (o link pode
    // ser pedido de novo pelo "esqueci a senha").
    let emailEnviado = false;
    if (!isEmailConfigured()) {
        console.error(`[contas-portal] SMTP não configurado — conta criada sem e-mail de boas-vindas ${JSON.stringify({ email })}`);
    } else {
        try {
            await sendEmail({
                to: email,
                ...buildPortalWelcomeEmail({
                    nome: pedido.nome,
                    origem: pedido.origem,
                    email,
                    link: `${baseUrl()}/redefinir-senha/${criado.token}`,
                }),
            });
            emailEnviado = true;
        } catch (error) {
            console.error(`[contas-portal] falha ao enviar boas-vindas ${JSON.stringify({ email })}`, error);
        }
    }

    return { ok: true, situacao: "criada", emailEnviado };
}

/* ==========================================================================
   Conta de operador da Central aprovada no Escalas (TARM, rádio-operador e
   quem coordena essas categorias) — POST /api/servicos/contas-escala.

   O Escalas aprova o cadastro, sorteia a senha temporária e a manda por
   e-mail com o endereço do portal (mnrs.com.br). O portal confere a senha
   AQUI; por isso a conta nasce aqui com essa mesma senha e
   `mustChangePassword`: no primeiro acesso o portal pede a senha definitiva
   (porteiro, fluxo de "nova senha"), que passa a valer nos dois sistemas.

   Conta que já existe nunca tem a senha tocada: só ganha os papéis que
   faltam. Só dá papéis de operador da Central (Mesa só leitura, só na
   Central) — nunca admin/chief/doctor. Tudo em audit_logs.
   ========================================================================== */
export type SituacaoContaDoEscala =
    | { situacao: "criada"; papeis: OperadorDaCentral[] }
    | { situacao: "existente"; papeisNovos: OperadorDaCentral[]; ativa: boolean };

export class ContaDoEscalaError extends Error {}

export async function provisionarContaDoEscala(pedido: {
    email: string;
    nome: string;
    senhaTemporaria: string;
    papeis: OperadorDaCentral[];
}): Promise<SituacaoContaDoEscala> {
    const email = pedido.email.trim().toLowerCase();
    const papeis = [...new Set(pedido.papeis)];
    if (papeis.length === 0) throw new ContaDoEscalaError("Informe ao menos um papel.");
    const politica = getPasswordPolicyError(pedido.senhaTemporaria);
    if (politica) throw new ContaDoEscalaError(`Senha temporária fraca: ${politica}`);

    const acrescentarPapeis = async (userId: string, ativa: boolean): Promise<SituacaoContaDoEscala> => {
        const db = getDb();
        const atuais = await db.select({ role: userRoles.role }).from(userRoles)
            .where(and(eq(userRoles.userId, userId), inArray(userRoles.role, papeis)));
        const novos = papeis.filter((p) => !atuais.some((a) => a.role === p));
        if (novos.length > 0) {
            await db.transaction(async (tx) => {
                await tx.insert(userRoles).values(novos.map((role) => ({ userId, role }))).onConflictDoNothing();
                await tx.insert(auditLogs).values({
                    actorUserId: null,
                    action: "escala_account.roles_added",
                    entityType: "user",
                    entityId: userId,
                    details: { email, papeis: novos, origem: "escala" },
                });
            });
        }
        return { situacao: "existente", papeisNovos: novos, ativa };
    };

    const [existente] = await getDb().select({ id: users.id, isActive: users.isActive }).from(users).where(eq(users.email, email)).limit(1);
    if (existente) return acrescentarPapeis(existente.id, existente.isActive);

    const passwordHash = await hashPassword(pedido.senhaTemporaria);
    try {
        await getDb().transaction(async (tx) => {
            const [user] = await tx
                .insert(users)
                .values({ email, passwordHash, mustChangePassword: true, isActive: true, doctorId: null })
                .returning({ id: users.id });
            await tx.insert(userRoles).values([PORTAL_ROLE, ...papeis].map((role) => ({ userId: user.id, role })));
            await tx.insert(auditLogs).values({
                actorUserId: null, // pedido servidor↔servidor: quem aprovou está no Escalas
                action: "escala_account.created",
                entityType: "user",
                entityId: user.id,
                details: { email, nome: pedido.nome, papeis, origem: "escala" },
            });
        });
    } catch (error) {
        // Corrida: dois pedidos para o mesmo e-mail — o segundo vira "existente".
        if (isUniqueViolation(error)) {
            const [corrida] = await getDb().select({ id: users.id, isActive: users.isActive }).from(users).where(eq(users.email, email)).limit(1);
            if (corrida) return acrescentarPapeis(corrida.id, corrida.isActive);
        }
        throw error;
    }
    return { situacao: "criada", papeis };
}
