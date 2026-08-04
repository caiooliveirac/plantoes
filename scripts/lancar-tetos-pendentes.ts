/**
 * Lançamento do teto e do consumo dos contratos que ficaram sem saldo de abertura.
 *
 *   npx tsx scripts/lancar-tetos-pendentes.ts [--apply] [--permitir-ciclo-assumido]
 *
 * O problema (dossiê docs/saldo-contrato/03-validacao-alertas-08-2026.md): sete
 * contratos nunca tiveram teto lançado na planilha. A coluna SALDO CONTRATO
 * deles nasce VAZIA e passa a acumular o consumo com sinal trocado — o
 * "−25.277,89" de João Miguez é o que ele produziu, não um estouro. O backfill
 * deixou o saldo em branco (certo), mas o alerta das 08:00 anuncia esses
 * contratos como "saldo zerado" assim que o médico bate o primeiro plantão,
 * porque `awaitingOpeningBalance` exige consumo zero.
 *
 * Este script fecha o buraco pela raiz: lança o teto de referência e o consumo
 * já ocorrido, de modo que o saldo passe a existir e a ser correto.
 *
 * Para cada contrato, dentro de UMA transação:
 *
 *   1. grava `ceiling_amount` (se estiver vazio ou diferente do de referência);
 *   2. lança um `opening` com o TETO INTEGRAL na data de início do ciclo;
 *   3. lança um `invoice` por mês de consumo já ocorrido até 31/05/2026, com os
 *      plantões de semana/fim de semana da planilha.
 *
 * Saldo resultante = teto − Σ invoices. De junho em diante quem desconta é o
 * fechamento assinado no próprio sistema, pelo caminho normal.
 *
 * Leonardo Copque (184/2026) é a exceção: a cadeia da planilha está íntegra, e
 * ele entra pelo mesmo caminho dos outros 117 contratos — uma abertura em 31/05
 * com o saldo de fechamento do mês (campo `seedClosingBrl`). O que ele precisava
 * era do teto certo: 349.716,00 (48h especialista), não os 174.858,00 que o
 * backfill deduziu lendo a coluna CH como 24h.
 *
 * IDONEIDADE (nada entra sem fechar as contas):
 *   - aritmética:  |teto − Σ meses − saldo esperado| ≤ R$ 0,05;
 *   - premissa:    o contrato NÃO pode já ter um lançamento `opening` — se tem,
 *                  o saldo não estava em branco e este script não é o dono dele;
 *   - ciclo:       `cycle_start` no banco tem que ser o esperado no JSON, e todo
 *                  mês de consumo tem que cair dentro do ciclo;
 *   - duplicidade: mês que já tem invoice de `spreadsheet_import` fica de fora;
 *   - sinal:       saldo resultante tem que ser > 0 (contrato recém-sem-teto que
 *                  já nasce negativo é sinal de que o consumo está errado).
 *
 * Thiago Borghi não tem DATA ADMISSÃO nem número de contrato na planilha: o
 * ciclo dele é ASSUMIDO a partir da primeira aparição (abril/2026) e só é
 * tocado com --permitir-ciclo-assumido.
 *
 * Sem --apply é dry-run: imprime a tabela e não escreve nada.
 * Rodar duas vezes não duplica: contrato com `opening` já lançado é pulado.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";

import { getDb, hasDatabaseUrl } from "@/db";
import { contractLedger, contracts, doctors } from "@/db/schema";
import { normalizeDoctorName } from "@/scripts/backfill-saldo-contrato";
import { isMonthWithinCycle } from "@/lib/contracts/statement";

const DATA_PATH = "docs/saldo-contrato/tetos-pendentes.json";
const IMPORT_SOURCE_TYPE = "spreadsheet_import";
const MAY_LAST_DAY = "2026-05-31";
export const TOLERANCE = 0.05;

export interface MesConsumo {
    month: string;
    amountBrl: number;
    weekdayShifts: number;
    weekendShifts: number;
}

export interface ContratoPendente {
    doctorName: string;
    contractNumber: string;
    weeklyHours: number;
    category: "generalista" | "especialista" | "psiquiatria";
    ceilingBrl: number;
    expectedCycleStart: string;
    cycleStartIsAssumed?: boolean;
    months: MesConsumo[];
    /** Só para quem entra pelo caminho da semente de 31/05 (cadeia íntegra). */
    seedClosingBrl?: number;
    expectedBalanceBrl: number;
    nota?: string;
}

export interface Encerramento {
    doctorName: string;
    contractNumber: string;
    endedAt: string;
    supersededBy: string;
    nota?: string;
}

export type PlanoStatus =
    | "lancar"
    | "ja_lancado"
    | "sem_contrato"
    | "ciclo_divergente"
    | "ciclo_assumido_bloqueado"
    | "aritmetica_nao_fecha"
    | "mes_fora_do_ciclo"
    | "saldo_negativo";

export interface Plano {
    status: PlanoStatus;
    detalhe: string;
}

