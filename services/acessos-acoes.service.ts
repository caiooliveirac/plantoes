/* Ações da coordenação no monitor de acessos (docs/monitor-acessos.md). Nada
   aqui é automático: cada ação é um clique do admin, com motivo obrigatório,
   linha em audit_logs e evento na linha do tempo da conta.

   O que cada uma corta de verdade:
   - encerrar uma sessão: aquele aparelho cai. Se ele tem login do portal
     (mnrs.com.br), volta sozinho pelo SSO — com o porteiro que manda `sv`,
     só depois de "encerrar todas" ou troca de senha é que o portal pede senha.
   - encerrar todas: sobe users.session_version — todo cookie daqui cai, e o
     login do portal com `sv` antigo é recusado no /api/auth/sso. Quem sabe a
     senha entra de novo (e aparece de novo no monitor).
   - exigir nova senha: troca a senha por uma aleatória que ninguém conhece e
     manda o link de redefinição ao e-mail da conta. É o que corta quem só tem
     a senha emprestada.
   - suspender: conta desativada (is_active=false) — ninguém entra, nem o dono,
     até reativar. */
import { randomBytes } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, authSessionEvents, authSessions, users } from "@/db/schema";
import { isEmailConfigured, sendEmail } from "@/lib/email";
import { REDEFINICAO_PELO_ADMIN, createPasswordResetTokenForUser, hashPassword } from "@/services/auth.service";

/** Link de redefinição mandado pela coordenação: 24 h (o do "esqueci a senha" é 2 h). */
const RESET_PELO_ADMIN_TTL_MS = 24 * 60 * 60 * 1000;

export class AcaoDeAcessoError extends Error {
    status: number;
    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

export type AcaoNaConta = "encerrar_sessoes" | "exigir_nova_senha" | "suspender" | "reativar";

const DESCRICAO: Record<AcaoNaConta | "encerrar_sessao", string> = {
    encerrar_sessao: "encerrou uma sessão",
    encerrar_sessoes: "encerrou todas as sessões",
    exigir_nova_senha: "trocou a senha por uma aleatória e mandou o link de redefinição",
    suspender: "suspendeu a conta",
    reativar: "reativou a conta",
};

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

async function registrar(tx: Tx, acao: AcaoNaConta | "encerrar_sessao", alvoId: string, adminId: string, motivo: string, extra: Record<string, unknown> = {}) {
    await tx.insert(auditLogs).values({
        actorUserId: adminId,
        // Entra em SENHA_DEFINIDA_ACTIONS: o portal diz "sua senha foi alterada em…".
        action: acao === "exigir_nova_senha" ? REDEFINICAO_PELO_ADMIN : `acessos.${acao}`,
        entityType: "user",
        entityId: alvoId,
        details: { motivo, ...extra },
    });
    await tx.insert(authSessionEvents).values({
        userId: alvoId,
        sessionId: typeof extra.sessaoId === "string" ? extra.sessaoId : null,
        kind: `admin_${acao}`,
        details: { descricao: DESCRICAO[acao], motivo, adminId, ...extra },
    });
}

async function encerrarAbertas(tx: Tx, userId: string, adminId: string, motivo: string) {
    const encerradas = await tx
        .update(authSessions)
        .set({ revokedAt: new Date(), revokedBy: adminId, revokedReason: motivo })
        .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)))
        .returning({ id: authSessions.id });
    return encerradas.length;
}

function validarMotivo(motivo: string) {
    const limpo = motivo.trim();
    if (limpo.length < 5) throw new AcaoDeAcessoError(400, "Escreva o motivo (mínimo 5 letras): ele fica no registro da conta.");
    return limpo.slice(0, 500);
}

export async function encerrarSessaoPeloAdmin(sessaoId: string, adminId: string, motivoBruto: string) {
    const motivo = validarMotivo(motivoBruto);
    return getDb().transaction(async (tx) => {
        const [sessao] = await tx
            .update(authSessions)
            .set({ revokedAt: new Date(), revokedBy: adminId, revokedReason: motivo })
            .where(and(eq(authSessions.id, sessaoId), isNull(authSessions.revokedAt)))
            .returning({ id: authSessions.id, userId: authSessions.userId });
        if (!sessao) throw new AcaoDeAcessoError(404, "Sessão não encontrada ou já encerrada.");
        await registrar(tx, "encerrar_sessao", sessao.userId, adminId, motivo, { sessaoId });
        return { userId: sessao.userId };
    });
}

