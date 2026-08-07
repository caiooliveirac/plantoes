/**
 * Correção do saldo de abertura semeado pelo backfill em dois contratos.
 *
 *   npx tsx scripts/corrigir-aberturas-seed.ts [--apply]
 *
 * Francisco Isensee de Macedo (797/2024): o backfill rodou sobre uma versão do
 * arquivo anterior à correção da virada de dez/2025 e semeou -46.778,94. A
 * planilha corrigida fecha maio em +153.128,27. Ele nunca estourou — diferença
 * de R$ 199.907,21 no razão.
 *
 * Karen Seifarth Miranda (518/2024): a planilha resetou em ago/2025 com o teto
 * de 24h (165.732,00) sendo ela 36h (248.598,00). Estourou de verdade, mas em
 * 6.896,24 e não em 89.762,24 — diferença de exatos R$ 82.866,00.
 *
 * POR QUE NA ABERTURA E NÃO COMO manual_adjustment: nos dois casos o errado é o
 * saldo de partida, não o consumo. A view contract_balance calcula
 * `consumed = -sum(amount) filter (type <> 'opening')`, então um ajuste manual
 * mexeria no consumo e no percentual do teto. Corrigir a carga na própria linha
 * é o mesmo padrão — e a mesma justificativa — de scripts/repair-maio-extrato.ts:
 * a abertura do backfill não é ato de negócio, é carga de dados.
 *
 * DUAS VARIANTES: o reparo de maio move a abertura de 31/05 para 01/05 e lança
 * o gasto do mês à parte. Como não dá para saber daqui se ele já rodou com
 * --apply, cada correção declara as duas formas possíveis e o script casa por
 * data + valor EXATO. Qualquer outro valor = divergente, e não se toca em nada:
 * é sinal de que alguém já mexeu, e aí a decisão é humana.
 *
 * Sem --apply é dry-run. Rodar duas vezes não muda nada: abertura já no valor
 * de destino é reportada como "ja_corrigido".
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";

import { getDb, hasDatabaseUrl } from "@/db";
import { contractLedger, contracts, doctors } from "@/db/schema";
import { normalizeDoctorName } from "@/scripts/backfill-saldo-contrato";

const DATA_PATH = "docs/saldo-contrato/aberturas-a-corrigir.json";
export const TOLERANCE = 0.005;

export interface Variante {
    entryDate: string;
    deBrl: number;
    paraBrl: number;
}

export interface Correcao {
    doctorName: string;
    contractNumber: string;
    expectedCeilingBrl: number;
    deltaBrl?: number;
    /** Sobrescreve o texto gravado no razão. Sem isso, vale a descrição das correções de 2026-08-04. */
    descricao?: string;
    variantes: Variante[];
    motivo?: string;
    nota?: string;
}

export interface AberturaAtual {
    ledgerId: string;
    entryDate: string;
    amountBrl: number;
}

export type PlanoStatus =
    | "corrigir"
    | "ja_corrigido"
    | "sem_contrato"
    | "sem_abertura"
    | "multiplas_aberturas"
    | "valor_divergente";

export interface Plano {
    status: PlanoStatus;
    detalhe: string;
    /** Preenchido só quando status = "corrigir". */
    alvo?: { ledgerId: string; paraBrl: number };
}

/**
 * Decisão pura, testável. Casa a abertura encontrada contra as variantes
 * declaradas; qualquer coisa fora delas é divergência e não vira escrita.
 */
export function planejar(correcao: Correcao, aberturas: AberturaAtual[]): Plano {
    if (aberturas.length === 0) {
        return { status: "sem_abertura", detalhe: "o contrato não tem lançamento de abertura no razão" };
    }
    if (aberturas.length > 1) {
        return {
            status: "multiplas_aberturas",
            detalhe: `${aberturas.length} lançamentos de abertura — decisão humana`,
        };
    }
    const [abertura] = aberturas;

    const jaNoDestino = correcao.variantes.find((variante) =>
        variante.entryDate === abertura.entryDate
        && Math.abs(abertura.amountBrl - variante.paraBrl) <= TOLERANCE);
    if (jaNoDestino) {
        return {
            status: "ja_corrigido",
            detalhe: `abertura de ${abertura.entryDate} já está em ${jaNoDestino.paraBrl.toFixed(2)}`,
        };
    }

    const alvo = correcao.variantes.find((variante) =>
        variante.entryDate === abertura.entryDate
        && Math.abs(abertura.amountBrl - variante.deBrl) <= TOLERANCE);
    if (!alvo) {
        return {
            status: "valor_divergente",
            detalhe: `razão tem ${abertura.amountBrl.toFixed(2)} em ${abertura.entryDate};`
                + ` esperado ${correcao.variantes.map((v) => `${v.deBrl.toFixed(2)} em ${v.entryDate}`).join(" ou ")}`
                + " — alguém já mexeu, nada foi alterado",
        };
    }

    // O delta tem que ser o mesmo em qualquer variante: é a mesma correção,
    // aplicada num ponto diferente da linha do tempo.
    if (correcao.deltaBrl !== undefined) {
        const delta = alvo.paraBrl - alvo.deBrl;
        if (Math.abs(delta - correcao.deltaBrl) > TOLERANCE) {
            return {
                status: "valor_divergente",
                detalhe: `variante de ${alvo.entryDate} move ${delta.toFixed(2)},`
                    + ` mas o JSON declara delta de ${correcao.deltaBrl.toFixed(2)}`,
            };
        }
    }

    return {
        status: "corrigir",
        detalhe: `${abertura.entryDate}: ${alvo.deBrl.toFixed(2)} → ${alvo.paraBrl.toFixed(2)}`
            + ` (${(alvo.paraBrl - alvo.deBrl >= 0 ? "+" : "")}${(alvo.paraBrl - alvo.deBrl).toFixed(2)})`,
        alvo: { ledgerId: abertura.ledgerId, paraBrl: alvo.paraBrl },
    };
}

