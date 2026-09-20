/**
 * Registra uma chegada na regulação pelo mesmo caminho do painel/bot
 * (startRegulationOccupancy), sem SQL à mão.
 *
 *   DATABASE_URL=... npx tsx scripts/register-regulation-arrival.ts \
 *     --doctor="Leonardo Copque" --ramal=4091 --date=2026-09-19 --time=07:00 \
 *     --shift=SD --source=admin_correction [--dry-run]
 *
 * --doctor   nome exato OU parte do nome (todas as palavras precisam bater no
 *            nome normalizado: "Leonardo Copque" acha "Leonardo Copque
 *            Magalhães"). Aborta se ambíguo — nunca escolhe por conta própria.
 * --source   manual (padrão) | admin_correction. Para plantão PASSADO cujo fim
 *            programado já venceu, admin_correction grava a ocupação já
 *            encerrada no fim do turno (ended_at = scheduled_end_at) e sincroniza
 *            o banco de horas na hora — ver resolveHistoricalAdminCorrectionEndAt.
 *            Para o turno corrente, o efeito é o mesmo de manual: fica aberta e
 *            aparece ao vivo no quadro.
 *            Um plantão passado nasce com actual_ended_at e, pela regra do app,
 *            a saída ficaria "aguardando confirmação da chefia" (banco de horas
 *            em espera). Como este é um lançamento administrativo de turno
 *            completo, sem saída verbalizada a questionar, o script confirma a
 *            saída pelo serviço oficial (endRegulationOccupancy, chiefConfirmed)
 *            — passe --no-confirm-departure para deixar na fila da chefia.
 * --dry-run  só resolve médico/ramal/janela e imprime; não grava nada.
 */
import { and, eq, like } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { doctors, regulationOccupancies, regulationPosts } from "@/db/schema";
import { normalizeDoctorName } from "@/modules/doctors/importer";
import { endRegulationOccupancy, startRegulationOccupancy } from "@/modules/regulation/service";

const SOURCES = ["manual", "admin_correction"] as const;
type ScriptSource = (typeof SOURCES)[number];

function getFlagValue(flag: string) {
    const prefix = `${flag}=`;
    return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function hasFlag(flag: string) {
    return process.argv.includes(flag);
}

function requireFlag(flag: string) {
    const value = getFlagValue(flag);
    if (!value) {
        throw new Error(`Parametro obrigatorio ausente: ${flag}`);
    }

    return value;
}

function parseStartedAt(rawDate: string, rawTime: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate) || !/^\d{2}:\d{2}$/.test(rawTime)) {
        throw new Error(`Use --date=AAAA-MM-DD e --time=HH:MM (recebido: ${rawDate} ${rawTime})`);
    }
    const iso = `${rawDate}T${rawTime}:00-03:00`;
    const startedAt = new Date(iso);
    if (Number.isNaN(startedAt.getTime())) {
        throw new Error(`Data/hora invalida: ${rawDate} ${rawTime}`);
    }

    return startedAt;
}

function parseSource(raw: string | null): ScriptSource {
    const value = (raw ?? "manual").trim().toLowerCase();
    if (!SOURCES.includes(value as ScriptSource)) {
        throw new Error(`--source invalido: ${raw}. Use ${SOURCES.join(" | ")}.`);
    }
    return value as ScriptSource;
}

async function resolveDoctor(query: string) {
    const db = getDb();
    const exact = await db.query.doctors.findFirst({
        where: and(eq(doctors.fullName, query), eq(doctors.isActive, true)),
    });
    if (exact) {
        return exact;
    }

    const normalizedQuery = normalizeDoctorName(query);
    const tokens = normalizedQuery.split(" ").filter(Boolean);
    if (tokens.length === 0) {
        throw new Error(`Nome vazio em --doctor: "${query}"`);
    }

    // Pré-filtro barato pelo primeiro token; a exigência de TODOS os tokens é
    // feita em memória para não depender de regex no banco.
    const candidates = (await db.query.doctors.findMany({
        where: and(eq(doctors.isActive, true), like(doctors.normalizedName, `%${tokens[0]}%`)),
    })).filter((doctor) => {
        const haystack = ` ${doctor.normalizedName} `;
        return tokens.every((token) => haystack.includes(` ${token} `) || haystack.includes(token));
    });

    if (candidates.length === 1) {
        return candidates[0];
    }
    if (candidates.length === 0) {
        throw new Error(`Medico nao encontrado ou inativo: "${query}" (normalizado: ${normalizedQuery})`);
    }
    throw new Error(
        `Nome ambiguo para "${query}": ${candidates.map((doctor) => doctor.fullName).join(" | ")}. Passe o nome completo em --doctor.`,
    );
}

