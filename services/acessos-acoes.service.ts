/* Ações da coordenação no monitor de acessos (docs/monitor-acessos.md). Cada
   ação é um clique do admin, com motivo obrigatório, linha em audit_logs e
   evento na linha do tempo da conta. Automáticas, sem admin e nunca contra
   papel admin: derrubarPorLugaresDemais (4+ lugares — troca a senha na hora) e
   aplicarAtitudeDeRisco (risco alto — derruba; se insistir, troca a senha).

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
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, authSessionEvents, authSessions, userRoles, users } from "@/db/schema";
import { isEmailConfigured, sendEmail } from "@/lib/email";
import { OPERADORES_DA_CENTRAL, type OperadorDaCentral } from "@/modules/auth/contracts";
import { sendMessage } from "@/modules/telegram/api";
import { getTelegramAdminUserIds } from "@/modules/telegram/config";
import { REDEFINICAO_PELO_ADMIN, createPasswordResetTokenForUser, hashPassword } from "@/services/auth.service";
import { provisionarContaPortal } from "@/services/portal-accounts.service";

/** Link de redefinição mandado pela coordenação: 24 h (o do "esqueci a senha" é 2 h). */
const RESET_PELO_ADMIN_TTL_MS = 24 * 60 * 60 * 1000;

export class AcaoDeAcessoError extends Error {
    status: number;
    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

export type AcaoNaConta = "encerrar_sessoes" | "exigir_nova_senha" | "suspender" | "reativar"
    | "dar_radio_operador" | "tirar_radio_operador" | "dar_tarm" | "tirar_tarm";

/** Ação de dar/tirar papel de operador da Central → papel e nome. */
const ACAO_DE_PAPEL: Partial<Record<AcaoNaConta, { papel: OperadorDaCentral; dar: boolean }>> = {
    dar_radio_operador: { papel: "radio_operador", dar: true },
    tirar_radio_operador: { papel: "radio_operador", dar: false },
    dar_tarm: { papel: "tarm", dar: true },
    tirar_tarm: { papel: "tarm", dar: false },
};
export const NOME_DO_OPERADOR: Record<OperadorDaCentral, string> = { radio_operador: "rádio-operador", tarm: "TARM" };

const DESCRICAO: Record<AcaoNaConta | "encerrar_sessao", string> = {
    encerrar_sessao: "encerrou uma sessão",
    encerrar_sessoes: "encerrou todas as sessões",
    exigir_nova_senha: "trocou a senha por uma aleatória e mandou o link de redefinição",
    suspender: "suspendeu a conta",
    reativar: "reativou a conta",
    dar_radio_operador: "deu o papel de rádio-operador (Mesa só leitura, na Central, sem bloqueio por ociosidade)",
    tirar_radio_operador: "tirou o papel de rádio-operador",
    dar_tarm: "deu o papel de TARM (Mesa só leitura, na Central, sem bloqueio por ociosidade)",
    tirar_tarm: "tirou o papel de TARM",
};

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

/** adminId null = o próprio monitor (derrubada automática). */
async function registrar(tx: Tx, acao: AcaoNaConta | "encerrar_sessao", alvoId: string, adminId: string | null, motivo: string, extra: Record<string, unknown> = {}) {
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
        kind: adminId ? `admin_${acao}` : `auto_${acao}`,
        details: { descricao: DESCRICAO[acao], motivo, adminId, ...extra },
    });
}

