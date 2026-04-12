/**
 * audit-false-bank-hours.ts
 *
 * Detecta entradas de banco de horas potencialmente indevidas: casos onde o
 * médico recebeu crédito de hora extra (overtime) mas na verdade apenas mudou
 * de função/posto/base em vez de ir para casa.
 *
 * Padrão do bug (exemplo real — Matheus Mendonça, 30/03/2025):
 *   1. Médico estava na PM04 (intervenção), plantão de 24h
 *   2. Saiu da PM04 com atraso → sistema registrou hora extra
 *   3. Porém ele não foi para casa — foi para a CRU (regulação)
 *   4. Transição de função NÃO gera banco de horas; quem continua de
 *      plantão não "saiu tarde"
 *
 * O que o script faz:
 *   - Busca todas as bank_hours_entries com balanceMinutes > 0
 *   - Para cada uma, verifica se o mesmo médico tinha outra ocupação
 *     (em qualquer domínio) iniciando dentro de uma janela de tempo
 *     próxima ao actualEndAt da ocupação creditada
 *   - Se a outra ocupação está em um continuityGroupId DIFERENTE,
 *     há forte suspeita de transição não vinculada (bug de continuidade)
 *   - Exibe relatório para avaliação manual
 *
 * Uso:
 *   npx tsx scripts/audit-false-bank-hours.ts
 *   npx tsx scripts/audit-false-bank-hours.ts --since=2025-01-01
 *   npx tsx scripts/audit-false-bank-hours.ts --window=120    (janela em minutos, default 120)
 */

import { closeDb, getDb } from "@/db";
import {
    bankHoursEntries,
    doctors,
    interventionBases,
    interventionOccupancies,
    regulationOccupancies,
    regulationPosts,
} from "@/db/schema";

type BankHoursEntry = typeof bankHoursEntries.$inferSelect;
type RegulationOccupancy = typeof regulationOccupancies.$inferSelect;
type InterventionOccupancy = typeof interventionOccupancies.$inferSelect;

interface OccupancySnapshot {
    domain: "regulation" | "intervention";
    occupancyId: string;
    doctorId: string;
    continuityGroupId: string;
    targetCode: string;
    startedAt: Date;
    endedAt: Date | null;
    actualEndedAt: Date | null;
    shiftLabel: string | null;
}

interface SuspectEntry {
    bankHoursEntryId: string;
    doctorName: string;
    doctorId: string;
    sourceType: string;
    sourceOccupancyCode: string;
    sourceOccupancyId: string;
    sourceContinuityGroupId: string;
    scheduledEndAt: string;
    actualEndAt: string;
    overtimeMinutes: number;
    creditedOvertimeMinutes: number;
    balanceMinutes: number;
    ruleCode: string;
    overlapping: boolean;
    nextOccupancy: {
        domain: string;
        occupancyId: string;
        targetCode: string;
        continuityGroupId: string;
        startedAt: string;
        gapMinutes: number;
        sameContinuityGroup: boolean;
    };
}

function getFlagValue(flag: string) {
    const prefix = `${flag}=`;
    return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function parseSinceDate() {
    const raw = getFlagValue("--since");
    if (!raw) {
        return null;
    }

    const normalized = raw.length === 10 ? `${raw}T00:00:00.000Z` : raw;
    const parsed = new Date(normalized);
    if (Number.isNaN(parsed.getTime())) {
        throw new Error(`Data invalida para --since: ${raw}`);
    }

    return parsed;
}

function parseWindowMinutes() {
    const raw = getFlagValue("--window");
    if (!raw) {
        return 120;
    }

    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
        throw new Error(`Valor invalido para --window: ${raw}`);
    }

    return parsed;
}

function diffMinutes(start: Date, end: Date) {
    return Math.round((end.getTime() - start.getTime()) / 60000);
}

