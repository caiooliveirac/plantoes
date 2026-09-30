/**
 * Saneamento: banco de horas de quem CHEGOU no NUCLEO (08:00) e foi remanejado.
 *
 * O NUCLEO abre às 08:00 no SD; todo o resto abre às 07:00. Quem chegou 07:50 no
 * NUCLEO estava no horário. Quando esse médico era remanejado (quadro ou bot)
 * para a CRU ou para uma ambulância, vários caminhos reinferiam a janela pelo
 * posto de DESTINO e gravavam 07:00 — correção de turno/saída no destino,
 * correção de horário, chegada nova na CRU dentro do mesmo turno, origem
 * NUCLEO apagada. O banco de horas então cobrava 50 min de atraso que não
 * existiram e, por causa do "atraso", pagava a hora extra simples em vez de
 * em dobro. O código foi corrigido (modules/operational/posto-de-chegada.ts);
 * este script devolve o que já foi cobrado.
 *
 * O que ele faz, por grupo de continuidade (= turno do médico):
 *   1. Descobre se o turno COMEÇOU no NUCLEO, por evidência:
 *        E1  a posição mais antiga do grupo é no NUCLEO;
 *        E2  as notas da posição mais antiga dizem "Remanejado ... de NUCLEO para ..."
 *            (origem apagada — modelo antigo do remanejo deletava a origem);
 *        E3  o audit log de remanejo (operational_occupancy.transferred) tem
 *            origem NUCLEO para uma posição do grupo, e essa origem começou
 *            antes ou junto da posição mais antiga que sobrou;
 *        E4  o médico tem um NUCLEO SD do MESMO turno em OUTRO grupo (turno
 *            partido). Só listado; com --unir-grupos as posições entram no
 *            grupo do NUCLEO antes do recálculo (é o que ADR-007 R1 faria hoje).
 *   2. Calcula a janela certa (08:00 do dia) e lista as posições gravadas com
 *      07:00 daquele dia e o lançamento de banco medido contra 07:00.
 *   3. Mostra o saldo ANTES (o que está gravado) e DEPOIS (o que o sync vai
 *      gravar): atraso some, e quem saiu tarde passa a ganhar em dobro.
 *   4. Com --apply: regrava scheduled_start_at das posições (com trilha em
 *      audit_logs) e roda syncBankHoursByContinuityGroup — o mesmo caminho da
 *      aplicação, que respeita override manual e desfecho de saída antecipada.
 *
 * Override manual de saldo: a prévia já mostra o saldo do override como "depois";
ao unir turno partido o override migra para o grupo do NUCLEO na mesma transação,
e se os dois grupos tiverem override o turno é recusado (alguém decide antes).

Só toca a janela 07:00 → 08:00 do turno identificado. Meia jornada (11:30),
 * SN e qualquer outra janela ficam como estão. Não mexe em chegada nem saída.
 *
 * Uso (LOCAL, no notebook, com DATABASE_URL apontando para o alvo — ver
 * docs/remanejamento-nucleo-banco-horas.md para o passo a passo com túnel SSH):
 *   npx tsx scripts/backfill-nucleo-remanejamento.ts                 # dry-run (padrão)
 *   npx tsx scripts/backfill-nucleo-remanejamento.ts --apply         # grava
 *   ... --since=2026-03-01           # ignora turnos anteriores à data
 *   ... --only=<id>[,<id>]           # só estes grupos de continuidade ou ocupações
 *   ... --include-attested           # inclui meses já atestados no fechamento
 *   ... --unir-grupos                # E4: junta turno partido ao grupo do NUCLEO
 *   ... --json                       # saída em JSON (para colar numa sessão de IA)
 *
 * Rode SEMPRE o dry-run antes e leia a lista. Mês já atestado fica FORA por
 * padrão: mexer em saldo depois da assinatura do admin é decisão explícita.
 */
import { eq } from "drizzle-orm";
import { closeDb, getDb, hasDatabaseUrl } from "@/db";
import {
    auditLogs,
    bankHoursBalanceOverrides,
    bankHoursEntries,
    interventionBases,
    interventionOccupancies,
    doctors,
    paymentClosingAttestations,
    regulationOccupancies,
    regulationPosts,
} from "@/db/schema";
import { calculateGuardedBankHours } from "@/modules/bank-hours/calculator";
import { buildContinuityBankHoursSpan, buildContinuityGroups, type ContinuityOccupancy } from "@/modules/bank-hours/continuity";
import { MANUAL_BANK_HOURS_OVERRIDE_RULE_CODE, syncBankHoursByContinuityGroup } from "@/modules/bank-hours/service";
import { isNucleoRegulationPost } from "@/modules/operational/board-display";
import { toAuditSnapshot } from "@/modules/operational/corrections";
import { parseReassignmentOriginCode, pickTurnoArrivalPostCode } from "@/modules/operational/posto-de-chegada";
import { inferRegulationCoverageWindow, resolvePShiftAwareBaseShiftLabel } from "@/modules/operational/rules";
import { resolveTurnoWindowStart } from "@/modules/operational/turno";

