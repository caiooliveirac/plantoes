/**
 * Cria contrato para os médicos cadastrados sem contrato entre abr e set/2026.
 *
 *   npx tsx scripts/seed-contratos-recem-cadastrados-2026-09.ts            # dry-run
 *   npx tsx scripts/seed-contratos-recem-cadastrados-2026-09.ts --apply
 *
 * Contexto: até o botão "Cadastrar médico" (que já cria o contrato), o
 * contrato era um passo manual no fechamento que sempre ficava para trás.
 * Conferência em 2026-09-22: 15 médicos ativos sem contrato, 14 plantonando.
 *
 * Decisões do usuário em 2026-09-22 (revogam a de 2026-08-03 que deixava
 * Lucyane, Thiago, Vinicius Pereira e Larissa sem a feature):
 *
 *   - Todos PJ, teto e abertura de R$ 165.732,00 (24h generalista).
 *   - Larissa Osthues e Thiago Borghi são psiquiatras: papel PSIQ e teto da
 *     coluna especialista, R$ 174.858,00 (regra de 2026-08-04, README §6).
 *   - Ivan de Mattos é estatutário (sem contrato PJ); já é admin.
 *   - O ciclo começa no dia 1 do mês do CADASTRO (não do primeiro plantão).
 *
 * O consumo entra pela reconciliação normal, mês a mês, só para fechamento
 * atestado e só destes médicos — nada é debitado à mão aqui.
 */
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { contracts, doctors } from "@/db/schema";
import { PENDING_CONTRACT_NUMBER } from "@/services/doctor-admin.service";
import { applyDoctorPaymentProfileFlags } from "@/services/payment-attestation.service";
import { recordOpeningBalance, syncContractLedgerForMonthBatch } from "@/services/contract-ledger.service";

const TETO_GENERALISTA = 165732;
const TETO_PSIQUIATRIA = 174858;

const PJ: { nome: string; psiquiatra?: true }[] = [
    { nome: "Jonas Rodrigues de Oliveira" },
    { nome: "Juan Victor Costa Lopes" },
    { nome: "Thayse Moreira Klein Boaventura" },
    { nome: "João Gabriel Batista Simon Viana" },
    { nome: "Diego Amorim Valente Bernardes" },
    { nome: "Fabricio Macedo Sampaio" },
    { nome: "Matheus Rocha Libório" },
    { nome: "Rafaela Ferreira de Almeida Siqueira" },
    { nome: "Rafael Santana Azevedo" },
    { nome: "Alexandre José de Santana Moraes" },
    { nome: "Larissa Osthues Revert Silva", psiquiatra: true },
    { nome: "Vinicius Pereira de Carvalho" },
    { nome: "Thiago Borghi Petrus Costa", psiquiatra: true },
    { nome: "Lucyane Santana Teixeira" },
];

const ESTATUTARIOS = ["Ivan de Mattos Paiva Filho"];

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

type Medico = { id: string; full_name: string; metadata: unknown; criado: string; contratos_ativos: number };

async function buscar(nome: string): Promise<Medico | null> {
    const rows = await getDb().execute(sql`
        select d.id::text, d.full_name, d.metadata,
               to_char(d.created_at at time zone 'America/Sao_Paulo', 'YYYY-MM') as criado,
               (select count(*) from operations_v2.contracts c
                where c.doctor_id = d.id and c.status = 'active')::int as contratos_ativos
        from operations_v2.doctors d
        where d.full_name = ${nome} and d.is_active
    `) as unknown as Medico[];
    if (rows.length !== 1) {
        console.log(`${nome}: ${rows.length} médicos ativos com esse nome — PULADO`);
        return null;
    }
    return rows[0];
}

async function main() {
    const apply = process.argv.includes("--apply");
    const db = getDb();
    const hoje = new Date().toISOString().slice(0, 7);
    const criados: { id: string; mesInicial: string }[] = [];

    for (const alvo of PJ) {
        const medico = await buscar(alvo.nome);
        if (!medico) continue;
        if (medico.contratos_ativos > 0) {
            console.log(`${alvo.nome}: já tem contrato ativo — PULADO`);
            continue;
        }

        const mesInicial = medico.criado;
        const [ano, mes] = mesInicial.split("-").map(Number);
        const cycleStart = `${mesInicial}-01`;
        const cycleEnd = `${ano + 1}-${String(mes).padStart(2, "0")}-01`;
        const teto = alvo.psiquiatra ? TETO_PSIQUIATRIA : TETO_GENERALISTA;
        const categoria = alvo.psiquiatra ? "psiquiatria" : "generalista";

        let metadata: Record<string, unknown> = { ...(medico.metadata as Record<string, unknown>), employmentType: "pj" };
        if (alvo.psiquiatra) {
            metadata = applyDoctorPaymentProfileFlags(metadata, { isPsychiatry: true }) as Record<string, unknown>;
        }

        console.log(`\n${medico.full_name}`);
        console.log(`  ciclo ${cycleStart} → ${cycleEnd} · ${categoria} · teto e abertura R$ ${teto.toLocaleString("pt-BR")},00`);
        console.log(`  metadata: ${JSON.stringify(medico.metadata)} → ${JSON.stringify(metadata)}`);

        if (!apply) continue;

        await db.transaction(async (tx) => {
            await tx.update(doctors).set({ metadata, updatedAt: new Date() }).where(eq(doctors.id, medico.id));
            const [criado] = await tx.insert(contracts).values({
                doctorId: medico.id,
                contractNumber: PENDING_CONTRACT_NUMBER,
                category: categoria,
                weeklyHours: "24",
                ceilingAmount: teto.toFixed(2),
                cycleStart,
                cycleEnd,
                startedAt: cycleStart,
                notes: "Criado em 2026-09-22: cadastrado sem contrato. Ciclo a partir do mês do cadastro,"
                    + " por decisão do coordenador. Conferir nº do contrato.",
            }).returning({ id: contracts.id });

            await recordOpeningBalance({
                contractId: criado.id,
                balanceCents: teto * 100,
                entryDate: cycleStart,
                actorUserId: null,
                tx,
            });
        });
        criados.push({ id: medico.id, mesInicial });
        console.log("  contrato criado.");
    }

    for (const nome of ESTATUTARIOS) {
        const medico = await buscar(nome);
        if (!medico) continue;
        const metadata = { ...(medico.metadata as Record<string, unknown>), employmentType: "estatutario" };
        console.log(`\n${medico.full_name}: estatutário (sem contrato) · ${JSON.stringify(medico.metadata)} → ${JSON.stringify(metadata)}`);
        if (apply) {
            await db.update(doctors).set({ metadata, updatedAt: new Date() }).where(eq(doctors.id, medico.id));
            console.log("  vínculo gravado.");
        }
    }

    if (apply && criados.length > 0) {
        // Reconciliação normal, restrita a quem ganhou contrato agora.
        console.log("\n=== reconciliando os meses ===");
        const inicio = criados.map((c) => c.mesInicial).sort()[0];
        for (const mes of mesesDe(inicio, hoje)) {
            const r = await syncContractLedgerForMonthBatch({ monthKey: mes, doctorIds: criados.map((c) => c.id) });
            const resumo = [...r.values()].map((x) => x.outcome).join(", ");
            console.log(`  ${mes}: ${resumo || "nada"}`);
        }
    }

    console.log(apply ? "\nconcluído." : "\ndry-run: nada gravado.");
    await closeDb();
    process.exit(0);
}

main().catch((error) => { console.error(error); process.exit(1); });
