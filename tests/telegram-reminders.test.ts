import assert from "node:assert/strict";
import test from "node:test";
import { buildReminderPlans, type ReminderBoardSnapshot } from "@/modules/telegram/reminders";

function makeBoard(): ReminderBoardSnapshot {
    return {
        generatedAt: "2026-03-25T21:52:00.000Z",
        intervention: [
            {
                baseId: 1,
                occupancyId: "int-1",
                baseCode: "PM04",
                baseLabel: "PM04",
                doctorId: "doc-1",
                doctorName: "Ana Souza",
                displayName: "Ana",
                startedAt: "2026-03-25T22:00:00.000Z",
                boardStartedAt: "2026-03-25T22:00:00.000Z",
                scheduledEndAt: "2026-03-26T10:00:00.000Z",
                shiftLabel: "SN",
                roleLabel: null,
                status: "active",
                liveSource: "operations_v2",
                liveUpdatedAt: null,
            },
            {
                baseId: 2,
                occupancyId: "int-2",
                baseCode: "BR05",
                baseLabel: "BR05",
                doctorId: "doc-2",
                doctorName: "Joao Santana",
                displayName: "Joao",
                startedAt: "2026-03-25T10:18:00.000Z",
                boardStartedAt: "2026-03-25T10:18:00.000Z",
                scheduledEndAt: "2026-03-25T22:00:00.000Z",
                shiftLabel: "SD",
                roleLabel: null,
                status: "active",
                liveSource: "operations_v2",
                liveUpdatedAt: null,
            },
            {
                baseId: 3,
                occupancyId: null,
                baseCode: "IT30",
                baseLabel: "IT30",
                doctorId: null,
                doctorName: null,
                displayName: null,
                startedAt: null,
                boardStartedAt: null,
                scheduledEndAt: null,
                shiftLabel: null,
                roleLabel: null,
                status: "waiting",
                liveSource: "none",
                liveUpdatedAt: null,
            },
        ],
        regulation: [
            {
                postId: 1,
                occupancyId: "reg-1",
                postCode: "2031",
                postLabel: "2031",
                defaultRole: "MR",
                doctorId: "doc-3",
                doctorName: "Bruno Lima",
                displayName: "Bruno",
                startedAt: "2026-03-25T22:02:00.000Z",
                boardStartedAt: "2026-03-25T22:02:00.000Z",
                scheduledEndAt: "2026-03-26T10:15:00.000Z",
                shiftLabel: "SN",
                roleLabel: "MR",
                ramalLabel: "2031",
                status: "active",
                liveSource: "operations_v2",
                liveUpdatedAt: null,
            },
            {
                postId: 2,
                occupancyId: null,
                postCode: "2032",
                postLabel: "2032",
                defaultRole: "MR",
                doctorId: null,
                doctorName: null,
                displayName: null,
                startedAt: null,
                boardStartedAt: null,
                scheduledEndAt: null,
                shiftLabel: null,
                roleLabel: null,
                ramalLabel: "2032",
                status: "waiting",
                liveSource: "none",
                liveUpdatedAt: null,
            },
        ],
    };
}

test("buildReminderPlans sends an instructional call 10 minutes before the shift", () => {
    const plans = buildReminderPlans({
        now: new Date("2026-03-25T18:52:00-03:00"),
        board: makeBoard(),
    });

    const instruction = plans.find((plan) => plan.stage === "instruction");
    assert.ok(instruction);
    assert.match(instruction?.text ?? "", /Plantão SN abrindo/);
    assert.match(instruction?.text ?? "", /PM04 SN 19:00/);
    assert.match(instruction?.text ?? "", /2031 SN 19:00/);
    assert.match(instruction?.text ?? "", /continua P 19:00/);
    assert.match(instruction?.text ?? "", /sem medico confirmado no grupo/i);
});

