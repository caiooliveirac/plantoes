// Cadastra (ou corrige) o médico coringa "Residente": elegível em regulação e
// intervenção, marcado com metadata.isResidente = true para não gerar banco
// de horas nem aparecer em payment-closing/payment-attestation/slot-audit
// (ver modules/doctors/directory.ts, modules/bank-hours/service.ts,
// services/payable-shifts.service.ts, modules/operational/residente-auto-close.ts).
// Idempotente: pode rodar mais de uma vez sem duplicar o cadastro.
//
// Uso (contra o banco apontado por DATABASE_URL no ambiente):
//   tsx scripts/create-residente-doctor-2026-07.ts              # preview
//   tsx scripts/create-residente-doctor-2026-07.ts --apply      # grava

import { eq } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { doctors } from "@/db/schema";
import { normalizeDoctorName } from "@/modules/doctors/importer";
import { extractDoctorIsResidente, mergeDoctorDirectoryMetadata } from "@/modules/doctors/directory";

const DOCTOR_NAME = "Residente";

function hasFlag(flag: string) {
    return process.argv.includes(flag);
}

async function main() {
    const apply = hasFlag("--apply");
    const db = getDb();
    const normalizedName = normalizeDoctorName(DOCTOR_NAME);

    const existing = await db.query.doctors.findFirst({ where: eq(doctors.normalizedName, normalizedName) });

    if (!existing) {
        console.log(`Médico "${DOCTOR_NAME}" não existe ainda — será criado com eligibleRegulation=true, eligibleIntervention=true, metadata.isResidente=true.`);
        if (!apply) {
            console.log("Modo preview (--apply para gravar).");
            await closeDb();
            return;
        }

        const [created] = await db.insert(doctors).values({
            fullName: DOCTOR_NAME,
            normalizedName,
            eligibleRegulation: true,
            eligibleIntervention: true,
            metadata: mergeDoctorDirectoryMetadata(null, { isResidente: true }),
        }).returning();

        console.log(`Criado: id=${created.id}`);
        await closeDb();
        return;
    }

    console.log(`Médico "${DOCTOR_NAME}" já existe: id=${existing.id}`);
    const alreadyFlagged = extractDoctorIsResidente(existing.metadata);
    const needsEligibilityFix = !existing.eligibleRegulation || !existing.eligibleIntervention;

    if (alreadyFlagged && !needsEligibilityFix) {
        console.log("Já está com metadata.isResidente=true e elegível nos dois domínios — nada a fazer.");
        await closeDb();
        return;
    }

    console.log(`Ajustes pendentes: isResidente=${alreadyFlagged} -> true${needsEligibilityFix ? ", eligibleRegulation/eligibleIntervention -> true" : ""}.`);
    if (!apply) {
        console.log("Modo preview (--apply para gravar).");
        await closeDb();
        return;
    }

    await db.update(doctors)
        .set({
            metadata: mergeDoctorDirectoryMetadata(existing.metadata, { isResidente: true }),
            eligibleRegulation: true,
            eligibleIntervention: true,
            updatedAt: new Date(),
        })
        .where(eq(doctors.id, existing.id));

    console.log("Atualizado.");
    await closeDb();
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