type Domain = "regulation" | "intervention";

interface Leg extends ContinuityOccupancy {
    domain: Domain;
    targetId: number;
    targetCode: string;
    boardStartedAt: Date | null;
    roleLabel: string | null;
    notes: string | null;
    earlyDepartureOutcome: string | null;
    startedAt: Date;
    endedAt: Date | null;
    actualEndedAt: Date | null;
    departureConfirmedAt: Date | null;
    scheduledStartAt: Date | null;
    scheduledEndAt: Date | null;
}

type Evidence = "E1" | "E2" | "E3" | "E4";

interface Candidate {
    continuityGroupId: string;
    doctorId: string;
    doctorName: string;
    turnoDate: string;
    monthKey: string;
    attested: boolean;
    evidence: Evidence[];
    expectedStartAt: Date;
    wrongStartAt: Date;
    legs: Leg[];
    legsToFix: Leg[];
    /** E4: posições de outro grupo a trazer para este (só com --unir-grupos). */
    legsToMerge: Leg[];
    /** Lançamentos gravados hoje para todas as posições (E4: um por grupo, que a união colapsa num só). */
    bankEntries: Array<typeof bankHoursEntries.$inferSelect>;
    hasManualOverride: boolean;
    /** Override manual do grupo-alvo (o que o sync vai manter como saldo). */
    targetOverrideBalance: number | null;
    /** E4: override manual do grupo partido que será unido — precisa migrar para o alvo. */
    sourceOverrideBalance: number | null;
    /** E4: grupos partidos que trazem override (mais de um, ou um com o alvo já tendo, é conflito). */
    sourceOverrideGroupIds: string[];
    /** Override em mais de um dos grupos que viram um só: não se une sozinho, alguém decide. */
    overrideConflict: boolean;
    tailEarlyDepartureOutcome: string | null;
    before: { balanceMinutes: number; arrivalDelayMinutes: number; ruleCode: string } | null;
    after: { balanceMinutes: number; arrivalDelayMinutes: number; ruleCode: string } | null;
    open: boolean;
}

type RawCandidate = Pick<Candidate,
    | "continuityGroupId" | "doctorId" | "doctorName" | "turnoDate" | "monthKey" | "attested" | "evidence"
    | "expectedStartAt" | "wrongStartAt" | "legs" | "legsToFix" | "legsToMerge" | "bankEntries" | "sourceOverrideGroupIds"
>;

function uniqueLegs(legs: Leg[]) {
    const seen = new Set<string>();
    return legs.filter((leg) => (seen.has(leg.occupancyId) ? false : (seen.add(leg.occupancyId), true)));
}

function uniqueEntries(entries: Array<typeof bankHoursEntries.$inferSelect | null>) {
    const seen = new Set<string>();
    return entries.filter((entry): entry is typeof bankHoursEntries.$inferSelect => Boolean(entry && !seen.has(entry.id) && seen.add(entry.id)));
}

const AUDIT_SOURCE = "backfill NUCLEO remanejado (scripts/backfill-nucleo-remanejamento.ts)";
const TRANSFER_ACTION = "operational_occupancy.transferred";

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
    const parsed = new Date(raw.length === 10 ? `${raw}T00:00:00-03:00` : raw);
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

const SP_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" });

function fmt(value: Date | null | undefined) {
    if (!value) return "—";
    return value.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" });
}

function dateKey(value: Date) {
    return SP_DATE.format(value);
}

function monthKeyOf(value: Date) {
    return dateKey(value).slice(0, 7);
}

function signed(value: number) {
    return `${value > 0 ? "+" : ""}${value} min`;
}

function sameMinute(left: Date | null, right: Date | null) {
    if (!left || !right) return false;
    return Math.floor(left.getTime() / 60000) === Math.floor(right.getTime() / 60000);
}

function previewBalance(legs: Leg[]) {
    const span = buildContinuityBankHoursSpan(legs);
    if (!span.isClosed || !span.scheduledStartAt || !span.scheduledEndAt || !span.actualEndAt) {
        return null;
    }
    const result = calculateGuardedBankHours({
        scheduledStartAt: span.scheduledStartAt,
        scheduledEndAt: span.scheduledEndAt,
        actualStartAt: span.actualStartAt,
        actualEndAt: span.actualEndAt,
    });
    return { balanceMinutes: result.balanceMinutes, arrivalDelayMinutes: result.arrivalDelayMinutes, ruleCode: result.ruleCode };
}

