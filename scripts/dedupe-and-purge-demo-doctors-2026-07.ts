// Três ações pontuais pedidas depois da auditoria PJ x Estatutário (julho/2026):
//
// 1) "Oswaldo Alves Bastos Neves" e "Oswaldo Alves Bastos Neto" são a mesma
//    pessoa. Mantemos Neves (tem conta de login vinculada) e aplicamos nele o
//    vínculo estatutário que estava em Neto (que não tinha nenhum outro dado
//    ligado). Neto é apagado.
// 2) "Ana Beatriz Bonfim Nunes" e "Ana Beatriz Nunes Bonfim" são a mesma
//    pessoa; a grafia correta (conforme planilha PJ) é "Ana Beatriz Nunes
//    Bomfim" (com M). Mantemos o registro com login/plantão vinculado,
//    corrigimos o nome e apagamos o duplicado (que não tinha nenhum dado).
// 3) 26 médicos de demonstração (padrão "Dr./Dra. <papel>", todos inativos,
//    contas @plantoes.local sem role) são removidos por completo do banco —
//    login e cadastro. NÃO inclui "Admin Sistema": apesar do nome bater no
//    mesmo padrão textual do relatório de auditoria, é a conta real de admin
//    (admin@plantoes.local, role admin, ativa) — está fora desta limpeza.
//
// Uso:
//   tsx scripts/dedupe-and-purge-demo-doctors-2026-07.ts            # preview
//   tsx scripts/dedupe-and-purge-demo-doctors-2026-07.ts --apply    # executa

import { eq } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { doctors, users } from "@/db/schema";
import { normalizeDoctorName } from "@/modules/doctors/importer";

function hasFlag(flag: string) {
    return process.argv.includes(flag);
}

const DEMO_NAME_PATTERN = /^(Dr\.|Dra\.)/;
const ADMIN_ACCOUNT_NAME = "Admin Sistema";

async function main() {
    const apply = hasFlag("--apply");
    const db = getDb();

    const allDoctors = await db.select().from(doctors);
    const byName = new Map(allDoctors.map((d) => [d.fullName, d]));

    const oswaldoKeep = byName.get("Oswaldo Alves Bastos Neves");
    const oswaldoDrop = byName.get("Oswaldo Alves Bastos Neto");
    const anaKeep = byName.get("Ana Beatriz Nunes Bonfim");
    const anaDrop = byName.get("Ana Beatriz Bonfim Nunes");
    const anaCorrectName = "Ana Beatriz Nunes Bomfim";

    if (!oswaldoKeep || !oswaldoDrop) throw new Error("Registros do Oswaldo não encontrados como esperado.");
    if (!anaKeep || !anaDrop) throw new Error("Registros da Ana Beatriz não encontrados como esperado.");

    const demoDoctors = allDoctors.filter((d) => DEMO_NAME_PATTERN.test(d.fullName) && d.fullName !== ADMIN_ACCOUNT_NAME);

    console.log("=== 1) Oswaldo: merge em um registro só ===");
    console.log(`  mantém: ${oswaldoKeep.fullName} (${oswaldoKeep.id}) — aplica employmentType=estatutario`);
    console.log(`  apaga:  ${oswaldoDrop.fullName} (${oswaldoDrop.id})`);

    console.log("\n=== 2) Ana Beatriz: merge em um registro só, grafia corrigida ===");
    console.log(`  mantém: ${anaKeep.fullName} (${anaKeep.id}) -> renomeia para "${anaCorrectName}"`);
    console.log(`  apaga:  ${anaDrop.fullName} (${anaDrop.id})`);

    console.log(`\n=== 3) Purga de médicos de demonstração (${demoDoctors.length}) ===`);
    for (const d of demoDoctors) {
        console.log(`  apaga: ${d.fullName} (${d.id})`);
    }
    console.log(`\n(mantido fora da purga: "${ADMIN_ACCOUNT_NAME}" — é a conta real de admin, não demo)`);

    if (!apply) {
        console.log("\nModo preview (--apply para gravar).");
        await closeDb();
        return;
    }

    await db.transaction(async (tx) => {
        const oswaldoMetadata = (oswaldoKeep.metadata && typeof oswaldoKeep.metadata === "object") ? oswaldoKeep.metadata as Record<string, unknown> : {};
        await tx.update(doctors)
            .set({ metadata: { ...oswaldoMetadata, employmentType: "estatutario" }, updatedAt: new Date() })
            .where(eq(doctors.id, oswaldoKeep.id));
        await tx.delete(doctors).where(eq(doctors.id, oswaldoDrop.id));

        await tx.update(doctors)
            .set({ fullName: anaCorrectName, normalizedName: normalizeDoctorName(anaCorrectName), updatedAt: new Date() })
            .where(eq(doctors.id, anaKeep.id));
        await tx.delete(doctors).where(eq(doctors.id, anaDrop.id));

        for (const demoDoctor of demoDoctors) {
            await tx.delete(users).where(eq(users.doctorId, demoDoctor.id));
            await tx.delete(doctors).where(eq(doctors.id, demoDoctor.id));
        }
    });

    console.log("\nConcluído.");
    await closeDb();
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
