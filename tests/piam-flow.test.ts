import assert from "node:assert/strict";
import test from "node:test";
import {
    isTelegramRoleCommandText,
    parseTelegramRoleCommand,
} from "@/modules/telegram/role-commands";
import { buildPiamAlreadyPresentReply, resolvePiamShiftBounds } from "@/modules/telegram/service";
import { isRegulationShadowOccupancyNotes } from "@/modules/regulation/service";
import { resolveDoctorPaymentProfile } from "@/modules/reporting/payable-shifts";

test("parseTelegramRoleCommand recognizes assign by bare name", () => {
    const parsed = parseTelegramRoleCommand("/piam Aline Cardoso");
    assert.equal(parsed?.action, "assign");
    assert.equal(parsed?.config.role, "PIAM");
    assert.equal(parsed?.rawBody, "Aline Cardoso");
    if (parsed?.action === "assign") {
        assert.equal(parsed.lookup, "Aline Cardoso");
    }
});

test("parseTelegramRoleCommand recognizes remove variants", () => {
    for (const command of [
        "/piam remover Aline Cardoso",
        "/piam remove Aline Cardoso",
        "/piam rm Aline Cardoso",
        "/piam tirar Aline Cardoso",
        "/piam desmarcar Aline Cardoso",
    ]) {
        const parsed = parseTelegramRoleCommand(command);
        assert.equal(parsed?.action, "unassign", `${command} should parse as unassign`);
        if (parsed?.action === "unassign") {
            assert.equal(parsed.lookup, "Aline Cardoso");
        }
    }
});

test("parseTelegramRoleCommand handles listar variants", () => {
    for (const command of ["/piam listar", "/piam list", "/piam ls"]) {
        const parsed = parseTelegramRoleCommand(command);
        assert.equal(parsed?.action, "list", `${command} should be a list command`);
    }
});

test("parseTelegramRoleCommand returns null on empty body", () => {
    assert.equal(parseTelegramRoleCommand("/piam"), null);
    assert.equal(parseTelegramRoleCommand("/piam   "), null);
    assert.equal(parseTelegramRoleCommand("/psiq"), null);
});

test("isTelegramRoleCommandText only matches /piam and /psiq", () => {
    assert.equal(isTelegramRoleCommandText("/piam Aline"), true);
    assert.equal(isTelegramRoleCommandText("/piam@bot Aline"), true);
    assert.equal(isTelegramRoleCommandText("/psiq Larissa Osthues"), true);
    assert.equal(isTelegramRoleCommandText("Aline /piam"), false);
    assert.equal(isTelegramRoleCommandText("/medico cadastrar Aline"), false);
});

test("/psiq assigns the PSIQ role and keeps the same assign/unassign/list grammar", () => {
    const assign = parseTelegramRoleCommand("/psiq Larissa Osthues");
    assert.equal(assign?.config.role, "PSIQ");
    assert.equal(assign?.config.command, "psiq");
    assert.equal(assign?.action, "assign");
    if (assign?.action === "assign") {
        assert.equal(assign.lookup, "Larissa Osthues");
    }

    const unassign = parseTelegramRoleCommand("/psiq remover Larissa Osthues");
    assert.equal(unassign?.action, "unassign");
    assert.equal(unassign?.config.role, "PSIQ");

    assert.equal(parseTelegramRoleCommand("/psiq listar")?.action, "list");
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
