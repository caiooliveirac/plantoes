import assert from "node:assert/strict";
import test from "node:test";
import { applyShadowMarkerToOccupancyNotes } from "@/modules/operational/corrections";

// Toggle de sombra do remanejamento: a detecção de sombra em todo o sistema é por
// notas (notes ~* SOMBRA). Ao remanejar, asShadow=true garante marcador; asShadow=false
// remove marcadores e o token "sombra" solto. Idempotente nos dois sentidos.

test("asShadow=true adiciona marcador quando não há sombra", () => {
    assert.equal(
        applyShadowMarkerToOccupancyNotes("Yngra PM40 07:10", true),
        "[sombra] Yngra PM40 07:10",
    );
});

test("asShadow=true é idempotente (já tem marcador / já tem a palavra)", () => {
    assert.equal(
        applyShadowMarkerToOccupancyNotes("[telegram sombra] Yngra 2152", true),
        "[telegram sombra] Yngra 2152",
    );
    assert.equal(
        applyShadowMarkerToOccupancyNotes("Yngra sombra 2152", true),
        "Yngra sombra 2152",
    );
});

test("asShadow=false remove o marcador bracket e o token solto", () => {
    // marcador admin
    assert.equal(applyShadowMarkerToOccupancyNotes("[sombra] Yngra 2152", false), "Yngra 2152");
    // marcador telegram
    assert.equal(applyShadowMarkerToOccupancyNotes("[telegram sombra] Yngra 2152", false), "Yngra 2152");
    // token solto na mensagem original
    assert.equal(applyShadowMarkerToOccupancyNotes("Yngra sombra 2152 SD", false), "Yngra 2152 SD");
});

test("asShadow=false: resultado não é mais detectado como sombra", () => {
    const cleaned = applyShadowMarkerToOccupancyNotes("[telegram sombra] Yngra sombra 2152", false) ?? "";
    const normalized = cleaned.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
    assert.equal(/\bSOMBRA\b/.test(normalized), false);
    assert.equal(normalized.includes("[TELEGRAM SOMBRA]"), false);
});

test("asShadow=false em notas vazias/só-marcador retorna null", () => {
    assert.equal(applyShadowMarkerToOccupancyNotes("[sombra]", false), null);
    assert.equal(applyShadowMarkerToOccupancyNotes(null, false), null);
});

test("asShadow=true é idempotente após um round-trip de remoção", () => {
    const off = applyShadowMarkerToOccupancyNotes("[sombra] Indira 2152", false);
    const on = applyShadowMarkerToOccupancyNotes(off, true);
    assert.equal(on, "[sombra] Indira 2152");
});