async function loadLegs(): Promise<Leg[]> {
    const db = getDb();
    const [regulation, intervention, posts, bases] = await Promise.all([
        db.query.regulationOccupancies.findMany(),
        db.query.interventionOccupancies.findMany(),
        db.query.regulationPosts.findMany(),
        db.query.interventionBases.findMany(),
    ]);
    const postCodeById = new Map(posts.map((post) => [post.id, post.code]));
    const baseCodeById = new Map(bases.map((base) => [base.id, base.code]));

    const legs: Leg[] = [];
    for (const row of regulation as Array<typeof regulationOccupancies.$inferSelect>) {
        // Cobertura de madrugada não é turno do médico nem gera banco (docs/madrugada.md).
        if (row.madrugadaCobertura) continue;
        legs.push({
            domain: "regulation",
            occupancyId: row.id,
            doctorId: row.doctorId,
            continuityGroupId: row.continuityGroupId,
            targetId: row.postId,
            targetCode: postCodeById.get(row.postId) ?? String(row.postId),
            startedAt: row.startedAt,
            boardStartedAt: row.boardStartedAt,
            endedAt: row.endedAt,
            actualEndedAt: row.actualEndedAt,
            departureConfirmedAt: row.departureConfirmedAt,
            scheduledStartAt: row.scheduledStartAt,
            scheduledEndAt: row.scheduledEndAt,
            shiftLabel: row.shiftLabel,
            roleLabel: row.roleLabel,
            notes: row.notes,
            earlyDepartureOutcome: row.earlyDepartureOutcome,
        });
    }
    for (const row of intervention as Array<typeof interventionOccupancies.$inferSelect>) {
        legs.push({
            domain: "intervention",
            occupancyId: row.id,
            doctorId: row.doctorId,
            continuityGroupId: row.continuityGroupId,
            targetId: row.baseId,
            targetCode: baseCodeById.get(row.baseId) ?? String(row.baseId),
            startedAt: row.startedAt,
            boardStartedAt: row.boardStartedAt,
            endedAt: row.endedAt,
            actualEndedAt: row.actualEndedAt,
            departureConfirmedAt: row.departureConfirmedAt,
            scheduledStartAt: row.scheduledStartAt,
            scheduledEndAt: row.scheduledEndAt,
            shiftLabel: row.shiftLabel,
            roleLabel: row.roleLabel,
            notes: row.notes,
            earlyDepartureOutcome: row.earlyDepartureOutcome,
        });
    }
    return legs;
}

/** Remanejos com origem NUCLEO registrados no audit log: ocupação criada → chegada na origem. */
async function loadNucleoTransfers() {
    const db = getDb();
    const rows = await db.query.auditLogs.findMany({ where: eq(auditLogs.action, TRANSFER_ACTION) });
    const movedFromNucleo = new Map<string, Date>();
    for (const row of rows as Array<typeof auditLogs.$inferSelect>) {
        const details = row.details as {
            sourceTarget?: { code?: string };
            movedOccupancyId?: string;
            sourceSnapshot?: { startedAt?: string };
        };
        const sourceCode = details.sourceTarget?.code;
        if (!sourceCode || !isNucleoRegulationPost(sourceCode) || !details.movedOccupancyId) continue;
        const originStartedAt = details.sourceSnapshot?.startedAt ? new Date(details.sourceSnapshot.startedAt) : row.createdAt;
        movedFromNucleo.set(details.movedOccupancyId, originStartedAt);
    }
    return movedFromNucleo;
}

