// Importa razão social + CNPJ da planilha oficial "MÉDICOS PJ.xls" (aba
// CHAMAMENTO, julho/2026) como SUGESTÃO fiscal por médico — não confirma nada
// sozinho. O bot do Telegram usa isso em /pagamento cadastro: se o médico já
// tem uma sugestão e ainda não confirmou dados fiscais antes, oferece botões
// "Está certo?" / "Corrigir" em vez de pedir para digitar do zero (ver
// modules/telegram/fiscal-confirmation.ts:resolveFiscalSuggestion).
//
// Uso:
//   tsx scripts/import-doctor-fiscal-suggestion-2026-07.ts            # preview
//   tsx scripts/import-doctor-fiscal-suggestion-2026-07.ts --apply    # grava

import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { doctors } from "@/db/schema";
import { normalizeDoctorName } from "@/modules/doctors/importer";
import { normalizeCnpj, isLikelyValidCnpj } from "@/modules/telegram/payment-access";

const PJ_FISCAL_JSON = "/private/tmp/claude-501/-Users-caiooliveirac-Projetos-gestor-artigos/0ff736de-ee3f-4bae-a57a-66bdec7d6b67/scratchpad/pj_fiscal.json";

interface PjFiscalRow {
    NOME: string;
    EMPRESA: string;
    CNPJ: string;
}

function hasFlag(flag: string) {
    return process.argv.includes(flag);
}

async function main() {
    const apply = hasFlag("--apply");

    const rows = JSON.parse(readFileSync(PJ_FISCAL_JSON, "utf-8")) as PjFiscalRow[];

    const db = getDb();
    const allDoctors = await db.select({ id: doctors.id, fullName: doctors.fullName, normalizedName: doctors.normalizedName, metadata: doctors.metadata }).from(doctors);
    const byNormalizedName = new Map(allDoctors.map((doctor) => [doctor.normalizedName, doctor]));

    const matched: Array<{ doctor: typeof allDoctors[number]; razaoSocial: string; cnpj: string }> = [];
    const unmatchedNames: string[] = [];
    const invalidCnpj: string[] = [];

    for (const row of rows) {
        const razaoSocial = row.EMPRESA.trim();
        const cnpj = normalizeCnpj(row.CNPJ);
        if (!razaoSocial || !cnpj || !isLikelyValidCnpj(row.CNPJ)) {
            invalidCnpj.push(`${row.NOME} (empresa="${row.EMPRESA}" cnpj="${row.CNPJ}")`);
            continue;
        }

        const doctor = byNormalizedName.get(normalizeDoctorName(row.NOME));
        if (!doctor) {
            unmatchedNames.push(row.NOME);
            continue;
        }

        matched.push({ doctor, razaoSocial, cnpj });
    }

    console.log(`Linhas na planilha: ${rows.length} | casaram com cadastro: ${matched.length}`);
    for (const { doctor, razaoSocial, cnpj } of matched) {
        console.log(`  [SUGESTAO] ${doctor.fullName} -> ${razaoSocial} / ${cnpj}`);
    }
    if (unmatchedNames.length > 0) {
        console.log(`\nNao encontrados no cadastro (${unmatchedNames.length}) — sem plantão registrado, nada a fazer:`);
        for (const name of unmatchedNames) {
            console.log(`  - ${name}`);
        }
    }
    if (invalidCnpj.length > 0) {
        console.log(`\nCNPJ/empresa invalido na planilha, pulados (${invalidCnpj.length}):`);
        for (const entry of invalidCnpj) {
            console.log(`  - ${entry}`);
        }
    }

    if (!apply) {
        console.log("\nModo preview (--apply para gravar).");
        await closeDb();
        return;
    }

    for (const { doctor, razaoSocial, cnpj } of matched) {
        const currentMetadata = (doctor.metadata && typeof doctor.metadata === "object") ? doctor.metadata as Record<string, unknown> : {};
        await db.update(doctors)
            .set({
                metadata: { ...currentMetadata, suggestedRazaoSocial: razaoSocial, suggestedCnpj: cnpj },
                updatedAt: new Date(),
            })
            .where(eq(doctors.id, doctor.id));
    }

    console.log(`\n${matched.length} médicos com sugestão fiscal gravada.`);
    await closeDb();
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
