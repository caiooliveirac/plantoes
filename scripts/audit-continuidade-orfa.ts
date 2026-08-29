/**
 * audit-continuidade-orfa.ts
 *
 * Levanta o passivo das cadeias que nasceram SOLTAS: chegadas que, pelas regras
 * de 2026-08-29, teriam herdado a âncora do plantão anterior, mas foram gravadas
 * como plantão novo porque o médico avisou tarde — em geral sem o verbo
 * "continua" (casos João Victor Perrone e Thainara).
 *
 * O que a âncora perdida custa, por ocupação órfã:
 *   - BANCO DE HORAS: a chegada vira a hora do aviso, não a real. Quem estava lá
 *     desde a manhã e avisou às 21h aparece com horas de atraso que não existiram.
 *   - REFEIÇÃO: a fila de prioridade ordena por chegada, e a duração da janta
 *     ("quem dobra desde a manhã janta 1h") sai da âncora da cadeia. O órfão cai
 *     para o fim da fila e para 30min.
 *
 * As regras novas só agem sobre mensagens novas — este passivo é o que ficou
 * para trás. O script NÃO GRAVA NADA: imprime para a coordenação decidir.
 *
 * Uso (contra produção, SOMENTE LEITURA, pelo túnel SSH — ver
 * docs/agent-operations.md §3):
 *   DATABASE_URL="$PLANTOES_RO_URL" npx tsx scripts/audit-continuidade-orfa.ts [--meses 3] [--csv]
 */
import { sql } from "drizzle-orm";
import { closeDb, getDb, hasDatabaseUrl } from "@/db";
import {
    shouldInferCrossShiftContinuation,
    shouldLinkExplicitContinuationClosedSource,
} from "@/modules/telegram/service";

const asCsv = process.argv.includes("--csv");
const mesesIndex = process.argv.indexOf("--meses");
const meses = mesesIndex >= 0 ? Number(process.argv[mesesIndex + 1]) || 3 : 3;

const DIA = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short" });
const HORA = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
});

interface Row extends Record<string, unknown> {
    occupancyId: string;
    domain: string;
    doctorId: string;
    doctorName: string;
    target: string;
    continuityGroupId: string;
    startedAt: string;
    boardStartedAt: string | null;
    endedAt: string | null;
    shiftLabel: string | null;
    arrivalDelayMinutes: number | null;
}

function toDate(value: string | null) {
    return value ? new Date(value) : null;
}