async function collectCandidates(): Promise<{ candidates: Candidate[]; brokenTurnos: number }> {
    const db = getDb();
    const since = parseSince();
    const only = parseOnly();
    const mergeGroups = hasFlag("--unir-grupos");

    const [legs, movedFromNucleo, doctorRows, attestations, overrides, entries] = await Promise.all([
        loadLegs(),
        loadNucleoTransfers(),
        db.query.doctors.findMany({ columns: { id: true, fullName: true, displayName: true } }),
        db.query.paymentClosingAttestations.findMany(),
        db.query.bankHoursBalanceOverrides.findMany({ columns: { continuityGroupId: true, balanceMinutes: true } }),
        db.query.bankHoursEntries.findMany(),
    ]);
    const doctorNameById = new Map(doctorRows.map((doctor) => [doctor.id, doctor.displayName?.trim() || doctor.fullName]));
    const attestedKeys = new Set(attestations.map((row) => `${row.doctorId}:${row.monthKey}`));
    const overrideByGroup = new Map(overrides.map((row) => [row.continuityGroupId, row.balanceMinutes]));
    const entryByOccupancy = new Map<string, typeof bankHoursEntries.$inferSelect>();
    for (const entry of entries as Array<typeof bankHoursEntries.$inferSelect>) {
        const key = entry.regulationOccupancyId ?? entry.interventionOccupancyId;
        if (key) entryByOccupancy.set(key, entry);
    }

    const groups = buildContinuityGroups(legs);
    // Índice E4: por médico, os grupos cuja posição mais antiga é NUCLEO SD, pela janela do turno.
    const nucleoGroupByDoctorTurno = new Map<string, { continuityGroupId: string; carrier: Leg }>();
    for (const group of groups) {
        const carrier = group.carrier;
        if (carrier.domain !== "regulation" || !isNucleoRegulationPost(carrier.targetCode)) continue;
        if (resolvePShiftAwareBaseShiftLabel(carrier.startedAt, carrier.shiftLabel) !== "SD") continue;
        nucleoGroupByDoctorTurno.set(`${carrier.doctorId}:${resolveTurnoWindowStart(carrier.startedAt)}`, {
            continuityGroupId: group.continuityGroupId,
            carrier,
        });
    }

    const candidates: Candidate[] = [];
    const rawByTarget = new Map<string, RawCandidate>();
    let brokenTurnos = 0;
    for (const group of groups) {
        const carrier = group.carrier;
        const carrierReference = carrier.boardStartedAt && carrier.boardStartedAt > carrier.startedAt ? carrier.boardStartedAt : carrier.startedAt;
        if (resolvePShiftAwareBaseShiftLabel(carrierReference, carrier.shiftLabel) !== "SD") continue;
        if (since && carrier.startedAt.getTime() < since.getTime()) continue;

        const evidence: Evidence[] = [];
        let legsToMerge: Leg[] = [];
        let effectiveCarrier = carrier;

        // E1/E2: o posto de chegada da posição mais antiga (ela mesma, ou a origem nas notas).
        const arrivalPostCode = pickTurnoArrivalPostCode({
            current: { domain: carrier.domain, targetCode: carrier.targetCode, startedAt: carrier.startedAt, notes: carrier.notes },
            earlierLegs: [],
        });
        if (arrivalPostCode && isNucleoRegulationPost(arrivalPostCode)) {
            evidence.push(carrier.domain === "regulation" && isNucleoRegulationPost(carrier.targetCode) ? "E1" : "E2");
        }

        // E3: audit log de remanejo com origem NUCLEO, cuja origem começou antes/junto da posição mais antiga que sobrou.
        if (evidence.length === 0) {
            for (const member of group.members) {
                const originStartedAt = movedFromNucleo.get(member.occupancyId);
                if (originStartedAt && originStartedAt.getTime() <= carrier.startedAt.getTime() + 60_000
                    && resolveTurnoWindowStart(originStartedAt) === resolveTurnoWindowStart(carrierReference)) {
                    evidence.push("E3");
                    break;
                }
            }
        }

        // E4: turno partido — NUCLEO SD do mesmo médico, mesmo turno, em OUTRO grupo, começado antes.
        if (evidence.length === 0) {
            const nucleo = nucleoGroupByDoctorTurno.get(`${carrier.doctorId}:${resolveTurnoWindowStart(carrierReference)}`);
            if (nucleo && nucleo.continuityGroupId !== group.continuityGroupId && nucleo.carrier.startedAt.getTime() < carrier.startedAt.getTime()) {
                brokenTurnos += 1;
                // Sem --unir-grupos só lista: o grupo do NUCLEO (E1) já entra por conta própria.
                if (!mergeGroups) {
                    console.error(`[turno partido] ${doctorNameById.get(carrier.doctorId) ?? carrier.doctorId} ${dateKey(carrier.startedAt)}: NUCLEO em ${nucleo.continuityGroupId} e ${carrier.targetCode} em ${group.continuityGroupId}. Use --unir-grupos para juntar.`);
                    continue;
                }
                evidence.push("E4");
                legsToMerge = group.members;
                effectiveCarrier = nucleo.carrier;
            }
        }
        if (evidence.length === 0) continue;

        // Também ignora quem chegou no NUCLEO como posição POSTERIOR do turno: aí a chegada foi 07:00 mesmo.
        const reference = effectiveCarrier.boardStartedAt && effectiveCarrier.boardStartedAt > effectiveCarrier.startedAt
            ? effectiveCarrier.boardStartedAt
            : effectiveCarrier.startedAt;
        const expectedStartAt = inferRegulationCoverageWindow({
            startedAt: reference,
            shiftLabel: effectiveCarrier.shiftLabel,
            postCode: "NUCLEO",
            explicitScheduledStartAt: null,
            explicitScheduledEndAt: null,
        }).scheduledStartAt;
        if (!expectedStartAt) continue;
        const wrongStartAt = new Date(expectedStartAt.getTime() - 60 * 60000);

        const targetGroupId = evidence.includes("E4") ? effectiveCarrier.continuityGroupId : group.continuityGroupId;
        const allLegs: Leg[] = evidence.includes("E4")
            ? [...(groups.find((candidate) => candidate.continuityGroupId === targetGroupId)?.members ?? []), ...legsToMerge.map((leg) => ({ ...leg, continuityGroupId: targetGroupId }))]
            : group.members;
        const legsToFix = allLegs.filter((leg) => sameMinute(leg.scheduledStartAt, wrongStartAt));
        const bankEntries = uniqueEntries(allLegs.map((leg) => entryByOccupancy.get(leg.occupancyId) ?? null));
        const bankWrong = bankEntries.some((entry) => sameMinute(entry.scheduledStartAt, wrongStartAt));
        if (legsToFix.length === 0 && !bankWrong && legsToMerge.length === 0) continue;

        if (only) {
            const ids = new Set([targetGroupId, group.continuityGroupId, ...allLegs.map((leg) => leg.occupancyId)]);
            if (![...ids].some((id) => only.has(id))) continue;
        }

        const sourceOverrideGroupIds = evidence.includes("E4") && overrideByGroup.has(group.continuityGroupId)
            ? [group.continuityGroupId]
            : [];
        pushCandidate({
            continuityGroupId: targetGroupId,
            doctorId: effectiveCarrier.doctorId,
            doctorName: doctorNameById.get(effectiveCarrier.doctorId) ?? effectiveCarrier.doctorId,
            turnoDate: dateKey(expectedStartAt),
            monthKey: monthKeyOf(expectedStartAt),
            attested: attestedKeys.has(`${effectiveCarrier.doctorId}:${monthKeyOf(expectedStartAt)}`),
            evidence,
            expectedStartAt,
            wrongStartAt,
            legs: allLegs,
            legsToFix,
            legsToMerge,
            bankEntries,
            sourceOverrideGroupIds,
        });
    }

    // Um turno = um candidato. Com --unir-grupos, o grupo do NUCLEO (E1) e cada
    // grupo partido (E4) apontam para o MESMO alvo: aqui viram um só, para a
    // prévia somar todos os lançamentos que a união colapsa e para o conflito de
    // override enxergar todos os grupos que vão virar um.
    function pushCandidate(raw: RawCandidate) {
        const existing = rawByTarget.get(raw.continuityGroupId);
        if (!existing) {
            rawByTarget.set(raw.continuityGroupId, raw);
            return;
        }
        const legs = uniqueLegs([...existing.legs, ...raw.legs]);
        rawByTarget.set(raw.continuityGroupId, {
            ...existing,
            evidence: [...new Set([...existing.evidence, ...raw.evidence])] as Evidence[],
            legs,
            legsToFix: uniqueLegs([...existing.legsToFix, ...raw.legsToFix]),
            legsToMerge: uniqueLegs([...existing.legsToMerge, ...raw.legsToMerge]),
            bankEntries: uniqueEntries([...existing.bankEntries, ...raw.bankEntries]),
            sourceOverrideGroupIds: [...new Set([...existing.sourceOverrideGroupIds, ...raw.sourceOverrideGroupIds])],
        });
    }

    for (const raw of rawByTarget.values()) {
        const repairedLegs = raw.legs.map((leg) => raw.legsToFix.some((fix) => fix.occupancyId === leg.occupancyId) ? { ...leg, scheduledStartAt: raw.expectedStartAt } : leg);
        const tail = buildContinuityGroups(repairedLegs)[0]!.tail as Leg;
        // ANTES = a soma do que está gravado hoje (E4: um lançamento por grupo, que
        // a união colapsa num só). DEPOIS = o que o sync grava para o grupo unido.
        const beforeStored = raw.bankEntries.length > 0
            ? {
                balanceMinutes: raw.bankEntries.reduce((sum, entry) => sum + entry.balanceMinutes, 0),
                arrivalDelayMinutes: Math.max(...raw.bankEntries.map((entry) => entry.arrivalDelayMinutes)),
                ruleCode: [...new Set(raw.bankEntries.map((entry) => entry.ruleCode))].join(" + "),
            }
            : previewBalance(raw.legs);
        // O sync mantém o override manual como saldo: a prévia tem de mostrar isso,
        // senão o delta e os totais mentem justamente nos casos que a coordenação revisa.
        const targetOverrideBalance = overrideByGroup.get(raw.continuityGroupId) ?? null;
        const sourceOverrideBalance = raw.sourceOverrideGroupIds.length === 1
            ? (overrideByGroup.get(raw.sourceOverrideGroupIds[0]!) ?? null)
            : null;
        const overrideConflict = raw.sourceOverrideGroupIds.length > 1
            || (targetOverrideBalance !== null && raw.sourceOverrideGroupIds.length > 0);
        const effectiveOverride = overrideConflict ? targetOverrideBalance : (targetOverrideBalance ?? sourceOverrideBalance);
        const automaticAfter = previewBalance(repairedLegs);
        const after = automaticAfter && effectiveOverride !== null
            ? { ...automaticAfter, balanceMinutes: effectiveOverride, ruleCode: MANUAL_BANK_HOURS_OVERRIDE_RULE_CODE }
            : automaticAfter;

        candidates.push({
            ...raw,
            hasManualOverride: effectiveOverride !== null || overrideConflict,
            targetOverrideBalance,
            sourceOverrideBalance,
            overrideConflict,
            tailEarlyDepartureOutcome: tail.earlyDepartureOutcome,
            before: beforeStored,
            after,
            open: after === null,
        });
    }

    candidates.sort((left, right) => left.doctorName.localeCompare(right.doctorName, "pt-BR") || left.expectedStartAt.getTime() - right.expectedStartAt.getTime());
    return { candidates, brokenTurnos };
}

