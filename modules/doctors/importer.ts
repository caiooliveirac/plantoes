import { readFile } from "node:fs/promises";
import { getDb } from "@/db";
import { doctors } from "@/db/schema";

export interface DoctorImportRow {
    externalCode?: string;
    fullName: string;
    displayName?: string;
}

export interface DoctorImportSummary {
    total: number;
    valid: number;
    invalid: number;
    duplicates: string[];
}

export function normalizeDoctorName(value: string) {
    return value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toUpperCase()
        .replace(/[^A-Z\s']/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function parseCsv(content: string): DoctorImportRow[] {
    const lines = content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

    if (lines.length === 0) {
        return [];
    }

    const [headerLine, ...dataLines] = lines;
    const headers = headerLine.split(",").map((item) => item.trim().toLowerCase());
    const fullNameIndex = headers.findIndex((item) => ["fullname", "full_name", "nome", "nome_completo"].includes(item));
    const displayNameIndex = headers.findIndex((item) => ["displayname", "display_name", "nome_exibicao", "apelido"].includes(item));
    const externalCodeIndex = headers.findIndex((item) => ["externalcode", "external_code", "codigo", "matricula"].includes(item));

    if (fullNameIndex === -1) {
        throw new Error("CSV must include a full_name or nome column.");
    }

    return dataLines.map((line) => {
        const columns = line.split(",").map((item) => item.trim());
        return {
            externalCode: externalCodeIndex >= 0 ? columns[externalCodeIndex] || undefined : undefined,
            fullName: columns[fullNameIndex] || "",
            displayName: displayNameIndex >= 0 ? columns[displayNameIndex] || undefined : undefined,
        };
    });
}

export function parseDoctorImportFile(fileName: string, content: string): DoctorImportRow[] {
    if (fileName.toLowerCase().endsWith(".json")) {
        const parsed = JSON.parse(content) as DoctorImportRow[];
        return parsed;
    }

    return parseCsv(content);
}

export function summarizeDoctorImport(rows: DoctorImportRow[]): DoctorImportSummary {
    const duplicates = new Set<string>();
    const seen = new Set<string>();
    let valid = 0;
    let invalid = 0;

    for (const row of rows) {
        const normalized = normalizeDoctorName(row.fullName ?? "");
        if (!normalized) {
            invalid += 1;
            continue;
        }

        if (seen.has(normalized)) {
            duplicates.add(normalized);
            continue;
        }

        seen.add(normalized);
        valid += 1;
    }

    return {
        total: rows.length,
        valid,
        invalid,
        duplicates: [...duplicates],
    };
}

export async function loadDoctorImportFile(filePath: string) {
    const content = await readFile(filePath, "utf8");
    return parseDoctorImportFile(filePath, content);
}

export async function applyDoctorImport(rows: DoctorImportRow[]) {
    const db = getDb();
    const uniqueRows = new Map<string, DoctorImportRow>();

    for (const row of rows) {
        const normalizedName = normalizeDoctorName(row.fullName);
        if (!normalizedName) {
            continue;
        }

        uniqueRows.set(normalizedName, {
            externalCode: row.externalCode?.trim() || undefined,
            fullName: row.fullName.trim(),
            displayName: row.displayName?.trim() || undefined,
        });
    }

    const values = [...uniqueRows.entries()].map(([normalizedName, row]) => ({
        externalCode: row.externalCode ?? null,
        fullName: row.fullName,
        displayName: row.displayName ?? null,
        normalizedName,
        isActive: true,
        metadata: {},
        updatedAt: new Date(),
    }));

    if (values.length === 0) {
        return { imported: 0 };
    }

    for (const value of values) {
        await db
            .insert(doctors)
            .values(value)
            .onConflictDoUpdate({
                target: doctors.normalizedName,
                set: {
                    externalCode: value.externalCode,
                    fullName: value.fullName,
                    displayName: value.displayName,
                    isActive: true,
                    updatedAt: new Date(),
                },
            });
    }

    return { imported: values.length };
}
