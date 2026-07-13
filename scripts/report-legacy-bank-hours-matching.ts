// Relatório de matching assistido: nome da planilha -> candidatos no cadastro.
// NÃO grava nada no banco. A saída serve para aprovação manual linha a linha;
// o resultado aprovado vira scripts/data/legacy-bank-hours-matching.json, que
// é o único insumo de doctor_id do seed (scripts/seed-legacy-bank-hours.ts).
import { readFile } from "node:fs/promises";
import path from "node:path";
import { closeDb, getDb } from "@/db";
import { doctors } from "@/db/schema";
import {
    parseLegacyBankHoursCsv,
    validateLegacyBankHoursDataset,
} from "@/modules/bank-hours/legacy";
import {
    pickConfidentDoctorCandidate,
    resolveDoctorCandidates,
    type TelegramDoctorDirectoryEntry,
} from "@/modules/telegram/name-resolution";

// Alternativa sem acesso direto ao banco: --doctors-file <tsv> com as colunas
// id, full_name, display_name, normalized_name, is_active (uma linha por médico),
// extraído por ex. via psql read-only na produção.
async function loadDirectory(): Promise<TelegramDoctorDirectoryEntry[]> {
    const fileFlagIndex = process.argv.indexOf("--doctors-file");
    if (fileFlagIndex !== -1) {
        const filePath = process.argv[fileFlagIndex + 1];
        if (!filePath) {
            throw new Error("--doctors-file exige um caminho.");
        }
        const content = await readFile(path.resolve(process.cwd(), filePath), "utf8");
        return content
            .split(/\r?\n/)
            .filter((line) => line.trim().length > 0)
            .map((line) => {
                const [id, fullName, displayName, normalizedName, isActive] = line.split("\t");
                if (!id || !fullName || !normalizedName) {
                    throw new Error(`Linha inválida no arquivo de médicos: "${line}".`);
                }
                return {
                    id,
                    fullName,
                    displayName: displayName || null,
                    normalizedName,
                    isActive: isActive === "t" || isActive === "true",
                    aliases: [],
                };
            });
    }

    const db = getDb();
    return (await db
        .select({
            id: doctors.id,
            fullName: doctors.fullName,
            displayName: doctors.displayName,
            normalizedName: doctors.normalizedName,
            isActive: doctors.isActive,
        })
        .from(doctors))
        .map((doctor) => ({ ...doctor, aliases: [] }));
}

async function main() {
    const csvPath = path.resolve(process.cwd(), "scripts/data/legacy-bank-hours-2026-07.csv");
    const rows = parseLegacyBankHoursCsv(await readFile(csvPath, "utf8"));
    validateLegacyBankHoursDataset(rows);

    const directory = await loadDirectory();

    const draft: Record<string, string | null> = {};
    let confident = 0;
    let ambiguous = 0;
    let missing = 0;

    for (const row of rows) {
        const candidates = resolveDoctorCandidates(row.spreadsheetName, directory, 3);
        const pick = pickConfidentDoctorCandidate(row.spreadsheetName, candidates);
        draft[row.spreadsheetName] = pick?.id ?? null;

        const summary = candidates.length === 0
            ? "(nenhum candidato)"
            : candidates
                .map((candidate) => `${candidate.fullName}${candidate.isActive ? "" : " [inativo]"} <${candidate.id}> score=${candidate.score}`)
                .join(" | ");

        let verdict: string;
        if (pick) {
            verdict = "SUGERIDO";
            confident += 1;
        } else if (candidates.length === 0) {
            verdict = "SEM CANDIDATO";
            missing += 1;
        } else {
            verdict = "AMBÍGUO";
            ambiguous += 1;
        }

        console.log(`${verdict.padEnd(13)} ${row.spreadsheetName.padEnd(30)} -> ${summary}`);
    }

    console.log("");
    console.log(`Resumo: ${confident} sugeridos, ${ambiguous} ambíguos, ${missing} sem candidato (total ${rows.length}).`);
    console.log("");
    console.log("Rascunho de scripts/data/legacy-bank-hours-matching.json (revisar linha a linha antes de usar):");
    console.log(JSON.stringify(draft, null, 4));
}

main()
    .catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    })
    .finally(() => closeDb());