function describeCandidate(candidate: Candidate) {
    const lines: string[] = [];
    lines.push(`${candidate.doctorName} — turno ${candidate.turnoDate} (${candidate.monthKey}${candidate.attested ? ", MÊS ATESTADO" : ""}) · evidência ${candidate.evidence.join("+")}`);
    lines.push(`  grupo ${candidate.continuityGroupId}`);
    for (const leg of [...candidate.legs].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())) {
        const fix = candidate.legsToFix.includes(leg) ? "  ← 07:00 → 08:00" : "";
        const merge = candidate.legsToMerge.some((other) => other.occupancyId === leg.occupancyId) ? "  ← entra no grupo do NUCLEO" : "";
        lines.push(`  [${leg.domain === "regulation" ? "reg" : "int"}] ${leg.targetCode.padEnd(6)} ${leg.occupancyId} chegada ${fmt(leg.startedAt)} saída ${fmt(leg.actualEndedAt ?? leg.endedAt)} janela ${fmt(leg.scheduledStartAt)}→${fmt(leg.scheduledEndAt)} ${leg.shiftLabel ?? "—"}${fix}${merge}`);
    }
    if (candidate.bankEntries.length > 0) {
        for (const entry of candidate.bankEntries) {
            lines.push(`  banco gravado: janela ${fmt(entry.scheduledStartAt)}→${fmt(entry.scheduledEndAt)} atraso ${entry.arrivalDelayMinutes} min · x${entry.overtimeMultiplier} · saldo ${signed(entry.balanceMinutes)} (${entry.ruleCode})`);
        }
        if (candidate.bankEntries.length > 1) {
            lines.push(`  (${candidate.bankEntries.length} lançamentos que a união vai colapsar num só; o "antes" abaixo é a soma)`);
        }
    } else {
        lines.push("  banco gravado: nenhum lançamento (plantão aberto ou saída sem confirmação)");
    }
    if (candidate.before && candidate.after) {
        const delta = candidate.after.balanceMinutes - candidate.before.balanceMinutes;
        lines.push(`  saldo   ${signed(candidate.before.balanceMinutes)} (${candidate.before.ruleCode}) -> ${signed(candidate.after.balanceMinutes)} (${candidate.after.ruleCode}) · delta ${signed(delta)}`);
    } else {
        lines.push("  saldo   plantão ainda aberto/sem confirmação: o cálculo roda no fechamento, só a janela é corrigida agora");
    }
    if (candidate.overrideConflict) {
        const parts = [
            ...(candidate.targetOverrideBalance !== null ? [`alvo ${signed(candidate.targetOverrideBalance)}`] : []),
            ...candidate.sourceOverrideGroupIds.map((groupId) => `partido ${groupId.slice(0, 8)}`),
        ];
        lines.push(`  ⛔ override manual em mais de um dos grupos que virariam um só (${parts.join(", ")}): não uno sozinho — decida qual vale e ajuste pelo /admin/bank-hours antes`);
    } else if (candidate.sourceOverrideBalance !== null) {
        lines.push(`  ⚠ override manual (${signed(candidate.sourceOverrideBalance)}) no grupo partido: migra para o grupo do NUCLEO e continua sendo o saldo`);
    } else if (candidate.hasManualOverride) {
        lines.push(`  ⚠ override manual de saldo (${signed(candidate.targetOverrideBalance!)}) neste grupo: o saldo gravado continua o do override, só a explicação muda`);
    }
    if (candidate.tailEarlyDepartureOutcome) {
        lines.push(`  ⚠ desfecho de saída antecipada gravado (${candidate.tailEarlyDepartureOutcome}): o sync usa a régua da chefia, prévia acima é aproximada`);
    }
    return lines.join("\n");
}

