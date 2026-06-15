import assert from "node:assert/strict";
import test from "node:test";
import { bonusIcons } from "@/services/shift-offers.service";

test("bonusIcons: um $ a cada R$100", () => {
    assert.equal(bonusIcons(0), "");
    assert.equal(bonusIcons(99), "");
    assert.equal(bonusIcons(100), "$");
    assert.equal(bonusIcons(250), "$$");
    assert.equal(bonusIcons(500), "$$$$$");
});

test("bonusIcons: acima do teto vira $×cap com sinal de +", () => {
    assert.equal(bonusIcons(1000), "$$$$$$$$$$");
    assert.equal(bonusIcons(1500), "$$$$$$$$$$+");
    assert.equal(bonusIcons(300, 2), "$$+");
});
