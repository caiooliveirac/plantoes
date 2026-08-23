import assert from "node:assert/strict";
import test from "node:test";
import { applyShadowMarkerToOccupancyNotes, resolveRearrivalNotes, shouldPromoteShadowToBoardOnRearrival } from "@/modules/operational/shadow";

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

// ── Promoção de sombra a titular ─────────────────────────────────────────────
// Sombra nunca assume o quadro (PR #224). Sem promoção ela não teria saída pelo
// Telegram: redeclarar caía no caminho de re-chegada, que preserva board nulo.
test("shouldPromoteShadowToBoardOnRearrival: sombra redeclarada sem a palavra vira titular", () => {
    assert.equal(shouldPromoteShadowToBoardOnRearrival({
        existingHasBoard: false,
        existingIsShadow: true,
        existingIsDisplaced: false,
        arrivingIsShadow: false,
        hasOtherBoardCarrier: false,
    }), true);
});

test("shouldPromoteShadowToBoardOnRearrival: sombra reenviada COMO sombra segue sombra", () => {
    assert.equal(shouldPromoteShadowToBoardOnRearrival({
        existingHasBoard: false,
        existingIsShadow: true,
        existingIsDisplaced: false,
        arrivingIsShadow: true,
        hasOtherBoardCarrier: false,
    }), false);
});

// O índice único de um board por alvo levantaria 23505 cru. Com titular no quadro
// a ocupação segue sombra, coexistindo — que é exatamente o que ela é.
test("shouldPromoteShadowToBoardOnRearrival: com titular no quadro NÃO promove", () => {
    assert.equal(shouldPromoteShadowToBoardOnRearrival({
        existingHasBoard: false,
        existingIsShadow: true,
        existingIsDisplaced: false,
        arrivingIsShadow: false,
        hasOtherBoardCarrier: true,
    }), false);
});

// Quem perdeu o quadro numa tomada volta declarando posição nova, não reassumindo
// esta. As notas do caso Vaner trazem os DOIS marcadores.
test("shouldPromoteShadowToBoardOnRearrival: deslocado não é sombra promovível", () => {
    assert.equal(shouldPromoteShadowToBoardOnRearrival({
        existingHasBoard: false,
        existingIsShadow: true,
        existingIsDisplaced: true,
        arrivingIsShadow: false,
        hasOtherBoardCarrier: false,
    }), false);
});

test("shouldPromoteShadowToBoardOnRearrival: quem já tem o quadro não é promovido", () => {
    assert.equal(shouldPromoteShadowToBoardOnRearrival({
        existingHasBoard: true,
        existingIsShadow: false,
        existingIsDisplaced: false,
        arrivingIsShadow: false,
        hasOtherBoardCarrier: false,
    }), false);
});

// Na promoção o marcador tem que sair das notas: é ele que o painel e o pagamento
// consultam. Se ficasse, a ocupação promovida seguiria sendo lida como sombra.
test("resolveRearrivalNotes: promoção anexa a mensagem nova e limpa o marcador", () => {
    const notes = resolveRearrivalNotes({
        existingNotes: "[telegram sombra] Vaner Sombra SD 2031",
        incomingNotes: "Vaner P 2031",
        promotingShadow: true,
    }) ?? "";
    assert.doesNotMatch(notes, /sombra/i);
    assert.match(notes, /Vaner P 2031/);
});

test("resolveRearrivalNotes: re-chegada comum só anexa, sem mexer nas notas", () => {
    assert.equal(
        resolveRearrivalNotes({
            existingNotes: "[telegram sombra] Yngra 2152",
            incomingNotes: "Yngra sombra 2152",
            promotingShadow: false,
        }),
        "[telegram sombra] Yngra 2152\nYngra sombra 2152",
    );
    assert.equal(
        resolveRearrivalNotes({ existingNotes: "Fulano 2153", incomingNotes: null, promotingShadow: false }),
        "Fulano 2153",
    );
});
