import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

let client: postgres.Sql | null = null;
let database: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function hasDatabaseUrl(): boolean {
    return Boolean(process.env.DATABASE_URL);
}

export function getDb() {
    if (!process.env.DATABASE_URL) {
        throw new Error("DATABASE_URL is required to use operations-v2 database features.");
    }

    if (!client) {
        client = postgres(process.env.DATABASE_URL, {
            max: 1,
            prepare: false,
        });
    }

    if (!database) {
        database = drizzle(client, { schema });
    }

    return database;
}

export async function closeDb() {
    if (client) {
        await client.end();
        client = null;
        database = null;
    }
}
