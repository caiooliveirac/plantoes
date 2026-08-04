/**
 * Reparo da linha de MAIO no extrato do saldo contratual.
 *
 *   npx tsx scripts/repair-maio-extrato.ts --file "<planilha.xlsx>" [--apply]
 *
 * O problema: o backfill (scripts/backfill-saldo-contrato.ts) importou UM número
 * por contrato — o SALDO CONTRATO do FIM de maio/2026 — como lançamento de
 * abertura datado de 31/05. Correto para o saldo, ruim para o extrato: a linha
 * de maio abre em "31/05" e mostra gasto zero, como se o mês não tivesse
 * existido.
 *
 * A planilha tem os três números de maio, e eles fecham entre si:
 *
 *   SALDO CONTRATO (col 3, início do mês)  −  TOTAL (col 43, gasto do mês)
 *     =  SALDO CONTRATO (col 45, fim do mês — o que o backfill importou)
 *
 * Este script reconstitui maio no razão SEM mudar o saldo de ninguém:
 *
 *   1. move o lançamento de abertura do backfill para 01/05, com o saldo de
 *      INÍCIO de maio (col 3);
 *   2. lança o gasto de maio como 'invoice' de 31/05 (origem
 *      'spreadsheet_import', chave '<doctorId>|2026-05'), com os plantões de
 *      semana/fim de semana das colunas 39/41.
 *
 * Como início − gasto = fim, a soma do razão fica exatamente a que era.
 *
 * Sobre o append-only: o razão não aceita UPDATE em lançamento de NEGÓCIO —
 * errou, estorna. A abertura do backfill não é um ato de negócio, é carga de
 * dados feita por este mesmo diretório de scripts; corrigir a carga na própria
 * linha (com relatório versionado) é mais legível do que empilhar um estorno +
 * relançamento que poluiria o histórico de 117 contratos.
 *
 * IDONEIDADE (nenhum número entra sem fechar as contas):
 *   - cadeia:      |início − gasto − fim| ≤ R$ 0,05;
 *   - razão:       |fim − abertura já gravada| ≤ R$ 0,05 (pega os saldos
 *                  corrigidos à mão em saldo-overrides.json, que ficam de fora);
 *   - decompor:    quando a planilha traz VALOR SEMANA/VALOR FDS, a soma deles
 *                  tem que bater com o TOTAL;
 *   - ciclo:       maio precisa pertencer ao ciclo do contrato (quem renovou em
 *                  maio importou o saldo do ciclo NOVO — maio pertence a ele;
 *                  quem renovou em junho tem maio no ciclo velho — idem ok);
 *   - célula única faltando é DERIVADA da cadeia (gasto vazio com início = fim
 *      vira gasto zero) e marcada no relatório; duas faltando = fica de fora.
 *
 * Sem --apply é dry-run: só escreve docs/saldo-contrato/repair-maio-report.md.
 * Rodar duas vezes não duplica nada: abertura já em 01/05 ou invoice de
 * spreadsheet_import existente = contrato pulado.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import { and, eq, like } from "drizzle-orm";
import { getDb, hasDatabaseUrl } from "@/db";
import { contractLedger, contracts, doctors } from "@/db/schema";
import { normalizeDoctorName } from "@/scripts/backfill-saldo-contrato";
import { isMonthWithinCycle } from "@/lib/contracts/statement";

const HEADER_ROW = 9;
const MAY_MONTH_KEY = "2026-05";
const MAY_FIRST_DAY = "2026-05-01";
const MAY_LAST_DAY = "2026-05-31";
const TOLERANCE = 0.05;
export const IMPORT_SOURCE_TYPE = "spreadsheet_import";

const COLUMN = {
    name: 1,
    startBalance: 3,        // SALDO CONTRATO no início do mês
    contractNumber: 5,
    weekdayShifts: 39,      // PLANTOES DIA DE SEMANA
    weekdayAmount: 40,      // VALOR SEMANA
    weekendShifts: 41,      // PLANTOES FIM DE SEMANA
    weekendAmount: 42,      // VALOR FIM DE SEMANA
    monthTotal: 43,         // TOTAL (gasto do mês)
    closingBalance: 45,     // SALDO CONTRATO no fim do mês (o que o backfill importou)
} as const;

// --------------------------------------------------------------------------
// Leitura da planilha (mesmas convenções do backfill)
// --------------------------------------------------------------------------

type Cell = ExcelJS.CellValue;

function cellText(value: Cell): string {
    if (value == null) return "";
    if (typeof value === "object") {
        const object = value as unknown as Record<string, unknown>;
        if ("richText" in object) return (object.richText as { text: string }[]).map((part) => part.text).join("");
        if ("result" in object) return String(object.result ?? "");
        if ("text" in object) return String(object.text);
    }
    return String(value);
}

/** null = célula ilegível (#VALUE!, fórmula sem resultado). Nunca vira zero. */
function cellNumber(value: Cell): number | null {
    if (value == null) return null;
    if (typeof value === "number") return value;
    if (typeof value === "object") {
        const object = value as unknown as Record<string, unknown>;
        if ("error" in object) return null;
        if ("result" in object) {
            const result = object.result;
            return typeof result === "number" ? result : null;
        }
        return null;
    }
    const parsed = Number(String(value).replace(/\./g, "").replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
}

export interface MayRowJson {
    rawName: string;
    contractNumbers: string[];
    startBalance: number | null;
    monthTotal: number | null;
    closingBalance: number | null;
    weekdayShifts: number | null;
    weekendShifts: number | null;
    weekdayAmount: number | null;
    weekendAmount: number | null;
}

export interface MayRow {
    rawName: string;
    normalized: string;
    contractNumbers: string[];
    startBalance: number | null;
    monthTotal: number | null;
    closingBalance: number | null;
    weekdayShifts: number | null;
    weekendShifts: number | null;
    weekdayAmount: number | null;
    weekendAmount: number | null;
}

export function readMayTabs(workbook: ExcelJS.Workbook): MayRow[] {
    const rows: MayRow[] = [];
    for (const sheet of workbook.worksheets) {
        if (!/MAIO/i.test(sheet.name)) continue;
        for (let index = HEADER_ROW + 1; index <= sheet.rowCount; index++) {
            const row = sheet.getRow(index);
            const rawName = cellText(row.getCell(COLUMN.name).value).trim();
            const normalized = normalizeDoctorName(rawName);
            if (normalized.length < 5 || !normalized.includes(" ")) continue;
            rows.push({
                rawName,
                normalized,
                contractNumbers: cellText(row.getCell(COLUMN.contractNumber).value)
                    .trim().split(/\s{2,}|\s*[,;]\s*/).map((part) => part.trim()).filter(Boolean),
                startBalance: cellNumber(row.getCell(COLUMN.startBalance).value),
                monthTotal: cellNumber(row.getCell(COLUMN.monthTotal).value),
                closingBalance: cellNumber(row.getCell(COLUMN.closingBalance).value),
                weekdayShifts: cellNumber(row.getCell(COLUMN.weekdayShifts).value),
                weekendShifts: cellNumber(row.getCell(COLUMN.weekendShifts).value),
                weekdayAmount: cellNumber(row.getCell(COLUMN.weekdayAmount).value),
                weekendAmount: cellNumber(row.getCell(COLUMN.weekendAmount).value),
            });
        }
    }
    return rows;
}

// --------------------------------------------------------------------------
// Plano por linha — puro, testável
// --------------------------------------------------------------------------

export type MayPlanStatus =
    | "ok"                 // três números legíveis, cadeia fecha
    | "ok_derivado"        // uma célula faltava e foi derivada da cadeia
    | "ilegivel"           // duas ou mais células faltando: não dá para derivar
    | "cadeia_quebrada"    // início − gasto ≠ fim (ou gasto negativo)
    | "soma_nao_bate";     // VALOR SEMANA + VALOR FDS ≠ TOTAL

export interface MayPlan {
    status: MayPlanStatus;
    /** Saldo no início de maio (vira a nova abertura, datada de 01/05). */
    startBalance: number;
    /** Gasto de maio (vira o invoice de 31/05). Sempre >= 0. */
    monthTotal: number;
    /** Saldo no fim de maio — tem que bater com a abertura já gravada. */
    closingBalance: number;
    weekdayShifts: number;
    weekendShifts: number;
    notes: string[];
}

function round2(value: number): number {
    return Number(value.toFixed(2));
}

/** Plantões andam de 0,5 em 0,5 (constraint do razão). */
function isHalfStep(value: number): boolean {
    return Number.isFinite(value) && value >= 0 && Math.abs(value * 2 - Math.round(value * 2)) < 1e-9;
}

export function planMayRepair(row: MayRow): MayPlan {
    const notes: string[] = [];
    let { startBalance: inicio, monthTotal: gasto, closingBalance: fim } = row;

    const missing = [inicio, gasto, fim].filter((value) => value === null).length;
    const invalid = (status: MayPlanStatus): MayPlan => ({
        status, startBalance: 0, monthTotal: 0, closingBalance: 0, weekdayShifts: 0, weekendShifts: 0, notes,
    });

    if (missing >= 2) {
        notes.push("duas ou mais células de maio ilegíveis — nada a derivar");
        return invalid("ilegivel");
    }
    // Uma célula faltando é derivável da identidade início − gasto = fim.
    if (gasto === null) {
        gasto = round2(inicio! - fim!);
        notes.push(`gasto de maio vazio na planilha — derivado da cadeia: ${gasto.toFixed(2)}`);
    } else if (inicio === null) {
        inicio = round2(fim! + gasto);
        notes.push(`saldo de início de maio vazio na planilha — derivado da cadeia: ${inicio.toFixed(2)}`);
    } else if (fim === null) {
        // O fim é o número que valida contra o razão: derivá-lo tiraria a única
        // checagem independente. Fica de fora.
        notes.push("SALDO CONTRATO do fim de maio ilegível — sem ele não há validação contra o razão");
        return invalid("ilegivel");
    }
    const derived = missing === 1;

    if (Math.abs(gasto) <= TOLERANCE) gasto = 0;
    if (gasto < 0) {
        notes.push(`gasto de maio negativo (${gasto.toFixed(2)}) — não existe consumo negativo`);
        return invalid("cadeia_quebrada");
    }
    if (Math.abs(inicio! - gasto - fim!) > TOLERANCE) {
        notes.push(`cadeia não fecha: ${inicio!.toFixed(2)} − ${gasto.toFixed(2)} ≠ ${fim!.toFixed(2)}`);
        return invalid("cadeia_quebrada");
    }
    // Quando a planilha decompõe o total, a decomposição tem que bater.
    if (row.weekdayAmount !== null && row.weekendAmount !== null
        && Math.abs(row.weekdayAmount + row.weekendAmount - gasto) > TOLERANCE) {
        notes.push(`VALOR SEMANA + VALOR FDS (${(row.weekdayAmount + row.weekendAmount).toFixed(2)}) ≠ TOTAL (${gasto.toFixed(2)})`);
        return invalid("soma_nao_bate");
    }

    let weekdayShifts = row.weekdayShifts ?? 0;
    let weekendShifts = row.weekendShifts ?? 0;
    if (!isHalfStep(weekdayShifts) || !isHalfStep(weekendShifts)) {
        notes.push(`plantões fora do passo de 0,5 (${weekdayShifts}/${weekendShifts}) — lançados como zero, só o valor entra`);
        weekdayShifts = 0;
        weekendShifts = 0;
    }
    if (gasto === 0 && (weekdayShifts > 0 || weekendShifts > 0)) {
        notes.push("plantões marcados com gasto zero — plantões lançados como zero");
        weekdayShifts = 0;
        weekendShifts = 0;
    }

    return {
        status: derived ? "ok_derivado" : "ok",
        startBalance: round2(inicio!),
        monthTotal: round2(gasto),
        closingBalance: round2(fim!),
        weekdayShifts,
        weekendShifts,
        notes,
    };
}

// --------------------------------------------------------------------------
// Execução
// --------------------------------------------------------------------------

const ALIASES_PATH = "docs/saldo-contrato/name-aliases.json";
const REPORT_PATH = "docs/saldo-contrato/repair-maio-report.md";
/** Descrição gravada pelo backfill — é o que identifica a abertura a corrigir. */
const BACKFILL_DESCRIPTION_PREFIX = "Saldo de MAIO/2026 importado da planilha";

interface RepairResult {
    doctorName: string;
    contractNumber: string;
    status: MayPlanStatus | "aplicado" | "dry_run" | "ja_reparado" | "saldo_diferente_do_razao" | "fora_do_ciclo" | "sem_linha_na_planilha" | "linha_ambigua";
    detail: string;
}

function formatBrl(value: number): string {
    return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

async function loadAliases(): Promise<Map<string, string>> {
    try {
        const raw = await readFile(path.resolve(process.cwd(), ALIASES_PATH), "utf8");
        const parsed = JSON.parse(raw) as Record<string, string>;
        const map = new Map<string, string>();
        for (const [from, to] of Object.entries(parsed)) {
            if (from.startsWith("_")) continue;
            map.set(normalizeDoctorName(from), normalizeDoctorName(to));
        }
        return map;
    } catch {
        return new Map();
    }
}

async function main() {
    const args = process.argv.slice(2);
    const fileIndex = args.indexOf("--file");
    const dataIndex = args.indexOf("--data");
    const sourceFile = fileIndex >= 0 ? args[fileIndex + 1] : "";
    const dataFile = dataIndex >= 0 ? args[dataIndex + 1] : "";
    const apply = args.includes("--apply");
    if (!sourceFile && !dataFile) {
        throw new Error("Uso: tsx scripts/repair-maio-extrato.ts (--file <planilha.xlsx> | --data <maio.json>) [--apply]");
    }
    if (!hasDatabaseUrl()) throw new Error("DATABASE_URL não configurada.");

    let mayRows: MayRow[];
    let sourceLabel: string;
    if (dataFile) {
        // JSON extraído da planilha (docs/saldo-contrato/maio-2026-planilha.json):
        // é a mesma leitura, congelada e versionada — serve para rodar o reparo
        // onde a planilha não está (ex.: no servidor, via workflow). Todas as
        // validações de idoneidade rodam do mesmo jeito.
        const parsed = JSON.parse(await readFile(path.resolve(process.cwd(), dataFile), "utf8")) as { rows: MayRowJson[] };
        mayRows = parsed.rows.map((row) => ({ ...row, normalized: normalizeDoctorName(row.rawName) }));
        sourceLabel = dataFile;
    } else {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(sourceFile);
        mayRows = readMayTabs(workbook);
        sourceLabel = sourceFile;
    }
    const aliases = await loadAliases();

    // Linhas da planilha indexadas pelo nome como está em doctors.normalizedName.
    const rowsByDoctor = new Map<string, MayRow[]>();
    for (const row of mayRows) {
        const key = aliases.get(row.normalized) ?? row.normalized;
        rowsByDoctor.set(key, [...(rowsByDoctor.get(key) ?? []), row]);
    }

    const db = getDb();
    // As aberturas que o backfill gravou em 31/05 e ainda não foram corrigidas.
    const openings = await db
        .select({
            ledgerId: contractLedger.id,
            amount: contractLedger.amount,
            contractId: contracts.id,
            contractNumber: contracts.contractNumber,
            cycleStart: contracts.cycleStart,
            cycleEnd: contracts.cycleEnd,
            doctorId: contracts.doctorId,
            doctorName: doctors.fullName,
            doctorNormalized: doctors.normalizedName,
        })
        .from(contractLedger)
        .innerJoin(contracts, eq(contracts.id, contractLedger.contractId))
        .innerJoin(doctors, eq(doctors.id, contracts.doctorId))
        .where(and(
            eq(contractLedger.type, "opening"),
            eq(contractLedger.entryDate, MAY_LAST_DAY),
            like(contractLedger.description, `${BACKFILL_DESCRIPTION_PREFIX}%`),
        ));

    // Idempotência: contrato que já tem o invoice de maio importado fica de fora.
    const alreadyImported = new Set<string>();
    const importedRows = await db
        .select({ contractId: contractLedger.contractId })
        .from(contractLedger)
        .where(and(
            eq(contractLedger.sourceType, IMPORT_SOURCE_TYPE),
            like(contractLedger.sourceKey, `%|${MAY_MONTH_KEY}`),
        ));
    for (const row of importedRows) alreadyImported.add(row.contractId);

    const results: RepairResult[] = [];
    let applied = 0;

    for (const opening of openings) {
        const push = (status: RepairResult["status"], detail: string) =>
            results.push({ doctorName: opening.doctorName, contractNumber: opening.contractNumber, status, detail });

        if (alreadyImported.has(opening.contractId)) {
            push("ja_reparado", "invoice de maio já existe no razão deste contrato");
            continue;
        }

        const candidates = rowsByDoctor.get(normalizeDoctorName(opening.doctorNormalized)) ?? [];
        let row: MayRow | undefined;
        if (candidates.length === 1) {
            row = candidates[0];
        } else if (candidates.length > 1) {
            // Mais de uma linha para o mesmo médico: o nº do contrato desambigua.
            const byNumber = candidates.filter((item) => item.contractNumbers.includes(opening.contractNumber));
            if (byNumber.length === 1) row = byNumber[0];
            else {
                push("linha_ambigua", `${candidates.length} linhas na planilha e o nº ${opening.contractNumber} não desambigua`);
                continue;
            }
        }
        if (!row) {
            push("sem_linha_na_planilha", "nenhuma linha de maio casou com este médico");
            continue;
        }

        const plan = planMayRepair(row);
        if (plan.status !== "ok" && plan.status !== "ok_derivado") {
            push(plan.status, plan.notes.join("; "));
            continue;
        }

        // O fim de maio da planilha tem que ser exatamente o que o backfill
        // gravou. Divergência = saldo corrigido à mão depois (saldo-overrides)
        // ou planilha editada — nos dois casos, não mexer.
        const openingAmount = Number(opening.amount);
        if (Math.abs(plan.closingBalance - openingAmount) > TOLERANCE) {
            push("saldo_diferente_do_razao",
                `planilha fecha maio em ${formatBrl(plan.closingBalance)}, razão tem ${formatBrl(openingAmount)} — fica como está`);
            continue;
        }
        if (!isMonthWithinCycle(MAY_MONTH_KEY, opening.cycleStart, opening.cycleEnd)) {
            push("fora_do_ciclo", `maio fora do ciclo ${opening.cycleStart} → ${opening.cycleEnd}`);
            continue;
        }

        const detail = `abertura ${formatBrl(openingAmount)} em 31/05 → ${formatBrl(plan.startBalance)} em 01/05; `
            + `gasto de maio ${formatBrl(plan.monthTotal)} (${plan.weekdayShifts} sem + ${plan.weekendShifts} fds)`
            + (plan.notes.length > 0 ? ` · ${plan.notes.join("; ")}` : "");

        if (!apply) {
            push("dry_run", detail);
            continue;
        }

        await db.transaction(async (tx) => {
            await tx.update(contractLedger)
                .set({
                    entryDate: MAY_FIRST_DAY,
                    amount: plan.startBalance.toFixed(2),
                    description: "Saldo de 01/05/2026 importado da planilha (corrigido de 31/05: o gasto de maio virou lançamento próprio — scripts/repair-maio-extrato.ts)",
                })
                .where(eq(contractLedger.id, opening.ledgerId));
            if (plan.monthTotal > 0) {
                await tx.insert(contractLedger).values({
                    contractId: opening.contractId,
                    entryDate: MAY_LAST_DAY,
                    type: "invoice",
                    amount: (-plan.monthTotal).toFixed(2),
                    weekdayShifts: plan.weekdayShifts.toFixed(1),
                    weekendShifts: plan.weekendShifts.toFixed(1),
                    sourceType: IMPORT_SOURCE_TYPE,
                    sourceKey: `${opening.doctorId}|${MAY_MONTH_KEY}`,
                    sourceRevision: 0,
                    description: "Consumo de maio/2026 importado da planilha 2026 CHAMAMENTO 004",
                });
            }
        });
        applied++;
        push("aplicado", detail);
    }

    // ------------------------------------------------------------------ report
    const lines: string[] = [];
    lines.push("# Reparo da linha de maio no extrato — relatório");
    lines.push("");
    lines.push(`- Origem: \`${path.basename(sourceLabel)}\``);
    lines.push(`- Modo: ${apply ? "**--apply** (gravou no banco)" : "**dry-run** (nada gravado)"}`);
    lines.push(`- Aberturas do backfill encontradas em 31/05: **${openings.length}**`);
    lines.push(`- ${apply ? "Reparados" : "Reparáveis"}: **${apply ? applied : results.filter((r) => r.status === "dry_run").length}**`);
    lines.push("");
    const groups: [RepairResult["status"], string][] = [
        ["aplicado", "Reparados"],
        ["dry_run", "Reparáveis (dry-run)"],
        ["ja_reparado", "Já reparados antes (pulados)"],
        ["saldo_diferente_do_razao", "Planilha ≠ razão — NÃO mexidos (provável saldo corrigido à mão)"],
        ["fora_do_ciclo", "Maio fora do ciclo do contrato — NÃO mexidos"],
        ["ilegivel", "Células ilegíveis demais — NÃO mexidos"],
        ["cadeia_quebrada", "Cadeia início − gasto ≠ fim — NÃO mexidos"],
        ["soma_nao_bate", "Decomposição não bate com o TOTAL — NÃO mexidos"],
        ["linha_ambigua", "Linha ambígua na planilha — NÃO mexidos"],
        ["sem_linha_na_planilha", "Sem linha de maio na planilha — NÃO mexidos"],
    ];
    for (const [status, title] of groups) {
        const subset = results.filter((result) => result.status === status);
        if (subset.length === 0) continue;
        lines.push(`## ${title} — ${subset.length}`);
        lines.push("");
        for (const result of subset) lines.push(`- **${result.doctorName}** (${result.contractNumber}): ${result.detail}`);
        lines.push("");
    }
    await writeFile(path.resolve(process.cwd(), REPORT_PATH), lines.join("\n"), "utf8");

    console.log(`${apply ? "Aplicado" : "Dry-run"}: ${apply ? applied : results.filter((r) => r.status === "dry_run").length} de ${openings.length} aberturas.`);
    console.log(`Relatório: ${REPORT_PATH}`);
    process.exit(0);
}

// Só roda como CLI — os testes importam as funções puras sem efeito colateral.
// Basename exato: "includes" dispararia também no arquivo de teste, cujo nome
// contém o nome deste script.
if (path.basename(process.argv[1] ?? "") === "repair-maio-extrato.ts") {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    });
}
