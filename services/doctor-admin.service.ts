import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, contracts, doctors } from "@/db/schema";
import { hojeEmSaoPaulo } from "@/lib/folha-ponto/emissao";
import { normalizeDoctorName } from "@/modules/doctors/importer";
import { recordOpeningBalance } from "@/services/contract-ledger.service";

export async function createDoctor(params: {
    fullName: string;
    displayName?: string | null;
    admittedAt?: string | null;
    eligibleRegulation: boolean;
    eligibleIntervention: boolean;
}) {
    const db = getDb();
    const normalizedName = normalizeDoctorName(params.fullName);
    if (!normalizedName) {
        throw new Error("Nome inválido.");
    }

    const existing = await db.query.doctors.findFirst({ where: eq(doctors.normalizedName, normalizedName) });
    if (existing) {
        throw new Error(`Já existe médico com este nome: ${existing.fullName}.`);
    }

    const [created] = await db.insert(doctors).values({
        fullName: params.fullName.trim(),
        displayName: params.displayName?.trim() || null,
        normalizedName,
        admittedAt: params.admittedAt ?? null,
        eligibleRegulation: params.eligibleRegulation,
        eligibleIntervention: params.eligibleIntervention,
    }).returning();

    return created;
}

/** Nº provisório: contracts.contract_number é NOT NULL e o número real chega depois. */
export const PENDING_CONTRACT_NUMBER = "A DEFINIR";

/**
 * Cadastro rápido do admin: médico + vínculo + (PJ) contrato com teto, tudo
 * numa transação. Antes o contrato era um passo manual no fechamento que
 * sempre ficava para trás — e médico sem contrato plantona sem teto vigiado
 * (docs/saldo-contrato/README.md). Estatutário não tem teto PJ: nasce sem
 * contrato.
 *
 * O contrato PJ nasce com ciclo de hoje a +1 ano e abertura igual ao teto
 * (nada consumido ainda). Número e mês de início se corrigem depois no modal
 * do fechamento (redefinir termos).
 */
export async function registerDoctor(params: {
    fullName: string;
    displayName: string | null;
    employmentType: "pj" | "estatutario";
    isSpecialist: boolean;
    /** Obrigatório para PJ; ignorado para estatutário. */
    ceilingBrl: number | null;
    weeklyHours: number | null;
    actorUserId: string;
}) {
    const db = getDb();
    const normalizedName = normalizeDoctorName(params.fullName);
    if (!normalizedName) {
        throw new Error("Nome inválido.");
    }
    if (params.employmentType === "pj" && !(params.ceilingBrl && params.ceilingBrl > 0)) {
        throw new Error("PJ precisa do valor do contrato.");
    }

    const existing = await db.query.doctors.findFirst({ where: eq(doctors.normalizedName, normalizedName) });
    if (existing) {
        throw new Error(`Já existe médico com este nome: ${existing.fullName}.`);
    }

    const cycleStart = hojeEmSaoPaulo();
    const cycleEnd = `${Number(cycleStart.slice(0, 4)) + 1}${cycleStart.slice(4)}`;

    const result = await db.transaction(async (tx) => {
        const [doctor] = await tx.insert(doctors).values({
            fullName: params.fullName.trim(),
            displayName: params.displayName?.trim() || null,
            normalizedName,
            metadata: {
                employmentType: params.employmentType,
                paymentProfile: { isSpecialist: params.isSpecialist },
            },
        }).returning();

        if (params.employmentType !== "pj" || !params.ceilingBrl) {
            return { doctor, contractId: null as string | null };
        }

        const [contract] = await tx.insert(contracts).values({
            doctorId: doctor.id,
            contractNumber: PENDING_CONTRACT_NUMBER,
            category: params.isSpecialist ? "especialista" : "generalista",
            weeklyHours: params.weeklyHours === null ? null : String(params.weeklyHours),
            ceilingAmount: params.ceilingBrl.toFixed(2),
            cycleStart,
            cycleEnd,
            startedAt: cycleStart,
            notes: "Criado no cadastro do médico; conferir nº do contrato e mês de início.",
            createdByUserId: params.actorUserId,
        }).returning({ id: contracts.id });

        await recordOpeningBalance({
            contractId: contract.id,
            balanceCents: Math.round(params.ceilingBrl * 100),
            entryDate: cycleStart,
            actorUserId: params.actorUserId,
            tx,
        });

        return { doctor, contractId: contract.id };
    });

    await db.insert(auditLogs).values({
        actorUserId: params.actorUserId,
        action: "doctor.register",
        entityType: "doctor",
        entityId: result.doctor.id,
        details: { ...params, contractId: result.contractId },
    });

    return result;
}
