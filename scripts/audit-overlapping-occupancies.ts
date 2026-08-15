/**
 * audit-overlapping-occupancies.ts
 *
 * Inventário de plantões duplicados: pares de ocupações SOBREPOSTAS do mesmo
 * médico no mesmo alvo (ramal ou base). Duplicata paga em dobro e só aparece no
 * fechamento, quando já foi atestada.
 *
 * O que NÃO é duplicata e por isso sai do relatório:
 *   - sobreposição de até 30min: é a virada de turno (fim programado 19:15 x
 *     chegada do turno seguinte às 19:00), plantões distintos de verdade;
 *   - carga `import`: a recarga de junho/2026 sobrepôs o registro original de
 *     propósito. Use --incluir-import para vê-la.
 *
 * Classifica cada par pelo estado da PRIMEIRA quando a segunda nasceu:
 *   A. anterior ABERTA                        -> redeclaração; os serviços já
 *      atualizavam no lugar (regulação e intervenção).
 *   B. anterior fechada SEM saída verbalizada -> fechamento automático ou
 *      rendição indevida (caso Maria Juliana, BR05 14/08).
 *   C. anterior fechada COM saída verbalizada -> a saída foi desmentida pela
 *      chegada seguinte (caso Perrone, 2151 13/08).
 *
 * B e C são o que `modules/operational/occupancy-identity.ts` passou a juntar
 * na chegada em vez de duplicar. Rode antes e depois de mexer nessa regra: a
 * contagem por mês é o placar.
 *
 * Uso (contra produção, SOMENTE LEITURA, pelo túnel SSH):
 *   DATABASE_URL="$PLANTOES_RO_URL" npx tsx scripts/audit-overlapping-occupancies.ts [--meses 6] [--incluir-import]
 */
import { sql } from "drizzle-orm";
import { getDb, hasDatabaseUrl } from "@/db";

interface OverlapRow {
    caso: string;
    domain: string;
    target: string;
    doctor_name: string;
    id_a: string;
    started_a: string;
    ended_a: string | null;
    source_a: string;
    id_b: string;
    started_b: string;
    source_b: string;
    overlap_min: number;
    mes: string;
}

function parseArgs() {
    const args = process.argv.slice(2);
    const mesesIndex = args.indexOf("--meses");
    const meses = mesesIndex >= 0 ? Number(args[mesesIndex + 1]) : 6;
    return {
        meses: Number.isFinite(meses) && meses > 0 ? Math.trunc(meses) : 6,
        incluirImport: args.includes("--incluir-import"),
    };
}

function hora(value: string | null) {
    if (!value) return "—";
    return new Intl.DateTimeFormat("pt-BR", {
        day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo",
    }).format(new Date(value));
}

async function main() {
    if (!hasDatabaseUrl()) {
        throw new Error("DATABASE_URL não configurada.");
    }

    const { meses, incluirImport } = parseArgs();
    const db = getDb();

    const rows = await db.execute(sql`
        with occ as (
            select 'regulation' as domain, o.id::text as id, o.doctor_id, d.full_name as doctor_name,
                   rp.code as target, o.started_at,
                   coalesce(o.actual_ended_at, o.ended_at, o.scheduled_end_at) as fin,
                   o.ended_at, o.actual_ended_at, o.source::text as source, o.created_at
            from operations_v2.regulation_occupancies o
            join operations_v2.regulation_posts rp on rp.id = o.post_id
            join operations_v2.doctors d on d.id = o.doctor_id
            where o.started_at > now() - (${meses} || ' months')::interval
            union all
            select 'intervention', o.id::text, o.doctor_id, d.full_name,
                   ib.code, o.started_at,
                   coalesce(o.actual_ended_at, o.ended_at, o.scheduled_end_at),
                   o.ended_at, o.actual_ended_at, o.source::text, o.created_at
            from operations_v2.intervention_occupancies o
            join operations_v2.intervention_bases ib on ib.id = o.base_id
            join operations_v2.doctors d on d.id = o.doctor_id
            where o.started_at > now() - (${meses} || ' months')::interval
        )
        select
            case
                when a.ended_at is null or a.ended_at > b.created_at then 'A. anterior ABERTA'
                when a.actual_ended_at is null then 'B. fechada SEM saida verbalizada'
                else 'C. fechada COM saida verbalizada'
            end as caso,
            a.domain, a.target, a.doctor_name,
            a.id as id_a, a.started_at::text as started_a, a.ended_at::text as ended_a, a.source as source_a,
            b.id as id_b, b.started_at::text as started_b, b.source as source_b,
            round(extract(epoch from (least(a.fin, b.fin) - greatest(a.started_at, b.started_at))) / 60)::int as overlap_min,
            to_char(date_trunc('month', a.started_at), 'YYYY-MM') as mes
        from occ a
        join occ b
          on a.domain = b.domain and a.target = b.target and a.doctor_id = b.doctor_id
         and a.created_at < b.created_at
         and a.started_at < b.fin and b.started_at < a.fin
        where extract(epoch from (least(a.fin, b.fin) - greatest(a.started_at, b.started_at))) / 60 > 30
          and (${incluirImport} or (a.source <> 'import' and b.source <> 'import'))
        order by a.started_at
    `) as unknown as OverlapRow[];

    if (rows.length === 0) {
        console.log(`Nenhum par sobreposto nos últimos ${meses} meses.`);
        return;
    }

    const porCaso = new Map<string, number>();
    const porMes = new Map<string, number>();
    for (const row of rows) {
        porCaso.set(row.caso, (porCaso.get(row.caso) ?? 0) + 1);
        porMes.set(row.mes, (porMes.get(row.mes) ?? 0) + 1);
    }

    console.log(`\nPares sobrepostos (> 30min) nos últimos ${meses} meses: ${rows.length}\n`);

    console.log("Por caso:");
    for (const [caso, total] of [...porCaso.entries()].sort()) {
        console.log(`  ${caso.padEnd(36)} ${String(total).padStart(4)}`);
    }

    console.log("\nPor mês:");
    for (const [mes, total] of [...porMes.entries()].sort()) {
        console.log(`  ${mes}  ${String(total).padStart(4)}`);
    }

    console.log("\nPares:");
    for (const row of rows) {
        console.log(
            `  ${row.mes} ${row.domain.padEnd(12)} ${row.target.padEnd(6)} ${row.doctor_name.slice(0, 28).padEnd(28)}`
            + ` ${row.caso.slice(0, 2)} ${String(row.overlap_min).padStart(5)}min`
            + ` | 1ª ${hora(row.started_a)}→${hora(row.ended_a)} (${row.source_a})`
            + ` | 2ª ${hora(row.started_b)} (${row.source_b})`
            + ` | ${row.id_a} ${row.id_b}`,
        );
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
