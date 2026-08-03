/**
 * Cria contrato para os médicos que a planilha de maio/2026 não cobria.
 *
 *   npx tsx scripts/seed-contratos-sem-planilha-2026-08.ts            # dry-run
 *   npx tsx scripts/seed-contratos-sem-planilha-2026-08.ts --apply
 *
 * Contexto: o backfill (scripts/backfill-saldo-contrato.ts) importou o saldo de
 * maio a partir da planilha. Quem entrou depois do corte, ou quem estava na
 * planilha sem DATA ADMISSÃO, ficou sem contrato — e portanto plantonando sem
 * nenhum controle de teto.
 *
 * Decisões do usuário em 2026-08-03:
 *
 *   - Lucyane Santana Teixeira, Thiago Borghi Petrus Costa, Vinicius Pereira de
 *     Carvalho e Larissa Osthues Revert Silva seguem SEM a feature. Não entram.
 *   - Os demais entram com teto e saldo de abertura de R$ 165.732,00 — o valor
 *     padrão de 24h generalista, que vale para a maioria.
 *
 * O ciclo começa no dia 1 do mês do PRIMEIRO PLANTÃO de cada um, seguindo a
 * mesma regra do resto da feature (o dia da admissão não importa; ver
 * docs/saldo-contrato/01-conferencia-2025.md §3.1). O consumo entra depois pela
 * reconciliação normal, mês a mês, só para fechamento atestado — nenhum valor é
 * debitado à mão aqui.
 */
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { contracts } from "@/db/schema";
import { resolveDoctorPaymentProfile } from "@/modules/reporting/payable-shifts";
import {
    recordOpeningBalance,
    syncContractLedgerForMonthBatch,
} from "@/services/contract-ledger.service";

/** Teto padrão de 24h generalista — o valor que vale para a maioria. */
const TETO_PADRAO_BRL = 165732;

/** Quem entra, com o nº de contrato quando a planilha o trazia. */
const ALVOS: { nome: string; contrato: string }[] = [
    { nome: "Giulia Santos dos Reis Souza", contrato: "SEM NÚMERO" },
    { nome: "Stephane Izabor de Oliveira Costa", contrato: "156/2026" },
    { nome: "Gabriela Alves Costa", contrato: "SEM NÚMERO" },
    { nome: "Isabella Pereira da Nóbrega", contrato: "SEM NÚMERO" },
    { nome: "Antonio Elcio Santos Silva", contrato: "235/2026" },
];

const CATEGORIA: Record<string, "generalista" | "especialista" | "psiquiatria"> = {
    generalist: "generalista",
    specialist: "especialista",
    psychiatry: "psiquiatria",
};

function mesesDe(inicio: string, fim: string): string[] {
    const meses: string[] = [];
    let [ano, mes] = inicio.split("-").map(Number);
    const [anoFim, mesFim] = fim.split("-").map(Number);
    while (ano < anoFim || (ano === anoFim && mes <= mesFim)) {
        meses.push(`${ano}-${String(mes).padStart(2, "0")}`);
        mes += 1;
        if (mes > 12) { mes = 1; ano += 1; }
    }
    return meses;
}

