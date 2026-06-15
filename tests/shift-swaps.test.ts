import assert from "node:assert/strict";
import test from "node:test";
import {
    type CoverageShift,
    type CoverageSwap,
    resolveEffectiveShiftOwner,
    resolveShiftCoverages,
} from "@/modules/shift-swaps/coverage";

const ANA = "doc-ana";
const VICTOR = "doc-victor";
const BELINA = "doc-belina";
const EMERSON = "doc-emerson";
const CARLA = "doc-carla";

function shift(id: string, doctorId: string, overrides: Partial<CoverageShift> = {}): CoverageShift {
    return {
        id,
        domain: "intervention",
        postId: null,
        baseId: 40,
        doctorId,
        roleLabel: "SD",
        ...overrides,
    };
}

let swapSequence = 0;

function approvedSwap(overrides: Partial<CoverageSwap> & Pick<CoverageSwap, "shiftId" | "swapType" | "fromDoctorId" | "toDoctorId">): CoverageSwap {
    swapSequence += 1;
    return {
        id: `swap-${swapSequence}`,
        counterpartShiftId: null,
        toPostId: null,
        toBaseId: null,
        toRoleLabel: null,
        status: "approved",
        approvedAt: new Date(Date.UTC(2026, 6, 1, 10, 0, swapSequence)),
        ...overrides,
    };
}

test("sem troca: dono efetivo é o próprio escalado", () => {
    const anaShift = shift("shift-ana", ANA);
    const coverage = resolveEffectiveShiftOwner(anaShift, [], []);

    assert.equal(coverage.originalDoctorId, ANA);
    assert.equal(coverage.effectiveDoctorId, ANA);
    assert.equal(coverage.effectiveTarget.baseId, 40);
    assert.equal(coverage.chain.length, 0);
});

test("transfer simples: Victor está por Ana", () => {
    const anaShift = shift("shift-ana", ANA);
    const coverage = resolveEffectiveShiftOwner(anaShift, [], [
        approvedSwap({ shiftId: "shift-ana", swapType: "transfer", fromDoctorId: ANA, toDoctorId: VICTOR }),
    ]);

    assert.equal(coverage.originalDoctorId, ANA);
    assert.equal(coverage.effectiveDoctorId, VICTOR);
    // O local previsto da linhagem não muda com transfer.
    assert.equal(coverage.effectiveTarget.baseId, 40);
});

test("cadeia A→B→C: o último da cadeia está pelo escalado original", () => {
    const anaShift = shift("shift-ana", ANA);
    const coverage = resolveEffectiveShiftOwner(anaShift, [], [
        approvedSwap({ shiftId: "shift-ana", swapType: "transfer", fromDoctorId: ANA, toDoctorId: VICTOR }),
        approvedSwap({ shiftId: "shift-ana", swapType: "transfer", fromDoctorId: VICTOR, toDoctorId: CARLA }),
    ]);

    assert.equal(coverage.originalDoctorId, ANA);
    assert.equal(coverage.effectiveDoctorId, CARLA);
    assert.equal(coverage.chain.length, 2);
});

test("mutual: os dois donos efetivos trocam entre as duas linhagens", () => {
    const anaShift = shift("shift-ana", ANA, { baseId: 40 });
    const emersonShift = shift("shift-emerson", EMERSON, { baseId: 2034 });
    const coverages = resolveShiftCoverages([anaShift, emersonShift], [
        approvedSwap({
            shiftId: "shift-ana",
            swapType: "mutual",
            fromDoctorId: ANA,
            toDoctorId: EMERSON,
            counterpartShiftId: "shift-emerson",
        }),
    ]);

    assert.equal(coverages.get("shift-ana")!.effectiveDoctorId, EMERSON);
    assert.equal(coverages.get("shift-emerson")!.effectiveDoctorId, ANA);
    // Mutual troca obrigações, não locais: cada um cumpre no alvo da linhagem assumida.
    assert.equal(coverages.get("shift-ana")!.effectiveTarget.baseId, 40);
    assert.equal(coverages.get("shift-emerson")!.effectiveTarget.baseId, 2034);
});

