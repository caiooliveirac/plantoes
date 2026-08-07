/**
 * Recorte de banco de horas para o briefing do secretário.
 *
 * Nada de régua nova: quem decide o que é pendência de ±12h é
 * `resolveBankHoursPendingAction`, e quem separa o que conta a partir de
 * mai/2025 é `resolveBankHoursSettlementBalance` — a regra de acerto não
 * existia antes dessa data, então a parcela anterior nunca vira bônus nem
 * punição. Aqui só se escolhe o que mostrar e em que ordem.
 */
import { sql } from "drizzle-orm";

import { getDb } from "@/db";
import { formatDoctorSurfaceName } from "@/modules/doctors/directory";
import { resolveBankHoursPendingAction } from "@/modules/bank-hours/pending-actions";
import { loadBankHoursSettlementDeltaByDoctor } from "@/services/bank-hours-settlements.service";
import { getDoctorBankHoursEffectiveBalances } from "@/services/bank-hours-history.service";

/** Atraso a partir do qual a chegada é notícia (mesmo corte do histórico operacional). */
const ATRASO_MINIMO_MINUTOS = 15;
/** Janela dos atrasos recentes. */
const ATRASO_JANELA_DIAS = 14;
/** Quantos saldos entram no ranking dos piores. */
const PIORES = 12;

export interface BriefingBankHours {
    pendencias: {
        doctorName: string;
        displayName: string;
        /** `bonus` = o chefe paga 12h; `penalty` = o chefe desconta 12h. */
        direction: "bonus" | "penalty";
        /** Quantos plantões de 12h estão pendentes. */
        pendingUnits: number;
        eligibleMinutes: number;
        residualMinutes: number;
        /** Saldo andou contra os acertos já lançados: precisa de olho humano. */
        inconsistency: boolean;
    }[];
    /** Piores saldos contando SÓ o que se formou de mai/2025 em diante. */
    piores: {
        doctorName: string;
        displayName: string;
        recentMinutes: number;
        oldMinutes: number;
        totalMinutes: number;
    }[];
    atrasos: {
        doctorName: string;
        displayName: string;
        /** Dia da escala (America/Sao_Paulo), AAAA-MM-DD. */
        day: string;
        minutes: number;
        local: string | null;
    }[];
}

interface DoctorNameRow { id: string; full_name: string; display_name: string | null }

export async function loadBriefingBankHours(): Promise<BriefingBankHours> {
    const db = getDb();

    const [balances, settlementDelta, nomes, atrasos] = await Promise.all([
        getDoctorBankHoursEffectiveBalances(),
        loadBankHoursSettlementDeltaByDoctor(),
        db.execute(sql`select id, full_name, display_name from operations_v2.doctors`),
        db.execute(sql`
            select
                d.full_name,
                d.display_name,
                (e.scheduled_start_at at time zone 'America/Sao_Paulo')::date::text as day,
                e.arrival_delay_minutes as minutes,
                coalesce(ib.code, rp.code) as local
            from operations_v2.bank_hours_entries e
            join operations_v2.doctors d on d.id = e.doctor_id
            left join operations_v2.intervention_occupancies io on io.id = e.intervention_occupancy_id
            left join operations_v2.intervention_bases ib on ib.id = io.base_id
            left join operations_v2.regulation_occupancies ro on ro.id = e.regulation_occupancy_id
            left join operations_v2.regulation_posts rp on rp.id = ro.post_id
            where e.arrival_delay_minutes >= ${ATRASO_MINIMO_MINUTOS}
              and e.scheduled_start_at >= now() - ${sql.raw(`interval '${ATRASO_JANELA_DIAS} days'`)}
            order by e.scheduled_start_at desc
        `),
    ]);

    const porId = new Map<string, DoctorNameRow>(
        (nomes as unknown as DoctorNameRow[]).map((row) => [row.id, row]),
    );
    const identidade = (doctorId: string) => {
        const doctor = porId.get(doctorId);
        return {
            doctorName: doctor?.full_name ?? "médico não identificado",
            displayName: formatDoctorSurfaceName({
                fullName: doctor?.full_name,
                displayName: doctor?.display_name,
            }),
        };
    };

    const pendencias: BriefingBankHours["pendencias"] = [];
    const piores: BriefingBankHours["piores"] = [];

    for (const [doctorId, balance] of balances) {
        const action = resolveBankHoursPendingAction({
            bonusEligibleMinutes: balance.bonusEligibleMinutes,
            penaltyEligibleMinutes: balance.penaltyEligibleMinutes,
            settlementDeltaMinutes: settlementDelta.get(doctorId) ?? 0,
        });
        if (action.direction) {
            pendencias.push({
                ...identidade(doctorId),
                direction: action.direction,
                pendingUnits: action.pendingUnits,
                eligibleMinutes: action.direction === "bonus"
                    ? balance.bonusEligibleMinutes
                    : balance.penaltyEligibleMinutes,
                residualMinutes: action.residualMinutes,
                inconsistency: action.inconsistency,
            });
        }
        if (balance.recentMinutes !== 0) {
            piores.push({
                ...identidade(doctorId),
                recentMinutes: balance.recentMinutes,
                oldMinutes: balance.oldMinutes,
                totalMinutes: balance.totalMinutes,
            });
        }
    }

    // Pendência: mais unidades primeiro — 3 plantões de 12h pesam mais que 1.
    pendencias.sort((esquerda, direita) => direita.pendingUnits - esquerda.pendingUnits
        || Math.abs(direita.eligibleMinutes) - Math.abs(esquerda.eligibleMinutes));

    // Piores: maior distância do zero, para os dois lados. Um crédito enorme é
    // conta a pagar; uma dívida enorme é hora a descontar. Os dois são notícia.
    piores.sort((esquerda, direita) => Math.abs(direita.recentMinutes) - Math.abs(esquerda.recentMinutes));

    return {
        pendencias,
        piores: piores.slice(0, PIORES),
        atrasos: (atrasos as unknown as {
            full_name: string; display_name: string | null; day: string; minutes: number; local: string | null;
        }[]).map((row) => ({
            doctorName: row.full_name,
            displayName: formatDoctorSurfaceName({ fullName: row.full_name, displayName: row.display_name }),
            day: row.day,
            minutes: Number(row.minutes),
            local: row.local,
        })),
    };
}