test("buildReminderPlans publishes a 10-minute coverage snapshot with confirmed and pending targets", () => {
    const plans = buildReminderPlans({
        now: new Date("2026-03-25T19:20:00-03:00"),
        board: makeBoard(),
    });

    const snapshot = plans.find((plan) => plan.stage === "coverage_snapshot");
    assert.ok(snapshot);
    assert.match(snapshot?.text ?? "", /Quadro SN/);
    assert.match(snapshot?.text ?? "", /Intervenção 1\/3/);
    assert.match(snapshot?.text ?? "", /✅ PM04 - Ana \| 19:00/);
    assert.match(snapshot?.text ?? "", /🟡 BR05 - Joao \(SD 07:18\) \| sem confirmação p\/ SN/);
    assert.match(snapshot?.text ?? "", /🔴 IT30 - Aguardando avançada/);
    assert.match(snapshot?.text ?? "", /Sem aviso \(1\): 2032/);
    assert.doesNotMatch(snapshot?.text ?? "", /🔴 2032 - Aguardando ramal/);
    assert.match(snapshot?.text ?? "", /TARM segue sem todos os ramais/);
    assert.match(snapshot?.text ?? "", /🟡 = turno anterior sem confirmar continua\/P/);
});

test("buildReminderPlans treats disabled bases as explicit operational state instead of missing coverage", () => {
    const board = makeBoard();
    board.intervention[2] = {
        baseId: 3,
        occupancyId: null,
        baseCode: "IT30",
        baseLabel: "IT30",
        doctorId: null,
        doctorName: null,
        displayName: null,
        startedAt: null,
        boardStartedAt: null,
        scheduledEndAt: null,
        shiftLabel: null,
        roleLabel: null,
        status: "disabled",
        disabledAt: "2026-03-25T18:40:00.000Z",
        disabledReason: "USA recolhida",
        liveSource: "none",
        liveUpdatedAt: null,
    };

    const plans = buildReminderPlans({
        now: new Date("2026-03-25T20:05:00-03:00"),
        board,
    });

    const checkpoint = plans.find((plan) => plan.stage === "coverage_checkpoint");
    assert.ok(checkpoint);
    assert.match(checkpoint?.text ?? "", /⚫ Bases desativadas \(1\): IT30/);
    assert.doesNotMatch(checkpoint?.text ?? "", /🚑 Avancadas sem aviso \(1\): IT30/);
});

test("buildReminderPlans publishes the 08h/20h public checkpoint with surface names", () => {
    const plans = buildReminderPlans({
        now: new Date("2026-03-25T20:05:00-03:00"),
        board: makeBoard(),
    });

    const checkpoint = plans.find((plan) => plan.stage === "coverage_checkpoint");
    assert.ok(checkpoint);
    assert.match(checkpoint?.text ?? "", /Fechamento público 20:00/);
    assert.match(checkpoint?.text ?? "", /🚑 Intervenção confirmada:/);
    assert.match(checkpoint?.text ?? "", /☎️ Regulação confirmada:/);
    assert.match(checkpoint?.text ?? "", /PM04 - Ana \| 19:00/);
    assert.match(checkpoint?.text ?? "", /2031 - Bruno \| 19:02/);
    assert.match(checkpoint?.text ?? "", /🟠 Pendências ainda abertas/);
    assert.match(checkpoint?.text ?? "", /🔴 Intervenção sem confirmação \(1\): BR05/);
    assert.match(checkpoint?.text ?? "", /🚑 Avançadas sem aviso \(1\): IT30/);
    assert.match(checkpoint?.text ?? "", /☎️ Ramais sem aviso \(1\): 2032/);
});

test("buildReminderPlans publishes the 12h\/00h payment checkpoint with arrival times", () => {
    const board = makeBoard();
    board.regulation.push({
        postId: 3,
        occupancyId: null,
        postCode: "2033",
        postLabel: "2033",
        defaultRole: "MR",
        doctorId: null,
        doctorName: null,
        displayName: null,
        startedAt: null,
        boardStartedAt: null,
        scheduledEndAt: null,
        shiftLabel: null,
        roleLabel: null,
        ramalLabel: "2033",
        status: "waiting",
        liveSource: "none",
        liveUpdatedAt: null,
    });

    const plans = buildReminderPlans({
        now: new Date("2026-03-26T00:05:00-03:00"),
        board,
    });

    const checkpoint = plans.find((plan) => plan.stage === "payment_checkpoint");
    assert.ok(checkpoint);
    assert.match(checkpoint?.text ?? "", /Registro 00:00 para pagamento e banco de horas/);
    assert.match(checkpoint?.text ?? "", /🚑 Intervenção confirmada:/);
    assert.match(checkpoint?.text ?? "", /☎️ Regulação confirmada:/);
    assert.match(checkpoint?.text ?? "", /🟠 Pendências que exigem conferência:/);
    assert.match(checkpoint?.text ?? "", /PM04 - Ana \| chegada 19:00 \| SN/);
    assert.match(checkpoint?.text ?? "", /2031 - Bruno \| chegada 19:02 \| SN/);
    assert.match(checkpoint?.text ?? "", /🔴 Intervenção sem confirmação \(1\): BR05/);
    assert.match(checkpoint?.text ?? "", /🚑 Avançadas sem aviso \(1\): IT30/);
    assert.match(checkpoint?.text ?? "", /☎️ Ramais sem aviso \(2\): 2032, 2033/);
    assert.doesNotMatch(checkpoint?.text ?? "", /2032 \| Sem aviso de ramal/);
});

