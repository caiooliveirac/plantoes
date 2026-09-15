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
            // max: 1 fazia uma transação presa enfileirar o app inteiro
            // (incidente de 03/08: idle-in-transaction de 12min = timeouts em tudo).
            max: 5,
            idle_timeout: 30,
            prepare: false,
            // Guardas de sessão (ms). Uma transação presa por 12 min travou o app
            // inteiro em 03/08; nenhuma consulta legítima da aplicação passa de
            // um minuto, e quem espera lock por mais de 10 s está em incidente.
            // As migrations usam conexão própria (scripts/apply-migrations.ts).
            connection: {
                application_name: "plantoes",
                statement_timeout: 60_000,
                lock_timeout: 10_000,
                idle_in_transaction_session_timeout: 60_000,
            },
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
