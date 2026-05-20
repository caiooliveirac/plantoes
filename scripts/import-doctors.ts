import { mkdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { loadDoctorImportFile, summarizeDoctorImport, applyDoctorImport, previewDoctorImport } from "@/modules/doctors/importer";

const execFileAsync = promisify(execFile);

function getFlag(name: string) {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] ?? null : null;
}

async function main() {
    const filePath = getFlag("--file");
    const allowAdditions = process.argv.includes("--allow-additions");
    const backupDirFlag = getFlag("--backup-dir");
    const dryRun = process.argv.includes("--dry-run") || !process.env.DATABASE_URL;

    if (!filePath) {
        throw new Error("Use --file <path-to-csv-or-json>.");
    }

    const rows = await loadDoctorImportFile(filePath);
    const summary = summarizeDoctorImport(rows);

    console.log(JSON.stringify({
        mode: dryRun ? "dry-run" : "apply",
        summary,
    }, null, 2));

    if (process.env.DATABASE_URL) {
        const preview = await previewDoctorImport(rows);
        console.log(JSON.stringify({ preview }, null, 2));

        if (!dryRun) {
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
            const backupDir = resolve(backupDirFlag || ".backups/doctor-imports", timestamp);
            await mkdir(backupDir, { recursive: true });

            const manifest = {
                createdAt: new Date().toISOString(),
                sourceFile: basename(filePath),
                summary,
                preview,
            };
            const manifestPath = resolve(backupDir, "manifest.json");
            const sqlDumpPath = resolve(backupDir, "operations_v2.sql");

            await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

            try {
                await execFileAsync("pg_dump", [
                    "--file",
                    sqlDumpPath,
                    "--format=plain",
                    "--schema=operations_v2",
                    process.env.DATABASE_URL,
                ], {
                    env: process.env,
                });
            } catch (error) {
                throw new Error(`Falha ao gerar backup obrigatório antes da importação. O apply foi abortado. Backup: ${backupDir}.`);
            }

            console.log(JSON.stringify({
                backup: {
                    directory: backupDir,
                    manifestPath,
                    sqlDumpPath,
                },
            }, null, 2));

            const result = await applyDoctorImport(rows, { allowAdditions, preview });
            console.log(JSON.stringify(result, null, 2));
            return;
        }
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