test("buildReminderPlans presents intervention and regulation in operational chat order", () => {
    const board = makeBoard();
    board.intervention = [
        {
            baseId: 8,
            occupancyId: null,
            baseCode: "IT30",
            baseLabel: "IT30",
            doctorId: null,
            doctorName: null,
            displayName: null,
            startedAt: null,
            boardStartedAt: null,
            scheduledEndAt: null,
            shiftLabel: null,
            roleLabel: null,
            status: "waiting",
            liveSource: "none",
            liveUpdatedAt: null,
        },
        {
            baseId: 1,
            occupancyId: "int-sm01",
            baseCode: "SM01",
            baseLabel: "SM01",
            doctorId: "doc-sm01",
            doctorName: "Primeiro Base",
            displayName: "Primeiro",
            startedAt: "2026-03-25T22:00:00.000Z",
            boardStartedAt: "2026-03-25T22:00:00.000Z",
            scheduledEndAt: "2026-03-26T10:00:00.000Z",
            shiftLabel: "SN",
            roleLabel: null,
            status: "active",
            liveSource: "operations_v2",
            liveUpdatedAt: null,
        },
        {
            baseId: 5,
            occupancyId: "int-br05",
            baseCode: "BR05",
            baseLabel: "BR05",
            doctorId: "doc-br05",
            doctorName: "Segundo Base",
            displayName: "Segundo",
            startedAt: "2026-03-25T22:05:00.000Z",
            boardStartedAt: "2026-03-25T22:05:00.000Z",
            scheduledEndAt: "2026-03-26T10:00:00.000Z",
            shiftLabel: "SN",
            roleLabel: null,
            status: "active",
            liveSource: "operations_v2",
            liveUpdatedAt: null,
        },
    ];
    board.regulation = [
        {
            postId: 66,
            occupancyId: "reg-1366",
            postCode: "1366",
            postLabel: "1366",
            defaultRole: "MR",
            doctorId: "doc-1366",
            doctorName: "Ultimo Ramal",
            displayName: "Ultimo",
            startedAt: "2026-03-25T22:03:00.000Z",
            boardStartedAt: "2026-03-25T22:03:00.000Z",
            scheduledEndAt: "2026-03-26T10:15:00.000Z",
            shiftLabel: "SN",
            roleLabel: "MR",
            ramalLabel: "1366",
            status: "active",
            liveSource: "operations_v2",
            liveUpdatedAt: null,
        },
        {
            postId: 31,
            occupancyId: "reg-2031",
            postCode: "2031",
            postLabel: "2031",
            defaultRole: "MR",
            doctorId: "doc-2031",
            doctorName: "Chefia",
            displayName: "Chefia",
            startedAt: "2026-03-25T22:00:00.000Z",
            boardStartedAt: "2026-03-25T22:00:00.000Z",
            scheduledEndAt: "2026-03-26T10:15:00.000Z",
            shiftLabel: "SN",
            roleLabel: "MR",
            ramalLabel: "2031",
            status: "active",
            liveSource: "operations_v2",
            liveUpdatedAt: null,
        },
        {
            postId: 32,
            occupancyId: null,
            postCode: "2032",
            postLabel: "2032",
            defaultRole: "MR",
            doctorId: null,
            doctorName: null,
            displayName: null,
            startedAt: null,
            boardStartedAt: null,
            scheduledEndAt: null,
            shiftLabel: null,
            roleLabel: null,
            ramalLabel: "2032",
            status: "waiting",
            liveSource: "none",
            liveUpdatedAt: null,
        },
    ];

    const plans = buildReminderPlans({
        now: new Date("2026-03-25T20:05:00-03:00"),
        board,
    });

    const checkpoint = plans.find((plan) => plan.stage === "coverage_checkpoint");
    assert.ok(checkpoint);
    assert.ok((checkpoint?.text ?? "").indexOf("✅ SM01 - Primeiro") < (checkpoint?.text ?? "").indexOf("✅ BR05 - Segundo"));
    assert.ok((checkpoint?.text ?? "").indexOf("🚑 Avançadas sem aviso (1): IT30") > (checkpoint?.text ?? "").indexOf("✅ BR05 - Segundo"));
    assert.ok((checkpoint?.text ?? "").indexOf("✅ 2031 - Chefia") < (checkpoint?.text ?? "").indexOf("✅ 1366 - Ultimo"));
    assert.match(checkpoint?.text ?? "", /☎️ Ramais sem aviso \(1\): 2032/);
});

