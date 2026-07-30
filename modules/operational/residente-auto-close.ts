import { and, inArray, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { doctors, interventionOccupancies, regulationOccupancies } from "@/db/schema";
import { extractDoctorIsResidente } from "@/modules/doctors/directory";
import { endRegulationOccupancy } from "@/modules/regulation/service";
import { endInterventionOccupancy } from "@/modules/intervention/service";

async function loadResidenteDoctorIds(): Promise<string[]> {
    const rows = await getDb()
        .select({ id: doctors.id, metadata: doctors.metadata })
        .from(doctors);
    return rows.filter((row) => extractDoctorIsResidente(row.metadata)).map((row) => row.id);
}

/**
 * Residente é um cadastro coringa: ocupa qualquer posto/base sem gerar banco
 * de horas nem entrar em pagamento, e por isso não passa pela fila normal de
 * confirmação de saída do chefe. Fecha sozinho, no horário programado
 * (scheduledEndAt), qualquer ocupação sua ainda aberta — regulação já expira
 * sozinha para todo mundo via expireStaleRegulationOccupancies (chamada a
 * cada carregamento do board), mas intervenção titular só expira para
 * ocupações sombra/base diurna, daí o Residente precisar deste fechamento
 * dedicado nos dois domínios.
 */
export async function expireResidenteOccupancies(referenceAt: Date = new Date()) {
    const residenteDoctorIds = await loadResidenteDoctorIds();
    if (residenteDoctorIds.length === 0) {
        return { evaluated: 0, closed: 0 };
    }

    const db = getDb();
    const [openRegulation, openIntervention] = await Promise.all([
        db.query.regulationOccupancies.findMany({
            where: and(isNull(regulationOccupancies.endedAt), inArray(regulationOccupancies.doctorId, residenteDoctorIds)),
        }),
        db.query.interventionOccupancies.findMany({
            where: and(isNull(interventionOccupancies.endedAt), inArray(interventionOccupancies.doctorId, residenteDoctorIds)),
        }),
    ]);

    let evaluated = 0;
    let closed = 0;

    for (const occupancy of openRegulation) {
        evaluated += 1;
        if (!occupancy.scheduledEndAt || occupancy.scheduledEndAt.getTime() > referenceAt.getTime()) {
            continue;
        }
        await endRegulationOccupancy(occupancy.id, {
            endedAt: occupancy.scheduledEndAt,
            actualEndedAt: occupancy.scheduledEndAt,
            chiefConfirmed: true,
        });
        closed += 1;
    }

    for (const occupancy of openIntervention) {
        evaluated += 1;
        if (!occupancy.scheduledEndAt || occupancy.scheduledEndAt.getTime() > referenceAt.getTime()) {
            continue;
        }
        await endInterventionOccupancy(occupancy.id, {
            endedAt: occupancy.scheduledEndAt,
            actualEndedAt: occupancy.scheduledEndAt,
            chiefConfirmed: true,
        });
        closed += 1;
    }

    return { evaluated, closed };
}
