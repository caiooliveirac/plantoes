/**
 * Saneamento: ocupações com JANELA de meia jornada (11:30–17:00) sob FUNÇÃO de
 * plantão inteiro.
 *
 * Como o passivo surgiu: até jul/2026 trocar a função no quadro mudava só o
 * rótulo. Quem o bot supôs meio plantão e a chefia reclassificou (MEIO_PLANTAO →
 * COI/MRV/…) ficou com a função inteira sobre a janela agendada de meia jornada.
 * O banco de horas mede atraso e hora extra contra essa janela, então o plantão
 * inteiro atrasado era lido como "chegou adiantado" e ainda ganhava hora extra
 * em dobro depois das 17:00.
 *
 * O que o script faz: reaplica a função vigente pelo caminho normal de correção
 * (correctRegulationOccupancy / correctInterventionOccupancy). Não escreve janela
 * na mão — a auto-cura de resolveCorrectedScheduledWindow reconhece a incoerência,
 * refaz a janela pelo turno e o sync do banco de horas roda em seguida.
 *
 * Uso (LOCAL, com DATABASE_URL apontando para o alvo):
 *   npx tsx scripts/repair-half-shift-role-change-windows.ts              # dry-run
 *   npx tsx scripts/repair-half-shift-role-change-windows.ts --apply
 *   ... --only=<occupancyId>[,<occupancyId>]   # restringe a ocupações específicas
 *   ... --since=2026-07-01                     # ignora o que é anterior à data
 *
 * Rode SEMPRE o dry-run antes. Meses já atestados no fechamento não devem ser
 * tocados sem decisão explícita — use --since/--only para delimitar.
 */
import { closeDb, getDb } from "@/db";
import { interventionOccupancies, regulationOccupancies } from "@/db/schema";
import { calculateBankHours, applyAnomalyGuard } from "@/modules/bank-hours/calculator";
import { resolveBankHoursScheduledWindow } from "@/modules/bank-hours/window";
import { correctInterventionOccupancy, correctRegulationOccupancy } from "@/modules/operational/corrections";
import { isHalfShiftRoleLabel, isHalfShiftScheduledWindow } from "@/modules/operational/half-shift";
import { inferInterventionCoverageWindow, inferRegulationCoverageWindow } from "@/modules/operational/rules";

type Domain = "regulation" | "intervention";

interface Candidate {
    domain: Domain;
    occupancyId: string;
    doctorId: string;
    targetCode: string;
    roleLabel: string | null;
    shiftLabel: string | null;
    startedAt: Date;
    actualEndAt: Date | null;
    storedWindow: { scheduledStartAt: Date | null; scheduledEndAt: Date | null };
    repairedWindow: { scheduledStartAt: Date | null; scheduledEndAt: Date | null };
}

function hasFlag(flag: string) {
    return process.argv.includes(flag);
}

