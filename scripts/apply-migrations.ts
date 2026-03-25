import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";

async function main() {
    if (!process.env.DATABASE_URL) {
        throw new Error("DATABASE_URL is required.");
    }

    const sqlClient = postgres(process.env.DATABASE_URL, { prepare: false });
    const migrationsDir = path.resolve(process.cwd(), "db/migrations");
    const files = (await readdir(migrationsDir))
        .filter((file) => file.endsWith(".sql"))
        .sort();

    await sqlClient`create table if not exists schema_migrations (
    filename text primary key,
    applied_at timestamptz not null default now()
  )`;

    const appliedRows = await sqlClient<{ filename: string }[]>`select filename from schema_migrations`;
    const applied = new Set(appliedRows.map((row) => row.filename));

    for (const file of files) {
        if (applied.has(file)) {
            continue;
        }

        const sqlText = await readFile(path.join(migrationsDir, file), "utf8");
        await sqlClient.begin(async (transaction) => {
            await transaction.unsafe(sqlText);
            await transaction.unsafe("insert into schema_migrations (filename) values ($1)", [file]);
        });

        console.log(`applied ${file}`);
    }

    await sqlClient.end();
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
