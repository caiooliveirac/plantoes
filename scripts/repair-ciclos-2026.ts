/**
 * Conserto dos 7 contratos com ciclo projetado no futuro (out–dez/2026→2027).
 *
 *   npx tsx scripts/repair-ciclos-2026.ts [--apply]
 *
 * Causa raiz (dossiê de 2026-08-04, aprovado por Caio): a coluna DATA ADMISSÃO
 * da planilha 2026 CHAMAMENTO 004 traz ANO 2026 para 7 médicos que já
 * trabalhavam em jan–mai/2026 — o backfill projetou o ciclo a partir dela e os
 * contratos nasceram com janela 2026→2027. Efeito: o saldo desses 7 está
 * congelado desde maio (consumo fora do ciclo não desconta) e a atestação não
 * encontra contrato para lançar (started_at no futuro).
 *
 * O conserto assume admissão em 2025 — que produz a MESMA janela vigente que a
 * admissão verdadeira produziria, inclusive para os dois contratos de 2024
 * (aniversário anual: nov/2024 e nov/2025 caem ambos no ciclo nov/2025→nov/2026).
 * Corrige cycle_start, cycle_end E started_at (os três vieram do mesmo erro).
 *
 * Guardas: só toca contrato ativo, do médico esperado, cujo cycle_start ainda é
 * exatamente o valor errado conhecido. Qualquer divergência = pulado e
 * reportado. Rodar duas vezes não muda nada ("ja_corrigido").
 *
 * Depois deste script, reexecutar o reparo de maio (scripts/repair-maio-extrato.ts)
 * pega os 7 automaticamente — as aberturas deles continuam datadas de 31/05.
 */
import { and, eq, inArray } from "drizzle-orm";
import { getDb, hasDatabaseUrl } from "@/db";
import { contracts, doctors } from "@/db/schema";
import { normalizeDoctorName } from "@/scripts/backfill-saldo-contrato";

export interface CicloFix {
    doctorName: string;
    contractNumber: string;
    /** O valor errado que o backfill gravou — é a guarda: diferente disso, não mexe. */
    wrongCycleStart: string;
    /** Início do ciclo vigente correto (admissão tratada como 2025). */
    newCycleStart: string;
}

/** Dossiê 2026-08-04: DATA ADMISSÃO com ano 2026 na planilha; ciclo real 2025→2026. */
export const CICLO_FIXES: CicloFix[] = [
    { doctorName: "Claudio Henrique Cavalcanti Teixeira", contractNumber: "562/2025", wrongCycleStart: "2026-10-01", newCycleStart: "2025-10-01" },
    { doctorName: "João Pedro da Silva Moreira", contractNumber: "807/2024", wrongCycleStart: "2026-11-01", newCycleStart: "2025-11-01" },
    { doctorName: "Luan Sampaio Evangelista Santos", contractNumber: "612/2025", wrongCycleStart: "2026-12-01", newCycleStart: "2025-12-01" },
    { doctorName: "Samara Alves Messias Viana", contractNumber: "618/2025", wrongCycleStart: "2026-12-01", newCycleStart: "2025-12-01" },
    { doctorName: "Taisa Passos dos Santos Mendonça", contractNumber: "639/2025", wrongCycleStart: "2026-12-01", newCycleStart: "2025-12-01" },
    { doctorName: "Victor Ramos da Silva", contractNumber: "869/2024", wrongCycleStart: "2026-12-01", newCycleStart: "2025-12-01" },
    { doctorName: "Bruno Mota de Almeida", contractNumber: "633/2025", wrongCycleStart: "2026-12-01", newCycleStart: "2025-12-01" },
];

/** Soma um ano a uma data AAAA-MM-DD (dia 1º — o caso 29/02 não existe aqui). */
export function plusOneYear(dateIso: string): string {
    return `${Number(dateIso.slice(0, 4)) + 1}${dateIso.slice(4)}`;
}

export type CicloPlanStatus = "corrigir" | "ja_corrigido" | "divergente";

/** Decisão pura, testável: o que fazer com o contrato encontrado. */
export function planCicloFix(fix: CicloFix, current: { cycleStart: string; status: string }): CicloPlanStatus {
    if (current.status !== "active") return "divergente";
    if (current.cycleStart === fix.newCycleStart) return "ja_corrigido";
    if (current.cycleStart !== fix.wrongCycleStart) return "divergente";
    return "corrigir";
}

async function main() {
    const apply = process.argv.includes("--apply");
    if (!hasDatabaseUrl()) throw new Error("DATABASE_URL não configurada.");
    const db = getDb();

    const rows = await db
        .select({
            id: contracts.id,
            contractNumber: contracts.contractNumber,
            cycleStart: contracts.cycleStart,
            cycleEnd: contracts.cycleEnd,
            startedAt: contracts.startedAt,
            status: contracts.status,
            notes: contracts.notes,
            doctorNormalized: doctors.normalizedName,
            doctorName: doctors.fullName,
        })
        .from(contracts)
        .innerJoin(doctors, eq(doctors.id, contracts.doctorId))
        .where(inArray(contracts.contractNumber, CICLO_FIXES.map((fix) => fix.contractNumber)));

    let aplicados = 0;
    for (const fix of CICLO_FIXES) {
        const match = rows.find((row) =>
            row.contractNumber === fix.contractNumber
            && normalizeDoctorName(row.doctorNormalized) === normalizeDoctorName(fix.doctorName));
        const label = `${fix.doctorName} (${fix.contractNumber})`;
        if (!match) {
            console.log(`- ${label}: NÃO ENCONTRADO — nada feito`);
            continue;
        }
        const plan = planCicloFix(fix, match);
        if (plan === "ja_corrigido") {
            console.log(`- ${label}: já corrigido (ciclo ${match.cycleStart} → ${match.cycleEnd})`);
            continue;
        }
        if (plan === "divergente") {
            console.log(`- ${label}: DIVERGENTE (status=${match.status}, cycle_start=${match.cycleStart}, esperado ${fix.wrongCycleStart}) — nada feito`);
            continue;
        }
        const newCycleEnd = plusOneYear(fix.newCycleStart);
        const detail = `ciclo ${match.cycleStart}→${match.cycleEnd} vira ${fix.newCycleStart}→${newCycleEnd}; started_at ${match.startedAt} vira ${fix.newCycleStart}`;
        if (!apply) {
            console.log(`- ${label}: corrigiria — ${detail}`);
            continue;
        }
        await db.update(contracts)
            .set({
                cycleStart: fix.newCycleStart,
                cycleEnd: newCycleEnd,
                startedAt: fix.newCycleStart,
                notes: `${match.notes ? `${match.notes}\n` : ""}Ciclo corrigido em 2026-08-04: DATA ADMISSÃO da planilha trazia ano 2026 (dossiê repair-ciclos-2026).`,
                updatedAt: new Date(),
            })
            .where(and(eq(contracts.id, match.id), eq(contracts.cycleStart, fix.wrongCycleStart)));
        aplicados++;
        console.log(`- ${label}: CORRIGIDO — ${detail}`);
    }
    console.log(`${apply ? "Aplicado" : "Dry-run"}: ${apply ? aplicados : 0} de ${CICLO_FIXES.length} contratos alterados.`);
    process.exit(0);
}

// Basename exato: o arquivo de teste contém o nome deste script.
import path from "node:path";
if (path.basename(process.argv[1] ?? "") === "repair-ciclos-2026.ts") {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    });
}
