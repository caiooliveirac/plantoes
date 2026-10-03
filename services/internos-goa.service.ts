/* ==========================================================================
   Internos do GOA — banco (docs/internos-goa.md; regras em
   modules/auth/internos-goa.ts).

   Primeira vez de um usuário do GOA: nasce aqui uma conta `interno` com
   e-mail goa.<login>@samu.local, senha aleatória que ninguém conhece e o
   vínculo (provedor "goa", sujeito = id de lá). Das próximas vezes vale o
   vínculo, nunca o e-mail: renomear o login lá não troca a conta daqui.

   Nunca se vincula a uma conta que já existia: e-mail ocupado = recusa (o
   admin resolve à mão). Conta vinculada suspensa, ou que ganhou outro papel,
   é recusada — o vínculo fica e o GOA não recria outra.
   ========================================================================== */
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, identidadesFederadas, userRoles, users } from "@/db/schema";
import { INTERNO_ROLE } from "@/modules/auth/contracts";
import {
    PROVEDOR_GOA,
    contaVinculadaPode,
    emailDoInterno,
    type PedidoFederado,
    type RecusaFederada,
} from "@/modules/auth/internos-goa";
import { hashPassword } from "@/services/auth.service";

export type ResultadoFederado =
    | {
        ok: true;
        criada: boolean;
        userId: string;
        email: string;
        nome: string | null;
        roles: string[];
        sessionVersion: number;
    }
    | { ok: false; motivo: RecusaFederada; userId?: string };

function isUniqueViolation(error: unknown) {
    const e = error as { code?: unknown; cause?: { code?: unknown } } | null;
    return e?.code === "23505" || e?.cause?.code === "23505";
}

async function contaDoVinculo(sujeito: string) {
    const db = getDb();
    const [vinculo] = await db
        .select({
            id: identidadesFederadas.id,
            userId: identidadesFederadas.userId,
            nome: identidadesFederadas.nome,
            email: users.email,
            isActive: users.isActive,
            sessionVersion: users.sessionVersion,
        })
        .from(identidadesFederadas)
        .innerJoin(users, eq(users.id, identidadesFederadas.userId))
        .where(and(eq(identidadesFederadas.provedor, PROVEDOR_GOA), eq(identidadesFederadas.sujeito, sujeito)))
        .limit(1);
    if (!vinculo) return null;
    const roles = (await db.select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, vinculo.userId))).map((r) => r.role as string);
    return { ...vinculo, roles };
}

async function criarInterno(pedido: PedidoFederado, email: string): Promise<{ userId: string } | null> {
    // Senha que ninguém conhece: e o login por senha recusa conta só interno (auth.service.ts).
    const passwordHash = await hashPassword(randomBytes(32).toString("base64url"));
    try {
        return await getDb().transaction(async (tx) => {
            const [user] = await tx
                .insert(users)
                .values({ email, passwordHash, mustChangePassword: false, isActive: true, doctorId: null })
                .returning({ id: users.id });
            await tx.insert(userRoles).values({ userId: user.id, role: INTERNO_ROLE });
            await tx.insert(identidadesFederadas).values({
                provedor: PROVEDOR_GOA,
                sujeito: pedido.sujeito,
                userId: user.id,
                login: pedido.login,
                nome: pedido.nome ?? null,
                ultimoUsoEm: new Date(),
            });
            await tx.insert(auditLogs).values({
                actorUserId: null, // sistema: pedido do porteiro, não há usuário daqui agindo
                action: "interno_goa.created",
                entityType: "user",
                entityId: user.id,
                details: { email, provedor: PROVEDOR_GOA, sujeito: pedido.sujeito, login: pedido.login, nome: pedido.nome ?? null },
            });
            return { userId: user.id };
        });
    } catch (erro) {
        // E-mail já usado (conta antiga, ou outro sujeito com o mesmo login), ou
        // dois cliques simultâneos do mesmo sujeito: quem chamou relê o vínculo.
        if (isUniqueViolation(erro)) return null;
        throw erro;
    }
}

export async function resolverInternoDoGoa(pedido: PedidoFederado): Promise<ResultadoFederado> {
    let criada = false;
    let conta = await contaDoVinculo(pedido.sujeito);
    if (!conta) {
        const email = emailDoInterno(pedido.login);
        if (!email) return { ok: false, motivo: "login_invalido" };
        criada = (await criarInterno(pedido, email)) !== null;
        conta = await contaDoVinculo(pedido.sujeito);
        if (!conta) return { ok: false, motivo: "email_em_uso" };
    }

    const pode = contaVinculadaPode(conta);
    if (!pode.ok) return { ok: false, motivo: pode.motivo, userId: conta.userId };

    // Nome e login seguem os do GOA (para o monitor de acessos); o e-mail fica o da criação.
    await getDb()
        .update(identidadesFederadas)
        .set({ login: pedido.login, nome: pedido.nome ?? conta.nome, ultimoUsoEm: new Date() })
        .where(eq(identidadesFederadas.id, conta.id));

    return {
        ok: true,
        criada,
        userId: conta.userId,
        email: conta.email,
        nome: pedido.nome ?? conta.nome ?? null,
        roles: conta.roles,
        sessionVersion: conta.sessionVersion,
    };
}