async function main() {
    const apply = process.argv.includes("--apply");
    if (!hasDatabaseUrl()) throw new Error("DATABASE_URL não configurada.");

    const dados = JSON.parse(await readFile(DATA_PATH, "utf8")) as { correcoes: Correcao[] };
    const db = getDb();

    const linhas = await db
        .select({
            id: contracts.id,
            contractNumber: contracts.contractNumber,
            ceilingAmount: contracts.ceilingAmount,
            status: contracts.status,
            doctorNormalized: doctors.normalizedName,
        })
        .from(contracts)
        .innerJoin(doctors, eq(doctors.id, contracts.doctorId))
        .where(inArray(contracts.contractNumber, dados.correcoes.map((item) => item.contractNumber)));

    console.log(apply ? "MODO: APLICAR (grava no razão)\n" : "MODO: DRY-RUN (não escreve nada)\n");
    let aplicados = 0;

    for (const correcao of dados.correcoes) {
        const rotulo = `${correcao.doctorName} (${correcao.contractNumber})`;
        const linha = linhas.find((item) =>
            item.contractNumber === correcao.contractNumber
            && normalizeDoctorName(item.doctorNormalized) === normalizeDoctorName(correcao.doctorName));
        if (!linha || linha.status !== "active") {
            console.log(`- ${rotulo}: SEM_CONTRATO — nenhum contrato ativo com este número para este médico`);
            continue;
        }

        const aberturas = await db
            .select({ id: contractLedger.id, entryDate: contractLedger.entryDate, amount: contractLedger.amount })
            .from(contractLedger)
            .where(and(eq(contractLedger.contractId, linha.id), eq(contractLedger.type, "opening")));

        const plano = planejar(correcao, aberturas.map((item) => ({
            ledgerId: item.id,
            entryDate: item.entryDate,
            amountBrl: Number(item.amount),
        })));

        if (plano.status !== "corrigir" || !plano.alvo) {
            console.log(`- ${rotulo}: ${plano.status.toUpperCase()} — ${plano.detalhe}`);
            continue;
        }

        const tetoAtual = linha.ceilingAmount === null ? null : Number(linha.ceilingAmount);
        const tetoPrecisaMudar = tetoAtual === null
            || Math.abs(tetoAtual - correcao.expectedCeilingBrl) > TOLERANCE;
        console.log(`- ${rotulo}: ${plano.detalhe}`
            + (tetoPrecisaMudar ? ` · teto ${tetoAtual?.toFixed(2) ?? "vazio"} → ${correcao.expectedCeilingBrl.toFixed(2)}` : ""));
        if (!apply) continue;

        const { ledgerId, paraBrl } = plano.alvo;
        await db.transaction(async (tx) => {
            await tx.update(contractLedger)
                .set({
                    amount: paraBrl.toFixed(2),
                    description: correcao.descricao
                        ?? "Saldo de MAIO/2026 importado da planilha"
                        + " (corrigido em 2026-08-04 — scripts/corrigir-aberturas-seed.ts)",
                })
                .where(eq(contractLedger.id, ledgerId));
            if (tetoPrecisaMudar) {
                await tx.update(contracts)
                    .set({ ceilingAmount: correcao.expectedCeilingBrl.toFixed(2), updatedAt: new Date() })
                    .where(eq(contracts.id, linha.id));
            }
        });
        aplicados++;
    }

    console.log(`\n${apply ? "Aplicado" : "Dry-run"}: ${aplicados} correção(ões).`);
    if (apply) {
        console.log("\nAtenção: rode o reparo de maio depois — o Francisco passa a bater com a planilha");
        console.log("e a linha de maio dele é recolhida automaticamente (npm run saldo:repair-maio).");
    }
}

// Basename exato: o arquivo de teste contém o nome deste script.
if (path.basename(process.argv[1] ?? "") === "corrigir-aberturas-seed.ts") {
    main().then(() => process.exit(0)).catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