async function applyCandidate(candidate: Candidate) {
    if (candidate.overrideConflict) {
        throw new Error("override manual em mais de um dos grupos que virariam um só: decida qual vale antes de unir (veja o dry-run)");
    }
    const db = getDb();
    await db.transaction(async (tx) => {
        // O override manual é chaveado por grupo: se ficasse no grupo partido (que
        // esvazia), o sync do alvo recalcularia sozinho e apagaria a decisão do
        // admin. Migra junto com as posições, na mesma transação.
        if (candidate.sourceOverrideBalance !== null && candidate.targetOverrideBalance === null) {
            const sourceGroupId = candidate.sourceOverrideGroupIds[0];
            // Recheca dentro da transação: o índice único por grupo derrubaria a migração
            // se o alvo ganhou override depois da leitura (outra rodada, o admin na tela).
            const targetOverrideNow = await tx.query.bankHoursBalanceOverrides.findFirst({
                where: eq(bankHoursBalanceOverrides.continuityGroupId, candidate.continuityGroupId),
                columns: { id: true },
            });
            if (targetOverrideNow) {
                throw new Error("o grupo do NUCLEO ganhou override manual depois da prévia: rode o dry-run de novo e decida qual vale");
            }
            if (sourceGroupId) {
                await tx.update(bankHoursBalanceOverrides)
                    .set({ continuityGroupId: candidate.continuityGroupId, updatedAt: new Date() })
                    .where(eq(bankHoursBalanceOverrides.continuityGroupId, sourceGroupId));
                await tx.insert(auditLogs).values({
                    actorUserId: null,
                    action: "bank_hours_override.regrouped",
                    entityType: "bank_hours_balance_override",
                    entityId: candidate.continuityGroupId,
                    details: {
                        source: AUDIT_SOURCE,
                        reason: "turno partido unido ao grupo do NUCLEO: override manual segue o turno (E4)",
                        previousContinuityGroupId: sourceGroupId,
                        nextContinuityGroupId: candidate.continuityGroupId,
                        balanceMinutes: candidate.sourceOverrideBalance,
                    },
                });
            }
        }
        for (const leg of candidate.legsToMerge) {
            const table = leg.domain === "regulation" ? regulationOccupancies : interventionOccupancies;
            await tx.update(table)
                .set({ continuityGroupId: candidate.continuityGroupId, updatedAt: new Date() })
                .where(eq(table.id, leg.occupancyId));
            await tx.insert(auditLogs).values({
                actorUserId: null,
                action: `${leg.domain}_occupancy.corrected`,
                entityType: `${leg.domain}_occupancy`,
                entityId: leg.occupancyId,
                details: {
                    source: AUDIT_SOURCE,
                    reason: "turno partido: posição entra no grupo de continuidade do NUCLEO onde o médico chegou (E4)",
                    previousContinuityGroupId: leg.continuityGroupId,
                    nextContinuityGroupId: candidate.continuityGroupId,
                },
            });
        }
        for (const leg of candidate.legsToFix) {
            const table = leg.domain === "regulation" ? regulationOccupancies : interventionOccupancies;
            const before = toAuditSnapshot({ ...leg, continuityGroupId: candidate.continuityGroupId });
            await tx.update(table)
                .set({ scheduledStartAt: candidate.expectedStartAt, updatedAt: new Date() })
                .where(eq(table.id, leg.occupancyId));
            await tx.insert(auditLogs).values({
                actorUserId: null,
                action: `${leg.domain}_occupancy.corrected`,
                entityType: `${leg.domain}_occupancy`,
                entityId: leg.occupancyId,
                details: {
                    source: AUDIT_SOURCE,
                    reason: `chegada do turno foi no NUCLEO (08:00), janela gravada como 07:00 (${candidate.evidence.join("+")})`,
                    previousDoctorId: leg.doctorId,
                    nextDoctorId: leg.doctorId,
                    previousStartedAt: before.startedAt,
                    nextStartedAt: before.startedAt,
                    beforeSnapshot: before,
                    afterSnapshot: { ...before, scheduledStartAt: candidate.expectedStartAt.toISOString() },
                },
            });
        }
        // Grupo de origem do turno partido fica vazio de posições e o sync o limpa.
        for (const leg of candidate.legsToMerge) {
            if (leg.continuityGroupId !== candidate.continuityGroupId) {
                await syncBankHoursByContinuityGroup(tx, leg.continuityGroupId);
            }
        }
        await syncBankHoursByContinuityGroup(tx, candidate.continuityGroupId);
    });
}

