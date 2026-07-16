import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";

function resolveMigrationsSchema() {
    const schema = (process.env.MIGRATIONS_SCHEMA || "operations_v2").trim().toLowerCase();
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) {
        throw new Error(`Invalid MIGRATIONS_SCHEMA: ${schema}`);
    }

    return schema;
}

function shouldSkipLegacyImportMigration(file: string, error: unknown) {
    const isLegacyImportMigration = /_import_legacy_/i.test(file);
    if (!isLegacyImportMigration) {
        return false;
    }

    const code = typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";
    const message = error instanceof Error ? error.message : String(error ?? "");
    const missingLegacyRelation = /relation\s+"public\.[^"]+"\s+does not exist/i.test(message);

    return code === "42P01" || missingLegacyRelation;
}

async function main() {
    if (!process.env.DATABASE_URL) {
        throw new Error("DATABASE_URL is required.");
    }

    const sqlClient = postgres(process.env.DATABASE_URL, { prepare: false });
    const migrationsSchema = resolveMigrationsSchema();
    const migrationsTable = `${migrationsSchema}.schema_migrations`;
    const migrationsDir = path.resolve(process.cwd(), "db/migrations");
    const files = (await readdir(migrationsDir))
        .filter((file) => file.endsWith(".sql"))
        .sort();

    await sqlClient.unsafe(`create schema if not exists ${migrationsSchema}`);
    await sqlClient.unsafe(`set search_path to ${migrationsSchema}, public`);
    await sqlClient.unsafe(`create table if not exists ${migrationsTable} (
        filename text primary key,
        applied_at timestamptz not null default now()
    )`);

    const appliedRows = await sqlClient.unsafe<{ filename: string }[]>(`select filename from ${migrationsTable}`);
    const applied = new Set(appliedRows.map((row) => row.filename));

    for (const file of files) {
        if (applied.has(file)) {
            continue;
        }

        const sqlText = await readFile(path.join(migrationsDir, file), "utf8");
        try {
            await sqlClient.begin(async (transaction) => {
                await transaction.unsafe(`set search_path to ${migrationsSchema}, public`);
                await transaction.unsafe(sqlText);
                await transaction.unsafe(`insert into ${migrationsTable} (filename) values ($1)`, [file]);
            });
        } catch (error) {
            if (!shouldSkipLegacyImportMigration(file, error)) {
                throw error;
            }

            console.warn(`skipped ${file} (legacy source tables unavailable in this environment)`);
            await sqlClient.unsafe(`insert into ${migrationsTable} (filename) values ($1) on conflict do nothing`, [file]);
            continue;
        }

        console.log(`applied ${file}`);
    }

    await sqlClient.end();
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
