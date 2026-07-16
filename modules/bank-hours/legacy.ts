// Saldos legados do banco de horas — planilha da coordenação digitalizada e
// auditada em jul/2026. Cada plantonista carrega duas parcelas imutáveis:
//   preMay2025Minutes        -> saldo acumulado até 30/abr/2025
//   spreadsheetPeriodMinutes -> saldo apurado pela planilha mai/2025 -> mai/2026
// A partir do corte quem apura é a aplicação; estes valores nunca mudam.

export const LEGACY_BANK_HOURS_SOURCE = "Planilha Banco de Horas 2026 — coordenação, importada em jul/2026";

export const LEGACY_BANK_HOURS_EXPECTED_ROW_COUNT = 149;
export const LEGACY_BANK_HOURS_EXPECTED_NET_TOTAL_MINUTES = -36946;

// A planilha trabalha em passos de 5 minutos. Valores fora dessa granularidade
// só passam se estiverem nesta lista (conferidos manualmente pela coordenação).
export const LEGACY_BANK_HOURS_GRANULARITY_EXCEPTIONS = new Set(["FRED ANDERSON"]);

export interface LegacyBankHoursRow {
    spreadsheetName: string;
    preMay2025Minutes: number;
    spreadsheetPeriodMinutes: number;
    totalMinutes: number;
}

const SIGNED_HOURS_PATTERN = /^([+-]?)(\d+):([0-5]\d)$/;

/**
 * Converte "±H:MM" em minutos inteiros assinados. O sinal vale para o valor
 * inteiro, inclusive quando as horas são zero ("-0:55" => -55).
 */
export function parseSignedHoursToMinutes(value: string): number {
    const match = value.trim().match(SIGNED_HOURS_PATTERN);
    if (!match) {
        throw new Error(`Valor de horas inválido: "${value}" (esperado ±H:MM).`);
    }

    const minutes = Number(match[2]) * 60 + Number(match[3]);
    return match[1] === "-" ? -minutes : minutes;
}

export function parseLegacyBankHoursCsv(csv: string): LegacyBankHoursRow[] {
    const lines = csv
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

    if (lines.length === 0) {
        throw new Error("CSV vazio.");
    }

    const header = lines[0];
    if (header !== "nome,saldo_pre_maio_2025,saldo_corrente_planilha,saldo_inicial_total") {
        throw new Error(`Cabeçalho inesperado no CSV: "${header}".`);
    }

    const rows: LegacyBankHoursRow[] = [];
    const seenNames = new Set<string>();

    for (const line of lines.slice(1)) {
        const parts = line.split(",");
        if (parts.length !== 4) {
            throw new Error(`Linha com número de colunas inesperado: "${line}".`);
        }

        const spreadsheetName = parts[0].trim();
        if (!spreadsheetName) {
            throw new Error(`Linha sem nome: "${line}".`);
        }
        if (seenNames.has(spreadsheetName)) {
            throw new Error(`Nome duplicado na planilha: "${spreadsheetName}".`);
        }
        seenNames.add(spreadsheetName);

        const preMay2025Minutes = parseSignedHoursToMinutes(parts[1]);
        const spreadsheetPeriodMinutes = parseSignedHoursToMinutes(parts[2]);
        const totalMinutes = parseSignedHoursToMinutes(parts[3]);

        if (preMay2025Minutes + spreadsheetPeriodMinutes !== totalMinutes) {
            throw new Error(
                `Soma divergente para "${spreadsheetName}": ${preMay2025Minutes} + ${spreadsheetPeriodMinutes} != ${totalMinutes}.`,
            );
        }

        if (!LEGACY_BANK_HOURS_GRANULARITY_EXCEPTIONS.has(spreadsheetName)) {
            for (const [label, minutes] of [
                ["saldo_pre_maio_2025", preMay2025Minutes],
                ["saldo_corrente_planilha", spreadsheetPeriodMinutes],
            ] as const) {
                if (minutes % 5 !== 0) {
                    throw new Error(
                        `"${spreadsheetName}" tem ${label} = ${minutes} min fora da granularidade de 5 min e não está na lista de exceções.`,
                    );
                }
            }
        }

        rows.push({ spreadsheetName, preMay2025Minutes, spreadsheetPeriodMinutes, totalMinutes });
    }

    return rows;
}

/** Confere o dataset inteiro contra os totais auditados; lança se divergir. */
export function validateLegacyBankHoursDataset(rows: LegacyBankHoursRow[]): void {
    if (rows.length !== LEGACY_BANK_HOURS_EXPECTED_ROW_COUNT) {
        throw new Error(
            `Esperava ${LEGACY_BANK_HOURS_EXPECTED_ROW_COUNT} plantonistas na planilha, encontrei ${rows.length}.`,
        );
    }

    const netTotal = rows.reduce((sum, row) => sum + row.totalMinutes, 0);
    if (netTotal !== LEGACY_BANK_HOURS_EXPECTED_NET_TOTAL_MINUTES) {
        throw new Error(
            `Soma líquida esperada era ${LEGACY_BANK_HOURS_EXPECTED_NET_TOTAL_MINUTES} min, encontrei ${netTotal} min.`,
        );
    }
}
