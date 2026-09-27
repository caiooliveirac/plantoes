/* A sessão do portal (cookie mnrs_sso do porteiro) ainda vale? O porteiro
   pergunta aqui antes de deixar passar Tabela e Triagem (nginx auth_request →
   /_auth/portao) e ao abrir o portal. É o que faz "suspender", "encerrar
   sessões" e troca de senha valerem também fora do app Plantões
   (docs/monitor-acessos.md). */
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userRoles, users } from "@/db/schema";

export type MotivoRecusaDoPortal = "sem_conta" | "inativa" | "sem_papel" | "versao";

export interface ConferenciaDoPortal {
    ok: boolean;
    motivo?: MotivoRecusaDoPortal;
    userId: string | null;
}

/** `sv` = users.session_version de quando a senha foi conferida no portal; cookie antigo sem ele vale 0. */
export async function conferirSessaoDoPortal(email: string, sv: number | null | undefined): Promise<ConferenciaDoPortal> {
    const db = getDb();
    const [conta] = await db
        .select({ id: users.id, isActive: users.isActive, sessionVersion: users.sessionVersion })
        .from(users)
        .where(eq(users.email, email.trim().toLowerCase()))
        .limit(1);
    if (!conta) return { ok: false, motivo: "sem_conta", userId: null };
    if (!conta.isActive) return { ok: false, motivo: "inativa", userId: conta.id };
    // Qualquer papel vale no portal, inclusive `portal` (mesmo escopo do verificar-escala).
    const [papel] = await db.select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, conta.id)).limit(1);
    if (!papel) return { ok: false, motivo: "sem_papel", userId: conta.id };
    if ((sv ?? 0) !== conta.sessionVersion) return { ok: false, motivo: "versao", userId: conta.id };
    return { ok: true, userId: conta.id };
}
