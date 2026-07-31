/**
 * Backfill do saldo contratual (docs/saldo-contrato/SPEC.md §9, revisado pelas
 * decisões do usuário em 2026-07-31).
 *
 *   npm run saldo:backfill -- --file "<planilha.xlsx>" [--apply]
 *
 * O que ele importa: UM número por contrato — o saldo de maio/2026, a coluna
 * SALDO CONTRATO da última aba mensal da planilha. De junho em diante o consumo
 * vem do próprio sistema, do fechamento assinado pelo coordenador. Os meses de
 * fevereiro a abril são lidos só para CLASSIFICAR o número de maio: em parte das
 * linhas ele não é saldo nenhum.
 *
 * Três estados em que o número de maio não serve como saldo de abertura:
 *
 *   teto_nao_carregado   a planilha abriu o contrato em R$ 0,00 e foi acumulando
 *                        o consumo com sinal negativo. O número é consumo, não
 *                        saldo — importá-lo inventaria um estouro.
 *   renovacao_pendente   o aniversário do contrato já passou e a planilha seguiu
 *                        debitando o ciclo velho. Quem define o saldo novo é o
 *                        chefe, na renovação.
 *   ilegivel             #VALUE! na célula. Ignorado, nunca convertido para zero.
 *
 * Nesses casos o contrato é criado SEM lançamento de abertura: o saldo fica em
 * branco para o coordenador digitar na tela. É de propósito — chutar um número
 * aqui é pior do que deixar o campo vazio.
 *
 * Sem --apply é dry-run: não toca no banco, só escreve
 * docs/saldo-contrato/backfill-report.md.
 *
 * Com --apply grava contracts + contract_ledger para os médicos que casaram por
 * nome normalizado com operations_v2.doctors. Os não casados NUNCA são criados
 * nem adivinhados.
 *
 * Fuzzy match existe, mas só como SUGESTÃO (decisão do usuário em 2026-07-31,
 * revisando o SPEC §9.5): quem não casa exato ganha os três candidatos mais
 * próximos e a similaridade de cada um, no relatório. Nada disso vira vínculo
 * sozinho. Para valer, o par tem que ser escrito à mão em
 * docs/saldo-contrato/name-aliases.json — que é lido no começo da execução e
 * fica versionado, auditável e reversível.
 *
 * Médico cadastrado no app que não aparece na planilha também NÃO ganha contrato
 * inventado aqui: sem nº de contrato e sem data de admissão, qualquer janela de
 * ciclo seria chute. Ele entra na lista "médicos sem contrato" do relatório e
 * aparece na tela com o saldo em branco, para o admin preencher numa sentada.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import { getDb, hasDatabaseUrl } from "@/db";
import { contractLedger, contracts, doctors } from "@/db/schema";

const HEADER_ROW = 9;
const COLUMN = {
    name: 1, weeklyHours: 2, openingBalance: 3, company: 4, contractNumber: 5, admission: 6,
    total: 43, closingBalance: 45,
} as const;

/** Janeiro fica de fora: 109 das 130 linhas têm #VALUE! (SPEC §9.4). */
const MONTHS = [
    { label: "FEVEREIRO", key: "2026-02", lastDay: "2026-02-28" },
    { label: "MARÇO", key: "2026-03", lastDay: "2026-03-31" },
    { label: "ABRIL", key: "2026-04", lastDay: "2026-04-30" },
    { label: "MAIO", key: "2026-05", lastDay: "2026-05-31" },
] as const;

/** O saldo importado é o do fim deste mês. */
const SEED_MONTH = MONTHS[MONTHS.length - 1];
const TOLERANCE = 0.05;

/** Tetos habituais por CH/categoria (SPEC §3.3). Só pré-preenchem o cadastro. */
const REFERENCE_CEILINGS: Record<string, { generalista: number; especialista: number }> = {
    "12": { generalista: 82866, especialista: 87429 },
    "24": { generalista: 165732, especialista: 174858 },
    "36": { generalista: 248598, especialista: 262287 },
    "48": { generalista: 331464, especialista: 349716 },
};

type Category = "generalista" | "especialista" | "psiquiatria";

// --------------------------------------------------------------------------
// Leitura da planilha
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

/**
 * Normalização de nome (SPEC §9.5): única chave de junção entre as abas, e vem
 * suja — espaço duplo, sufixo "+ UPA", "(PSIQUIATRIA)", "(-12h)", acento
 * inconsistente. Mesma regra dos dois lados da comparação.
 */
