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