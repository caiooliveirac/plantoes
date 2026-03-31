import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRegulationRamalLabel } from "@/modules/regulation/ramal-label";

test("normalizeRegulationRamalLabel usa sempre o post real quando o payload nao informa ramal", () => {
    assert.equal(normalizeRegulationRamalLabel({ actualPostCode: "2152" }), "2152");
    assert.equal(normalizeRegulationRamalLabel({ actualPostCode: "1368", requestedRamalLabel: null }), "1368");
});

test("normalizeRegulationRamalLabel rejeita divergencia entre ramalLabel e post real", () => {
    assert.throws(
        () => normalizeRegulationRamalLabel({ actualPostCode: "2152", requestedRamalLabel: "1368" }),
        /use remanejamento para trocar de ramal/i,
    );
});

test("normalizeRegulationRamalLabel aceita o mesmo ramal informado pelo cliente", () => {
    assert.equal(normalizeRegulationRamalLabel({ actualPostCode: "1368", requestedRamalLabel: "1368" }), "1368");
});