async function main() {
    if (!hasDatabaseUrl()) {
        console.error("DATABASE_URL não configurada. Aponte para $PLANTOES_RO_URL (ver docs/agent-operations.md §3).");
        process.exitCode = 1;
        return;
    }

    const db = getDb();
    const desde = new Date(Date.now() - meses * 30 * 24 * 60 * 60 * 1000).toISOString();

    // Uma linha por ocupação dos dois domínios, com o atraso que o banco gravou.
    const rows = await db.execute<Row>(sql`
        select o.id::text as "occupancyId", 'regulação' as domain, o.doctor_id::text as "doctorId",
               d.full_name as "doctorName", p.code as target,
               o.continuity_group_id::text as "continuityGroupId",
               o.started_at as "startedAt", o.board_started_at as "boardStartedAt",
               coalesce(o.actual_ended_at, o.ended_at) as "endedAt", o.shift_label as "shiftLabel",
               bhe.arrival_delay_minutes as "arrivalDelayMinutes"
        from operations_v2.regulation_occupancies o
        join operations_v2.doctors d on d.id = o.doctor_id
        join operations_v2.regulation_posts p on p.id = o.post_id
        left join operations_v2.bank_hours_entries bhe on bhe.regulation_occupancy_id = o.id
        where o.started_at >= ${desde}
        union all
        select o.id::text, 'intervenção', o.doctor_id::text, d.full_name, b.code,
               o.continuity_group_id::text, o.started_at, o.board_started_at,
               coalesce(o.actual_ended_at, o.ended_at), o.shift_label,
               bhe.arrival_delay_minutes
        from operations_v2.intervention_occupancies o
        join operations_v2.doctors d on d.id = o.doctor_id
        join operations_v2.intervention_bases b on b.id = o.base_id
        left join operations_v2.bank_hours_entries bhe on bhe.intervention_occupancy_id = o.id
        where o.started_at >= ${desde}
    `) as unknown as Row[];

    const porMedico = new Map<string, Row[]>();
    for (const row of rows) {
        const lista = porMedico.get(row.doctorId) ?? [];
        lista.push(row);
        porMedico.set(row.doctorId, lista);
    }

    const orfas: Array<Row & { fonteTarget: string; fonteStartedAt: string; ancoraPerdidaMin: number }> = [];

    for (const lista of porMedico.values()) {
        const ordenadas = [...lista].sort(
            (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime(),
        );

        for (let i = 0; i < ordenadas.length; i += 1) {
            const chegada = ordenadas[i];
            const chegadaAt = new Date(chegada.startedAt);

            // A fonte é o plantão imediatamente anterior do mesmo médico.
            const fonte = [...ordenadas.slice(0, i)].reverse().find((candidata) => {
                const fim = toDate(candidata.endedAt);
                return fim !== null && fim.getTime() <= chegadaAt.getTime();
            });
            if (!fonte) continue;

            const fonteEndedAt = toDate(fonte.endedAt)!;

            // As duas condições que hoje ligam a cadeia (ver modules/telegram/service.ts).
            const adjacente = shouldLinkExplicitContinuationClosedSource({
                eventAt: chegadaAt,
                sourceStartedAt: new Date(fonte.startedAt),
                sourceEndedAt: fonteEndedAt,
            });
            const travessia = shouldInferCrossShiftContinuation({
                sourceShiftLabel: fonte.shiftLabel,
                eventAt: chegadaAt,
                isExplicitContinuation: false,
            });
            if (!adjacente || !travessia) continue;

            // Já ligada? Então nada a fazer.
            if (chegada.continuityGroupId === fonte.continuityGroupId) continue;

            const ancora = toDate(chegada.boardStartedAt) ?? chegadaAt;
            const ancoraCorreta = toDate(fonte.boardStartedAt) ?? new Date(fonte.startedAt);
            orfas.push({
                ...chegada,
                fonteTarget: fonte.target,
                fonteStartedAt: fonte.startedAt,
                ancoraPerdidaMin: Math.round((ancora.getTime() - ancoraCorreta.getTime()) / 60000),
            });
        }
    }

    orfas.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

    if (asCsv) {
        console.log("dia;medico;dominio;alvo;chegada_gravada;ancora_correta;ancora_perdida_min;atraso_no_banco_min;ocupacao");
        for (const o of orfas) {
            console.log([
                DIA.format(new Date(o.startedAt)), o.doctorName, o.domain, o.target,
                HORA.format(new Date(o.startedAt)), HORA.format(new Date(o.fonteStartedAt)),
                o.ancoraPerdidaMin, o.arrivalDelayMinutes ?? "", o.occupancyId,
            ].join(";"));
        }
    } else {
        for (const o of orfas) {
            const atraso = o.arrivalDelayMinutes && o.arrivalDelayMinutes > 0
                ? ` — banco gravou ${o.arrivalDelayMinutes}min de atraso que provavelmente não existiu`
                : "";
            console.log(
                `${DIA.format(new Date(o.startedAt))}  ${o.doctorName} (${o.domain} ${o.target}): `
                + `chegada gravada ${HORA.format(new Date(o.startedAt))}, `
                + `mas vinha de ${o.fonteTarget} desde ${HORA.format(new Date(o.fonteStartedAt))} `
                + `— âncora ${(o.ancoraPerdidaMin / 60).toFixed(1)}h adiantada${atraso}`,
            );
        }
    }

    const comAtraso = orfas.filter((o) => (o.arrivalDelayMinutes ?? 0) > 0);
    const debitoMin = comAtraso.reduce((soma, o) => soma + (o.arrivalDelayMinutes ?? 0), 0);
    const medicos = new Set(orfas.map((o) => o.doctorId)).size;

    console.log(`\n${orfas.length} cadeias órfãs em ${meses} meses, ${medicos} médicos.`);
    console.log(`${comAtraso.length} com atraso lançado no banco de horas — ${(debitoMin / 60).toFixed(1)}h de débito somadas.`);
    console.log("Cada uma também perdeu prioridade de refeição e caiu de 1h para 30min de janta no dia.");
    console.log("\nNada gravado por este script.");
}

main()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => closeDb());
