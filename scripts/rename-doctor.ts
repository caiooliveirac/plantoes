// Corrige o cadastro de um médico já existente (fullName + normalizedName), sem
// tocar em metadata (preferredOperationalRole etc.) nem em snapshots históricos
// (payment_attestation_slot_entries.doctor_name é auditoria e não é retroativo).
//
// Uso:
//   tsx scripts/rename-doctor.ts --role=PSIQ                      (preview, acha o registro pelo role)
//   tsx scripts/rename-doctor.ts --id=<uuid> --to="Novo Nome"     (preview)
//   tsx scripts/rename-doctor.ts --id=<uuid> --to="Novo Nome" --apply
import { eq } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { doctors } from "@/db/schema";
import { normalizeDoctorName } from "@/modules/doctors/importer";
import { extractDoctorPreferredOperationalRole } from "@/modules/doctors/directory";

function getFlagValue(flag: string) {
    const prefix = `${flag}=`;
    return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function hasFlag(flag: string) {
    return process.argv.includes(flag);
}

async function findByRole(role: string) {
    const db = getDb();
    const rows = await db.select().from(doctors);
    return rows.filter((row) => extractDoctorPreferredOperationalRole(row.metadata) === role);
}

async function main() {
    const role = getFlagValue("--role");
    const id = getFlagValue("--id");
    const to = getFlagValue("--to");
    const apply = hasFlag("--apply");

    if (!id && role) {
        const matches = await findByRole(role);
        console.log(JSON.stringify({
            mode: "find-by-role",
            role,
            matches: matches.map((row) => ({
                id: row.id,
                fullName: row.fullName,
                displayName: row.displayName,
                normalizedName: row.normalizedName,
            })),
        }, null, 2));
        await closeDb();
        return;
    }

    if (!id || !to) {
        console.error("Uso: tsx scripts/rename-doctor.ts --id=<uuid> --to=\"Novo Nome\" [--apply]");
        console.error("  ou: tsx scripts/rename-doctor.ts --role=PSIQ   (para localizar o id primeiro)");
        process.exitCode = 1;
        await closeDb();
        return;
    }

    const db = getDb();
    const existing = await db.query.doctors.findFirst({ where: eq(doctors.id, id) });
    if (!existing) {
        console.error(`Médico ${id} não encontrado.`);
        process.exitCode = 1;
        await closeDb();
        return;
    }

    const nextFullName = to.trim();
    const nextNormalizedName = normalizeDoctorName(nextFullName);
    if (!nextNormalizedName) {
        console.error("Nome inválido.");
        process.exitCode = 1;
        await closeDb();
        return;
    }

    const collision = await db.query.doctors.findFirst({ where: eq(doctors.normalizedName, nextNormalizedName) });
    if (collision && collision.id !== existing.id) {
        console.error(`Já existe outro médico com este nome normalizado: ${collision.fullName} (${collision.id}).`);
        process.exitCode = 1;
        await closeDb();
        return;
    }

    console.log(JSON.stringify({
        mode: apply ? "apply" : "preview",
        before: { fullName: existing.fullName, displayName: existing.displayName, normalizedName: existing.normalizedName },
        after: { fullName: nextFullName, displayName: existing.displayName, normalizedName: nextNormalizedName },
        preferredOperationalRole: extractDoctorPreferredOperationalRole(existing.metadata),
    }, null, 2));

    if (!apply) {
        await closeDb();
        return;
    }

    await db.update(doctors)
        .set({ fullName: nextFullName, normalizedName: nextNormalizedName, updatedAt: new Date() })
        .where(eq(doctors.id, existing.id));

    console.log("Atualizado.");
    await closeDb();
}

main().catch(async (error) => {
    console.error(error);
    await closeDb().catch(() => undefined);
    process.exitCode = 1;
});