test("buildReminderPlans treats SD with early arrival before tolerance as confirmed, not awaiting", () => {
    const board: ReminderBoardSnapshot = {
        generatedAt: "2026-03-25T10:20:00.000Z",
        intervention: [
            {
                baseId: 1,
                occupancyId: "int-early",
                baseCode: "PM04",
                baseLabel: "PM04",
                doctorId: "doc-early",
                doctorName: "Carlos Madrugador",
                displayName: "Carlos",
                startedAt: "2026-03-25T08:50:00.000Z",
                boardStartedAt: "2026-03-25T08:50:00.000Z",
                scheduledEndAt: "2026-03-25T22:00:00.000Z",
                shiftLabel: "SD",
                roleLabel: null,
                status: "active",
                liveSource: "operations_v2",
                liveUpdatedAt: null,
            },
        ],
        regulation: [],
    };

    const plans = buildReminderPlans({
        now: new Date("2026-03-25T07:20:00-03:00"),
        board,
    });

    const snapshot = plans.find((plan) => plan.stage === "coverage_snapshot");
    assert.ok(snapshot);
    assert.match(snapshot?.text ?? "", /✅ PM04 - Carlos/);
    assert.doesNotMatch(snapshot?.text ?? "", /🟡 PM04/);
});

test("buildReminderPlans publishes 11:00 regulation confirmation with occupied posts only", () => {
    const plans = buildReminderPlans({
        now: new Date("2026-03-26T11:05:00-03:00"),
        board: makeBoard(),
    });

    const confirmation = plans.find((plan) => plan.stage === "regulation_confirmation");
    assert.ok(confirmation);
    assert.match(confirmation?.text ?? "", /Checagem da Regulação 11:00/);
    assert.match(confirmation?.text ?? "", /Reguladores logados além da chefia: 0/);
    assert.match(confirmation?.text ?? "", /Não conta 2031, NUCLEO nem PIAM/);
    assert.match(confirmation?.text ?? "", /USAs com médico: 2/);
    assert.match(confirmation?.text ?? "", /USAs sem informação \(1\): IT30/);
    assert.match(confirmation?.text ?? "", /Chefia, confirme se falta regulador/);
});

test("buildReminderPlans publishes 22:30 regulation confirmation", () => {
    const plans = buildReminderPlans({
        now: new Date("2026-03-26T22:34:00-03:00"),
        board: makeBoard(),
    });

    const confirmation = plans.find((plan) => plan.stage === "regulation_confirmation");
    assert.ok(confirmation);
    assert.match(confirmation?.text ?? "", /Checagem da Regulação 22:30/);
    assert.match(confirmation?.text ?? "", /Reguladores logados além da chefia: 0/);
    assert.match(confirmation?.text ?? "", /USAs sem informação \(1\): IT30/);
});

test("buildReminderPlans publishes 22:00 regulation confirmation", () => {
    const plans = buildReminderPlans({
        now: new Date("2026-03-26T22:05:00-03:00"),
        board: makeBoard(),
    });

    const confirmation = plans.find((plan) => plan.stage === "regulation_confirmation");
    assert.ok(confirmation);
    assert.match(confirmation?.text ?? "", /Checagem da Regulação 22:00/);
    assert.match(confirmation?.text ?? "", /Reguladores logados além da chefia: 0/);
    assert.match(confirmation?.text ?? "", /USAs com médico: 2/);
});

