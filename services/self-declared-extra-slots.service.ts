/**
 * Colisão do plantão extra declarado pelo médico com o plantão que ele acabou
 * trabalhando de verdade.
 *
 * O extra é uma unidade de pagamento pendurada num dia+turno. Se o médico
 * declara o extra num turno e depois trabalha nesse mesmo turno, o dia passa a
 * ter duas unidades pelo mesmo slot — pagamento duplicado. A criação bloqueia o
 * caso já conhecido; a varredura diária pega o que aconteceu depois e remarca o
 * extra para o primeiro slot livre, avisando o coordenador.
 */
import { isPremiumRateDate } from "@/modules/operational/holidays";
import {
    findFreeExtraSlot,
    slotKey,
    type ExtraSlot,
} from "@/modules/reporting/self-declared-extra-slot";
import {
    loadSelfDeclaredExtrasForMonth,
    moveSelfDeclaredExtra,
} from "@/services/bank-hours-settlements.service";
import { getChiefPayableShiftsBoard } from "@/services/payable-shifts.service";

/** Slots (dia+turno) já tomados por plantão REAL, por médico. */
export async function loadWorkedSlotsByDoctor(monthKey: string): Promise<Map<string, Set<string>>> {
    const board = await getChiefPayableShiftsBoard(monthKey);
    const byDoctor = new Map<string, Set<string>>();
    for (const shift of board.payableShifts) {
        if (shift.paymentUnit <= 0 || shift.source === "admin_extra") continue;
        const bucket = byDoctor.get(shift.doctorId) ?? new Set<string>();
        bucket.add(slotKey({ operationalDate: shift.operationalDate, shiftLabel: shift.shiftLabel }));
        byDoctor.set(shift.doctorId, bucket);
    }
    return byDoctor;
}

/** O médico já trabalhou nesse dia+turno? (guard da criação/edição do extra) */
export async function hasWorkedSlot(params: {
    monthKey: string;
    doctorId: string;
    operationalDate: string;
    shiftLabel: "SD" | "SN";
}): Promise<boolean> {
    const worked = (await loadWorkedSlotsByDoctor(params.monthKey)).get(params.doctorId);
    return Boolean(worked?.has(slotKey(params)));
}

export interface SelfDeclaredExtraMove {
    doctorId: string;
    settlementId: string;
    from: ExtraSlot;
    to: ExtraSlot | null;
}

/**
 * Remarca todo extra declarado que caiu em cima de um plantão realmente
 * trabalhado. `to: null` = o mês inteiro está tomado; aí não mexe em nada e o
 * coordenador decide (o aviso sai com a mesma lista).
 */
export async function relocateCollidingSelfDeclaredExtras(monthKey: string): Promise<SelfDeclaredExtraMove[]> {
    const [workedByDoctor, extras] = await Promise.all([
        loadWorkedSlotsByDoctor(monthKey),
        loadSelfDeclaredExtrasForMonth(monthKey),
    ]);

    // Um extra não pode pousar em cima de outro extra do mesmo médico.
    const takenByDoctor = new Map<string, Set<string>>();
    for (const [doctorId, worked] of workedByDoctor) {
        takenByDoctor.set(doctorId, new Set(worked));
    }
    for (const extra of extras) {
        const bucket = takenByDoctor.get(extra.doctorId) ?? new Set<string>();
        bucket.add(slotKey(extra));
        takenByDoctor.set(extra.doctorId, bucket);
    }

    const moves: SelfDeclaredExtraMove[] = [];
    for (const extra of extras) {
        const worked = workedByDoctor.get(extra.doctorId);
        const from: ExtraSlot = { operationalDate: extra.operationalDate, shiftLabel: extra.shiftLabel };
        if (!worked?.has(slotKey(from))) continue;

        const taken = takenByDoctor.get(extra.doctorId) ?? new Set<string>();
        const to = findFreeExtraSlot({
            current: from,
            monthKey,
            occupied: taken,
            isPremium: isPremiumRateDate,
        });
        if (to) {
            await moveSelfDeclaredExtra({ adminExtraShiftId: extra.adminExtraShiftId, ...to });
            taken.delete(slotKey(from));
            taken.add(slotKey(to));
        }
        moves.push({ doctorId: extra.doctorId, settlementId: extra.settlementId, from, to });
    }
    return moves;
}
