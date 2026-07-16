// Seed idempotente dos saldos legados do banco de horas (migration 0034).
// Insumos, ambos versionados:
//   scripts/data/legacy-bank-hours-2026-07.csv      -> valores auditados
//   scripts/data/legacy-bank-hours-matching.json    -> matching aprovado manualmente
//     ({ "NOME DA PLANILHA": "<doctor uuid>" | null }); precisa cobrir exatamente
//     todas as linhas do CSV — null explícito = fica unmatched.
// Reexecução não duplica (on conflict do nothing na chave spreadsheet_name) e
// nunca faz UPDATE: se uma linha já existente divergir do CSV, aborta e reporta.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { inArray, sql } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { bankHoursLegacyBalances, doctors } from "@/db/schema";
import {
    LEGACY_BANK_HOURS_EXPECTED_NET_TOTAL_MINUTES,
    LEGACY_BANK_HOURS_EXPECTED_ROW_COUNT,
    LEGACY_BANK_HOURS_SOURCE,
    parseLegacyBankHoursCsv,
    validateLegacyBankHoursDataset,
    type LegacyBankHoursRow,
} from "@/modules/bank-hours/legacy";

async function loadMatching(rows: LegacyBankHoursRow[]) {
    const matchingPath = path.resolve(process.cwd(), "scripts/data/legacy-bank-hours-matching.json");
    const matching = JSON.parse(await readFile(matchingPath, "utf8")) as Record<string, string | null>;

    const csvNames = new Set(rows.map((row) => row.spreadsheetName));
    const missing = [...csvNames].filter((name) => !(name in matching));
    const extra = Object.keys(matching).filter((name) => !csvNames.has(name));
    if (missing.length > 0 || extra.length > 0) {
        throw new Error(
            `Matching não cobre o CSV exatamente. Faltando: ${JSON.stringify(missing)}; sobrando: ${JSON.stringify(extra)}.`,
        );
    }

    const doctorIds = Object.values(matching).filter((value): value is string => value !== null);
    const duplicated = doctorIds.filter((id, index) => doctorIds.indexOf(id) !== index);
    if (duplicated.length > 0) {
        throw new Error(`Mesmo médico apontado por mais de um nome da planilha: ${JSON.stringify([...new Set(duplicated)])}.`);
    }

    if (doctorIds.length > 0) {
        const db = getDb();
        const found = await db
            .select({ id: doctors.id })
            .from(doctors)
            .where(inArray(doctors.id, doctorIds));
        const foundIds = new Set(found.map((row) => row.id));
        const unknown = doctorIds.filter((id) => !foundIds.has(id));
        if (unknown.length > 0) {
            throw new Error(`doctor_id inexistente no cadastro: ${JSON.stringify(unknown)}.`);
        }
    }

    return matching;
}

async function main() {
    const csvPath = path.resolve(process.cwd(), "scripts/data/legacy-bank-hours-2026-07.csv");
    const rows = parseLegacyBankHoursCsv(await readFile(csvPath, "utf8"));
    validateLegacyBankHoursDataset(rows);

    const matching = await loadMatching(rows);
    const db = getDb();

    // Linhas já importadas não podem divergir do CSV atual (imutabilidade).
    const existing = await db
        .select({
            spreadsheetName: bankHoursLegacyBalances.spreadsheetName,
            preMay2025Minutes: bankHoursLegacyBalances.preMay2025Minutes,
            spreadsheetPeriodMinutes: bankHoursLegacyBalances.spreadsheetPeriodMinutes,
            totalMinutes: bankHoursLegacyBalances.totalMinutes,
        })
        .from(bankHoursLegacyBalances);
    const existingByName = new Map(existing.map((row) => [row.spreadsheetName, row]));
    for (const row of rows) {
        const persisted = existingByName.get(row.spreadsheetName);
        if (!persisted) {
            continue;
        }
        if (
            persisted.preMay2025Minutes !== row.preMay2025Minutes
            || persisted.spreadsheetPeriodMinutes !== row.spreadsheetPeriodMinutes
            || persisted.totalMinutes !== row.totalMinutes
        ) {
            throw new Error(
                `"${row.spreadsheetName}" já existe no banco com valores diferentes do CSV. `
                + "Registros legados são imutáveis: corrija via nova migração explícita, não pelo seed.",
            );
        }
    }

    let inserted = 0;
    for (const row of rows) {
        const doctorId = matching[row.spreadsheetName];
        const result = await db
            .insert(bankHoursLegacyBalances)
            .values({
                doctorId,
                spreadsheetName: row.spreadsheetName,
                preMay2025Minutes: row.preMay2025Minutes,
                spreadsheetPeriodMinutes: row.spreadsheetPeriodMinutes,
                totalMinutes: row.totalMinutes,
                source: LEGACY_BANK_HOURS_SOURCE,
                status: doctorId ? "matched" : "unmatched",
            })
            .onConflictDoNothing({ target: bankHoursLegacyBalances.spreadsheetName })
            .returning({ id: bankHoursLegacyBalances.id });
        inserted += result.length;
    }

    const [check] = await db
        .select({
            count: sql<number>`count(*)::int`,
            netTotal: sql<number>`coalesce(sum(${bankHoursLegacyBalances.totalMinutes}), 0)::int`,
            matched: sql<number>`count(*) filter (where ${bankHoursLegacyBalances.status} = 'matched')::int`,
        })
        .from(bankHoursLegacyBalances);

    console.log(`Inseridos agora: ${inserted}; já existiam: ${rows.length - inserted}.`);
    console.log(`Conferência: ${check.count} registros, soma líquida ${check.netTotal} min, ${check.matched} matched.`);

    if (check.count !== LEGACY_BANK_HOURS_EXPECTED_ROW_COUNT || check.netTotal !== LEGACY_BANK_HOURS_EXPECTED_NET_TOTAL_MINUTES) {
        throw new Error(
            `Conferência final divergente: esperava ${LEGACY_BANK_HOURS_EXPECTED_ROW_COUNT} registros somando `
            + `${LEGACY_BANK_HOURS_EXPECTED_NET_TOTAL_MINUTES} min. Investigue antes de qualquer uso.`,
        );
    }
}

main()
    .catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    })
    .finally(() => closeDb());