export function normalizeDoctorName(raw: string): string {
    return raw
        .normalize("NFD").replace(/[̀-ͯ]/g, "")
        .toUpperCase()
        .replace(/\([^)]*\)/g, " ")
        .replace(/\+.*$/, " ")
        .replace(/[^A-Z\s']/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/** Bigramas para o coeficiente de Dice. Nome curto demais vira o próprio token. */
function bigrams(value: string): string[] {
    const clean = value.replace(/\s+/g, " ");
    if (clean.length < 2) return [clean];
    return Array.from({ length: clean.length - 1 }, (_, index) => clean.slice(index, index + 2));
}

/** Dice: 0 = nada em comum, 1 = idêntico. Tolera troca de letra e inversão. */
export function nameSimilarity(left: string, right: string): number {
    if (left === right) return 1;
    const a = bigrams(left);
    const b = new Map<string, number>();
    for (const gram of bigrams(right)) b.set(gram, (b.get(gram) ?? 0) + 1);
    let hits = 0;
    for (const gram of a) {
        const count = b.get(gram) ?? 0;
        if (count > 0) { hits++; b.set(gram, count - 1); }
    }
    return (2 * hits) / (a.length + bigrams(right).length);
}

/**
 * Candidatos mais prováveis para um nome que não casou exato. É SUGESTÃO: quem
 * decide é o humano, escrevendo o par em name-aliases.json.
 */
export function suggestMatches(
    target: string,
    candidates: { id: string; normalized: string; fullName: string }[],
    limit = 3,
): { fullName: string; normalized: string; score: number }[] {
    return candidates
        .map((candidate) => ({
            fullName: candidate.fullName,
            normalized: candidate.normalized,
            score: nameSimilarity(target, candidate.normalized),
        }))
        .sort((left, right) => right.score - left.score)
        .slice(0, limit);
}

function resolveCategory(sheetName: string, rawName: string): Category {
    if (/psiq/i.test(rawName)) return "psiquiatria";
    return /ESPECIALISTAS/i.test(sheetName) ? "especialista" : "generalista";
}

/** "24h" -> 24. */
function parseWeeklyHours(raw: string): number | null {
    const match = raw.match(/(\d{1,3})/);
    return match ? Number(match[1]) : null;
}

/** Célula Date é lida como UTC; texto pode trazer uma ou duas datas. */
function parseAdmissionDates(value: Cell): string[] {
    if (value instanceof Date) {
        const year = value.getUTCFullYear();
        const month = String(value.getUTCMonth() + 1).padStart(2, "0");
        const day = String(value.getUTCDate()).padStart(2, "0");
        return [`${year}-${month}-${day}`];
    }
    return [...cellText(value).matchAll(/(\d{2})[/-](\d{2})[/-](\d{4})/g)].map((m) => `${m[3]}-${m[2]}-${m[1]}`);
}

interface SheetRow {
    rawName: string;
    normalized: string;
    category: Category;
    weeklyHours: number | null;
    company: string;
    contractNumbers: string[];
    admissions: string[];
    openingBalance: number | null;
    closingBalance: number | null;
    total: number | null;
}

function readSheet(sheet: ExcelJS.Worksheet): SheetRow[] {
    const rows: SheetRow[] = [];
    for (let index = HEADER_ROW + 1; index <= sheet.rowCount; index++) {
        const row = sheet.getRow(index);
        const rawName = cellText(row.getCell(COLUMN.name).value).trim();
        const normalized = normalizeDoctorName(rawName);
        if (normalized.length < 5 || !normalized.includes(" ")) continue;
        rows.push({
            rawName,
            normalized,
            category: resolveCategory(sheet.name, rawName),
            weeklyHours: parseWeeklyHours(cellText(row.getCell(COLUMN.weeklyHours).value)),
            company: cellText(row.getCell(COLUMN.company).value).trim(),
            // "471/2024  455/2025" = dois contratos. Só espaço duplo separa.
            contractNumbers: cellText(row.getCell(COLUMN.contractNumber).value)
                .trim().split(/\s{2,}|\s*[,;]\s*/).map((part) => part.trim()).filter(Boolean),
            admissions: parseAdmissionDates(row.getCell(COLUMN.admission).value),
            openingBalance: cellNumber(row.getCell(COLUMN.openingBalance).value),
            closingBalance: cellNumber(row.getCell(COLUMN.closingBalance).value),
            total: cellNumber(row.getCell(COLUMN.total).value),
        });
    }
    return rows;
}

// --------------------------------------------------------------------------
// Ciclo
// --------------------------------------------------------------------------

/**
 * Início do ciclo: dia 1 do mês da admissão.
 *
 * O dia da admissão NÃO importa. Confirmado por Caio em 2026-07-31 e verificado
 * contra a planilha: em 56 dos 63 resets limpos da série 2025–2026 a virada cai
 * no mesmo mês da admissão, com o teto integral já no dia 1. Quem é admitido em
 * 26 de dezembro queima o saldo velho até 30 de novembro e recebe o teto novo em
 * 1º de dezembro.
 *
 * Efeito colateral bom: como o ciclo sempre começa no dia 1, o caso do
 * aniversário em 29/02 simplesmente não existe.
 */
export function cycleWindowFor(admission: string, asOf: string): { start: string; end: string } {
    const [admYear, admMonth] = admission.split("-").map(Number);
    const [asOfYear, asOfMonth] = asOf.split("-").map(Number);

    // Último aniversário do mês de admissão que já começou.
    let year = asOfYear;
    if (admMonth > asOfMonth) year -= 1;
    if (year < admYear) year = admYear;

    const start = `${year}-${String(admMonth).padStart(2, "0")}-01`;
    const end = `${year + 1}-${String(admMonth).padStart(2, "0")}-01`;
    return { start, end };
}

function round2(value: number): number {
    return Number(value.toFixed(2));
}

// --------------------------------------------------------------------------
// Plano por contrato
// --------------------------------------------------------------------------

type SeedStatus =
    | "importado"           // o saldo de maio serve como abertura
    | "teto_nao_carregado"  // planilha abriu em zero: o número é consumo, não saldo
    | "renovacao_pendente"  // aniversário passou e a planilha não resetou
    | "ilegivel"            // #VALUE! na célula de maio
    | "sem_ciclo";          // DATA ADMISSÃO ausente: sem janela para projetar

interface ContractPlan {
    rawName: string;
    normalized: string;
    contractNumber: string;
    company: string;
    category: Category;
    weeklyHours: number | null;
    ceiling: number | null;
    cycle: { start: string; end: string } | null;
    seedBalance: number | null;
    status: SeedStatus;
    notes: string[];
}

function buildContractPlan(
    normalized: string,
    contractNumber: string,
    monthRows: Map<string, SheetRow>,
): ContractPlan {
    const ordered = MONTHS.map((month) => ({ month, row: monthRows.get(month.key) })).filter((item) => item.row);
    const reference = ordered.at(-1)!.row!;
    const notes: string[] = [];

    const anniversary = reference.admissions.at(-1) ?? null;
    const hoursKey = String(reference.weeklyHours ?? "");
    const ceiling = reference.category === "psiquiatria"
        ? REFERENCE_CEILINGS[hoursKey]?.generalista ?? null
        : REFERENCE_CEILINGS[hoursKey]?.[reference.category] ?? null;
    if (ceiling == null) {
        notes.push(`CH "${reference.weeklyHours ?? "?"}" fora da tabela de referência — teto fica em branco para o coordenador preencher`);
    }

    const plan: ContractPlan = {
        rawName: reference.rawName,
        normalized,
        contractNumber,
        company: reference.company,
        category: reference.category,
        weeklyHours: reference.weeklyHours,
        ceiling,
        cycle: null,
        seedBalance: null,
        status: "importado",
        notes,
    };

    if (!anniversary) {
        plan.status = "sem_ciclo";
        notes.push("sem DATA ADMISSÃO parseável — o coordenador precisa informar a janela do ciclo");
        return plan;
    }
    if (anniversary > SEED_MONTH.lastDay) {
        notes.push(`DATA ADMISSÃO no futuro (${anniversary}) — provável erro de digitação na planilha`);
    }
    plan.cycle = cycleWindowFor(anniversary, SEED_MONTH.lastDay);

    const seedRow = monthRows.get(SEED_MONTH.key);
    if (!seedRow || seedRow.closingBalance == null) {
        plan.status = "ilegivel";
        notes.push(`sem SALDO CONTRATO legível em ${SEED_MONTH.label}/2026 — saldo em branco`);
        return plan;
    }
    plan.seedBalance = round2(seedRow.closingBalance);

    // A planilha abriu este contrato em R$ 0,00 e foi acumulando negativo: o
    // número dela é consumo, não saldo. É o caso de Gabriel Vitor e João Pedro
    // Miguez, que o SPEC §1 lista como estourados — não estão.
    const firstLegible = ordered.find(({ row }) => row!.openingBalance != null)?.row ?? null;
    if (firstLegible && Math.abs(firstLegible.openingBalance!) <= TOLERANCE && (firstLegible.total ?? 0) > 0) {
        plan.status = "teto_nao_carregado";
        notes.push(`a planilha abre este contrato em R$ 0,00 e acumula o consumo com sinal negativo: ${plan.seedBalance.toFixed(2)} é consumo, não saldo. NÃO é estouro.`);
        return plan;
    }

    // O aniversário caiu dentro dos meses lidos e a planilha não resetou o saldo:
    // ela segue no ciclo velho. Quem define o saldo do ciclo novo é o chefe.
    const renewedInWindow = plan.cycle.start >= MONTHS[0].lastDay;
    const sawReset = ordered.some(({ row }, index) => index > 0
        && row!.openingBalance != null
        && ordered[index - 1].row!.closingBalance != null
        && row!.openingBalance! > ordered[index - 1].row!.closingBalance! + TOLERANCE);
    if (renewedInWindow && !sawReset) {
        plan.status = "renovacao_pendente";
        notes.push(`o ciclo virou em ${plan.cycle.start} e a planilha seguiu debitando o ciclo anterior (${plan.seedBalance.toFixed(2)}) — o chefe define o saldo do ciclo novo`);
        return plan;
    }

    if (plan.seedBalance < 0) {
        notes.push(`saldo negativo de verdade em ${SEED_MONTH.label}: ${plan.seedBalance.toFixed(2)} — encadeamento consistente nos meses lidos`);
    }
    return plan;
}

interface UnmatchedName {
    rawName: string;
    normalized: string;
    contractNumber: string;
    suggestions: { fullName: string; normalized: string; score: number }[];
    /** Alias escrito no arquivo que não achou médico nenhum — erro de digitação no próprio alias. */
    aliasMissTarget: string | null;
}

const ALIASES_PATH = "docs/saldo-contrato/name-aliases.json";
const aliasesUsed: string[] = [];

/**
 * { "<nome como está na planilha>": "<nome como está em doctors>" }
 * Os dois lados passam pela mesma normalização, então pode escrever como quiser.
 */
async function loadNameAliases(): Promise<Map<string, string>> {
    try {
        const raw = await readFile(path.resolve(process.cwd(), ALIASES_PATH), "utf8");
        const parsed = JSON.parse(raw) as Record<string, string>;
        // Chaves com "_" são comentário do próprio arquivo, não vínculo.
        return new Map(Object.entries(parsed)
            .filter(([from]) => !from.startsWith("_"))
            .map(([from, to]) => [normalizeDoctorName(from), to]));
    } catch {
        return new Map();
    }
}

// --------------------------------------------------------------------------
// Relatório
// --------------------------------------------------------------------------

function formatBrl(value: number | null): string {
    return value == null ? "—" : value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function buildReport(params: {
    plans: ContractPlan[];
    matched: Map<string, string>;
    unmatched: UnmatchedName[];
    doctorsWithoutContract: string[];
    applied: boolean;
    sourceFile: string;
}): string {
    const { plans, matched, unmatched, doctorsWithoutContract, applied, sourceFile } = params;
    const by = (status: SeedStatus) => plans.filter((plan) => plan.status === status);
    const imported = by("importado");
    const lines: string[] = [];

    lines.push("# Backfill do saldo contratual — relatório");
    lines.push("");
    lines.push(`- Origem: \`${path.basename(sourceFile)}\``);
    lines.push(`- Modo: ${applied ? "**--apply** (gravou no banco)" : "dry-run (não tocou no banco)"}`);
    lines.push(`- Importa **um número por contrato**: a coluna \`SALDO CONTRATO\` de ${SEED_MONTH.label}/2026. De junho em diante o consumo vem do fechamento assinado no próprio sistema.`);
    lines.push(`- Contratos encontrados: **${plans.length}**`);
    lines.push(`- Saldo de abertura importado: **${imported.length}**`);
    lines.push(`- Saldo em branco para o coordenador digitar: **${plans.length - imported.length}** — renovação pendente ${by("renovacao_pendente").length} · teto não carregado ${by("teto_nao_carregado").length} · célula ilegível ${by("ilegivel").length} · sem ciclo ${by("sem_ciclo").length}`);
    lines.push(`- Casados com \`operations_v2.doctors\`: **${matched.size}** · não casados: **${unmatched.length}**`);
    lines.push("");

    lines.push("## Saldo em branco — o coordenador precisa digitar");
    lines.push("");
    lines.push("O contrato é criado sem lançamento de abertura. Chutar um número aqui seria pior que deixar o campo vazio.");
    lines.push('A coluna "planilha mostra" está aqui só como referência do que **não** foi importado, e por quê.');
    lines.push("");
    const pending = plans.filter((plan) => plan.status !== "importado");
    if (pending.length === 0) {
        lines.push("Nenhum.");
    } else {
        const reasons: Record<SeedStatus, string> = {
            importado: "",
            renovacao_pendente: "ciclo virou e a planilha não resetou",
            teto_nao_carregado: "planilha abriu em R$ 0,00: o número é consumo",
            ilegivel: "`#VALUE!` na célula de maio",
            sem_ciclo: "sem DATA ADMISSÃO",
        };
        lines.push("| Médico | Contrato | Motivo | Planilha mostra |");
        lines.push("|---|---|---|---:|");
        for (const plan of pending) {
            lines.push(`| ${plan.rawName} | ${plan.contractNumber} | ${reasons[plan.status]} | ${formatBrl(plan.seedBalance)} |`);
        }
    }
    lines.push("");

    lines.push("## Saldos negativos importados — estouro real");
    lines.push("");
    const negative = imported.filter((plan) => (plan.seedBalance ?? 0) < 0).sort((a, b) => a.seedBalance! - b.seedBalance!);
    if (negative.length === 0) {
        lines.push("Nenhum.");
    } else {
        lines.push("Encadeamento consistente nos meses lidos: o saldo negativo é real, não artefato da planilha.");
        lines.push("");
        lines.push("| Médico | Contrato | Saldo em maio |");
        lines.push("|---|---|---:|");
        for (const plan of negative) lines.push(`| ${plan.rawName} | ${plan.contractNumber} | ${formatBrl(plan.seedBalance)} |`);
    }
    lines.push("");

    lines.push("## Nomes que não casaram — sugestões para você validar");
    lines.push("");
    if (unmatched.length === 0) {
        lines.push("Todos os nomes da planilha casaram com um médico cadastrado.");
    } else {
        lines.push("Nenhum vínculo foi criado a partir daqui. A coluna **similaridade** é coeficiente de Dice sobre bigramas:");
        lines.push("1,00 é idêntico. Para aprovar um par, escreva-o em `" + ALIASES_PATH + "` e rode de novo:");
        lines.push("");
        lines.push("```json");
        lines.push('{ "NOME COMO ESTÁ NA PLANILHA": "NOME COMO ESTÁ EM doctors" }');
        lines.push("```");
        lines.push("");
        lines.push("| Planilha | Contrato | Candidato no app | Similaridade |");
        lines.push("|---|---|---|---:|");
        for (const item of unmatched) {
            if (item.suggestions.length === 0) {
                lines.push(`| ${item.rawName} | ${item.contractNumber} | _sem candidato_ | — |`);
                continue;
            }
            item.suggestions.forEach((suggestion, index) => {
                lines.push(`| ${index === 0 ? item.rawName : ""} | ${index === 0 ? item.contractNumber : ""} | ${suggestion.fullName} | ${suggestion.score.toFixed(2)} |`);
            });
        }
        const brokenAliases = unmatched.filter((item) => item.aliasMissTarget);
        if (brokenAliases.length > 0) {
            lines.push("");
            lines.push("**Aliases apontando para médico inexistente** (erro de digitação no próprio arquivo):");
            lines.push("");
            for (const item of brokenAliases) lines.push(`- \`${item.rawName}\` -> \`${item.aliasMissTarget}\``);
        }
    }
    lines.push("");

    if (aliasesUsed.length > 0) {
        lines.push("## Aliases aplicados");
        lines.push("");
        lines.push(`Vínculos aprovados à mão em \`${ALIASES_PATH}\` — **${aliasesUsed.length}**:`);
        lines.push("");
        for (const entry of aliasesUsed) lines.push(`- ${entry}`);
        lines.push("");
    }

    lines.push("## Médicos do app sem contrato — saldo em branco na tela");
    lines.push("");
    lines.push("Ativos em `operations_v2.doctors` que a planilha de maio não cobre (contratados depois, em geral).");
    lines.push("**Nenhum contrato foi inventado para eles**: sem nº de contrato e sem data de admissão, a janela do");
    lines.push("ciclo seria chute. Aparecem na tela com o saldo em branco e destacado, para o admin preencher.");
    lines.push("");
    if (doctorsWithoutContract.length === 0) {
        lines.push("Nenhum — todo médico ativo tem contrato.");
    } else {
        lines.push(`Total: **${doctorsWithoutContract.length}**`);
        lines.push("");
        for (const name of doctorsWithoutContract) lines.push(`- ${name}`);
    }
    lines.push("");

    lines.push("## Achados por contrato");
    lines.push("");
    const withNotes = plans.filter((plan) => plan.notes.length > 0);
    if (withNotes.length === 0) {
        lines.push("Nenhum.");
    } else {
        for (const plan of withNotes) {
            lines.push(`### ${plan.rawName} — contrato ${plan.contractNumber}`);
            lines.push("");
            lines.push(`Ciclo: ${plan.cycle ? `${plan.cycle.start} → ${plan.cycle.end}` : "indeterminado"} · teto ${formatBrl(plan.ceiling)}`);
            lines.push("");
            for (const note of plan.notes) lines.push(`- ${note}`);
            lines.push("");
        }
    }

    return lines.join("\n");
}

// --------------------------------------------------------------------------
// Escrita
// --------------------------------------------------------------------------

async function applyPlans(plans: ContractPlan[], matched: Map<string, string>): Promise<number> {
    const db = getDb();
    let written = 0;

    for (const plan of plans) {
        const doctorId = matched.get(plan.normalized);
        if (!doctorId || !plan.cycle) continue;
        const cycle = plan.cycle;

        await db.transaction(async (tx) => {
            const [contract] = await tx.insert(contracts).values({
                doctorId,
                contractNumber: plan.contractNumber,
                companyName: plan.company || null,
                category: plan.category,
                weeklyHours: plan.weeklyHours == null ? null : String(plan.weeklyHours),
                ceilingAmount: plan.ceiling == null ? null : plan.ceiling.toFixed(2),
                cycleStart: cycle.start,
                cycleEnd: cycle.end,
                startedAt: cycle.start,
                notes: `Importado da planilha 2026 CHAMAMENTO 004 (saldo de ${SEED_MONTH.label}/2026)`,
            }).returning({ id: contracts.id });

            // Só quem tem saldo confiável ganha abertura. Os demais ficam com o
            // razão vazio de propósito, esperando o coordenador.
            if (plan.status === "importado" && plan.seedBalance != null) {
                await tx.insert(contractLedger).values({
                    contractId: contract.id,
                    entryDate: SEED_MONTH.lastDay,
                    type: "opening",
                    amount: plan.seedBalance.toFixed(2),
                    description: `Saldo de ${SEED_MONTH.label}/2026 importado da planilha`,
                });
            }
        });
        written++;
    }

    return written;
}

// --------------------------------------------------------------------------

async function main() {
    const args = process.argv.slice(2);
    const fileIndex = args.indexOf("--file");
    const sourceFile = fileIndex >= 0 ? args[fileIndex + 1] : "";
    const apply = args.includes("--apply");

    if (!sourceFile) {
        throw new Error('Uso: npm run saldo:backfill -- --file "<planilha.xlsx>" [--apply]');
    }
    await readFile(sourceFile);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(sourceFile);

    // "<nome normalizado>||<nº do contrato>" -> monthKey -> linha. A chave inclui
    // o contrato porque um médico pode aparecer duas vezes no mesmo mês, em abas
    // diferentes, com contratos diferentes (Leonardo Copque em maio: 247/2025
    // encerrado no negativo e 184/2026 recém-aberto).
    const perContract = new Map<string, Map<string, SheetRow>>();
    for (const month of MONTHS) {
        for (const sheet of workbook.worksheets.filter((ws) => ws.name.startsWith(`${month.label} 2026`))) {
            for (const row of readSheet(sheet)) {
                const key = `${row.normalized}||${row.contractNumbers[0] ?? "SEM NÚMERO"}`;
                if (!perContract.has(key)) perContract.set(key, new Map());
                perContract.get(key)!.set(month.key, row);
            }
        }
    }

    const plans = [...perContract.entries()]
        // Contrato que nem aparece no mês semente já foi substituído: não entra.
        .filter(([, monthRows]) => monthRows.has(SEED_MONTH.key))
        .map(([key, monthRows]) => {
            const [normalized, contractNumber] = key.split("||");
            return buildContractPlan(normalized, contractNumber, monthRows);
        })
        .sort((left, right) => left.rawName.localeCompare(right.rawName, "pt-BR"));

    // Pares aprovados à mão pelo usuário. Sem isso, nome que não casa exato não
    // vira vínculo — o fuzzy só sugere.
    const aliases = await loadNameAliases();

    const matched = new Map<string, string>();
    const unmatched: UnmatchedName[] = [];
    const doctorsWithoutContract: string[] = [];
    if (hasDatabaseUrl()) {
        const rows = await getDb()
            .select({ id: doctors.id, fullName: doctors.fullName, normalizedName: doctors.normalizedName, isActive: doctors.isActive })
            .from(doctors);
        const candidates = rows.map((row) => ({ id: row.id, fullName: row.fullName, normalized: normalizeDoctorName(row.normalizedName) }));
        const byNormalized = new Map(candidates.map((candidate) => [candidate.normalized, candidate.id]));
        for (const plan of plans) {
            const aliasTarget = aliases.get(plan.normalized);
            const id = byNormalized.get(plan.normalized)
                ?? (aliasTarget ? byNormalized.get(normalizeDoctorName(aliasTarget)) : undefined);
            if (id) {
                matched.set(plan.normalized, id);
                if (aliasTarget) aliasesUsed.push(`${plan.rawName} -> ${aliasTarget}`);
            } else {
                unmatched.push({
                    rawName: plan.rawName,
                    normalized: plan.normalized,
                    contractNumber: plan.contractNumber,
                    suggestions: suggestMatches(plan.normalized, candidates),
                    aliasMissTarget: aliasTarget ?? null,
                });
            }
        }
        // Médico ativo no app que a planilha não tem — contratado depois de maio,
        // na maioria. Fica sem contrato e com saldo em branco na tela.
        const covered = new Set(plans.filter((plan) => matched.has(plan.normalized)).map((plan) => plan.normalized));
        for (const row of rows) {
            if (!row.isActive) continue;
            if (!covered.has(normalizeDoctorName(row.normalizedName))) doctorsWithoutContract.push(row.fullName);
        }
        doctorsWithoutContract.sort((left, right) => left.localeCompare(right, "pt-BR"));
    } else {
        unmatched.push(...plans.map((plan) => ({
            rawName: plan.rawName, normalized: plan.normalized, contractNumber: plan.contractNumber,
            suggestions: [], aliasMissTarget: null,
        })));
    }

    let written = 0;
    if (apply) {
        if (!hasDatabaseUrl()) throw new Error("--apply exige DATABASE_URL.");
        // Grava o que casou. Os não casados não bloqueiam o resto: eles saem
        // nominalmente no relatório e o admin resolve na tela.
        written = await applyPlans(plans, matched);
    }

    const report = buildReport({ plans, matched, unmatched, doctorsWithoutContract, applied: apply, sourceFile });
    const reportPath = path.resolve(process.cwd(), "docs/saldo-contrato/backfill-report.md");
    await writeFile(reportPath, `${report}\n`, "utf8");

    const imported = plans.filter((plan) => plan.status === "importado").length;
    console.log(`contratos: ${plans.length} | saldo importado: ${imported} | em branco para o coordenador: ${plans.length - imported}`);
    console.log(`casados com doctors: ${matched.size} | para revisão manual: ${unmatched.length}`
        + ` | médicos do app sem contrato: ${doctorsWithoutContract.length}`);
    console.log(apply ? `contratos gravados: ${written}` : "dry-run: nada gravado");
    process.exit(0);
}

// Só roda quando chamado pela CLI; os testes importam as funções puras daqui.
if (process.argv[1]?.includes("backfill-saldo-contrato")) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    });
}
