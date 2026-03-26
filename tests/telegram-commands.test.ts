import assert from "node:assert/strict";
import test from "node:test";
import { parseTelegramCommand } from "@/modules/telegram/commands";
import { buildGroupCorrectionAnnouncement, pickTelegramReply } from "@/modules/telegram/replies";
import { hasTelegramOperationalJustification } from "@/modules/telegram/service";

test("parseTelegramCommand parses corrigir with target, full name and time", () => {
    const parsed = parseTelegramCommand("/corrigir PM04 Marcela Souza 20:00");

    assert.equal(parsed?.name, "corrigir");
    assert.equal(parsed?.sector, "INTERVENTION");
    assert.equal(parsed?.targetCode, "PM04");
    assert.equal(parsed?.doctorName, "Marcela Souza");
    assert.equal(parsed?.time, "20:00");
});

test("parseTelegramCommand parses retirar with target and time", () => {
    const parsed = parseTelegramCommand("/retirar 2031 19:05");

    assert.equal(parsed?.name, "retirar");
    assert.equal(parsed?.sector, "REGULATION");
    assert.equal(parsed?.targetCode, "2031");
    assert.equal(parsed?.time, "19:05");
    assert.equal(parsed?.isDeparture, false);
});

test("parseTelegramCommand parses saiu alias as departure command", () => {
    const parsed = parseTelegramCommand("/saiu PP20 08:35");

    assert.equal(parsed?.name, "retirar");
    assert.equal(parsed?.sector, "INTERVENTION");
    assert.equal(parsed?.targetCode, "PP20");
    assert.equal(parsed?.time, "08:35");
    assert.equal(parsed?.isDeparture, true);
});

test("parseTelegramCommand parses corrigir with departure wording", () => {
    const parsed = parseTelegramCommand("/corrigir Emmanuelle PP20 saiu 08:35");

    assert.equal(parsed?.name, "corrigir");
    assert.equal(parsed?.sector, "INTERVENTION");
    assert.equal(parsed?.targetCode, "PP20");
    assert.equal(parsed?.doctorName, "Emmanuelle");
    assert.equal(parsed?.time, "08:35");
    assert.equal(parsed?.isDeparture, true);
});

test("parseTelegramCommand parses remover with base alias", () => {
    const parsed = parseTelegramCommand("/remover na 04");

    assert.equal(parsed?.name, "remover");
    assert.equal(parsed?.sector, "INTERVENTION");
    assert.equal(parsed?.targetCode, "PM04");
});

test("pickTelegramReply supports polite command denial", () => {
    const reply = pickTelegramReply("command_forbidden", 7, {});

    assert.match(reply, /chef/i);
});

test("pickTelegramReply supports casual smalltalk without sounding like an error", () => {
    const reply = pickTelegramReply("casual_smalltalk", 11, {});

    assert.ok(reply.length > 0);
    assert.doesNotMatch(reply, /nao consegui|nao entendi|erro/i);
    assert.match(reply, /\^\^|:\)/);
});

test("pickTelegramReply describes continuation without resetting arrival", () => {
    const reply = pickTelegramReply("continuation_recorded", 17, {
        name: "Taiane Pinto Menezes",
        target: "BR05",
        time: "19:00",
    });

    assert.match(reply, /continua|continuidade/i);
    assert.match(reply, /chegada original|nao zerei a chegada|preservada/i);
});

test("pickTelegramReply prefixes unresolved replies with emoticon", () => {
    const reply = pickTelegramReply("name_unresolved", 21, {});

    assert.match(reply, /^:\/|^:\(|^:\|/);
});

test("buildGroupCorrectionAnnouncement creates playful group summary", () => {
    const reply = buildGroupCorrectionAnnouncement(9, {
        name: "Gabriel Carvalho Monteiro",
        target: "CZ50",
        time: "07:00",
    });

    assert.match(reply, /Gabriel Carvalho Monteiro/);
    assert.match(reply, /CZ50/);
    assert.match(reply, /07:00/);
});

test("hasTelegramOperationalJustification rejects bare departure commands after stripping operational tokens", () => {
    assert.equal(
        hasTelegramOperationalJustification("/saiu PP20 19:20", ["PP20", "19:20"]),
        false,
    );
});

test("hasTelegramOperationalJustification accepts written operational reason", () => {
    assert.equal(
        hasTelegramOperationalJustification(
            "/saiu PP20 19:20 motivo cobertura estendida por sala vermelha",
            ["PP20", "19:20"],
        ),
        true,
    );
});

test("hasTelegramOperationalJustification accepts continuation messages only when there is real free text", () => {
    assert.equal(
        hasTelegramOperationalJustification("PP20 Maria Silva 07:20 P", ["PP20", "Maria Silva", "07:20", "P"]),
        false,
    );

    assert.equal(
        hasTelegramOperationalJustification(
            "PP20 Maria Silva 07:20 P motivo aguardando liberacao da sala vermelha",
            ["PP20", "Maria Silva", "07:20", "P"],
        ),
        true,
    );
});