import { loadDoctorImportFile, summarizeDoctorImport, applyDoctorImport } from "@/modules/doctors/importer";

function getFlag(name: string) {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] ?? null : null;
}

async function main() {
    const filePath = getFlag("--file");
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

    if (!dryRun) {
        const result = await applyDoctorImport(rows);
        console.log(JSON.stringify(result, null, 2));
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
