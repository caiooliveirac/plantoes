import assert from "node:assert/strict";
import test from "node:test";
import {
    buildDisplacedListReply,
    buildDisplacedMissingOccupancyReply,
    buildDisplacedNameMismatchReply,
    buildDisplacedStaleTimePrompt,
    isStaleOpenOccupancy,
    isTelegramDisplacedCommandText,
    parseTelegramDisplacedCommand,
    pickCommandOccupancyTarget,
    resolveDisplacedDepartureDefault,
} from "@/modules/telegram/displaced-commands";

test("parseTelegramDisplacedCommand aceita /deslocados e /deslocado", () => {
    assert.deepEqual(parseTelegramDisplacedCommand("/deslocados"), { name: "deslocados" });
    assert.deepEqual(parseTelegramDisplacedCommand("/deslocado"), { name: "deslocados" });
    assert.deepEqual(parseTelegramDisplacedCommand("/deslocados agora"), { name: "deslocados" });
    assert.equal(parseTelegramDisplacedCommand("/deslocados Carolina"), null);
    assert.equal(parseTelegramDisplacedCommand("/retirar PM04"), null);
    assert.equal(isTelegramDisplacedCommandText("/deslocados"), true);
    assert.equal(isTelegramDisplacedCommandText("/deslocado@PlantaoesBot"), true);
    assert.equal(isTelegramDisplacedCommandText("/plantao"), false);
});

test("pickCommandOccupancyTarget: nome do deslocado não retira o titular", () => {
    const titular = { id: "occ-uemerson", doctorId: "doc-uemerson" };
    const offBoard = { id: "occ-carolina", doctorId: "doc-carolina" };

    assert.deepEqual(
        pickCommandOccupancyTarget({ namedDoctorId: "doc-carolina", titular, offBoard }),
        { kind: "off_board", occupancyId: "occ-carolina" },
    );
    assert.deepEqual(
        pickCommandOccupancyTarget({ namedDoctorId: "doc-uemerson", titular, offBoard }),
        { kind: "titular", occupancyId: "occ-uemerson" },
    );
    assert.deepEqual(
        pickCommandOccupancyTarget({ namedDoctorId: null, titular, offBoard }),
        { kind: "titular", occupancyId: "occ-uemerson" },
    );
    assert.deepEqual(
        pickCommandOccupancyTarget({ namedDoctorId: "doc-outra", titular, offBoard }),
        { kind: "name_mismatch" },
    );
});

test("pickCommandOccupancyTarget: sem titular, /retirar Nome ainda acha o deslocado", () => {
    const offBoard = { id: "occ-carolina", doctorId: "doc-carolina" };
    assert.deepEqual(
        pickCommandOccupancyTarget({ namedDoctorId: "doc-carolina", titular: null, offBoard }),
        { kind: "off_board", occupancyId: "occ-carolina" },
    );
    assert.deepEqual(
        pickCommandOccupancyTarget({ namedDoctorId: null, titular: null, offBoard }),
        { kind: "missing" },
    );
    assert.deepEqual(
        pickCommandOccupancyTarget({ namedDoctorId: "doc-carolina", titular: null, offBoard: null }),
        { kind: "missing" },
    );
});

test("isStaleOpenOccupancy e resolveDisplacedDepartureDefault não usam agora em plantão vencido", () => {
    const now = new Date("2026-08-20T12:00:00-03:00");
    const scheduledEnd = new Date("2026-08-18T19:00:00-03:00");

    assert.equal(isStaleOpenOccupancy(scheduledEnd, now), true);
    assert.equal(isStaleOpenOccupancy(null, now), false);
    assert.equal(isStaleOpenOccupancy(new Date("2026-08-20T19:00:00-03:00"), now), false);

    assert.equal(resolveDisplacedDepartureDefault({ scheduledEndAt: scheduledEnd, now }).toISOString(), scheduledEnd.toISOString());
    assert.equal(resolveDisplacedDepartureDefault({ scheduledEndAt: null, now }).toISOString(), now.toISOString());
});

test("buildDisplacedListReply lista alvo, nome e comando de retirada", () => {
    const empty = buildDisplacedListReply([]);
    assert.match(empty, /Ninguém fora do quadro/);

    const reply = buildDisplacedListReply([
        {
            domain: "intervention",
            targetCode: "PM04",
            occupancyId: "occ-1",
            doctorName: "Carolina Restrepo Villafuerte",
            displayName: "Carolina Restrepo",
            startedAt: "2026-08-18T10:47:27.000Z",
            scheduledEndAt: "2026-08-18T22:00:00.000Z",
        },
    ], new Date("2026-08-20T12:00:00-03:00"));

    assert.match(reply, /Fora do quadro/);
    assert.match(reply, /PM04/);
    assert.match(reply, /Carolina Restrepo/);
    assert.match(reply, /\/retirar Carolina Restrepo PM04/);
    assert.match(reply, /18\/08/);
});

test("buildDisplacedStaleTimePrompt e mismatch não sugerem chutar o titular", () => {
    const stale = buildDisplacedStaleTimePrompt({
        doctorName: "Carolina Restrepo",
        targetCode: "PM04",
        startedAt: new Date("2026-08-18T10:47:27.000Z"),
        scheduledEndAt: new Date("2026-08-18T22:00:00.000Z"),
        referenceAt: new Date("2026-08-20T12:00:00-03:00"),
    });
    assert.match(stale, /informe o horário/);
    assert.match(stale, /\/retirar Carolina Restrepo PM04/);
    assert.doesNotMatch(stale, /Uemerson/);

    const mismatch = buildDisplacedNameMismatchReply({
        queriedName: "Carolina Restrepo",
        targetCode: "PM04",
        titularName: "Uemerson Alcantara",
        offBoardName: null,
    });
    assert.match(mismatch, /não está em PM04/);
    assert.match(mismatch, /titular Uemerson/);
    assert.match(mismatch, /\/deslocados/);

    const missing = buildDisplacedMissingOccupancyReply({
        targetCode: "PM04",
        offBoardNames: ["Carolina Restrepo"],
    });
    assert.match(missing, /não tem titular/);
    assert.match(missing, /Carolina Restrepo/);
    assert.match(missing, /\/retirar/);
});
