/**
 * Saneamento: ocupações em que FUNÇÃO e JANELA agendada discordam sobre ser meio
 * plantão. O banco de horas mede atraso e hora extra contra a janela, então o
 * desacordo vira saldo errado — nas duas direções:
 *
 *  A. Janela de meia jornada (11:30–17:00) sob função de plantão inteiro. Até
 *     jul/2026 trocar a função no quadro mudava só o rótulo: quem o bot supôs
 *     meio plantão e a chefia reclassificou (MEIO_PLANTAO → COI/MRV/…) ficou com
 *     o plantão inteiro atrasado sendo lido como "chegou adiantado", e ainda
 *     ganhava hora extra em dobro depois das 17:00. (caso Vanessa Brito)
 *
 *  B. Função MEIO_PLANTAO sobre janela de turno inteiro (07:00–19:15). Toda
 *     correção de horário reescrevia a janela pelo turno e mantinha o rótulo: o
 *     médico pagava 0,5 e ainda levava ~4h30 de atraso inventado, medido desde
 *     as 07:00 de um plantão que começava 11:30. (caso Cecilia Veiga, 26/07/2026
 *     — 11 ocupações entre abr e jul/2026)
 *
 * O que o script faz: reaplica a função vigente pelo caminho normal de correção
 * (correctRegulationOccupancy / correctInterventionOccupancy). Não escreve janela
 * na mão — resolveCorrectedHalfShiftState reconhece a incoerência, refaz a janela
 * e o sync do banco de horas roda em seguida. Quando a chegada é anterior às
 * 11:10 o próprio corretor rebaixa a função: meia jornada fora da janela de
 * reconhecimento não se sustenta, e manter o rótulo pagaria 0,5 de um plantão
 * inteiro.
 *
 * Uso (LOCAL, com DATABASE_URL apontando para o alvo):
 *   npx tsx scripts/repair-half-shift-role-change-windows.ts              # dry-run
 *   npx tsx scripts/repair-half-shift-role-change-windows.ts --apply
 *   ... --only=<occupancyId>[,<occupancyId>]   # restringe a ocupações específicas
 *   ... --since=2026-07-01                     # ignora o que é anterior à data
 *   ... --include-attested                     # libera meses já atestados
 *
 * Rode SEMPRE o dry-run antes. Mês já atestado no fechamento fica FORA por
 * padrão: mexer no saldo depois da assinatura do admin exige decisão explícita.
 */
import { closeDb, getDb } from "@/db";
import { interventionOccupancies, regulationOccupancies } from "@/db/schema";
import { calculateBankHours, applyAnomalyGuard } from "@/modules/bank-hours/calculator";
import { resolveBankHoursScheduledWindow } from "@/modules/bank-hours/window";
import { correctInterventionOccupancy, correctRegulationOccupancy } from "@/modules/operational/corrections";
import {
    isBeforeHalfShiftWindow,
    isHalfShiftRoleLabel,
    isHalfShiftScheduledWindow,
    resolveHalfShiftScheduledWindow,
} from "@/modules/operational/half-shift";
import { inferInterventionCoverageWindow, inferRegulationCoverageWindow } from "@/modules/operational/rules";

type Domain = "regulation" | "intervention";

interface Candidate {
    domain: Domain;
    occupancyId: string;
    doctorId: string;
    doctorName: string;
    monthKey: string;
    attested: boolean;
    targetCode: string;
    roleLabel: string | null;
    repairedRoleLabel: string | null;
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

function monthKeyOf(date: Date) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit" })
        .format(date)
        .slice(0, 7);
}

