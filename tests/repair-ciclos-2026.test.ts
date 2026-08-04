/**
 * Conserto dos ciclos 2026→2025 (scripts/repair-ciclos-2026.ts): o planner puro.
 * A regra que não pode quebrar: só corrige quem ainda está EXATAMENTE com o
 * valor errado conhecido — qualquer outra coisa fica intocada.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CICLO_FIXES, planCicloFix, plusOneYear } from "@/scripts/repair-ciclos-2026";

describe("planCicloFix — guardas", () => {
    const fix = CICLO_FIXES[0]; // Claudio: errado 2026-10-01, correto 2025-10-01

    it("contrato com o valor errado conhecido é corrigido", () => {
        assert.equal(planCicloFix(fix, { cycleStart: "2026-10-01", status: "active" }), "corrigir");
    });

    it("já corrigido não é tocado de novo (idempotência)", () => {
        assert.equal(planCicloFix(fix, { cycleStart: "2025-10-01", status: "active" }), "ja_corrigido");
    });

    it("qualquer outro cycle_start é divergência — nada feito", () => {
        assert.equal(planCicloFix(fix, { cycleStart: "2026-01-01", status: "active" }), "divergente");
    });

    it("contrato não ativo é divergência", () => {
        assert.equal(planCicloFix(fix, { cycleStart: "2026-10-01", status: "terminated" }), "divergente");
    });
});

describe("a janela corrigida", () => {
    it("todos os 7 apontam para ciclos 2025→2026 que contêm maio e agosto de 2026", () => {
        for (const fix of CICLO_FIXES) {
            const end = plusOneYear(fix.newCycleStart);
            assert.ok(fix.newCycleStart <= "2026-05-01", `${fix.doctorName}: início ${fix.newCycleStart}`);
            assert.ok(end > "2026-08-04", `${fix.doctorName}: fim ${end}`);
            assert.equal(fix.wrongCycleStart, plusOneYear(fix.newCycleStart).slice(0, 4) + fix.newCycleStart.slice(4));
        }
    });
});
