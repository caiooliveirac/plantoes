import { eq } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { doctors, regulationPosts } from "@/db/schema";
import { startRegulationOccupancy } from "@/modules/regulation/service";

function getFlagValue(flag: string) {
    const prefix = `${flag}=`;
    return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function requireFlag(flag: string) {
    const value = getFlagValue(flag);
    if (!value) {
        throw new Error(`Parametro obrigatorio ausente: ${flag}`);
    }

    return value;
}

function parseStartedAt(rawDate: string, rawTime: string) {
    const iso = `${rawDate}T${rawTime}:00-03:00`;
    const startedAt = new Date(iso);
    if (Number.isNaN(startedAt.getTime())) {
        throw new Error(`Data/hora invalida: ${rawDate} ${rawTime}`);
    }

    return startedAt;
}

async function main() {
    if (!process.env.DATABASE_URL) {
        throw new Error("DATABASE_URL is required.");
    }

    const doctorName = requireFlag("--doctor");
    const ramal = requireFlag("--ramal").trim().toUpperCase();
    const date = requireFlag("--date");
    const time = requireFlag("--time");
    const shiftLabel = (getFlagValue("--shift")?.trim().toUpperCase() ?? "SD") as "SD" | "SN" | "P";
    const notes = getFlagValue("--notes") ?? `[script retroativo] ${doctorName} ${ramal} ${date} ${time}`;

    const db = getDb();
    const doctor = await db.query.doctors.findFirst({
        where: eq(doctors.fullName, doctorName),
    });

    if (!doctor || !doctor.isActive) {
        throw new Error(`Medico nao encontrado ou inativo: ${doctorName}`);
    }

    const post = await db.query.regulationPosts.findFirst({
        where: eq(regulationPosts.code, ramal),
    });

    if (!post || !post.isActive) {
        throw new Error(`Ramal de regulacao nao encontrado ou inativo: ${ramal}`);
    }

    const startedAt = parseStartedAt(date, time);
    const occupancy = await startRegulationOccupancy({
        doctorId: doctor.id,
        postId: post.id,
        startedAt,
        shiftLabel,
        source: "manual",
        notes,
    });

    console.log(JSON.stringify({
        ok: true,
        occupancyId: occupancy.id,
        doctorId: doctor.id,
        doctorName: doctor.fullName,
        ramal: post.code,
        startedAt: occupancy.startedAt.toISOString(),
        shiftLabel: occupancy.shiftLabel,
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