async function collectCandidates(): Promise<Candidate[]> {
    const db = getDb();
    const since = parseSince();
    const only = parseOnly();
    const candidates: Candidate[] = [];

    const [regulation, intervention, posts, bases, doctorRows, attestations] = await Promise.all([
        db.query.regulationOccupancies.findMany(),
        db.query.interventionOccupancies.findMany(),
        db.query.regulationPosts.findMany(),
        db.query.interventionBases.findMany(),
        db.query.doctors.findMany(),
        db.query.paymentClosingAttestations.findMany(),
    ]);
    const postCodeById = new Map(posts.map((post) => [post.id, post.code]));
    const baseCodeById = new Map(bases.map((base) => [base.id, base.code]));
    const doctorNameById = new Map(doctorRows.map((doctor) => [doctor.id, doctor.fullName]));
    const attestedKeys = new Set(attestations.map((row) => `${row.doctorId}:${row.monthKey}`));

    const push = (candidate: Candidate) => {
        if (since && candidate.startedAt.getTime() < since.getTime()) return;
        if (only && !only.has(candidate.occupancyId)) return;
        candidates.push(candidate);
    };

    /** Função e janela discordam? Se sim, devolve o par corrigido — espelha a
     *  decisão que resolveCorrectedHalfShiftState toma dentro da correção. */
    function diagnose(params: {
        roleLabel: string | null;
        reference: Date;
        storedWindow: { scheduledStartAt: Date | null; scheduledEndAt: Date | null };
        inferFullShiftWindow: () => { scheduledStartAt: Date | null; scheduledEndAt: Date | null };
    }) {
        // O gatilho e SEMPRE a discordancia entre funcao e janela. O corte das
        // 11:10 nasceu em 30/07/2026 e nao entra como motivo por si so: quem
        // avisou meio plantao sob a regra antiga (reconhecimento a partir das
        // 10:30) e ja tem a janela de meia jornada gravada nao pode ser rebaixado
        // retroativamente. Quando a ocupacao ENTRA no saneamento por outro motivo,
        // ai sim o corretor rebaixa a funcao se a chegada estiver fora da janela.
        if (isHalfShiftRoleLabel(params.roleLabel)) {
            // Passivo: janela de turno inteiro sob meia jornada. Janela tardia
            // (13:13–17:00, do bot antigo) e coerente e fica como esta.
            const storedStartAt = params.storedWindow.scheduledStartAt;
            if (storedStartAt !== null && !isBeforeHalfShiftWindow(storedStartAt)) {
                return null;
            }
            const demoted = isBeforeHalfShiftWindow(params.reference);
            return {
                repairedRoleLabel: demoted ? null : params.roleLabel,
                repairedWindow: demoted
                    ? params.inferFullShiftWindow()
                    : resolveHalfShiftScheduledWindow(params.reference),
            };
        }

        // Passivo inverso: funcao de plantao inteiro sobre a janela canonica de
        // meia jornada.
        if (!isHalfShiftScheduledWindow(params.storedWindow)) {
            return null;
        }
        return { repairedRoleLabel: params.roleLabel, repairedWindow: params.inferFullShiftWindow() };
    }

    for (const occupancy of regulation as Array<typeof regulationOccupancies.$inferSelect>) {
        const storedWindow = {
            scheduledStartAt: occupancy.scheduledStartAt,
            scheduledEndAt: occupancy.scheduledEndAt,
        };
        const targetCode = postCodeById.get(occupancy.postId) ?? String(occupancy.postId);
        const reference = occupancy.boardStartedAt && occupancy.boardStartedAt > occupancy.startedAt
            ? occupancy.boardStartedAt
            : occupancy.startedAt;
        const diagnosis = diagnose({
            roleLabel: occupancy.roleLabel,
            reference,
            storedWindow,
            inferFullShiftWindow: () => inferRegulationCoverageWindow({
                startedAt: reference,
                shiftLabel: occupancy.shiftLabel,
                postCode: targetCode,
                explicitScheduledStartAt: null,
                explicitScheduledEndAt: null,
            }),
        });
        if (!diagnosis) continue;

        const monthKey = monthKeyOf(occupancy.startedAt);
        push({
            domain: "regulation",
            occupancyId: occupancy.id,
            doctorId: occupancy.doctorId,
            doctorName: doctorNameById.get(occupancy.doctorId) ?? occupancy.doctorId,
            monthKey,
            attested: attestedKeys.has(`${occupancy.doctorId}:${monthKey}`),
            targetCode,
            roleLabel: occupancy.roleLabel,
            repairedRoleLabel: diagnosis.repairedRoleLabel,
            shiftLabel: occupancy.shiftLabel,
            startedAt: occupancy.startedAt,
            actualEndAt: occupancy.actualEndedAt ?? occupancy.endedAt,
            storedWindow,
            repairedWindow: diagnosis.repairedWindow,
        });
    }

    for (const occupancy of intervention as Array<typeof interventionOccupancies.$inferSelect>) {
        const storedWindow = {
            scheduledStartAt: occupancy.scheduledStartAt,
            scheduledEndAt: occupancy.scheduledEndAt,
        };
        const reference = occupancy.boardStartedAt && occupancy.boardStartedAt > occupancy.startedAt
            ? occupancy.boardStartedAt
            : occupancy.startedAt;
        const diagnosis = diagnose({
            roleLabel: occupancy.roleLabel,
            reference,
            storedWindow,
            inferFullShiftWindow: () => inferInterventionCoverageWindow({
                startedAt: reference,
                shiftLabel: occupancy.shiftLabel,
                explicitScheduledStartAt: null,
                explicitScheduledEndAt: null,
            }),
        });
        if (!diagnosis) continue;

        const monthKey = monthKeyOf(occupancy.startedAt);
        push({
            domain: "intervention",
            occupancyId: occupancy.id,
            doctorId: occupancy.doctorId,
            doctorName: doctorNameById.get(occupancy.doctorId) ?? occupancy.doctorId,
            monthKey,
            attested: attestedKeys.has(`${occupancy.doctorId}:${monthKey}`),
            targetCode: baseCodeById.get(occupancy.baseId) ?? String(occupancy.baseId),
            roleLabel: occupancy.roleLabel,
            repairedRoleLabel: diagnosis.repairedRoleLabel,
            shiftLabel: occupancy.shiftLabel,
            startedAt: occupancy.startedAt,
            actualEndAt: occupancy.actualEndedAt ?? occupancy.endedAt,
            storedWindow,
            repairedWindow: diagnosis.repairedWindow,
        });
    }

    return candidates.sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime());
}