/**
 * Decisão pura, testável — é a parte que não pode errar: daqui saem os números
 * que viram dinheiro na tela do chefe.
 */
export function planejar(
    contrato: ContratoPendente,
    atual: { cycleStart: string; cycleEnd: string; status: string; temOpening: boolean } | null,
    permitirCicloAssumido: boolean,
): Plano {
    if (!atual) return { status: "sem_contrato", detalhe: "nenhum contrato ativo com este número para este médico" };
    if (atual.status !== "active") {
        return { status: "sem_contrato", detalhe: `contrato com status "${atual.status}", não "active"` };
    }
    if (atual.temOpening) {
        return { status: "ja_lancado", detalhe: "o contrato já tem lançamento de abertura no razão — nada a fazer" };
    }
    if (contrato.cycleStartIsAssumed && !permitirCicloAssumido) {
        return {
            status: "ciclo_assumido_bloqueado",
            detalhe: `ciclo ${contrato.expectedCycleStart} é assumido (sem DATA ADMISSÃO na planilha)`
                + " — rode com --permitir-ciclo-assumido para incluir",
        };
    }
    if (atual.cycleStart !== contrato.expectedCycleStart) {
        return {
            status: "ciclo_divergente",
            detalhe: `banco tem cycle_start ${atual.cycleStart}, JSON espera ${contrato.expectedCycleStart}`,
        };
    }

    const consumo = contrato.months.reduce((soma, mes) => soma + mes.amountBrl, 0);
    const saldo = contrato.seedClosingBrl ?? contrato.ceilingBrl - consumo;

    if (Math.abs(saldo - contrato.expectedBalanceBrl) > TOLERANCE) {
        return {
            status: "aritmetica_nao_fecha",
            detalhe: `teto ${contrato.ceilingBrl.toFixed(2)} − consumo ${consumo.toFixed(2)}`
                + ` = ${saldo.toFixed(2)}, mas o JSON espera ${contrato.expectedBalanceBrl.toFixed(2)}`,
        };
    }
    if (saldo <= 0) {
        return { status: "saldo_negativo", detalhe: `saldo resultante ${saldo.toFixed(2)} não é positivo` };
    }
    for (const mes of contrato.months) {
        if (!isMonthWithinCycle(mes.month, atual.cycleStart, atual.cycleEnd)) {
            return {
                status: "mes_fora_do_ciclo",
                detalhe: `${mes.month} fora do ciclo ${atual.cycleStart} → ${atual.cycleEnd}`,
            };
        }
    }

    const onde = contrato.seedClosingBrl !== undefined
        ? `abertura ${saldo.toFixed(2)} em ${MAY_LAST_DAY}`
        : `abertura ${contrato.ceilingBrl.toFixed(2)} em ${atual.cycleStart}`
            + ` + ${contrato.months.length} mês(es) de consumo (${consumo.toFixed(2)})`;
    return { status: "lancar", detalhe: `${onde} → saldo ${saldo.toFixed(2)}` };
}

/** Último dia do mês AAAA-MM. */
export function ultimoDiaDoMes(monthKey: string): string {
    const ano = Number(monthKey.slice(0, 4));
    const mes = Number(monthKey.slice(5, 7));
    const data = new Date(Date.UTC(ano, mes, 0));
    return data.toISOString().slice(0, 10);
}