async function main() {
    if (!hasDatabaseUrl()) {
        console.error("DATABASE_URL não configurada. Aponte para o banco alvo (ver docs/remanejamento-nucleo-banco-horas.md).");
        process.exitCode = 1;
        return;
    }
    const apply = hasFlag("--apply");
    const includeAttested = hasFlag("--include-attested");
    const asJson = hasFlag("--json");

    const { candidates: all, brokenTurnos } = await collectCandidates();
    const candidates = includeAttested ? all : all.filter((candidate) => !candidate.attested);
    const skippedAttested = all.length - candidates.length;

    let devolvido = 0;
    let debitado = 0;
    let semPrevia = 0;
    let conflitos = 0;
    for (const candidate of candidates) {
        // Turno com conflito de override não é aplicado: fica fora dos totais.
        if (candidate.overrideConflict) {
            conflitos += 1;
            continue;
        }
        if (candidate.before && candidate.after) {
            const delta = candidate.after.balanceMinutes - candidate.before.balanceMinutes;
            if (delta > 0) devolvido += delta;
            if (delta < 0) debitado += delta;
        } else {
            semPrevia += 1;
        }
    }

    if (asJson) {
        console.log(JSON.stringify({
            mode: apply ? "apply" : "dry-run",
            total: all.length,
            skippedAttested,
            brokenTurnosNotMerged: brokenTurnos,
            overrideConflicts: conflitos,
            devolvidoMinutos: devolvido,
            debitadoMinutos: debitado,
            candidates: candidates.map((candidate) => ({
                doctor: candidate.doctorName,
                doctorId: candidate.doctorId,
                turnoDate: candidate.turnoDate,
                monthKey: candidate.monthKey,
                attested: candidate.attested,
                evidence: candidate.evidence,
                continuityGroupId: candidate.continuityGroupId,
                expectedStartAt: candidate.expectedStartAt.toISOString(),
                legs: candidate.legs.map((leg) => ({
                    domain: leg.domain,
                    occupancyId: leg.occupancyId,
                    targetCode: leg.targetCode,
                    startedAt: leg.startedAt.toISOString(),
                    endedAt: (leg.actualEndedAt ?? leg.endedAt)?.toISOString() ?? null,
                    scheduledStartAt: leg.scheduledStartAt?.toISOString() ?? null,
                    fix: candidate.legsToFix.includes(leg),
                    merge: candidate.legsToMerge.some((other) => other.occupancyId === leg.occupancyId),
                })),
                before: candidate.before,
                after: candidate.after,
                hasManualOverride: candidate.hasManualOverride,
                targetOverrideBalance: candidate.targetOverrideBalance,
                sourceOverrideBalance: candidate.sourceOverrideBalance,
                sourceOverrideGroupIds: candidate.sourceOverrideGroupIds,
                overrideConflict: candidate.overrideConflict,
                bankEntries: candidate.bankEntries.map((entry) => ({ id: entry.id, balanceMinutes: entry.balanceMinutes, arrivalDelayMinutes: entry.arrivalDelayMinutes, ruleCode: entry.ruleCode })),
                tailEarlyDepartureOutcome: candidate.tailEarlyDepartureOutcome,
            })),
        }, null, 2));
    } else {
        console.log(`\n${all.length} turno(s) que começaram no NUCLEO com janela/lançamento em 07:00.`);
        if (skippedAttested > 0) {
            console.log(`${skippedAttested} em mês já atestado — fora desta rodada (use --include-attested para incluir).`);
        }
        if (brokenTurnos > 0 && !hasFlag("--unir-grupos")) {
            console.log(`${brokenTurnos} turno(s) partido(s) (NUCLEO num grupo, resto em outro) listados acima em stderr — só entram com --unir-grupos.`);
        }
        console.log("");
        for (const candidate of candidates) {
            console.log(describeCandidate(candidate));
            console.log("");
        }

        // Por médico, para a coordenação conferir.
        const porMedico = new Map<string, { turnos: number; delta: number }>();
        for (const candidate of candidates) {
            const current = porMedico.get(candidate.doctorName) ?? { turnos: 0, delta: 0 };
            current.turnos += 1;
            if (candidate.before && candidate.after && !candidate.overrideConflict) current.delta += candidate.after.balanceMinutes - candidate.before.balanceMinutes;
            porMedico.set(candidate.doctorName, current);
        }
        if (porMedico.size > 0) {
            console.log("Por médico:");
            for (const [name, totals] of [...porMedico.entries()].sort((a, b) => a[0].localeCompare(b[0], "pt-BR"))) {
                console.log(`  ${name.padEnd(40)} ${String(totals.turnos).padStart(3)} turno(s)  ${signed(totals.delta)}`);
            }
            console.log("");
        }
        console.log(`Devolvido a médicos: ${signed(devolvido)}. Débito novo: ${signed(debitado)}. ${semPrevia} sem prévia (plantão aberto/sem confirmação). ${conflitos} com conflito de override (não aplicados, fora dos totais).\n`);
    }

    if (!apply) {
        if (!asJson) {
            console.log("DRY-RUN. Nada foi alterado. Rode de novo com --apply para corrigir.");
            console.log("Delimite com --only=<grupo|ocupacao> ou --since=YYYY-MM-DD se quiser recortar.\n");
        }
        return;
    }

    let applied = 0;
    for (const candidate of candidates) {
        try {
            await applyCandidate(candidate);
            applied += 1;
            console.log(`corrigido ${candidate.doctorName} ${candidate.turnoDate} (${candidate.continuityGroupId})`);
        } catch (error) {
            console.error(`FALHOU ${candidate.doctorName} ${candidate.turnoDate} (${candidate.continuityGroupId}): ${(error as Error).message}`);
        }
    }
    console.log(`\n${applied}/${candidates.length} turno(s) corrigido(s).\n`);
}

main()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await closeDb();
    });
