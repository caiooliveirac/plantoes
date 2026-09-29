import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { closeDb, getDb, hasDatabaseUrl } from "@/db";
import {
    classifyContractPendencies,
    contractPendencyHref,
    loadContractPendencyQueue,
    type ContractPendencyContract,
    type ContractPendencyDoctor,
} from "@/services/contract-pendency-queue.service";

const HOJE = new Date("2026-09-27T12:00:00Z");

function doctor(overrides: Partial<ContractPendencyDoctor> = {}): ContractPendencyDoctor {
    return {
        id: overrides.id ?? "d-1",
        fullName: "Médico Teste",
        metadata: { employmentType: "pj" },
        admittedAt: "2025-09-01",
        lastShiftAt: new Date("2026-09-20T10:00:00Z"),
        ...overrides,
    };
}

function contract(overrides: Partial<ContractPendencyContract> = {}): ContractPendencyContract {
    return {
        contractId: "c-1",
        doctorId: "d-1",
        contractNumber: "001/2026",
        cycleStart: "2026-01-01",
        cycleEnd: "2027-01-01",
        ceilingCents: 16_573_200,
        awaitingOpeningBalance: false,
        ...overrides,
    };
}

const kinds = (doctors: ContractPendencyDoctor[], contracts: ContractPendencyContract[]) =>
    classifyContractPendencies({ doctors, contracts, asOf: HOJE }).items.map((item) => item.kind);

describe("classifyContractPendencies — a fila de 02-pendencias-pos-deploy", () => {
    it("contrato em dia não é pendência", () => {
        assert.deepEqual(kinds([doctor()], [contract()]), []);
    });

    it("PJ plantonando sem contrato é o primeiro da fila, e avisa a falta de admissão", () => {
        const queue = classifyContractPendencies({ doctors: [doctor({ admittedAt: null })], contracts: [], asOf: HOJE });
        assert.equal(queue.items[0].kind, "sem_contrato");
        assert.match(queue.items[0].detail, /admissão/);
        assert.equal(queue.items[0].lastShiftMonth, "2026-09");
    });

    it("PJ sem contrato e sem plantão recente vira conferência de cadastro, não cadastro de contrato", () => {
        assert.deepEqual(kinds([doctor({ lastShiftAt: new Date("2026-05-01T10:00:00Z") })], []), ["sem_plantao_recente"]);
        assert.deepEqual(kinds([doctor({ lastShiftAt: null })], []), ["sem_plantao_recente"]);
    });

    it("vencido e sem saldo de abertura vêm da mesma régua dos avisos (findPendingRenewals)", () => {
        assert.deepEqual(kinds([doctor()], [contract({ cycleEnd: "2026-09-01" })]), ["vencido"]);
        assert.deepEqual(kinds([doctor()], [contract({ awaitingOpeningBalance: true })]), ["sem_saldo_de_abertura"]);
    });

    it("teto vazio conta só no contrato mais recente", () => {
        assert.deepEqual(kinds([doctor()], [contract({ ceilingCents: null })]), ["sem_teto"]);
        assert.deepEqual(kinds([doctor()], [
            contract({ contractId: "velho", cycleStart: "2025-06-01", cycleEnd: "2026-12-01", ceilingCents: null }),
            contract({ contractId: "novo" }),
        ]), []);
    });

    it("estatutário sem contrato é o normal; com contrato ativo, o vínculo está suspeito", () => {
        const estatutario = doctor({ metadata: { employmentType: "estatutario" } });
        assert.deepEqual(kinds([estatutario], []), []);
        assert.deepEqual(kinds([estatutario], [contract()]), ["vinculo_suspeito"]);
    });

    it("psiquiatria e não plantonista ficam fora, como na tela do fechamento", () => {
        assert.deepEqual(kinds([doctor({ metadata: { preferredOperationalRole: "PSIQ" } })], []), []);
        assert.deepEqual(kinds([doctor({ metadata: { isNaoPlantonista: true } })], []), []);
    });

    it("o link leva ao modal do médico no mês do último plantão; sem plantão, sem link", () => {
        assert.equal(
            contractPendencyHref({ kind: "sem_contrato", doctorId: "d-1", lastShiftMonth: "2026-09" }),
            "/admin/payment-closing?month=2026-09&doctor=d-1",
        );
        assert.equal(contractPendencyHref({ kind: "sem_plantao_recente", doctorId: "d-1", lastShiftMonth: "2026-01" }), null);
        assert.equal(contractPendencyHref({ kind: "vencido", doctorId: "d-1", lastShiftMonth: null }), null);
    });

    it("contador por tipo soma o total", () => {
        const queue = classifyContractPendencies({
            doctors: [doctor({ id: "a" }), doctor({ id: "b" }), doctor({ id: "c", lastShiftAt: null })],
            contracts: [contract({ doctorId: "b", ceilingCents: null })],
            asOf: HOJE,
        });
        assert.equal(queue.total, 3);
        assert.equal(queue.counts.sem_contrato, 1);
        assert.equal(queue.counts.sem_teto, 1);
        assert.equal(queue.counts.sem_plantao_recente, 1);
    });
});

