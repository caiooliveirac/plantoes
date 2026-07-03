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
        await sqlClient.begin(async (transaction) => {
            await transaction.unsafe(`set search_path to ${migrationsSchema}, public`);
            await transaction.unsafe(sqlText);
            await transaction.unsafe(`insert into ${migrationsTable} (filename) values ($1)`, [file]);
        });

        console.log(`applied ${file}`);
    }

    await sqlClient.end();
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