function formatLocalDate(date: Date) {
    return date.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

async function main() {
    const db = getDb();
    const since = parseSinceDate();
    const windowMinutes = parseWindowMinutes();

    console.log(`\n=== Auditoria de Banco de Horas — Transições Falsas ===`);
    console.log(`Janela de detecção: ${windowMinutes} minutos`);
    if (since) {
        console.log(`Desde: ${formatLocalDate(since)}`);
    }
    console.log();

    // 1. Carrega dados de referência
    const [posts, bases, doctorRows] = await Promise.all([
        db.query.regulationPosts.findMany({ columns: { id: true, code: true } }),
        db.query.interventionBases.findMany({ columns: { id: true, code: true } }),
        db.query.doctors.findMany({ columns: { id: true, fullName: true, displayName: true } }),
    ]);

    const postCodeById = new Map(posts.map((p) => [p.id, p.code]));
    const baseCodeById = new Map(bases.map((b) => [b.id, b.code]));
    const doctorNameById = new Map(
        doctorRows.map((d) => [d.id, d.displayName ?? d.fullName]),
    );

    // 2. Busca todas as bank_hours_entries com crédito positivo
    const entries = await db.query.bankHoursEntries.findMany({
        where: (fields, operators) => {
            const conditions = [operators.gt(fields.balanceMinutes, 0)];
            if (since) {
                conditions.push(operators.gte(fields.scheduledStartAt, since));
            }

            return operators.and(...conditions);
        },
        orderBy: (table, { asc }) => [asc(table.scheduledStartAt)],
    });

    if (entries.length === 0) {
        console.log("Nenhuma entrada de banco de horas com crédito positivo encontrada.");
        await closeDb();
        return;
    }

    console.log(`Entradas com crédito positivo: ${entries.length}`);

    // 3. Carrega todas as ocupações (ambos domínios)
    const [allRegulation, allIntervention] = await Promise.all([
        db.query.regulationOccupancies.findMany({
            where: (fields, operators) => since ? operators.gte(fields.startedAt, since) : undefined,
        }),
        db.query.interventionOccupancies.findMany({
            where: (fields, operators) => since ? operators.gte(fields.startedAt, since) : undefined,
        }),
    ]);

    // Indexa ocupações por doctorId para busca rápida
    const occupationsByDoctor = new Map<string, OccupancySnapshot[]>();

    for (const row of allRegulation) {
        const snapshots = occupationsByDoctor.get(row.doctorId) ?? [];
        snapshots.push({
            domain: "regulation",
            occupancyId: row.id,
            doctorId: row.doctorId,
            continuityGroupId: row.continuityGroupId,
            targetCode: postCodeById.get(row.postId) ?? `post-${row.postId}`,
            startedAt: row.startedAt,
            endedAt: row.endedAt,
            actualEndedAt: row.actualEndedAt,
            shiftLabel: row.shiftLabel,
        });
        occupationsByDoctor.set(row.doctorId, snapshots);
    }

    for (const row of allIntervention) {
        const snapshots = occupationsByDoctor.get(row.doctorId) ?? [];
        snapshots.push({
            domain: "intervention",
            occupancyId: row.id,
            doctorId: row.doctorId,
            continuityGroupId: row.continuityGroupId,
            targetCode: baseCodeById.get(row.baseId) ?? `base-${row.baseId}`,
            startedAt: row.startedAt,
            endedAt: row.endedAt,
            actualEndedAt: row.actualEndedAt,
            shiftLabel: row.shiftLabel,
        });
        occupationsByDoctor.set(row.doctorId, snapshots);
    }

    // 4. Para cada entry com crédito, verifica se há ocupação subsequente
    const suspects: SuspectEntry[] = [];

    for (const entry of entries) {
        const actualEndAt = entry.actualEndAt;
        const doctorOccupancies = occupationsByDoctor.get(entry.doctorId);
        if (!doctorOccupancies) {
            continue;
        }

        // Identifica a ocupação fonte da entry
        const sourceOccupancyId = entry.regulationOccupancyId ?? entry.interventionOccupancyId;
        if (!sourceOccupancyId) {
            continue;
        }

        const sourceOccupancy = doctorOccupancies.find((o) => o.occupancyId === sourceOccupancyId);
        const sourceStartedAt = sourceOccupancy?.startedAt ?? entry.actualStartAt;

        // Busca ocupações que:
        //   a) começaram dentro da janela após actualEndAt (transição sequencial), OU
        //   b) se sobrepõem ao período da ocupação fonte (transição cruzada, ex: PM04 SD → CRU SN)
        //      Detecta quando a próxima ocupação começou DURANTE a ocupação fonte
        const nextOccupancies = doctorOccupancies
            .filter((o) => {
                if (o.occupancyId === sourceOccupancyId) return false;
                // Se mesma continuityGroup, já está vinculado — pular
                if (sourceOccupancy && o.continuityGroupId === sourceOccupancy.continuityGroupId) return false;

                const gapFromEnd = diffMinutes(actualEndAt, o.startedAt);
                // Caso A: começou perto do fim (sequencial) — até +window min após
                if (gapFromEnd >= -30 && gapFromEnd <= windowMinutes) return true;

                // Caso B: começou DURANTE a ocupação fonte (sobreposição / cross-domain)
                // Ex: SD termina às 19:00 mas fecha às 22:22; SN começa às 19:00
                const startedDuringSource = o.startedAt.getTime() >= sourceStartedAt.getTime()
                    && o.startedAt.getTime() <= actualEndAt.getTime();
                if (startedDuringSource) return true;

                return false;
            })
            .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());

        if (nextOccupancies.length === 0) {
            continue;
        }

        const next = nextOccupancies[0]!;
        const gapMinutes = diffMinutes(actualEndAt, next.startedAt);
        const overlapping = next.startedAt.getTime() < actualEndAt.getTime()
            && next.startedAt.getTime() > sourceStartedAt.getTime();
        const sameContinuityGroup = false; // Filtramos mesma continuidade acima

        suspects.push({
            bankHoursEntryId: entry.id,
            doctorName: doctorNameById.get(entry.doctorId) ?? entry.doctorId,
            doctorId: entry.doctorId,
            sourceType: entry.sourceType,
            sourceOccupancyCode: sourceOccupancy?.targetCode ?? "?",
            sourceOccupancyId: sourceOccupancyId,
            sourceContinuityGroupId: sourceOccupancy?.continuityGroupId ?? "?",
            scheduledEndAt: formatLocalDate(entry.scheduledEndAt),
            actualEndAt: formatLocalDate(actualEndAt),
            overtimeMinutes: entry.overtimeMinutes,
            creditedOvertimeMinutes: entry.creditedOvertimeMinutes,
            balanceMinutes: entry.balanceMinutes,
            ruleCode: entry.ruleCode,
            overlapping,
            nextOccupancy: {
                domain: next.domain,
                occupancyId: next.occupancyId,
                targetCode: next.targetCode,
                continuityGroupId: next.continuityGroupId,
                startedAt: formatLocalDate(next.startedAt),
                gapMinutes,
                sameContinuityGroup,
            },
        });
    }

    // 5. Exibe resultados
    if (suspects.length === 0) {
        console.log("✅ Nenhuma suspeita encontrada. Todas as entradas com crédito parecem legítimas.");
        await closeDb();
        return;
    }

    console.log(`\n⚠️  ${suspects.length} entradas suspeitas encontradas:\n`);
    console.log("─".repeat(100));

    for (const s of suspects) {
        const typeTag = s.overlapping
            ? "⏱️  SOBREPOSIÇÃO — ocupações concorrentes em grupos diferentes"
            : "🔗 SEQUENCIAL — próxima ocupação logo após fim, grupo diferente";

        console.log(`Médico:             ${s.doctorName}`);
        console.log(`Tipo:               ${typeTag}`);
        console.log(`Ocupação origem:    ${s.sourceOccupancyCode} (${s.sourceType})`);
        console.log(`Fim previsto:       ${s.scheduledEndAt}`);
        console.log(`Saída real:         ${s.actualEndAt}`);
        console.log(`Overtime:           ${s.overtimeMinutes} min → creditado ${s.creditedOvertimeMinutes} min (${s.ruleCode})`);
        console.log(`Saldo creditado:    ${s.balanceMinutes} min (+${(s.balanceMinutes / 60).toFixed(1)}h)`);
        console.log(`Próxima ocupação:   ${s.nextOccupancy.targetCode} (${s.nextOccupancy.domain}) — início ${s.nextOccupancy.startedAt}`);
        console.log(`Gap:                ${s.nextOccupancy.gapMinutes} min ${s.overlapping ? "(sobreposição)" : ""}`);
        console.log(`Bank Hours Entry:   ${s.bankHoursEntryId}`);
        console.log(`Occupancy IDs:      src=${s.sourceOccupancyId}  next=${s.nextOccupancy.occupancyId}`);
        console.log(`Continuity Groups:  src=${s.sourceContinuityGroupId}  next=${s.nextOccupancy.continuityGroupId}`);
        console.log("─".repeat(100));
    }

    // Resumo
    const byDoctor = new Map<string, number>();
    let totalSuspectMinutes = 0;

    for (const s of suspects) {
        const current = byDoctor.get(s.doctorName) ?? 0;
        byDoctor.set(s.doctorName, current + s.balanceMinutes);
        totalSuspectMinutes += s.balanceMinutes;
    }

    console.log(`\n=== Resumo por médico ===\n`);

    const sorted = [...byDoctor.entries()].sort((a, b) => b[1] - a[1]);
    for (const [name, minutes] of sorted) {
        console.log(`  ${name.padEnd(35)} ${minutes} min (${(minutes / 60).toFixed(1)}h)`);
    }

    console.log(`\n  TOTAL SUSPEITO: ${totalSuspectMinutes} min (${(totalSuspectMinutes / 60).toFixed(1)}h)`);

    const overlappingCount = suspects.filter((s) => s.overlapping).length;
    const sequentialCount = suspects.filter((s) => !s.overlapping).length;

    console.log(`\n  Sobreposição (cross-domain/cross-shift): ${overlappingCount}`);
    console.log(`  Sequencial (gap curto, grupo diferente):  ${sequentialCount}`);

    // JSON para processamento
    console.log(`\n--- JSON para referência ---`);
    console.log(JSON.stringify({
        totalSuspects: suspects.length,
        totalSuspectMinutes,
        overlappingCount,
        sequentialCount,
        suspects: suspects.map((s) => ({
            bankHoursEntryId: s.bankHoursEntryId,
            doctorName: s.doctorName,
            sourceCode: s.sourceOccupancyCode,
            sourceType: s.sourceType,
            nextCode: s.nextOccupancy.targetCode,
            nextDomain: s.nextOccupancy.domain,
            overtimeMinutes: s.overtimeMinutes,
            balanceMinutes: s.balanceMinutes,
            gapMinutes: s.nextOccupancy.gapMinutes,
            overlapping: s.overlapping,
        })),
    }, null, 2));

    await closeDb();
}

main().catch(async (error) => {
    console.error(error);
    await closeDb().catch(() => undefined);
    process.exitCode = 1;
});