async function encerrarAbertas(tx: Tx, userId: string, adminId: string | null, motivo: string) {
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

    // Papel lido a cada pedido (loadUserSession): vale no próximo clique, sem derrubar sessão.
    const dePapel = ACAO_DE_PAPEL[acao];
    if (dePapel) {
        const { papel, dar } = dePapel;
        const papeis = await db.select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, userId));
        const tem = papeis.some((p) => p.role === papel);
        if (dar && tem) throw new AcaoDeAcessoError(409, `A conta já é de ${NOME_DO_OPERADOR[papel]}.`);
        if (!dar && !tem) throw new AcaoDeAcessoError(409, `A conta não é de ${NOME_DO_OPERADOR[papel]}.`);
        await db.transaction(async (tx) => {
            if (dar) {
                await tx.insert(userRoles).values({ userId, role: papel }).onConflictDoNothing();
            } else {
                await tx.delete(userRoles).where(and(eq(userRoles.userId, userId), eq(userRoles.role, papel)));
            }
            await registrar(tx, acao, userId, adminId, motivo);
        });
        return { sessoesEncerradas: 0 };
    }

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
    return trocarSenhaEMandarLink(userId, conta.email, adminId, motivo, `senha trocada pela coordenação: ${motivo}`, [
        "A coordenação encerrou todos os acessos da sua conta e trocou a sua senha.",
        "A senha antiga não vale mais, em nenhum aparelho.",
    ]);
}

async function trocarSenhaEMandarLink(
    userId: string,
    email: string,
    adminId: string | null,
    motivo: string,
    motivoDaRevogacao: string,
    abertura: string[],
    extra: Record<string, unknown> = {},
): Promise<ResultadoDaAcao> {
    const db = getDb();
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
        const total = await encerrarAbertas(tx, userId, adminId, motivoDaRevogacao);
        const novoToken = await createPasswordResetTokenForUser(userId, RESET_PELO_ADMIN_TTL_MS, tx);
        await registrar(tx, "exigir_nova_senha", userId, adminId, motivo, { sessoesEncerradas: total, ...extra });
        return { sessoesEncerradas: total, token: novoToken };
    });

    const baseUrl = process.env.AUTH_URL?.trim()?.replace(/\/$/, "") || "https://plantoes.mnrs.com.br";
    const link = `${baseUrl}/redefinir-senha/${token}`;
    let emailEnviado = false;
    if (isEmailConfigured()) {
        try {
            await sendEmail({
                to: email,
                subject: "Sua senha do Plantões SAMU foi redefinida",
                text: [
                    ...abertura,
                    "",
                    "Escolha uma senha nova por este link (vale por 24 horas):",
                    link,
                    "",
                    "A senha é pessoal: não passe para ninguém. Em caso de dúvida, fale com a coordenação.",
                ].join("\n"),
            });
            emailEnviado = true;
        } catch (erro) {
            console.error("[acessos] e-mail de redefinição falhou", erro);
        }
    }
    return emailEnviado ? { sessoesEncerradas, emailEnviado } : { sessoesEncerradas, emailEnviado, linkDeRedefinicao: link };
}

/** Conta em mais de 3 lugares ao mesmo tempo (services/acessos-portao.service.ts):
    tudo cai, senha trocada, link no e-mail da conta, aviso aos admins no Telegram. */
export async function derrubarPorLugaresDemais(userId: string, lugares: number, faixas: string[]) {
    const [conta] = await getDb()
        .select({ id: users.id, email: users.email, isActive: users.isActive })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
    if (!conta || !conta.isActive) return null;
    const motivo = `uso em ${lugares} lugares ao mesmo tempo (limite: 3)`;
    const resultado = await trocarSenhaEMandarLink(userId, conta.email, null, motivo, `automático: ${motivo}`, [
        `Sua conta foi usada em ${lugares} lugares diferentes ao mesmo tempo. O limite é 3.`,
        "Por segurança, todos os acessos foram encerrados e a senha antiga não vale mais, em nenhum aparelho.",
    ], { lugares, faixas });

    if (process.env.TELEGRAM_BOT_TOKEN?.trim()) {
        const app = (process.env.AUTH_URL?.trim() || "https://plantoes.mnrs.com.br").replace(/\/$/, "");
        const texto = [
            "Acesso derrubado automaticamente",
            `${conta.email}: em uso em ${lugares} lugares ao mesmo tempo (limite 3).`,
            `Sessões encerradas: ${resultado.sessoesEncerradas}. Senha trocada; link ${resultado.emailEnviado ? "enviado ao e-mail da conta" : "NÃO saiu por e-mail — repasse pelo relatório"}.`,
            `${app}/admin/acessos/${userId}?periodo=24h`,
        ].join("\n");
        for (const chatId of new Set(getTelegramAdminUserIds().filter(Boolean))) {
            await sendMessage(chatId, texto).catch((erro) => console.error("[acessos] aviso de derrubada falhou", erro));
        }
    }
    return resultado;
}

