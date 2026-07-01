// Reconstroi rapidamente o que aconteceu com um medico numa data operacional quando o
// painel/relatorio ao vivo sugeriu pagamento mas o fechamento (ou vice-versa) divergiu.
// Junta em uma unica chamada: ocupacoes (regulacao + intervencao), mensagens brutas do
// telegram, extras/admin do mes, e um detector do padrao mais comum ate hoje (ocupacao "P"
// com started_at retrodatado que colide, no mesmo dia, com uma ocupacao real em outro
// dominio). Rode local, apontando DATABASE_URL para $PLANTOES_RO_URL (docs/agent-operations.md).
//
// Uso: npx tsx scripts/audit-doctor-payment-gap.ts "Ana Beatriz" 2026-06-20 [--window=1]
import { and, asc, gte, ilike, lte, or } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import {
    adminExtraShifts,
    doctors,
    interventionBases,
    interventionOccupancies,
    regulationOccupancies,
    regulationPosts,
    telegramIngestedMessages,
} from "@/db/schema";

const BACKDATE_THRESHOLD_MS = 6 * 60 * 60 * 1000;

function getFlagValue(flag: string) {
    const prefix = `${flag}=`;
    return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function parseArgs() {
    const [, , doctorQuery, dateArg] = process.argv;
    if (!doctorQuery || !dateArg) {
        throw new Error('Uso: tsx scripts/audit-doctor-payment-gap.ts "Nome do medico" YYYY-MM-DD [--window=1]');
    }
    const windowDays = Number.parseInt(getFlagValue("--window") ?? "1", 10);
    const centerDate = new Date(`${dateArg}T00:00:00.000Z`);
    if (Number.isNaN(centerDate.getTime())) {
        throw new Error(`Data invalida: ${dateArg}. Use YYYY-MM-DD.`);
    }
    return { doctorQuery, dateArg, windowDays: Number.isFinite(windowDays) ? windowDays : 1, centerDate };
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) {
    return aStart < bEnd && bStart < aEnd;
}

async function main() {
    const { doctorQuery, dateArg, windowDays, centerDate } = parseArgs();
    const db = getDb();

    const rangeStart = new Date(centerDate.getTime() - windowDays * 86_400_000);
    const rangeEnd = new Date(centerDate.getTime() + (windowDays + 1) * 86_400_000);

    const matchedDoctors = await db.select().from(doctors).where(
        or(ilike(doctors.fullName, `%${doctorQuery}%`), ilike(doctors.displayName, `%${doctorQuery}%`)),
    );

    if (matchedDoctors.length === 0) {
        console.log(JSON.stringify({ error: `Nenhum medico encontrado para "${doctorQuery}"` }, null, 2));
        return;
    }

    const doctorIds = matchedDoctors.map((doctor) => doctor.id);

    const [regOccupancies, ivOccupancies, extras, messages, allPosts, allBases] = await Promise.all([
        db.select().from(regulationOccupancies).where(and(
            gte(regulationOccupancies.startedAt, rangeStart),
            lte(regulationOccupancies.startedAt, rangeEnd),
        )),
        db.select().from(interventionOccupancies).where(and(
            gte(interventionOccupancies.startedAt, rangeStart),
            lte(interventionOccupancies.startedAt, rangeEnd),
        )),
        db.select().from(adminExtraShifts),
        db.select().from(telegramIngestedMessages).where(and(
            gte(telegramIngestedMessages.createdAt, rangeStart),
            lte(telegramIngestedMessages.createdAt, rangeEnd),
        )),
        db.select().from(regulationPosts),
        db.select().from(interventionBases),
    ]);

    const postCodeById = new Map(allPosts.map((post) => [post.id, post.code]));
    const baseCodeById = new Map(allBases.map((base) => [base.id, base.code]));
    const doctorIdSet = new Set(doctorIds);

    const myRegOccupancies = regOccupancies
        .filter((row) => doctorIdSet.has(row.doctorId))
        .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
        .map((row) => ({
            id: row.id,
            target: postCodeById.get(row.postId) ?? row.postId,
            shiftLabel: row.shiftLabel,
            roleLabel: row.roleLabel,
            source: row.source,
            scheduledStartAt: row.scheduledStartAt?.toISOString() ?? null,
            scheduledEndAt: row.scheduledEndAt?.toISOString() ?? null,
            startedAt: row.startedAt.toISOString(),
            endedAt: row.endedAt?.toISOString() ?? null,
            actualEndedAt: row.actualEndedAt?.toISOString() ?? null,
            createdAt: row.createdAt.toISOString(),
            notes: row.notes,
        }));

    const myIvOccupancies = ivOccupancies
        .filter((row) => doctorIdSet.has(row.doctorId))
        .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
        .map((row) => ({
            id: row.id,
            target: baseCodeById.get(row.baseId) ?? row.baseId,
            shiftLabel: row.shiftLabel,
            roleLabel: row.roleLabel,
            source: row.source,
            scheduledStartAt: row.scheduledStartAt?.toISOString() ?? null,
            scheduledEndAt: row.scheduledEndAt?.toISOString() ?? null,
            startedAt: row.startedAt.toISOString(),
            endedAt: row.endedAt?.toISOString() ?? null,
            actualEndedAt: row.actualEndedAt?.toISOString() ?? null,
            createdAt: row.createdAt.toISOString(),
            notes: row.notes,
        }));

    // Padrao mais comum ate hoje (caso Ana Beatriz, 20/06): ocupacao de regulacao "P" cujo
    // created_at destoa muito do started_at (retrodatada) E que se sobrepoe, no mesmo medico,
    // a uma ocupacao real em OUTRO dominio (intervencao) — o motor de pagamento so premia um
    // dominio por slot, entao o "P" perde o SD para o dominio real e o SN some junto.
    const suspiciousBackdatedP = myRegOccupancies
        .filter((row) => row.shiftLabel === "P")
        .map((row) => {
            const createdAtMs = new Date(row.createdAt).getTime();
            const startedAtMs = new Date(row.startedAt).getTime();
            const isBackdated = createdAtMs - startedAtMs > BACKDATE_THRESHOLD_MS;
            const scheduledStart = row.scheduledStartAt ? new Date(row.scheduledStartAt) : new Date(row.startedAt);
            const scheduledEnd = row.scheduledEndAt ? new Date(row.scheduledEndAt) : new Date(row.startedAt);
            const conflictingIv = myIvOccupancies.filter((iv) => overlaps(
                scheduledStart,
                scheduledEnd,
                new Date(iv.startedAt),
                iv.endedAt ? new Date(iv.endedAt) : new Date(),
            ));
            return { ...row, isBackdated, conflictingInterventionOccupancies: conflictingIv };
        })
        .filter((row) => row.isBackdated && row.conflictingInterventionOccupancies.length > 0);

    const myMessages = messages
        .filter((row) => matchedDoctors.some((doctor) => (
            (row.senderName && row.senderName.toLowerCase().includes(doctor.displayName?.toLowerCase().split(" ")[0] ?? "\0"))
            || row.parsedDoctorName === doctor.fullName
        )))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((row) => ({
            telegramMessageId: row.telegramMessageId,
            senderName: row.senderName,
            rawText: row.rawText,
            parsedDomain: row.parsedDomain,
            parsedTargetCode: row.parsedTargetCode,
            parsedAction: row.parsedAction,
            status: row.status,
            createdAt: row.createdAt.toISOString(),
        }));

    const myExtras = extras
        .filter((row) => doctorIdSet.has(row.doctorId))
        .sort((a, b) => a.operationalDate.localeCompare(b.operationalDate))
        .map((row) => ({
            operationalDate: row.operationalDate,
            shiftLabel: row.shiftLabel,
            label: row.label,
            kind: row.kind,
            unit: row.unit,
            createdAt: row.createdAt.toISOString(),
        }));

    console.log(JSON.stringify({
        doctorQuery,
        dateArg,
        matchedDoctors: matchedDoctors.map((doctor) => ({ id: doctor.id, fullName: doctor.fullName, displayName: doctor.displayName })),
        regulationOccupancies: myRegOccupancies,
        interventionOccupancies: myIvOccupancies,
        telegramMessages: myMessages,
        adminExtraShifts: myExtras,
        suspiciousBackdatedP,
    }, null, 2));
}

main()
    .catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await closeDb();
    });
