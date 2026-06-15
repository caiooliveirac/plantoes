import assert from "node:assert/strict";
import test from "node:test";
import {
    isTelegramPiamCommandText,
    parseTelegramPiamCommand,
} from "@/modules/telegram/piam-commands";
import { buildPiamAlreadyPresentReply, resolvePiamShiftBounds } from "@/modules/telegram/service";
import { isRegulationShadowOccupancyNotes } from "@/modules/regulation/service";
import { resolveDoctorPaymentProfile } from "@/modules/reporting/payable-shifts";

test("parseTelegramPiamCommand recognizes assign by bare name", () => {
    const parsed = parseTelegramPiamCommand("/piam Aline Cardoso");
    assert.deepEqual(parsed, {
        name: "piam_assign",
        lookup: "Aline Cardoso",
        rawBody: "Aline Cardoso",
    });
});

test("parseTelegramPiamCommand recognizes remove variants", () => {
    for (const command of [
        "/piam remover Aline Cardoso",
        "/piam remove Aline Cardoso",
        "/piam rm Aline Cardoso",
        "/piam tirar Aline Cardoso",
        "/piam desmarcar Aline Cardoso",
    ]) {
        const parsed = parseTelegramPiamCommand(command);
        assert.equal(parsed?.name, "piam_unassign", `${command} should parse as unassign`);
        if (parsed?.name === "piam_unassign") {
            assert.equal(parsed.lookup, "Aline Cardoso");
        }
    }
});

test("parseTelegramPiamCommand handles listar variants", () => {
    for (const command of ["/piam listar", "/piam list", "/piam ls"]) {
        const parsed = parseTelegramPiamCommand(command);
        assert.equal(parsed?.name, "piam_list", `${command} should be a list command`);
    }
});

test("parseTelegramPiamCommand returns null on empty body", () => {
    assert.equal(parseTelegramPiamCommand("/piam"), null);
    assert.equal(parseTelegramPiamCommand("/piam   "), null);
});

test("isTelegramPiamCommandText only matches the /piam command", () => {
    assert.equal(isTelegramPiamCommandText("/piam Aline"), true);
    assert.equal(isTelegramPiamCommandText("/piam@bot Aline"), true);
    assert.equal(isTelegramPiamCommandText("Aline /piam"), false);
    assert.equal(isTelegramPiamCommandText("/medico cadastrar Aline"), false);
});

test("resolvePiamShiftBounds anchors SD to 07:00-19:00 of the local day", () => {
    // Mensagem chegou as 12:30 BRT (15:30 UTC) — turno SD ja em curso.
    const eventAt = new Date("2026-05-12T15:30:00Z");
    const bounds = resolvePiamShiftBounds(eventAt, "SD");
    assert.equal(bounds.scheduledStartAt.toISOString(), "2026-05-12T10:00:00.000Z");
    assert.equal(bounds.scheduledEndAt.toISOString(), "2026-05-12T22:00:00.000Z");
});

test("resolvePiamShiftBounds anchors SN to 19:00-07:00+1 of the local day", () => {
    // Mensagem chegou as 20:30 BRT (23:30 UTC) — turno SN em curso.
    const eventAt = new Date("2026-05-12T23:30:00Z");
    const bounds = resolvePiamShiftBounds(eventAt, "SN");
    assert.equal(bounds.scheduledStartAt.toISOString(), "2026-05-12T22:00:00.000Z");
    assert.equal(bounds.scheduledEndAt.toISOString(), "2026-05-13T10:00:00.000Z");
});

test("resolvePiamShiftBounds for SD announced during SN window points to the upcoming SD", () => {
    // 04:00 BRT (07:00 UTC) — relogio esta em SN, mas medico declarou SD.
    // Deve apontar para o SD que comeca as 07:00 BRT do mesmo dia (10:00 UTC).
    const eventAt = new Date("2026-05-12T07:00:00Z");
    const bounds = resolvePiamShiftBounds(eventAt, "SD");
    assert.equal(bounds.scheduledStartAt.toISOString(), "2026-05-12T10:00:00.000Z");
    assert.equal(bounds.scheduledEndAt.toISOString(), "2026-05-12T22:00:00.000Z");
});

test("resolvePiamShiftBounds for SN announced during SD window points to the upcoming SN", () => {
    // 18:00 BRT (21:00 UTC) — relogio em SD; medico declarou SN.
    const eventAt = new Date("2026-05-12T21:00:00Z");
    const bounds = resolvePiamShiftBounds(eventAt, "SN");
    assert.equal(bounds.scheduledStartAt.toISOString(), "2026-05-12T22:00:00.000Z");
    assert.equal(bounds.scheduledEndAt.toISOString(), "2026-05-13T10:00:00.000Z");
});

test("resolveDoctorPaymentProfile maps PIAM to specialist", () => {
    assert.equal(
        resolveDoctorPaymentProfile({ preferredOperationalRole: "PIAM" }),
        "specialist",
    );
});

test("resolveDoctorPaymentProfile maps PSIQ to psychiatry (regression)", () => {
    assert.equal(
        resolveDoctorPaymentProfile({ preferredOperationalRole: "PSIQ" }),
        "psychiatry",
    );
});

test("resolveDoctorPaymentProfile falls back to generalist without role flags", () => {
    assert.equal(resolveDoctorPaymentProfile({}), "generalist");
    assert.equal(resolveDoctorPaymentProfile({ preferredOperationalRole: "RECIP" }), "generalist");
});

// Caso Polliana (2026-06-09): a chegada PIAM "sombra" deve ser reconhecida como
// sombra a partir do texto da mensagem — esse é o sinal que mantém a ocupação ABERTA
// (ended_at nulo) para que o painel a renderize pela query de sombra, em vez de fechá-la
// na hora como o titular.
test("handlePiamAutoArrival: mensagem PIAM sombra é reconhecida como sombra (mantém aberta)", () => {
    assert.equal(isRegulationShadowOccupancyNotes("[PIAM auto SD] Polliana Roriz sombra PIAM SD"), true);
    assert.equal(isRegulationShadowOccupancyNotes("[PIAM auto SD] Diego Aguiar PIAM SD"), false);
});

test("buildPiamAlreadyPresentReply: reinformar chegada não abre saída e orienta saída/remanejamento", () => {
    const reply = buildPiamAlreadyPresentReply("Pollianna", { role: "PIAM", shiftLabel: "SD", isShadow: true });
    assert.match(reply, /já está no plantão como \*PIAM\*/);
    assert.match(reply, /SD \(diurno\)/);
    assert.match(reply, /cobertura \*sombra\*/);
    assert.match(reply, /não cria duplicata nem abre saída/);
    assert.match(reply, /Saída/);
    assert.match(reply, /Remanejamento/);
    assert.match(reply, /preservando a chegada original/);
});

test("buildPiamAlreadyPresentReply: titular (não-sombra) noturno sem o sufixo de sombra", () => {
    const reply = buildPiamAlreadyPresentReply("Diego", { role: "PIAM", shiftLabel: "SN", isShadow: false });
    assert.match(reply, /SN \(noturno\)/);
    assert.doesNotMatch(reply, /cobertura \*sombra\*/);
});
