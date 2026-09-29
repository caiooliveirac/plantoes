import { asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { doctors } from "@/db/schema";

/* O fluxo de convite/pedido/bootstrap de chefia saiu com a tela "Acesso de
   chefia" (29/09/2026). Fica só a lista de médicos ativos que a Mesa usa nos
   seletores da coordenação. */
export async function listDoctorsForChiefInvite() {
    const db = getDb();
    const rows = await db
        .select({
            id: doctors.id,
            fullName: doctors.fullName,
            displayName: doctors.displayName,
        })
        .from(doctors)
        .where(eq(doctors.isActive, true))
        .orderBy(asc(doctors.fullName));

    return rows;
}
