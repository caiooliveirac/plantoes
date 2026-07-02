/**
 * Resolução de cobertura de escala ("fulano está POR sicrano").
 *
 * Núcleo puro, sem banco: recebe os plantões previstos e as trocas e devolve,
 * por linhagem de plantão, quem cobre quem e onde a obrigação será cumprida.
 *
 * Regras (confirmadas com o coordenador):
 *   - Só trocas `approved` contam, aplicadas em ordem de `approvedAt`.
 *   - `transfer` move o médico efetivo da linhagem (Victor por Ana).
 *   - `mutual` é transfer nos dois sentidos entre duas linhagens.
 *   - `function_change`/`base_change` movem APENAS o local/função efetivos;
 *     a atribuição não muda (Victor segue por Ana mesmo assumindo na 2034).
 *     Com `counterpartShiftId`, os locais são trocados entre as duas
 *     linhagens; sem contraparte, valem os campos `toPostId`/`toBaseId`/
 *     `toRoleLabel`.
 *   - Linhagens são independentes: Ana pode passar o dela para Victor e, no
 *     mesmo dia, cobrir o plantão de Emerson.
 */

export type SwapType = "transfer" | "mutual" | "function_change" | "base_change";
export type SwapStatus = "offered" | "accepted" | "approved" | "rejected" | "cancelled";

export interface CoverageShift {
    id: string;
    domain: "regulation" | "intervention";
    postId: number | null;
    baseId: number | null;
    doctorId: string;
    roleLabel: string | null;
}

export interface CoverageSwap {
    id: string;
    shiftId: string;
    swapType: SwapType;
    fromDoctorId: string;
    toDoctorId: string;
    counterpartShiftId: string | null;
    toPostId: number | null;
    toBaseId: number | null;
    toRoleLabel: string | null;
    status: SwapStatus;
    approvedAt: Date | null;
}

export interface EffectiveTarget {
    domain: "regulation" | "intervention";
    postId: number | null;
    baseId: number | null;
    roleLabel: string | null;
}

export interface ShiftCoverage {
    shiftId: string;
    originalDoctorId: string;
    effectiveDoctorId: string;
    effectiveTarget: EffectiveTarget;
    /** Trocas aprovadas aplicadas a esta linhagem, em ordem cronológica. */
    chain: CoverageSwap[];
}

function initialCoverage(shift: CoverageShift): ShiftCoverage {
    return {
        shiftId: shift.id,
        originalDoctorId: shift.doctorId,
        effectiveDoctorId: shift.doctorId,
        effectiveTarget: {
            domain: shift.domain,
            postId: shift.postId,
            baseId: shift.baseId,
            roleLabel: shift.roleLabel,
        },
        chain: [],
    };
}

function swapTargets(left: ShiftCoverage, right: ShiftCoverage) {
    const leftTarget = left.effectiveTarget;
    left.effectiveTarget = right.effectiveTarget;
    right.effectiveTarget = leftTarget;
}

/**
 * Resolve a cobertura de um conjunto de plantões previstos aplicando as
 * trocas aprovadas em ordem cronológica de aprovação.
 */
export function resolveShiftCoverages(
    shifts: CoverageShift[],
    swaps: CoverageSwap[],
): Map<string, ShiftCoverage> {
    const coverages = new Map<string, ShiftCoverage>();
    for (const shift of shifts) {
        coverages.set(shift.id, initialCoverage(shift));
    }

    const approved = swaps
        .filter((swap) => swap.status === "approved" && swap.approvedAt)
        .sort((left, right) => left.approvedAt!.getTime() - right.approvedAt!.getTime());

    for (const swap of approved) {
        const lineage = coverages.get(swap.shiftId);
        if (!lineage) {
            continue;
        }

        const counterpart = swap.counterpartShiftId ? coverages.get(swap.counterpartShiftId) : null;

        switch (swap.swapType) {
            case "transfer": {
                // A troca só move a linhagem se quem passa é o coberto atual —
                // uma transfer aprovada fora de ordem/estado não corrompe a cadeia.
                if (lineage.effectiveDoctorId === swap.fromDoctorId) {
                    lineage.effectiveDoctorId = swap.toDoctorId;
                    lineage.chain.push(swap);
                }
                break;
            }
            case "mutual": {
                if (!counterpart) {
                    break;
                }
                if (lineage.effectiveDoctorId !== swap.fromDoctorId || counterpart.effectiveDoctorId !== swap.toDoctorId) {
                    break;
                }
                lineage.effectiveDoctorId = swap.toDoctorId;
                counterpart.effectiveDoctorId = swap.fromDoctorId;
                lineage.chain.push(swap);
                counterpart.chain.push(swap);
                break;
            }
            case "function_change":
            case "base_change": {
                // Muda o ONDE/COMO, nunca o POR QUEM.
                if (counterpart) {
                    swapTargets(lineage, counterpart);
                    lineage.chain.push(swap);
                    counterpart.chain.push(swap);
                    break;
                }

                lineage.effectiveTarget = {
                    domain: swap.toBaseId != null ? "intervention" : swap.toPostId != null ? "regulation" : lineage.effectiveTarget.domain,
                    postId: swap.toPostId ?? (swap.toBaseId != null ? null : lineage.effectiveTarget.postId),
                    baseId: swap.toBaseId ?? (swap.toPostId != null ? null : lineage.effectiveTarget.baseId),
                    roleLabel: swap.swapType === "function_change"
                        ? (swap.toRoleLabel ?? lineage.effectiveTarget.roleLabel)
                        : lineage.effectiveTarget.roleLabel,
                };
                lineage.chain.push(swap);
                break;
            }
        }
    }

    return coverages;
}

/** Dono efetivo de um único plantão previsto (quem está "por" o escalado). */
export function resolveEffectiveShiftOwner(
    shift: CoverageShift,
    relatedShifts: CoverageShift[],
    swaps: CoverageSwap[],
): ShiftCoverage {
    const universe = [shift, ...relatedShifts.filter((entry) => entry.id !== shift.id)];
    const coverages = resolveShiftCoverages(universe, swaps);
    return coverages.get(shift.id)!;
}