// Contra o banco: CI tem Postgres migrado (ci-pr.yml). Sem DATABASE_URL, pula.
describe("loadContractPendencyQueue — query real", { skip: !hasDatabaseUrl() && "sem DATABASE_URL" }, () => {
    after(async () => {
        await closeDb();
    });

    it("lê médicos, contratos, abertura no razão e último plantão", async () => {
        const db = getDb();
        const tag = randomUUID().slice(0, 8);
        const ids: Record<"semContrato" | "semAbertura" | "emDia" | "inativo", string> = {
            semContrato: randomUUID(), semAbertura: randomUUID(), emDia: randomUUID(), inativo: randomUUID(),
        };
        const contratoSemAbertura = randomUUID();
        const contratoEmDia = randomUUID();
        const [post] = await db.execute(sql`select id from operations_v2.regulation_posts order by id limit 1`) as unknown as { id: number }[];
        assert.ok(post, "migrations deveriam semear os ramais");

        try {
            for (const [key, id] of Object.entries(ids)) {
                await db.execute(sql`
                    insert into operations_v2.doctors (id, full_name, normalized_name, is_active, metadata)
                    values (${id}, ${`Fila ${key} ${tag}`}, ${`fila ${key} ${tag}`}, ${key !== "inativo"}, '{"employmentType":"pj"}'::jsonb)
                `);
            }
            // Plantão há 5 dias para quem não tem contrato (e para o inativo, que não entra).
            for (const id of [ids.semContrato, ids.inativo]) {
                await db.execute(sql`
                    insert into operations_v2.regulation_occupancies (doctor_id, continuity_group_id, post_id, started_at, source)
                    values (${id}, ${randomUUID()}, ${post.id}, now() - interval '5 days', 'manual')
                `);
            }
            await db.execute(sql`
                insert into operations_v2.contracts (id, doctor_id, contract_number, category, ceiling_amount, cycle_start, cycle_end, started_at)
                values (${contratoSemAbertura}, ${ids.semAbertura}, ${`A-${tag}`}, 'generalista', 165732.00,
                        current_date - 30, current_date + 300, current_date - 30),
                       (${contratoEmDia}, ${ids.emDia}, ${`B-${tag}`}, 'generalista', 165732.00,
                        current_date - 30, current_date + 300, current_date - 30)
            `);
            await db.execute(sql`
                insert into operations_v2.contract_ledger (contract_id, entry_date, type, amount)
                values (${contratoEmDia}, current_date - 30, 'opening', 165732.00)
            `);

            const queue = await loadContractPendencyQueue();
            const mine = new Map(queue.items
                .filter((item) => Object.values(ids).includes(item.doctorId))
                .map((item) => [item.doctorId, item]));

            assert.equal(mine.get(ids.semContrato)?.kind, "sem_contrato");
            assert.match(mine.get(ids.semContrato)?.lastShiftMonth ?? "", /^\d{4}-\d{2}$/);
            assert.equal(mine.get(ids.semAbertura)?.kind, "sem_saldo_de_abertura");
            assert.equal(mine.get(ids.semAbertura)?.contractNumber, `A-${tag}`);
            assert.equal(mine.has(ids.emDia), false, "contrato com teto e abertura não é pendência");
            assert.equal(mine.has(ids.inativo), false, "médico inativo não entra na fila");
        } finally {
            const all = Object.values(ids);
            await db.execute(sql`delete from operations_v2.contract_ledger where contract_id in (${contratoSemAbertura}, ${contratoEmDia})`);
            await db.execute(sql`delete from operations_v2.contracts where id in (${contratoSemAbertura}, ${contratoEmDia})`);
            await db.execute(sql`delete from operations_v2.regulation_occupancies where doctor_id in (${all[0]}, ${all[1]}, ${all[2]}, ${all[3]})`);
            await db.execute(sql`delete from operations_v2.doctors where id in (${all[0]}, ${all[1]}, ${all[2]}, ${all[3]})`);
        }
    });
});