test("buildReminderPlans publishes 13:00 regulation confirmation", () => {
    const plans = buildReminderPlans({
        now: new Date("2026-03-26T13:05:00-03:00"),
        board: makeBoard(),
    });

    const confirmation = plans.find((plan) => plan.stage === "regulation_confirmation");
    assert.ok(confirmation);
    assert.match(confirmation?.text ?? "", /Checagem da Regulação 13:00/);
    assert.match(confirmation?.text ?? "", /Reguladores logados além da chefia: 0/);
});

test("buildReminderPlans publishes 15:00 regulation confirmation", () => {
    const plans = buildReminderPlans({
        now: new Date("2026-03-26T15:05:00-03:00"),
        board: makeBoard(),
    });

    const confirmation = plans.find((plan) => plan.stage === "regulation_confirmation");
    assert.ok(confirmation);
    assert.match(confirmation?.text ?? "", /Checagem da Regulação 15:00/);
    assert.match(confirmation?.text ?? "", /Reguladores logados além da chefia: 0/);
});

test("buildReminderPlans publishes 21:30 regulation confirmation", () => {
    const plans = buildReminderPlans({
        now: new Date("2026-03-26T21:34:00-03:00"),
        board: makeBoard(),
    });

    const confirmation = plans.find((plan) => plan.stage === "regulation_confirmation");
    assert.ok(confirmation);
    assert.match(confirmation?.text ?? "", /Checagem da Regulação 21:30/);
    assert.match(confirmation?.text ?? "", /Reguladores logados além da chefia: 0/);
});

test("buildReminderPlans ignores chief, NUCLEO and PIAM in regulation confirmation headcount", () => {
    const board = makeBoard();
    board.regulation.push(
        {
            postId: 3,
            occupancyId: "reg-1362",
            postCode: "1362",
            postLabel: "1362",
            defaultRole: "MR",
            doctorId: "doc-1362",
            doctorName: "Regulador Valido",
            displayName: "Valido",
            startedAt: "2026-03-26T14:00:00.000Z",
            boardStartedAt: "2026-03-26T14:00:00.000Z",
            scheduledEndAt: "2026-03-26T22:15:00.000Z",
            shiftLabel: "SD",
            roleLabel: "MR",
            ramalLabel: "1362",
            status: "active",
            liveSource: "operations_v2",
            liveUpdatedAt: null,
        },
        {
            postId: 4,
            occupancyId: "reg-nucleo",
            postCode: "NUCLEO",
            postLabel: "NUCLEO",
            defaultRole: "MR",
            doctorId: "doc-nucleo",
            doctorName: "Nucleo",
            displayName: "Nucleo",
            startedAt: "2026-03-26T14:00:00.000Z",
            boardStartedAt: "2026-03-26T14:00:00.000Z",
            scheduledEndAt: "2026-03-26T22:15:00.000Z",
            shiftLabel: "SD",
            roleLabel: "MR",
            ramalLabel: "NUCLEO",
            status: "active",
            liveSource: "operations_v2",
            liveUpdatedAt: null,
        },
        {
            postId: 5,
            occupancyId: "reg-piam",
            postCode: "PIAM",
            postLabel: "PIAM",
            defaultRole: "MR",
            doctorId: "doc-piam",
            doctorName: "Piam",
            displayName: "Piam",
            startedAt: "2026-03-26T14:00:00.000Z",
            boardStartedAt: "2026-03-26T14:00:00.000Z",
            scheduledEndAt: "2026-03-26T22:15:00.000Z",
            shiftLabel: "SD",
            roleLabel: "MR",
            ramalLabel: "PIAM",
            status: "active",
            liveSource: "operations_v2",
            liveUpdatedAt: null,
        },
    );

    const plans = buildReminderPlans({
        now: new Date("2026-03-26T15:05:00-03:00"),
        board,
    });

    const confirmation = plans.find((plan) => plan.stage === "regulation_confirmation");
    assert.ok(confirmation);
    assert.match(confirmation?.text ?? "", /Reguladores logados além da chefia: 1/);
});