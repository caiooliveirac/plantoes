/**
 * Relatório de divergência da sombra ADR-007 R4 (desfecho por turno x régua
 * atual por pedaço) num período. É o insumo da decisão de virada da R4.
 *
 * SOMENTE LEITURA: a sessão abre com default_transaction_read_only=on — um
 * INSERT/UPDATE acidental falha no Postgres. A sombra não persiste nada, então
 * o relatório remonta o fechamento do período (mesmos loaders e núcleo do
 * /admin/payment-closing) e lê as divergências que a sombra anexou às linhas.
 *
 * Uso (datas operacionais, SD 07:00 do primeiro dia até o SN do último):
 *   tsx scripts/relatorio-sombra-turno.ts --de 2026-09-15 --ate 2026-10-14
 *   tsx scripts/relatorio-sombra-turno.ts --de 2026-09-15 --ate 2026-10-14 --exemplos 30
 *
 * Saída markdown no stdout. A própria sombra loga `[turno-sombra]` via
 * console.warn a cada linha divergente: redirecione o stderr (2>/dev/null)
 * para ficar só com o relatório.
 */
import { closeDb } from "@/db";
import { buildPayableShiftsFromBoards } from "@/modules/reporting/payable-shifts";
import { buildTurnoShadowReport, renderTurnoShadowReportMarkdown } from "@/modules/reporting/turno-shadow-report";

/** Acrescenta default_transaction_read_only=on às options da connection string. */
export function withReadOnlySession(databaseUrl: string): string {
    const url = new URL(databaseUrl);
    const options = url.searchParams.get("options");
    url.searchParams.set("options", `${options ? `${options} ` : ""}-c default_transaction_read_only=on`);
    return url.toString();
}

function arg(name: string): string | null {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function addDays(isoDay: string, days: number): string {
    const date = new Date(`${isoDay}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}

async function main() {
    const from = arg("--de");
    const to = arg("--ate");
    const maxExamples = Number(arg("--exemplos") ?? 15);
    if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) {
        throw new Error("Uso: tsx scripts/relatorio-sombra-turno.ts --de AAAA-MM-DD --ate AAAA-MM-DD [--exemplos N]");
    }
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL é obrigatória.");
    // Antes do primeiro getDb(): o pool nasce read-only.
    process.env.DATABASE_URL = withReadOnlySession(process.env.DATABASE_URL);

    // Import tardio: o service só abre conexão quando chamado, mas assim fica
    // explícito que nada toca o banco antes da troca acima.
    const { getPayableAllocationBoardsForRange, loadDoctorPaymentSettings } = await import("@/services/payable-shifts.service");

    // Slot SD começa 07:00 em São Paulo (10:00 UTC); o intervalo é [SD do
    // primeiro dia, SD do dia seguinte ao último).
    const rangeStart = new Date(`${from}T10:00:00.000Z`);
    const rangeEnd = new Date(`${addDays(to, 1)}T10:00:00.000Z`);
    const [{ boards }, settings] = await Promise.all([
        getPayableAllocationBoardsForRange(rangeStart, rangeEnd),
        loadDoctorPaymentSettings(),
    ]);
    const report = buildTurnoShadowReport(buildPayableShiftsFromBoards(boards), settings);
    process.stdout.write(`${renderTurnoShadowReportMarkdown(report, { from, to, maxExamples })}\n`);
}

// Só roda como CLI; o teste importa withReadOnlySession.
if (process.argv[1]?.endsWith("relatorio-sombra-turno.ts")) {
    main()
        .catch((error) => {
            console.error(error instanceof Error ? error.message : error);
            process.exitCode = 1;
        })
        .finally(() => closeDb());
}