async function main() {
    if (!process.env.DATABASE_URL) {
        throw new Error("DATABASE_URL is required.");
    }

    const doctorQuery = requireFlag("--doctor");
    const ramal = requireFlag("--ramal").trim().toUpperCase();
    const date = requireFlag("--date");
    const time = requireFlag("--time");
    const shiftLabel = (getFlagValue("--shift")?.trim().toUpperCase() ?? "SD") as "SD" | "SN" | "P";
    if (!["SD", "SN", "P"].includes(shiftLabel)) {
        throw new Error(`--shift invalido: ${shiftLabel}. Use SD | SN | P.`);
    }
    const source = parseSource(getFlagValue("--source"));
    const dryRun = hasFlag("--dry-run");

    const db = getDb();
    const doctor = await resolveDoctor(doctorQuery);
    const notes = getFlagValue("--notes") ?? `[script retroativo] ${doctor.fullName} ${ramal} ${date} ${time} ${shiftLabel}`;

    const post = await db.query.regulationPosts.findFirst({
        where: eq(regulationPosts.code, ramal),
    });

    if (!post || !post.isActive) {
        throw new Error(`Ramal de regulacao nao encontrado ou inativo: ${ramal}`);
    }

    const startedAt = parseStartedAt(date, time);
    const plan = {
        doctorId: doctor.id,
        doctorName: doctor.fullName,
        ramal: post.code,
        onDemand: post.onDemand,
        startedAt: startedAt.toISOString(),
        startedAtSaoPaulo: `${date} ${time}`,
        shiftLabel,
        source,
        notes,
    };

    // Idempotência: o serviço só reaproveita uma ocupação ABERTA idêntica; um
    // plantão passado já fechado seria duplicado numa segunda execução.
    const alreadyRegistered = await db.query.regulationOccupancies.findFirst({
        where: and(
            eq(regulationOccupancies.doctorId, doctor.id),
            eq(regulationOccupancies.postId, post.id),
            eq(regulationOccupancies.startedAt, startedAt),
        ),
    });

    if (dryRun) {
        console.log(JSON.stringify({ dryRun: true, ...plan, alreadyRegisteredOccupancyId: alreadyRegistered?.id ?? null }, null, 2));
        return;
    }

    if (alreadyRegistered) {
        console.log(JSON.stringify({
            ok: true,
            skipped: "ja_registrado",
            occupancyId: alreadyRegistered.id,
            ...plan,
            endedAt: alreadyRegistered.endedAt?.toISOString() ?? null,
        }, null, 2));
        return;
    }

    const created = await startRegulationOccupancy({
        doctorId: doctor.id,
        postId: post.id,
        startedAt,
        shiftLabel,
        source,
        notes,
    });

    const closedRetroactively = Boolean(created.endedAt);
    const confirmDeparture = closedRetroactively && !hasFlag("--no-confirm-departure");
    const occupancy = confirmDeparture
        ? await endRegulationOccupancy(created.id, {
            endedAt: created.endedAt!,
            actualEndedAt: created.actualEndedAt ?? created.endedAt!,
            chiefConfirmed: true,
        })
        : created;

    console.log(JSON.stringify({
        ok: true,
        occupancyId: occupancy.id,
        ...plan,
        scheduledStartAt: occupancy.scheduledStartAt?.toISOString() ?? null,
        scheduledEndAt: occupancy.scheduledEndAt?.toISOString() ?? null,
        endedAt: occupancy.endedAt?.toISOString() ?? null,
        boardStartedAt: occupancy.boardStartedAt?.toISOString() ?? null,
        closedRetroactively,
        departureConfirmedAt: occupancy.departureConfirmedAt?.toISOString() ?? null,
    }, null, 2));
}

main()
    .catch(async (error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await closeDb().catch(() => undefined);
    });
