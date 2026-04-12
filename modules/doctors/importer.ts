import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { doctors } from "@/db/schema";
import {
    extractDoctorAliases,
    extractDoctorPreferredOperationalRole,
    mergeDoctorDirectoryMetadata,
    parseDoctorAliasesInput,
} from "@/modules/doctors/directory";

export interface DoctorImportRow {
    externalCode?: string;
    fullName: string;
    displayName?: string;
    aliases?: string[] | string;
}

export interface DoctorImportSummary {
    total: number;
    valid: number;
    invalid: number;
    duplicates: string[];
}

interface NormalizedDoctorImportRow {
    externalCode?: string;
    fullName: string;
    displayName?: string;
    aliases: string[];
    preferredOperationalRole: string | null;
}

export interface DoctorImportPreviewChange {
    fullName: string;
    previousDisplayName: string | null;
    nextDisplayName: string | null;
}

export interface DoctorImportPreviewAdd {
    fullName: string;
    displayName: string | null;
    preferredOperationalRole: string | null;
}

export interface DoctorImportRiskyAdditionMatch {
    id: string;
    fullName: string;
    displayName: string | null;
    matchedBy: string[];
}

export interface DoctorImportRiskyAddition {
    fullName: string;
    displayName: string | null;
    matchedDoctors: DoctorImportRiskyAdditionMatch[];
}

export interface DoctorImportPreview {
    total: number;
    unchanged: number;
    additions: DoctorImportPreviewAdd[];
    riskyAdditions: DoctorImportRiskyAddition[];
    displayNameChanges: DoctorImportPreviewChange[];
    normalizedNameFixes: Array<{ fullName: string; previousNormalizedName: string; nextNormalizedName: string }>;
    preferredOperationalRoleChanges: Array<{ fullName: string; previousRole: string | null; nextRole: string | null }>;
    aliasChanges: Array<{ fullName: string; addedAliases: string[] }>;
}

export interface ApplyDoctorImportOptions {
    allowAdditions?: boolean;
    preview?: DoctorImportPreview;
}

interface DoctorDirectorySnapshotEntry {
    id: string;
    fullName: string;
    displayName: string | null;
    normalizedName: string;
    externalCode: string | null;
    metadata: unknown;
    isActive: boolean;
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

function stripPsychiatrySuffix(value: string | undefined) {
    const trimmed = value?.trim() ?? "";
    return trimmed.replace(/\s*\((?:Psiquiatria|PSIQUIATRIA)\)\s*$/i, "").trim();
}

function hasPsychiatryTag(value: string | undefined) {
    return /\((?:Psiquiatria|PSIQUIATRIA)\)/i.test(value ?? "");
}

function detectCsvDelimiter(headerLine: string) {
    const commaCount = (headerLine.match(/,/g) ?? []).length;
    const semicolonCount = (headerLine.match(/;/g) ?? []).length;
    return semicolonCount > commaCount ? ";" : ",";
}

function normalizeImportRow(row: DoctorImportRow): NormalizedDoctorImportRow | null {
    const fullName = stripPsychiatrySuffix(row.fullName);
    const normalizedName = normalizeDoctorName(fullName);
    if (!normalizedName) {
        return null;
    }

    const displayName = stripPsychiatrySuffix(row.displayName);
    const aliases = parseDoctorAliasesInput(row.aliases);
    const preferredOperationalRole = hasPsychiatryTag(row.fullName) || hasPsychiatryTag(row.displayName)
        ? "PSIQ"
        : null;

    return {
        externalCode: row.externalCode?.trim() || undefined,
        fullName,
        displayName: displayName || undefined,
        aliases,
        preferredOperationalRole,
    };
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
    const delimiter = detectCsvDelimiter(headerLine);
    const headers = headerLine
        .split(delimiter)
        .map((item) => item.trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, ""));
    const fullNameIndex = headers.findIndex((item) => ["fullname", "full_name", "nome", "nome_completo"].includes(item));
    const displayNameIndex = headers.findIndex((item) => ["displayname", "display_name", "nome_exibicao", "apelido"].includes(item));
    const externalCodeIndex = headers.findIndex((item) => ["externalcode", "external_code", "codigo", "matricula"].includes(item));
    const aliasesIndex = headers.findIndex((item) => ["aliases", "alias", "apelidos", "nomes_alternativos"].includes(item));

    if (fullNameIndex === -1) {
        throw new Error("CSV must include a full_name or nome column.");
    }

