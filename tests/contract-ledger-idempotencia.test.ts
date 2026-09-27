import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import { closeDb, getDb, hasDatabaseUrl } from "@/db";
import { contractLedger, contracts, doctors, users } from "@/db/schema";
import {
    recordBalanceAnchor,
    recordManualAdjustment,
    recordOpeningBalance,
} from "@/services/contract-ledger.service";

// Precisa de banco migrado (o CI tem). Sem DATABASE_URL, pula.
const skip = !hasDatabaseUrl();

let actorUserId = "";

async function novoContrato(): Promise<string> {
    const db = getDb();
    const sufixo = randomUUID().slice(0, 8);
    const [doctor] = await db.insert(doctors)
        .values({ fullName: `Teste Idempotência ${sufixo}`, normalizedName: `teste idempotencia ${sufixo}` })
        .returning({ id: doctors.id });
    const [contract] = await db.insert(contracts)
        .values({
            doctorId: doctor.id,
            contractNumber: `T-${sufixo}`,
            category: "generalista",
            cycleStart: "2026-01-01",
            cycleEnd: "2027-01-01",
            startedAt: "2026-01-01",
        })
        .returning({ id: contracts.id });
    return contract.id;
}

async function lancamentos(contractId: string, type: "manual_adjustment" | "opening") {
    return getDb()
        .select({ amount: contractLedger.amount })
        .from(contractLedger)
        .where(and(eq(contractLedger.contractId, contractId), eq(contractLedger.type, type)));
}

describe("razão do contrato — requisição repetida não lança duas vezes", { skip }, () => {
    before(async () => {
        const [user] = await getDb().insert(users)
            .values({ email: `idempotencia-${randomUUID()}@teste.local`, passwordHash: "x" })
            .returning({ id: users.id });
        actorUserId = user.id;
    });
    after(async () => {
        await closeDb();
    });

    it("ajuste manual: mesmo requestId, em sequência e em paralelo, grava 1 lançamento", async () => {
        const contractId = await novoContrato();
        const requestId = randomUUID();
        const ajuste = {
            contractId,
            amountCents: -138110,
            entryDate: "2026-05-10",
            description: "Glosa de plantão em duplicidade",
            actorUserId,
            requestId,
        };

        const [a, b] = await Promise.all([recordManualAdjustment(ajuste), recordManualAdjustment(ajuste)]);
        const c = await recordManualAdjustment(ajuste);

        assert.equal([a, b].filter((r) => r.replayed).length, 1);
        assert.equal(c.replayed, true);
        assert.equal(c.amountCents, -138110);
        assert.equal(c.entryDate, "2026-05-10");
        assert.equal((await lancamentos(contractId, "manual_adjustment")).length, 1);
    });

    it("ajuste manual sem requestId continua lançando a cada chamada", async () => {
        const contractId = await novoContrato();
        const ajuste = {
            contractId,
            amountCents: 50000,
            entryDate: "2026-05-10",
            description: "Dobra de plantão",
            actorUserId,
        };
        await recordManualAdjustment(ajuste);
        await recordManualAdjustment(ajuste);
        assert.equal((await lancamentos(contractId, "manual_adjustment")).length, 2);
    });

    it("correção de saldo (âncora) reenviada devolve a já aplicada", async () => {
        const contractId = await novoContrato();
        const anchor = {
            contractId,
            targetBalanceCents: 10000000,
            anchorDate: "2026-05-01",
            description: "Saldo conferido na planilha",
            actorUserId,
            requestId: randomUUID(),
        };
        const primeira = await recordBalanceAnchor(anchor);
        const reenvio = await recordBalanceAnchor(anchor);

        assert.equal(primeira.replayed, false);
        assert.equal(reenvio.replayed, true);
        assert.equal(reenvio.deltaCents, primeira.deltaCents);
        assert.equal((await lancamentos(contractId, "manual_adjustment")).length, 1);
    });

    it("abertura em paralelo: só uma entra, a outra recebe o erro de sempre", async () => {
        const contractId = await novoContrato();
        const abertura = { contractId, balanceCents: 16573200, entryDate: "2026-01-01", actorUserId };
        const resultados = await Promise.allSettled([recordOpeningBalance(abertura), recordOpeningBalance(abertura)]);

        assert.equal(resultados.filter((r) => r.status === "fulfilled").length, 1);
        const recusa = resultados.find((r) => r.status === "rejected") as PromiseRejectedResult;
        assert.match(String(recusa.reason), /já tem saldo de abertura/);
        assert.equal((await lancamentos(contractId, "opening")).length, 1);
    });
});