async function avisarAdmins(linhas: string[]) {
    if (!process.env.TELEGRAM_BOT_TOKEN?.trim()) return;
    const texto = linhas.join("\n");
    for (const chatId of new Set(getTelegramAdminUserIds().filter(Boolean))) {
        await sendMessage(chatId, texto).catch((erro) => console.error("[acessos] aviso de atitude falhou", erro));
    }
}

/** Risco alto, primeira vez neste episódio: sobe session_version, encerra as
    sessões, avisa o dono por e-mail e os admins no Telegram. A senha fica. */
async function derrubarPorRiscoAlto(conta: { id: string; email: string }, resumo: string) {
    const motivo = "uso simultâneo em lugares diferentes (risco alto)";
    const sessoesEncerradas = await getDb().transaction(async (tx) => {
        await tx.update(users).set({ sessionVersion: sql`${users.sessionVersion} + 1`, updatedAt: new Date() }).where(eq(users.id, conta.id));
        const total = await encerrarAbertas(tx, conta.id, null, motivo);
        await registrar(tx, "encerrar_sessoes", conta.id, null, motivo, { sessoesEncerradas: total });
        return total;
    });

    if (isEmailConfigured()) {
        try {
            await sendEmail({
                to: conta.email,
                subject: "Seus acessos do Plantões SAMU foram encerrados",
                text: [
                    "Sua conta estava em uso em lugares diferentes ao mesmo tempo.",
                    "Encerramos todos os acessos. A senha ainda é a mesma: entre de novo só você.",
                    "Se a conta voltar a aparecer em lugares diferentes, a senha será trocada e você recebe um link para criar outra.",
                    "",
                    "A senha é pessoal. Não passe para ninguém.",
                ].join("\n"),
            });
        } catch (erro) {
            console.error("[acessos] e-mail de derrubada falhou", erro);
        }
    }

    const app = (process.env.AUTH_URL?.trim() || "https://plantoes.mnrs.com.br").replace(/\/$/, "");
    await avisarAdmins([
        "Acesso derrubado — risco alto",
        `${conta.email}: sessões encerradas (${sessoesEncerradas}). A senha ainda vale.`,
        "Se voltar a usar em lugares diferentes, a senha será trocada.",
        resumo,
        `${app}/admin/acessos/${conta.id}?periodo=24h`,
    ]);
    return { sessoesEncerradas };
}

/** Segunda vez em 24 h: a mesma troca de senha do limite de lugares. */
async function trocarSenhaPorRiscoAlto(conta: { id: string; email: string }, resumo: string) {
    const motivo = "voltou a usar a conta em lugares diferentes depois de ter os acessos encerrados";
    const resultado = await trocarSenhaEMandarLink(conta.id, conta.email, null, motivo, `automático: ${motivo}`, [
        "Sua conta voltou a ser usada em lugares diferentes depois que os acessos foram encerrados.",
        "Por segurança, todos os acessos foram encerrados de novo e a senha antiga não vale mais, em nenhum aparelho.",
    ]);
    const app = (process.env.AUTH_URL?.trim() || "https://plantoes.mnrs.com.br").replace(/\/$/, "");
    await avisarAdmins([
        "Senha trocada — a conta insistiu depois de derrubada",
        `${conta.email}: sessões encerradas (${resultado.sessoesEncerradas}). Senha trocada; link ${resultado.emailEnviado ? "enviado ao e-mail da conta" : "NÃO saiu por e-mail — repasse pelo relatório"}.`,
        resumo,
        `${app}/admin/acessos/${conta.id}?periodo=24h`,
    ]);
    return resultado;
}

