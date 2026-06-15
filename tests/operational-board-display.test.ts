import assert from "node:assert/strict";
import test from "node:test";
import { compareRootBoardRegulationCodes, resolvePendingRegulationOccupantLabel, shouldShowRegulationCardOnRootBoard } from "@/modules/operational/board-display";

test("root board keeps nucleo before PIAM at the end of day shift ordering", () => {
    assert.deepEqual(
        ["1366", "PIAM", "2031", "NUCLEO", "1321"].sort((left, right) => compareRootBoardRegulationCodes(left, right, "SD")),
        ["2031", "1321", "1366", "NUCLEO", "PIAM"],
    );
});

test("root board keeps PIAM as the last visible regulation post at night", () => {
    assert.deepEqual(
        ["1366", "PIAM", "2031", "1321"].sort((left, right) => compareRootBoardRegulationCodes(left, right, "SN")),
        ["2031", "1321", "1366", "PIAM"],
    );
});

test("root board keeps 2151 and 2032 prioritized on P shift like daytime", () => {
    assert.deepEqual(
        ["1366", "2032", "2151", "2031", "1321"].sort((left, right) => compareRootBoardRegulationCodes(left, right, "P")),
        ["2031", "2151", "2032", "1321", "1366"],
    );
});

test("role-based ordering: CP → MRV → RECIP → PSIQ → normais → COI → NUCLEO → PIAM", () => {
    const cards = [
        { code: "PIAM",  roleLabel: null },
        { code: "2100",  roleLabel: "PSIQ" },
        { code: "2200",  roleLabel: null },   // ramal normal sem papel
        { code: "2032",  roleLabel: "MRV" },
        { code: "2151",  roleLabel: "MRV" },
        { code: "2031",  roleLabel: "CP" },
        { code: "1367",  roleLabel: "COI" },
        { code: "2300",  roleLabel: "RECIP" },
        { code: "NUCLEO", roleLabel: null },
    ];
    const result = [...cards]
        .sort((l, r) => compareRootBoardRegulationCodes(l, r, "SD"))
        .map((c) => c.code);
    assert.deepEqual(result, ["2031", "2032", "2151", "2300", "2100", "2200", "1367", "NUCLEO", "PIAM"]);
});

test("role-based: MRV em ramal nao-canonico vem antes de ramais normais", () => {
    // Chefe atribuiu MRV a 2080 e RECIP a 2032 (fora do padrao)
    const cards = [
        { code: "2032", roleLabel: "RECIP" },
        { code: "2080", roleLabel: "MRV" },
        { code: "2031", roleLabel: "CP" },
        { code: "2200", roleLabel: null },
    ];
    const result = [...cards]
        .sort((l, r) => compareRootBoardRegulationCodes(l, r, "SD"))
        .map((c) => c.code);
    assert.deepEqual(result, ["2031", "2080", "2032", "2200"]);
});

test("root board keeps PIAM pending visible on any shift and nucleo only on SD", () => {
    assert.equal(shouldShowRegulationCardOnRootBoard({
        postCode: "PIAM",
        status: "waiting",
        doctorId: null,
        shiftLabel: "SD",
    }), true);

    assert.equal(shouldShowRegulationCardOnRootBoard({
        postCode: "PIAM",
        status: "waiting",
        doctorId: null,
        shiftLabel: "SN",
    }), true);

    assert.equal(shouldShowRegulationCardOnRootBoard({
        postCode: "NUCLEO",
        status: "waiting",
        doctorId: null,
        shiftLabel: "SD",
    }), true);

    assert.equal(shouldShowRegulationCardOnRootBoard({
        postCode: "NUCLEO",
        status: "waiting",
        doctorId: null,
        shiftLabel: "SN",
    }), false);
});

test("pending nucleo is displayed as remanejado para CRU", () => {
    assert.equal(resolvePendingRegulationOccupantLabel("NUCLEO"), "REMANEJADO PARA CRU");
    assert.equal(resolvePendingRegulationOccupantLabel("1366"), "Aguardando confirmação");
});

test("disabled regulation posts stay visible on the root board regardless of shift", () => {
    assert.equal(shouldShowRegulationCardOnRootBoard({
        postCode: "1366",
        status: "disabled",
        doctorId: null,
        shiftLabel: "SN",
    }), true);

    assert.equal(shouldShowRegulationCardOnRootBoard({
        postCode: "NUCLEO",
        status: "disabled",
        doctorId: null,
        shiftLabel: "SN",
    }), true);
});