async function main() {
    const apply = process.argv.includes("--apply");
    const db = getDb();
    const hoje = new Date().toISOString().slice(0, 7);

    for (const alvo of ALVOS) {
        const encontrados = await db.execute(sql`
            select d.id::text, d.full_name, d.metadata,
                   (select min(t.started_at)::text from (
                        select started_at from operations_v2.regulation_occupancies where doctor_id = d.id
                        union all
                        select started_at from operations_v2.intervention_occupancies where doctor_id = d.id
                   ) t) as primeiro_plantao,
                   (select count(*) from operations_v2.contracts c
                    where c.doctor_id = d.id and c.status = 'active') as contratos_ativos
            from operations_v2.doctors d
            where d.full_name = ${alvo.nome}
        `) as unknown as {
            id: string; full_name: string; metadata: unknown;
            primeiro_plantao: string | null; contratos_ativos: number;
        }[];

        if (encontrados.length !== 1) {
            console.log(`${alvo.nome}: ${encontrados.length} médicos com esse nome — PULADO`);
            continue;
        }
        const medico = encontrados[0];
        if (Number(medico.contratos_ativos) > 0) {
            console.log(`${alvo.nome}: já tem contrato ativo — PULADO`);
            continue;
        }
        if (!medico.primeiro_plantao) {
            console.log(`${alvo.nome}: sem nenhum plantão registrado — PULADO`);
            continue;
        }

        // Ciclo começa no dia 1 do mês do primeiro plantão.
        const mesInicial = medico.primeiro_plantao.slice(0, 7);
        const [ano, mes] = mesInicial.split("-").map(Number);
        const cycleStart = `${mesInicial}-01`;
        const cycleEnd = `${ano + 1}-${String(mes).padStart(2, "0")}-01`;
        const categoria = CATEGORIA[resolveDoctorPaymentProfile(medico.metadata)] ?? "generalista";

        console.log(`\n${medico.full_name}`);
        console.log(`  primeiro plantão: ${medico.primeiro_plantao.slice(0, 10)}`);
        console.log(`  ciclo: ${cycleStart} → ${cycleEnd} · categoria ${categoria} · contrato ${alvo.contrato}`);
        console.log(`  teto e abertura: R$ ${TETO_PADRAO_BRL.toLocaleString("pt-BR")},00`);
        console.log(`  meses a reconciliar: ${mesesDe(mesInicial, hoje).join(", ")}`);

        if (!apply) continue;

        await db.transaction(async (tx) => {
            const [criado] = await tx.insert(contracts).values({
                doctorId: medico.id,
                contractNumber: alvo.contrato,
                category: categoria,
                weeklyHours: "24",
                ceilingAmount: TETO_PADRAO_BRL.toFixed(2),
                cycleStart,
                cycleEnd,
                startedAt: cycleStart,
                notes: "Criado em 2026-08-03: a planilha de maio/2026 não cobria este médico."
                    + " Teto e saldo de abertura no padrão de 24h, por decisão do coordenador.",
            }).returning({ id: contracts.id });

            await recordOpeningBalance({
                contractId: criado.id,
                balanceCents: TETO_PADRAO_BRL * 100,
                entryDate: cycleStart,
                actorUserId: null,
                tx,
            });
        });
        console.log(`  contrato criado.`);
    }

    if (apply) {
        // Reconciliação normal: só lança o que estiver atestado.
        console.log("\n=== reconciliando os meses ===");
        for (const mes of mesesDe("2026-04", hoje)) {
            const r = await syncContractLedgerForMonthBatch({ monthKey: mes });
            const lancados = [...r.values()].filter((x) => x.outcome === "lancado" || x.outcome === "reajustado").length;
            console.log(`  ${mes}: ${r.size} médicos · ${lancados} lançamento(s)`);
        }
    }

    // Contrato substituído: o novo é que vale (decisão do usuário em 2026-08-03).
    const copque = await db.execute(sql`
        select c.id::text, c.contract_number from operations_v2.contracts c
        join operations_v2.doctors d on d.id = c.doctor_id
        where d.full_name ilike '%Copque%' and c.contract_number = '247/2025' and c.status = 'active'
    `) as unknown as { id: string; contract_number: string }[];
    if (copque.length > 0) {
        console.log(`\nLeonardo Copque ${copque[0].contract_number}: encerrar (substituído pelo 184/2026)`);
        if (apply) {
            await db.update(contracts)
                .set({ status: "terminated", endedAt: "2026-05-01", updatedAt: new Date() })
                .where(eq(contracts.id, copque[0].id));
            console.log("  encerrado.");
        }
    }

    console.log(apply ? "\nconcluído." : "\ndry-run: nada gravado.");
    await closeDb();
    process.exit(0);
}

main().catch((error) => { console.error(error); process.exit(1); });