async function main() {
    const apply = hasFlag("--apply");
    const includeAttested = hasFlag("--include-attested");
    const all = await collectCandidates();
    const candidates = includeAttested ? all : all.filter((candidate) => !candidate.attested);
    const skipped = all.length - candidates.length;

    console.log(`\n${all.length} ocupacao(oes) com funcao e janela em desacordo sobre meio plantao.`);
    if (skipped > 0) {
        console.log(`${skipped} em mes ja atestado — fora desta rodada (use --include-attested para incluir).`);
    }
    console.log("");

    let totalDelta = 0;
    let devolvido = 0;
    let debitado = 0;
    for (const candidate of candidates) {
        const before = previewBalance(candidate, candidate.storedWindow);
        const after = previewBalance(candidate, candidate.repairedWindow);

        console.log(`[${candidate.domain}] ${candidate.targetCode} — ${candidate.doctorName} (${candidate.monthKey})`);
        console.log(`  ${candidate.occupancyId}`);
        console.log(`  funcao=${candidate.roleLabel ?? "—"} turno=${candidate.shiftLabel ?? "—"}`);
        if (candidate.repairedRoleLabel !== candidate.roleLabel) {
            console.log(`  funcao  ${candidate.roleLabel ?? "—"} -> ${candidate.repairedRoleLabel ?? "—"} (chegada antes das 11:10: nao e meia jornada)`);
        }
        console.log(`  chegada ${fmt(candidate.startedAt)} · saida ${fmt(candidate.actualEndAt)}`);
        console.log(`  janela  ${fmt(candidate.storedWindow.scheduledStartAt)} -> ${fmt(candidate.storedWindow.scheduledEndAt)}`);
        console.log(`  vira    ${fmt(candidate.repairedWindow.scheduledStartAt)} -> ${fmt(candidate.repairedWindow.scheduledEndAt)}`);
        if (before && after) {
            const delta = after.balanceMinutes - before.balanceMinutes;
            totalDelta += delta;
            if (delta > 0) devolvido += delta;
            if (delta < 0) debitado += delta;
            console.log(`  saldo   ${signed(before.balanceMinutes)} (${before.ruleCode}) -> ${signed(after.balanceMinutes)} (${after.ruleCode}) · delta ${signed(delta)}`);
        } else {
            console.log("  saldo   plantao ainda aberto: o calculo so roda no fechamento");
        }
        console.log("");
    }

    // O saldo devolvido e o debito novo andam juntos: a mesma incoerencia que
    // inventou atraso em quem foi pontual escondeu atraso de quem chegou tarde.
    // Os dois lados sao decisao de quem roda — use --only para separar.
    console.log(`Devolvido a medicos: ${signed(devolvido)}. Debito novo: ${signed(debitado)}. Liquido: ${signed(totalDelta)}.\n`);

    if (!apply) {
        console.log("DRY-RUN. Nada foi alterado. Rode de novo com --apply para corrigir.");
        console.log("Delimite com --only=<id> ou --since=YYYY-MM-DD se quiser recortar ainda mais.\n");
        return;
    }

    for (const candidate of candidates) {
        // Reaplica a funcao vigente: a auto-cura refaz a janela (e rebaixa a
        // funcao quando a chegada e anterior as 11:10) e o sync do banco de horas
        // roda dentro da propria correcao.
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