/** Confere o papel admin de novo no banco antes de agir. Conta inativa: nada. */
export async function aplicarAtitudeDeRisco(
    atitude: "derrubar" | "trocar_senha",
    conta: { userId: string; email: string },
    resumo: string,
) {
    const db = getDb();
    const papeis = await db.select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, conta.userId));
    if (papeis.some((papel) => papel.role === "admin")) return null;
    const [usuario] = await db
        .select({ id: users.id, email: users.email, isActive: users.isActive })
        .from(users)
        .where(eq(users.id, conta.userId))
        .limit(1);
    if (!usuario?.isActive) return null;
    return atitude === "derrubar" ? derrubarPorRiscoAlto(usuario, resumo) : trocarSenhaPorRiscoAlto(usuario, resumo);
}

// ── Operadores da Central (rádio-operador, TARM) ─────────────────────────────
/* Quem despacha unidades (rádio) ou atende o telefone (TARM) na Central não tem
   médico vinculado: a conta nasce aqui, pelo admin. Conta nova vem igual à do
   Huddle (papel `portal`, senha que ninguém sabe, e-mail com link de 7 dias
   para criar a senha) e ganha o papel. Conta que já existe só ganha o papel. */
export interface CadastroDeOperador {
    userId: string;
    situacao: "criada" | "existente";
    emailEnviado?: boolean;
    jaEra: boolean;
    ativa: boolean;
}

export function ehPapelDeOperador(valor: unknown): valor is OperadorDaCentral {
    return typeof valor === "string" && (OPERADORES_DA_CENTRAL as readonly string[]).includes(valor);
}

export async function cadastrarOperadorDaCentral(
    pedido: { email: string; nome: string; papel: OperadorDaCentral },
    adminId: string,
): Promise<CadastroDeOperador> {
    const email = pedido.email.trim().toLowerCase();
    const nome = pedido.nome.trim();
    const { papel } = pedido;
    if (!ehPapelDeOperador(papel)) throw new AcaoDeAcessoError(400, "Função inválida.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AcaoDeAcessoError(400, "E-mail inválido.");
    if (nome.length < 2) throw new AcaoDeAcessoError(400, "Escreva o nome.");

    const provisionada = await provisionarContaPortal({ email, nome: nome.slice(0, 160), origem: "SAMU Salvador" });
    const db = getDb();
    const [conta] = await db.select({ id: users.id, isActive: users.isActive }).from(users).where(eq(users.email, email)).limit(1);
    if (!conta) throw new AcaoDeAcessoError(500, "A conta não foi encontrada depois de criada.");

    const papeis = await db.select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, conta.id));
    const jaEra = papeis.some((p) => p.role === papel);
    if (!jaEra) {
        await db.transaction(async (tx) => {
            await tx.insert(userRoles).values({ userId: conta.id, role: papel }).onConflictDoNothing();
            await registrar(tx, papel === "tarm" ? "dar_tarm" : "dar_radio_operador", conta.id, adminId,
                `cadastro de ${NOME_DO_OPERADOR[papel]}: ${nome.slice(0, 160)}`, { contaNova: provisionada.situacao === "criada" });
        });
    }
    return {
        userId: conta.id,
        situacao: provisionada.situacao === "criada" ? "criada" : "existente",
        emailEnviado: provisionada.situacao === "criada" ? provisionada.emailEnviado : undefined,
        jaEra,
        ativa: conta.isActive,
    };
}

/** Contas com papel de operador da Central, para a lista em /admin/acessos. */
export async function listarOperadoresDaCentral() {
    return getDb()
        .select({ userId: users.id, email: users.email, ativa: users.isActive, papel: userRoles.role })
        .from(userRoles)
        .innerJoin(users, eq(users.id, userRoles.userId))
        .where(inArray(userRoles.role, [...OPERADORES_DA_CENTRAL]))
        .orderBy(userRoles.role, users.email);
}