function brl(valor: number) {
    return valor.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

async function main() {
    const apply = process.argv.includes("--apply");
    const permitirCicloAssumido = process.argv.includes("--permitir-ciclo-assumido");
    if (!hasDatabaseUrl()) throw new Error("DATABASE_URL não configurada.");

    const dados = JSON.parse(await readFile(DATA_PATH, "utf8")) as {
        contratos: ContratoPendente[];
        encerrar: Encerramento[];
    };
    const db = getDb();

    const numeros = dados.contratos.map((item) => item.contractNumber)
        .concat(dados.encerrar.map((item) => item.contractNumber));
    const linhas = await db
        .select({
            id: contracts.id,
            contractNumber: contracts.contractNumber,
            ceilingAmount: contracts.ceilingAmount,
            cycleStart: contracts.cycleStart,
            cycleEnd: contracts.cycleEnd,
            status: contracts.status,
            doctorId: contracts.doctorId,
            doctorName: doctors.fullName,
            doctorNormalized: doctors.normalizedName,
        })
        .from(contracts)
        .innerJoin(doctors, eq(doctors.id, contracts.doctorId))
        .where(inArray(contracts.contractNumber, numeros));

    const comOpening = new Set<string>();
    if (linhas.length > 0) {
        const aberturas = await db
            .select({ contractId: contractLedger.contractId })
            .from(contractLedger)
            .where(and(
                eq(contractLedger.type, "opening"),
                inArray(contractLedger.contractId, linhas.map((linha) => linha.id)),
            ));
        for (const abertura of aberturas) comOpening.add(abertura.contractId);
    }

    console.log(apply ? "MODO: APLICAR (grava no razão)\n" : "MODO: DRY-RUN (não escreve nada)\n");
    let aplicados = 0;

    for (const contrato of dados.contratos) {
        const linha = linhas.find((item) =>
            item.contractNumber === contrato.contractNumber
            && normalizeDoctorName(item.doctorNormalized) === normalizeDoctorName(contrato.doctorName));
        const rotulo = `${contrato.doctorName} (${contrato.contractNumber})`;
        const plano = planejar(
            contrato,
            linha ? { ...linha, temOpening: comOpening.has(linha.id) } : null,
            permitirCicloAssumido,
        );

        if (plano.status !== "lancar" || !linha) {
            console.log(`- ${rotulo}: ${plano.status.toUpperCase()} — ${plano.detalhe}`);
            continue;
        }
        console.log(`- ${rotulo}: ${plano.detalhe}`);
        if (!apply) continue;

        await db.transaction(async (tx) => {
            const tetoAtual = linha.ceilingAmount === null ? null : Number(linha.ceilingAmount);
            if (tetoAtual === null || Math.abs(tetoAtual - contrato.ceilingBrl) > TOLERANCE) {
                await tx.update(contracts)
                    .set({ ceilingAmount: contrato.ceilingBrl.toFixed(2), updatedAt: new Date() })
                    .where(eq(contracts.id, linha.id));
            }

            if (contrato.seedClosingBrl !== undefined) {
                await tx.insert(contractLedger).values({
                    contractId: linha.id,
                    entryDate: MAY_LAST_DAY,
                    type: "opening",
                    amount: contrato.seedClosingBrl.toFixed(2),
                    description: "Saldo de MAIO/2026 importado da planilha 2026 CHAMAMENTO 004"
                        + " (teto corrigido para 48h especialista — scripts/lancar-tetos-pendentes.ts)",
                });
                return;
            }

            await tx.insert(contractLedger).values({
                contractId: linha.id,
                entryDate: linha.cycleStart,
                type: "opening",
                amount: contrato.ceilingBrl.toFixed(2),
                description: `Teto de referência do ciclo (${contrato.weeklyHours}h ${contrato.category})`
                    + " lançado em 2026-08-04: a planilha nunca carregou o teto deste contrato"
                    + " — scripts/lancar-tetos-pendentes.ts",
            });
            for (const mes of contrato.months) {
                await tx.insert(contractLedger).values({
                    contractId: linha.id,
                    entryDate: ultimoDiaDoMes(mes.month),
                    type: "invoice",
                    amount: (-mes.amountBrl).toFixed(2),
                    weekdayShifts: mes.weekdayShifts.toFixed(1),
                    weekendShifts: mes.weekendShifts.toFixed(1),
                    sourceType: IMPORT_SOURCE_TYPE,
                    sourceKey: `${linha.doctorId}|${mes.month}`,
                    sourceRevision: 0,
                    description: `Consumo de ${mes.month} importado da planilha 2026 CHAMAMENTO 004`,
                });
            }
        });
        aplicados++;
    }

    console.log("");
    for (const item of dados.encerrar) {
        const linha = linhas.find((row) =>
            row.contractNumber === item.contractNumber
            && normalizeDoctorName(row.doctorNormalized) === normalizeDoctorName(item.doctorName));
        const rotulo = `${item.doctorName} (${item.contractNumber})`;
        if (!linha) {
            console.log(`- ENCERRAR ${rotulo}: NÃO ENCONTRADO — nada feito`);
            continue;
        }
        if (linha.status !== "active") {
            console.log(`- ENCERRAR ${rotulo}: já está "${linha.status}" — nada feito`);
            continue;
        }
        const sucessor = linhas.find((row) =>
            row.contractNumber === item.supersededBy
            && normalizeDoctorName(row.doctorNormalized) === normalizeDoctorName(item.doctorName));
        if (!sucessor) {
            console.log(`- ENCERRAR ${rotulo}: sucessor ${item.supersededBy} não encontrado — nada feito`);
            continue;
        }
        console.log(`- ENCERRAR ${rotulo}: terminated em ${item.endedAt}, substituído por ${item.supersededBy}`);
        if (!apply) continue;
        await db.update(contracts)
            .set({
                status: "terminated",
                endedAt: item.endedAt,
                supersededByContractId: sucessor.id,
                updatedAt: new Date(),
            })
            .where(eq(contracts.id, linha.id));
        aplicados++;
    }

    console.log(`\n${apply ? "Aplicado" : "Dry-run"}: ${aplicados} alteração(ões).`);
    if (apply) {
        console.log("\nSaldos resultantes:");
        for (const contrato of dados.contratos) {
            console.log(`  ${contrato.doctorName}: ${brl(contrato.expectedBalanceBrl)}`);
        }
    }
}

// Basename exato: o arquivo de teste contém o nome deste script.
if (path.basename(process.argv[1] ?? "") === "lancar-tetos-pendentes.ts") {
    main().then(() => process.exit(0)).catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
