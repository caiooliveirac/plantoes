import { asc } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, doctors, interventionBases, regulationPosts } from "@/db/schema";
import { getAuthSecret } from "@/lib/auth/server";
import { montarCaso } from "@/modules/extrator-caso/caso";
import { Mascara, type Legenda } from "@/modules/extrator-caso/mascara";
import { getBankHoursHistory } from "@/services/bank-hours-history.service";
import { getChiefPayableShiftsBoard } from "@/services/payable-shifts.service";

export interface CasoExtraido {
    /** JSON pronto para copiar: é a única parte que sai do servidor. */
    texto: string;
    /** Só para a tela do admin. Nunca vai junto do texto. */
    legenda: Legenda;
}

export async function listarMedicosDoExtrator() {
    return getDb()
        .select({ id: doctors.id, nome: doctors.fullName, ativo: doctors.isActive })
        .from(doctors)
        .orderBy(asc(doctors.fullName));
}

/** Só leitura, fora o registro de quem extraiu (audit_logs). */
export async function extrairCaso(params: {
    medicoId: string;
    mes: string;
    comTextos: boolean;
    atorUserId: string;
}): Promise<CasoExtraido | null> {
    const db = getDb();
    const [medicos, ramais, bases] = await Promise.all([
        db.select({ id: doctors.id, fullName: doctors.fullName, displayName: doctors.displayName }).from(doctors),
        db.select({ codigo: regulationPosts.code, rotulo: regulationPosts.label }).from(regulationPosts),
        db.select({ codigo: interventionBases.code, rotulo: interventionBases.label }).from(interventionBases),
    ]);
    if (!medicos.some((medico) => medico.id === params.medicoId)) {
        return null;
    }

    const [historico, fechamento] = await Promise.all([
        getBankHoursHistory({ doctorId: params.medicoId }),
        getChiefPayableShiftsBoard(params.mes),
    ]);

    const mascara = new Mascara({
        segredo: getAuthSecret(),
        mesAncora: params.mes,
        pessoas: medicos.map((medico) => ({ id: medico.id, nomes: [medico.fullName, medico.displayName] })),
        alvos: [
            ...ramais.map((ramal) => ({ dominio: "regulation" as const, ...ramal })),
            ...bases.map((base) => ({ dominio: "intervention" as const, ...base })),
        ],
    });
    const caso = montarCaso(
        {
            medicoId: params.medicoId,
            mes: params.mes,
            comTextos: params.comTextos,
            pagamento: fechamento.doctors.find((linha) => linha.doctorId === params.medicoId) ?? null,
            bancoDeHoras: historico.doctors.find((linha) => linha.doctorId === params.medicoId) ?? null,
        },
        mascara,
    );

    await db.insert(auditLogs).values({
        actorUserId: params.atorUserId,
        action: "admin.extrator_caso.extrair",
        entityType: "extrator_caso",
        entityId: params.medicoId,
        details: { mes: params.mes, comTextos: params.comTextos },
    });

    return { texto: JSON.stringify(caso, null, 2), legenda: mascara.legenda() };
}