    return dataLines.map((line) => {
        const columns = line.split(delimiter).map((item) => item.trim());
        return {
            externalCode: externalCodeIndex >= 0 ? columns[externalCodeIndex] || undefined : undefined,
            fullName: columns[fullNameIndex] || "",
            displayName: displayNameIndex >= 0 ? columns[displayNameIndex] || undefined : undefined,
            aliases: aliasesIndex >= 0 ? columns[aliasesIndex] || undefined : undefined,
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
        const normalized = normalizeDoctorName(stripPsychiatrySuffix(row.fullName));
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

function buildDirectoryLookup(entries: DoctorDirectorySnapshotEntry[]) {
    const byNormalizedFullName = new Map<string, DoctorDirectorySnapshotEntry>();
    const byId = new Map<string, DoctorDirectorySnapshotEntry>();

    for (const entry of entries) {
        byNormalizedFullName.set(normalizeDoctorName(entry.fullName), entry);
        byId.set(entry.id, entry);
    }

    return { byNormalizedFullName, byId };
}

function buildExistingDoctorTermMap(entry: DoctorDirectorySnapshotEntry) {
    const termMap = new Map<string, Set<string>>();
    const register = (value: string | null | undefined, source: string) => {
        const normalized = normalizeDoctorName(value ?? "");
        if (!normalized) {
            return;
        }

        const sources = termMap.get(normalized) ?? new Set<string>();
        sources.add(source);
        termMap.set(normalized, sources);
    };

    register(entry.fullName, "full_name");
    register(entry.displayName, "display_name");
    register(entry.normalizedName, "legacy_normalized_name");
    register(entry.externalCode, "external_code");

    for (const alias of extractDoctorAliases(entry.metadata)) {
        register(alias, "alias");
    }

    return termMap;
}

function detectRiskyAddition(row: NormalizedDoctorImportRow, entries: DoctorDirectorySnapshotEntry[]) {
    const incomingTerms = new Map<string, Set<string>>();
    const registerIncoming = (value: string | null | undefined, source: string) => {
        const normalized = normalizeDoctorName(value ?? "");
        if (!normalized) {
            return;
        }

        const sources = incomingTerms.get(normalized) ?? new Set<string>();
        sources.add(source);
        incomingTerms.set(normalized, sources);
    };

    registerIncoming(row.displayName, "display_name");
    registerIncoming(row.externalCode, "external_code");
    for (const alias of row.aliases) {
        registerIncoming(alias, "alias");
    }

    const matches: DoctorImportRiskyAdditionMatch[] = [];
    for (const entry of entries) {
        const existingTerms = buildExistingDoctorTermMap(entry);
        const matchedBy = new Set<string>();

        for (const [term, sources] of incomingTerms.entries()) {
            const existingSources = existingTerms.get(term);
            if (!existingSources) {
                continue;
            }

            for (const source of sources) {
                matchedBy.add(source);
            }

            for (const source of existingSources) {
                matchedBy.add(source);
            }
        }

        if (matchedBy.size === 0) {
            continue;
        }

        matches.push({
            id: entry.id,
            fullName: entry.fullName,
            displayName: entry.displayName ?? null,
            matchedBy: [...matchedBy].sort(),
        });
    }

    if (matches.length === 0) {
        return null;
    }

    return {
        fullName: row.fullName,
        displayName: row.displayName ?? null,
        matchedDoctors: matches,
    } satisfies DoctorImportRiskyAddition;
}

export function previewDoctorImportAgainstDirectory(rows: DoctorImportRow[], entries: DoctorDirectorySnapshotEntry[]): DoctorImportPreview {
    const uniqueRows = new Map<string, NormalizedDoctorImportRow>();
    for (const row of rows) {
        const normalized = normalizeImportRow(row);
        if (!normalized) {
            continue;
        }

        uniqueRows.set(normalizeDoctorName(normalized.fullName), normalized);
    }

    const lookup = buildDirectoryLookup(entries);
    const additions: DoctorImportPreviewAdd[] = [];
    const riskyAdditions: DoctorImportPreview["riskyAdditions"] = [];
    const displayNameChanges: DoctorImportPreviewChange[] = [];
    const normalizedNameFixes: DoctorImportPreview["normalizedNameFixes"] = [];
    const preferredOperationalRoleChanges: DoctorImportPreview["preferredOperationalRoleChanges"] = [];
    const aliasChanges: DoctorImportPreview["aliasChanges"] = [];
    let unchanged = 0;

    for (const [normalizedFullName, row] of uniqueRows.entries()) {
        const existing = lookup.byNormalizedFullName.get(normalizedFullName) ?? null;
        if (!existing) {
            additions.push({
                fullName: row.fullName,
                displayName: row.displayName ?? null,
                preferredOperationalRole: row.preferredOperationalRole,
            });

            const riskyAddition = detectRiskyAddition(row, entries);
            if (riskyAddition) {
                riskyAdditions.push(riskyAddition);
            }
            continue;
        }

        let hasChange = false;

        const nextDisplayName = row.displayName ?? null;
        if ((existing.displayName ?? null) !== nextDisplayName) {
            hasChange = true;
            displayNameChanges.push({
                fullName: row.fullName,
                previousDisplayName: existing.displayName ?? null,
                nextDisplayName,
            });
        }

        if (existing.normalizedName !== normalizedFullName) {
            hasChange = true;
            normalizedNameFixes.push({
                fullName: row.fullName,
                previousNormalizedName: existing.normalizedName,
                nextNormalizedName: normalizedFullName,
            });
        }

        const previousRole = extractDoctorPreferredOperationalRole(existing.metadata);
        if (previousRole !== row.preferredOperationalRole) {
            hasChange = true;
            preferredOperationalRoleChanges.push({
                fullName: row.fullName,
                previousRole,
                nextRole: row.preferredOperationalRole,
            });
        }

        const existingAliases = extractDoctorAliases(existing.metadata);
        const aliasesToAdd = [...new Set(row.aliases)].filter((alias) => !existingAliases.includes(alias));
        if (aliasesToAdd.length > 0) {
            hasChange = true;
            aliasChanges.push({
                fullName: row.fullName,
                addedAliases: aliasesToAdd,
            });
        }

        if (!hasChange) {
            unchanged += 1;
        }
    }

    return {
        total: uniqueRows.size,
        unchanged,
        additions,
        riskyAdditions,
        displayNameChanges,
        normalizedNameFixes,
        preferredOperationalRoleChanges,
        aliasChanges,
    };
}

export function assertDoctorImportSafeToApply(preview: DoctorImportPreview, options: ApplyDoctorImportOptions = {}) {
    if (preview.riskyAdditions.length > 0) {
        const summary = preview.riskyAdditions
            .map((item) => {
                const candidates = item.matchedDoctors
                    .map((candidate) => `${candidate.fullName} [${candidate.matchedBy.join(", ")}]`)
                    .join("; ");
                return `${item.fullName}: ${candidates}`;
            })
            .join(" | ");
        throw new Error(`Import blocked: found risky additions that may split historical data. Review these rows manually: ${summary}`);
    }

    if (preview.additions.length > 0 && !options.allowAdditions) {
        const additions = preview.additions.map((item) => item.fullName).join(", ");
        throw new Error(`Import blocked: ${preview.additions.length} new doctors would be created. Re-run with explicit addition approval after review. Additions: ${additions}`);
    }
}

export async function previewDoctorImport(rows: DoctorImportRow[]) {
    const db = getDb();
    const entries = await db.query.doctors.findMany({
        columns: {
            id: true,
            fullName: true,
            displayName: true,
            normalizedName: true,
            externalCode: true,
            metadata: true,
            isActive: true,
        },
    });

    return previewDoctorImportAgainstDirectory(rows, entries);
}

export async function applyDoctorImport(rows: DoctorImportRow[], options: ApplyDoctorImportOptions = {}) {
    const db = getDb();
    const uniqueRows = new Map<string, NormalizedDoctorImportRow>();

    for (const row of rows) {
        const normalized = normalizeImportRow(row);
        if (!normalized) {
            continue;
        }

        uniqueRows.set(normalizeDoctorName(normalized.fullName), normalized);
    }

    if (uniqueRows.size === 0) {
        return { imported: 0 };
    }

    const preview = options.preview ?? await previewDoctorImport(rows);
    assertDoctorImportSafeToApply(preview, options);

    const existingDoctors = await db.query.doctors.findMany({
        columns: {
            id: true,
            externalCode: true,
            fullName: true,
            displayName: true,
            normalizedName: true,
            isActive: true,
            metadata: true,
        },
    });
    const lookup = buildDirectoryLookup(existingDoctors);
    let imported = 0;

    await db.transaction(async (tx) => {
        for (const [normalizedName, row] of uniqueRows.entries()) {
            const existing = lookup.byNormalizedFullName.get(normalizedName) ?? null;
            const now = new Date();

            if (existing) {
                const aliases = parseDoctorAliasesInput([
                    ...extractDoctorAliases(existing.metadata),
                    ...row.aliases,
                    existing.displayName && existing.displayName !== row.displayName ? existing.displayName : "",
                ]);
                await tx
                    .update(doctors)
                    .set({
                        externalCode: row.externalCode ?? existing.externalCode,
                        fullName: row.fullName,
                        displayName: row.displayName ?? null,
                        normalizedName,
                        metadata: mergeDoctorDirectoryMetadata(existing.metadata, {
                            aliases,
                            preferredOperationalRole: row.preferredOperationalRole,
                        }),
                        isActive: true,
                        updatedAt: now,
                    })
                    .where(eq(doctors.id, existing.id));
                imported += 1;
                continue;
            }

            await tx.insert(doctors).values({
                externalCode: row.externalCode ?? null,
                fullName: row.fullName,
                displayName: row.displayName ?? null,
                normalizedName,
                isActive: true,
                metadata: mergeDoctorDirectoryMetadata({}, {
                    aliases: row.aliases,
                    preferredOperationalRole: row.preferredOperationalRole,
                }),
                updatedAt: now,
            });
            imported += 1;
        }
    });

    return { imported };
}
