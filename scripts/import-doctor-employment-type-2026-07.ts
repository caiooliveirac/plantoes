// Classifica médicos existentes em PJ vs Estatutário a partir das planilhas da
// prefeitura ("MÉDICOS ESTATUTARIOS.xlsx" e "MÉDICOS PJ.xls", julho/2026).
// Estatutário/REDA é pago fora deste sistema (folha da prefeitura) — por isso
// o payment-closing zera o valor por plantão para esse grupo (ver
// modules/reporting/payable-shifts.ts:resolveDoctorEmploymentType). PJ é o
// padrão implícito, então este script só precisa marcar quem é estatutário;
// a lista de PJ ativos serve apenas para conferência/log dos não encontrados.
//
// Uso:
//   tsx scripts/import-doctor-employment-type-2026-07.ts              # preview
//   tsx scripts/import-doctor-employment-type-2026-07.ts --apply      # grava

import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { doctors } from "@/db/schema";
import { normalizeDoctorName } from "@/modules/doctors/importer";

const ESTATUTARIOS_CSV = "/private/tmp/claude-501/-Users-caiooliveirac-Projetos-gestor-artigos/0ff736de-ee3f-4bae-a57a-66bdec7d6b67/scratchpad/estatutarios.csv";
const PJ_ATIVOS_CSV = "/private/tmp/claude-501/-Users-caiooliveirac-Projetos-gestor-artigos/0ff736de-ee3f-4bae-a57a-66bdec7d6b67/scratchpad/pj_ativos.csv";

function hasFlag(flag: string) {
    return process.argv.includes(flag);
}

function readNameColumn(path: string, headerToSkip: string) {
    const lines = readFileSync(path, "utf-8").split("\n").map((line) => line.trim()).filter(Boolean);
    const names: string[] = [];
    for (const line of lines.slice(1)) {
        const [rawName] = line.split(",");
        const name = (rawName ?? "").trim();
        if (!name || name === headerToSkip) {
            continue;
        }
        names.push(name);
    }
    return names;
}

async function main() {
    const apply = hasFlag("--apply");

    const estatutarioNames = readNameColumn(ESTATUTARIOS_CSV, "NOME COMPLETO");
    const pjNames = readNameColumn(PJ_ATIVOS_CSV, "nome");

    const db = getDb();
    const allDoctors = await db.select({ id: doctors.id, fullName: doctors.fullName, normalizedName: doctors.normalizedName, metadata: doctors.metadata }).from(doctors);
    const byNormalizedName = new Map(allDoctors.map((doctor) => [doctor.normalizedName, doctor]));

    const matchedEstatutario: typeof allDoctors = [];
    const unmatchedEstatutario: string[] = [];
    for (const name of estatutarioNames) {
        const doctor = byNormalizedName.get(normalizeDoctorName(name));
        if (doctor) {
            matchedEstatutario.push(doctor);
        } else {
            unmatchedEstatutario.push(name);
        }
    }

    const unmatchedPj: string[] = [];
    for (const name of pjNames) {
        if (!byNormalizedName.has(normalizeDoctorName(name))) {
            unmatchedPj.push(name);
        }
    }

    console.log(`Estatutários na planilha: ${estatutarioNames.length} | encontrados no cadastro: ${matchedEstatutario.length}`);
    for (const doctor of matchedEstatutario) {
        console.log(`  [ESTATUTARIO] ${doctor.fullName}`);
    }
    if (unmatchedEstatutario.length > 0) {
        console.log(`  Não encontrados no cadastro (${unmatchedEstatutario.length}) — sem plantão registrado, nada a fazer:`);
        for (const name of unmatchedEstatutario) {
            console.log(`    - ${name}`);
        }
    }

    console.log(`\nPJ ativos na planilha: ${pjNames.length} | não encontrados no cadastro: ${unmatchedPj.length} (esperado — nem todo PJ da chamada pública tem plantão registrado)`);

    if (!apply) {
        console.log("\nModo preview (--apply para gravar).");
        await closeDb();
        return;
    }

    for (const doctor of matchedEstatutario) {
        const currentMetadata = (doctor.metadata && typeof doctor.metadata === "object") ? doctor.metadata as Record<string, unknown> : {};
        await db.update(doctors)
            .set({
                metadata: { ...currentMetadata, employmentType: "estatutario" },
                updatedAt: new Date(),
            })
            .where(eq(doctors.id, doctor.id));
    }

    console.log(`\n${matchedEstatutario.length} médicos marcados como estatutário.`);
    await closeDb();
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