function getFlagValue(flag: string) {
    const prefix = `${flag}=`;
    return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function parseSince() {
    const raw = getFlagValue("--since");
    if (!raw) return null;
    const parsed = new Date(raw.length === 10 ? `${raw}T00:00:00.000Z` : raw);
    if (Number.isNaN(parsed.getTime())) {
        throw new Error(`Data invalida para --since: ${raw}`);
    }
    return parsed;
}

function parseOnly() {
    const raw = getFlagValue("--only");
    if (!raw) return null;
    return new Set(raw.split(",").map((value) => value.trim()).filter(Boolean));
}

function fmt(value: Date | null | undefined) {
    if (!value) return "—";
    return value.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" });
}

function signed(value: number) {
    return `${value > 0 ? "+" : ""}${value} min`;
}

/** Saldo que o banco de horas produziria para essa ocupação com a janela dada.
 *  Só serve de PRÉVIA no relatório — o cálculo oficial roda no sync, sobre o
 *  grupo de continuidade inteiro. */
function previewBalance(candidate: Candidate, window: { scheduledStartAt: Date | null; scheduledEndAt: Date | null }) {
    if (!window.scheduledStartAt || !window.scheduledEndAt || !candidate.actualEndAt) {
        return null;
    }

    const bankWindow = resolveBankHoursScheduledWindow({
        domain: candidate.domain,
        startedAt: candidate.startedAt,
        shiftLabel: candidate.shiftLabel,
        scheduledStartAt: window.scheduledStartAt,
        scheduledEndAt: window.scheduledEndAt,
        postCode: candidate.targetCode,
    });
    if (!bankWindow.scheduledStartAt || !bankWindow.scheduledEndAt) {
        return null;
    }

    return applyAnomalyGuard(calculateBankHours({
        scheduledStartAt: bankWindow.scheduledStartAt,
        scheduledEndAt: bankWindow.scheduledEndAt,
        actualStartAt: candidate.startedAt,
        actualEndAt: candidate.actualEndAt,
    }));
}

async function collectCandidates(): Promise<Candidate[]> {
    const db = getDb();
    const since = parseSince();
    const only = parseOnly();
    const candidates: Candidate[] = [];

    const [regulation, intervention, posts, bases] = await Promise.all([
        db.query.regulationOccupancies.findMany(),
        db.query.interventionOccupancies.findMany(),
        db.query.regulationPosts.findMany(),
        db.query.interventionBases.findMany(),
    ]);
    const postCodeById = new Map(posts.map((post) => [post.id, post.code]));
    const baseCodeById = new Map(bases.map((base) => [base.id, base.code]));

    const push = (candidate: Candidate) => {
        if (since && candidate.startedAt.getTime() < since.getTime()) return;
        if (only && !only.has(candidate.occupancyId)) return;
        candidates.push(candidate);
    };

    for (const occupancy of regulation as Array<typeof regulationOccupancies.$inferSelect>) {
        const storedWindow = {
            scheduledStartAt: occupancy.scheduledStartAt,
            scheduledEndAt: occupancy.scheduledEndAt,
        };
        if (!isHalfShiftScheduledWindow(storedWindow)) continue;
        if (isHalfShiftRoleLabel(occupancy.roleLabel)) continue;

        const targetCode = postCodeById.get(occupancy.postId) ?? String(occupancy.postId);
        const reference = occupancy.boardStartedAt && occupancy.boardStartedAt > occupancy.startedAt
            ? occupancy.boardStartedAt
            : occupancy.startedAt;
        push({
            domain: "regulation",
            occupancyId: occupancy.id,
            doctorId: occupancy.doctorId,
            targetCode,
            roleLabel: occupancy.roleLabel,
            shiftLabel: occupancy.shiftLabel,
            startedAt: occupancy.startedAt,
            actualEndAt: occupancy.actualEndedAt ?? occupancy.endedAt,
            storedWindow,
            repairedWindow: inferRegulationCoverageWindow({
                startedAt: reference,
                shiftLabel: occupancy.shiftLabel,
                postCode: targetCode,
                explicitScheduledStartAt: null,
                explicitScheduledEndAt: null,
            }),
        });
    }

    for (const occupancy of intervention as Array<typeof interventionOccupancies.$inferSelect>) {
        const storedWindow = {
            scheduledStartAt: occupancy.scheduledStartAt,
            scheduledEndAt: occupancy.scheduledEndAt,
        };
        if (!isHalfShiftScheduledWindow(storedWindow)) continue;
        if (isHalfShiftRoleLabel(occupancy.roleLabel)) continue;

        const reference = occupancy.boardStartedAt && occupancy.boardStartedAt > occupancy.startedAt
            ? occupancy.boardStartedAt
            : occupancy.startedAt;
        push({
            domain: "intervention",
            occupancyId: occupancy.id,
            doctorId: occupancy.doctorId,
            targetCode: baseCodeById.get(occupancy.baseId) ?? String(occupancy.baseId),
            roleLabel: occupancy.roleLabel,
            shiftLabel: occupancy.shiftLabel,
            startedAt: occupancy.startedAt,
            actualEndAt: occupancy.actualEndedAt ?? occupancy.endedAt,
            storedWindow,
            repairedWindow: inferInterventionCoverageWindow({
                startedAt: reference,
                shiftLabel: occupancy.shiftLabel,
                explicitScheduledStartAt: null,
                explicitScheduledEndAt: null,
            }),
        });
    }

    return candidates.sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime());
}

async function main() {
    const apply = hasFlag("--apply");
    const candidates = await collectCandidates();

    console.log(`\n${candidates.length} ocupacao(oes) com janela de meia jornada sob funcao de plantao inteiro.\n`);

    for (const candidate of candidates) {
        const before = previewBalance(candidate, candidate.storedWindow);
        const after = previewBalance(candidate, candidate.repairedWindow);

        console.log(`[${candidate.domain}] ${candidate.targetCode} — ${candidate.occupancyId}`);
        console.log(`  funcao=${candidate.roleLabel ?? "—"} turno=${candidate.shiftLabel ?? "—"}`);
        console.log(`  chegada ${fmt(candidate.startedAt)} · saida ${fmt(candidate.actualEndAt)}`);
        console.log(`  janela  ${fmt(candidate.storedWindow.scheduledStartAt)} -> ${fmt(candidate.storedWindow.scheduledEndAt)}`);
        console.log(`  vira    ${fmt(candidate.repairedWindow.scheduledStartAt)} -> ${fmt(candidate.repairedWindow.scheduledEndAt)}`);
        if (before && after) {
            const delta = after.balanceMinutes - before.balanceMinutes;
            console.log(`  saldo   ${signed(before.balanceMinutes)} (${before.ruleCode}) -> ${signed(after.balanceMinutes)} (${after.ruleCode}) · delta ${signed(delta)}`);
        } else {
            console.log("  saldo   plantao ainda aberto: o calculo so roda no fechamento");
        }
        console.log("");
    }

    if (!apply) {
        console.log("DRY-RUN. Nada foi alterado. Rode de novo com --apply para corrigir.");
        console.log("Delimite com --only=<id> ou --since=YYYY-MM-DD para nao tocar mes ja atestado.\n");
        return;
    }

    for (const candidate of candidates) {
        // Reaplica a funcao vigente: a auto-cura refaz a janela e o sync do banco
        // de horas roda dentro da propria correcao.
        //
        // O payload leva SO o roleLabel de proposito. Mandar notes: null apagaria
        // as anotacoes da ocupacao e chiefConfirmed: false apagaria a confirmacao
        // de saida da chefia — os dois campos so sao tocados quando presentes no
        // input, entao omitir e o que preserva o registro.
        const payload = { roleLabel: candidate.roleLabel };
        if (candidate.domain === "regulation") {
            await correctRegulationOccupancy(candidate.occupancyId, payload as never, null);
        } else {
            await correctInterventionOccupancy(candidate.occupancyId, payload as never, null);
        }
        console.log(`corrigida ${candidate.domain} ${candidate.targetCode} ${candidate.occupancyId}`);
    }

    console.log(`\n${candidates.length} ocupacao(oes) corrigida(s).\n`);
}

main()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await closeDb();
    });