export interface ResultadoDaAcao {
    sessoesEncerradas: number;
    emailEnviado?: boolean;
    /** Só quando o e-mail não saiu: o admin repassa o link por outro meio. */
    linkDeRedefinicao?: string;
}

export async function agirNaConta(acao: AcaoNaConta, userId: string, adminId: string, motivoBruto: string): Promise<ResultadoDaAcao> {
    const motivo = validarMotivo(motivoBruto);
    if (userId === adminId && acao !== "encerrar_sessoes") {
        throw new AcaoDeAcessoError(400, "Você não pode suspender nem trocar a senha da sua própria conta por aqui.");
    }
    const db = getDb();
    const [conta] = await db.select({ id: users.id, email: users.email, isActive: users.isActive }).from(users).where(eq(users.id, userId)).limit(1);
    if (!conta) throw new AcaoDeAcessoError(404, "Conta não encontrada.");

    if (acao === "reativar") {
        if (conta.isActive) throw new AcaoDeAcessoError(409, "A conta já está ativa.");
        await db.transaction(async (tx) => {
            await tx.update(users).set({ isActive: true, updatedAt: new Date() }).where(eq(users.id, userId));
            await registrar(tx, acao, userId, adminId, motivo);
        });
        return { sessoesEncerradas: 0 };
    }

    if (acao === "suspender") {
        if (!conta.isActive) throw new AcaoDeAcessoError(409, "A conta já está suspensa.");
        const sessoesEncerradas = await db.transaction(async (tx) => {
            await tx
                .update(users)
                .set({ isActive: false, sessionVersion: sql`${users.sessionVersion} + 1`, updatedAt: new Date() })
                .where(eq(users.id, userId));
            const total = await encerrarAbertas(tx, userId, adminId, `conta suspensa: ${motivo}`);
            await registrar(tx, acao, userId, adminId, motivo, { sessoesEncerradas: total });
            return total;
        });
        return { sessoesEncerradas };
    }

    if (acao === "encerrar_sessoes") {
        const sessoesEncerradas = await db.transaction(async (tx) => {
            await tx.update(users).set({ sessionVersion: sql`${users.sessionVersion} + 1`, updatedAt: new Date() }).where(eq(users.id, userId));
            const total = await encerrarAbertas(tx, userId, adminId, motivo);
            await registrar(tx, acao, userId, adminId, motivo, { sessoesEncerradas: total });
            return total;
        });
        return { sessoesEncerradas };
    }

    // exigir_nova_senha: senha aleatória que ninguém conhece + link por e-mail.
    const passwordHash = await hashPassword(randomBytes(32).toString("base64url"));
    const { sessoesEncerradas, token } = await db.transaction(async (tx) => {
        await tx
            .update(users)
            .set({
                passwordHash,
                mustChangePassword: false,
                sessionVersion: sql`${users.sessionVersion} + 1`,
                updatedAt: new Date(),
            })
            .where(eq(users.id, userId));
        const total = await encerrarAbertas(tx, userId, adminId, `senha trocada pela coordenação: ${motivo}`);
        const novoToken = await createPasswordResetTokenForUser(userId, RESET_PELO_ADMIN_TTL_MS, tx);
        await registrar(tx, acao, userId, adminId, motivo, { sessoesEncerradas: total });
        return { sessoesEncerradas: total, token: novoToken };
    });

    const baseUrl = process.env.AUTH_URL?.trim()?.replace(/\/$/, "") || "https://plantoes.mnrs.com.br";
    const link = `${baseUrl}/redefinir-senha/${token}`;
    let emailEnviado = false;
    if (isEmailConfigured()) {
        try {
            await sendEmail({
                to: conta.email,
                subject: "Sua senha do Plantões SAMU foi redefinida pela coordenação",
                text: [
                    "A coordenação encerrou todos os acessos da sua conta e trocou a sua senha.",
                    "A senha antiga não vale mais, em nenhum aparelho.",
                    "",
                    "Escolha uma senha nova por este link (vale por 24 horas):",
                    link,
                    "",
                    "A senha é pessoal: não passe para ninguém. Em caso de dúvida, fale com a coordenação.",
                ].join("\n"),
            });
            emailEnviado = true;
        } catch (erro) {
            console.error("[acessos] e-mail de redefinição pelo admin falhou", erro);
        }
    }
    return emailEnviado ? { sessoesEncerradas, emailEnviado } : { sessoesEncerradas, emailEnviado, linkDeRedefinicao: link };
}
