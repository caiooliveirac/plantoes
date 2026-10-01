import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { CHIEF_REGULATION_POST_CODE } from "@/modules/operational/roles";
import type { ChefeDePlantaoAtual } from "@/modules/operational/chefe-de-plantao";

/**
 * Quem está na 2031 agora: a ocupação titular (board_started_at preenchido)
 * aberta no ramal da chefia. Mesma noção de "ativo" do quadro: sem saída real
 * e sem handoff passado. Erro de banco devolve null (não barra ninguém).
 */
export async function chefeDePlantaoAtual(): Promise<ChefeDePlantaoAtual | null> {
    try {
        const db = getDb();
        const result = await db.execute(sql`
            select d.id as "doctorId",
                   coalesce(nullif(trim(d.display_name), ''), d.full_name) as "nome",
                   ro.board_started_at as "desde"
              from operations_v2.regulation_occupancies ro
              join operations_v2.regulation_posts rp on rp.id = ro.post_id
              join operations_v2.doctors d on d.id = ro.doctor_id
             where rp.code = ${CHIEF_REGULATION_POST_CODE}
               and ro.board_started_at is not null
               and ro.actual_ended_at is null
               and (ro.ended_at is null or ro.ended_at > now())
             order by ro.board_started_at desc
             limit 1
        `);
        const row = (result as unknown as Array<Record<string, unknown>>)[0];
        if (!row) return null;
        const desde = row.desde instanceof Date ? row.desde.toISOString() : row.desde ? String(row.desde) : null;
        return { doctorId: String(row.doctorId), nome: String(row.nome), desde };
    } catch {
        return null;
    }
}

/** Nome curto do médico vinculado à conta (display_name, senão full_name). */
export async function nomeDoMedicoDaSessao(doctorId: string | null): Promise<string | null> {
    if (!doctorId) return null;
    try {
        const result = await getDb().execute(sql`
            select coalesce(nullif(trim(d.display_name), ''), d.full_name) as "nome"
              from operations_v2.doctors d where d.id = ${doctorId}::uuid limit 1
        `);
        const row = (result as unknown as Array<Record<string, unknown>>)[0];
        return row?.nome ? String(row.nome) : null;
    } catch {
        return null;
    }
}