test("troca rejeitada não afeta a linhagem", () => {
    const anaShift = shift("shift-ana", ANA);
    const rejected: CoverageSwap = {
        ...approvedSwap({ shiftId: "shift-ana", swapType: "transfer", fromDoctorId: ANA, toDoctorId: VICTOR }),
        status: "rejected",
        approvedAt: null,
    };
    const coverage = resolveEffectiveShiftOwner(anaShift, [], [rejected]);

    assert.equal(coverage.effectiveDoctorId, ANA);
    assert.equal(coverage.chain.length, 0);
});

test("caso Ana/Victor/Belina: transfer + base_change mantém atribuição e muda local", () => {
    // Ana escalada na 40 passa para Victor; Victor troca base com Belina
    // (escalada na 2034) e assume na 2034. Victor está POR ANA na 2034;
    // Belina NÃO está por Ana — ela cumpre a linhagem dela na 40.
    const anaShift = shift("shift-ana", ANA, { baseId: 40 });
    const belinaShift = shift("shift-belina", BELINA, { baseId: 2034 });

    const coverages = resolveShiftCoverages([anaShift, belinaShift], [
        approvedSwap({ shiftId: "shift-ana", swapType: "transfer", fromDoctorId: ANA, toDoctorId: VICTOR }),
        approvedSwap({
            shiftId: "shift-ana",
            swapType: "base_change",
            fromDoctorId: VICTOR,
            toDoctorId: BELINA,
            counterpartShiftId: "shift-belina",
        }),
    ]);

    const anaLineage = coverages.get("shift-ana")!;
    const belinaLineage = coverages.get("shift-belina")!;

    assert.equal(anaLineage.originalDoctorId, ANA);
    assert.equal(anaLineage.effectiveDoctorId, VICTOR, "Victor está por Ana");
    assert.equal(anaLineage.effectiveTarget.baseId, 2034, "Victor cumpre na 2034, não no previsto para Ana");

    assert.equal(belinaLineage.originalDoctorId, BELINA);
    assert.equal(belinaLineage.effectiveDoctorId, BELINA, "Belina não está por Ana — segue na própria linhagem");
    assert.equal(belinaLineage.effectiveTarget.baseId, 40, "Belina cumpre na 40 após a troca de base");
});

test("caso Ana por Emerson: Ana passa o dela e cobre o de outro no mesmo dia", () => {
    // Ana passa o próprio plantão para Victor E pega o plantão de Emerson.
    // Relatório do dia: Victor por Ana; Ana por Emerson.
    const anaShift = shift("shift-ana", ANA, { baseId: 40 });
    const emersonShift = shift("shift-emerson", EMERSON, { baseId: 2034 });

    const coverages = resolveShiftCoverages([anaShift, emersonShift], [
        approvedSwap({ shiftId: "shift-ana", swapType: "transfer", fromDoctorId: ANA, toDoctorId: VICTOR }),
        approvedSwap({ shiftId: "shift-emerson", swapType: "transfer", fromDoctorId: EMERSON, toDoctorId: ANA }),
    ]);

    assert.equal(coverages.get("shift-ana")!.effectiveDoctorId, VICTOR, "Victor por Ana");
    assert.equal(coverages.get("shift-emerson")!.effectiveDoctorId, ANA, "Ana por Emerson");
});

test("function_change solo muda só a função da linhagem", () => {
    const anaShift = shift("shift-ana", ANA, { roleLabel: "SD" });
    const coverage = resolveEffectiveShiftOwner(anaShift, [], [
        approvedSwap({
            shiftId: "shift-ana",
            swapType: "function_change",
            fromDoctorId: ANA,
            toDoctorId: ANA,
            toRoleLabel: "SN",
        }),
    ]);

    assert.equal(coverage.effectiveDoctorId, ANA);
    assert.equal(coverage.effectiveTarget.roleLabel, "SN");
    assert.equal(coverage.effectiveTarget.baseId, 40);
});
