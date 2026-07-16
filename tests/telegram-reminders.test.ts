import assert from "node:assert/strict";
import test from "node:test";
import {
    buildChiefPrivateRegulationAlertPlan,
    buildReminderPlans,
    buildTakeoverConflictPlan,
    diffCoverageSnapshotStates,
    isCoverageSnapshotPendingState,
    resolveReminderRecipientsForPlan,
    type CoverageSnapshotPendingState,
    type ReminderBoardSnapshot,
    type ReminderPlan,
} from "@/modules/telegram/reminders";

function makePlan(overrides: Partial<ReminderPlan>): ReminderPlan {
    return {
        noticeKey: "coverage:2026-03-26T08:00",
        stage: "coverage_checkpoint",
        text: "test",
        payload: {},
        ...overrides,
    };
}

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

function makeCoverageState(overrides: Partial<CoverageSnapshotPendingState> = {}): CoverageSnapshotPendingState {
    return {
        shiftStartedAt: "2026-03-25T22:00:00.000Z",
        bucketAt: "2026-03-25T22:20:00.000Z",
        awaitingInterventionCodes: ["BR05"],
        missingInterventionCodes: ["IT30"],
        disabledInterventionCodes: [],
        missingRegulationCodes: ["2032"],
        ...overrides,
    };
}

test("buildReminderPlans sends an instructional call 10 minutes before the shift", () => {
    const plans = buildReminderPlans({
        now: new Date("2026-03-25T18:52:00-03:00"),
        board: makeBoard(),
    });

    const instruction = plans.find((plan) => plan.stage === "instruction");
    assert.ok(instruction);
    assert.equal(instruction?.parseMode, "Markdown");
    assert.match(instruction?.text ?? "", /^⏰ Plantão SN abre às 19:00\./);
    assert.match(instruction?.text ?? "", /Chegada: `Vagner Costa 1363 SN 19:00`/);
    assert.match(instruction?.text ?? "", /Continuação: `Vagner Costa 1363 continuando SN`/);
    assert.match(instruction?.text ?? "", /Sem aviso, a posição fica sem médico no quadro\./);
    assert.ok((instruction?.text ?? "").length <= 240);
    assert.doesNotMatch(instruction?.text ?? "", /🧭/);
});

test("resolveReminderRecipientsForPlan sends payment checkpoint integral to admins only", () => {
    const recipients = resolveReminderRecipientsForPlan({
        plan: makePlan({
            noticeKey: "payment:2026-03-26T12:00",
            stage: "payment_checkpoint",
        }),
        reminderChatIds: ["-1001591556887"],
        adminChatIds: ["1438288563", "140695090"],
        chiefPrivateAlertRecipients: ["700000001"],
    });

    assert.deepEqual(recipients, ["1438288563", "140695090"]);
});

test("resolveReminderRecipientsForPlan keeps the public noon payment summary in reminder chats", () => {
    const recipients = resolveReminderRecipientsForPlan({
        plan: makePlan({
            noticeKey: "payment-public:2026-03-26T12:00",
            stage: "payment_checkpoint_public",
        }),
        reminderChatIds: ["-1001591556887"],
        adminChatIds: ["1438288563", "140695090"],
        chiefPrivateAlertRecipients: ["700000001"],
    });

    assert.deepEqual(recipients, ["-1001591556887"]);
});

test("resolveReminderRecipientsForPlan keeps regular plans in reminder chats only", () => {
    const recipients = resolveReminderRecipientsForPlan({
        plan: makePlan({
            noticeKey: "coverage:2026-03-26T08:00",
            stage: "coverage_checkpoint",
        }),
        reminderChatIds: ["-1001591556887"],
        adminChatIds: ["1438288563", "140695090"],
        chiefPrivateAlertRecipients: ["700000001"],
    });

    assert.deepEqual(recipients, ["-1001591556887"]);
});

test("resolveReminderRecipientsForPlan routes conflict alerts to admin and chief privates only", () => {
    const paymentConflictRecipients = resolveReminderRecipientsForPlan({
        plan: makePlan({
            noticeKey: "payment-conflict:2026-03-26:SD:2026-03-26T11:00:00.000Z",
            stage: "payment_conflict_alert",
        }),
        reminderChatIds: ["-1001591556887"],
        adminChatIds: ["1438288563", "140695090"],
        chiefPrivateAlertRecipients: ["700000001", "700000002"],
    });

    assert.deepEqual(paymentConflictRecipients, ["1438288563", "140695090", "700000001", "700000002"]);

    const takeoverRecipients = resolveReminderRecipientsForPlan({
        plan: makePlan({
            noticeKey: "takeover-conflict:log-1:2026-03-26T11:00:00.000Z",
            stage: "takeover_conflict_alert",
        }),
        reminderChatIds: ["-1001591556887"],
        adminChatIds: ["1438288563"],
        chiefPrivateAlertRecipients: ["700000001"],
    });

    assert.deepEqual(takeoverRecipients, ["1438288563", "700000001"]);
});

test("resolveReminderRecipientsForPlan routes private regulation checks to chiefs", () => {
    const recipients = resolveReminderRecipientsForPlan({
        plan: makePlan({
            noticeKey: "reg-confirm-private:2026-03-26T11:00",
            stage: "regulation_confirmation_private",
        }),
        reminderChatIds: ["-1001591556887"],
        adminChatIds: ["1438288563"],
        chiefPrivateAlertRecipients: ["700000001", "700000002"],
    });

    assert.deepEqual(recipients, ["700000001", "700000002"]);
});

test("buildReminderPlans publishes the full board on the first coverage snapshot of the shift", () => {
    const plans = buildReminderPlans({
        now: new Date("2026-03-25T19:20:00-03:00"),
        board: makeBoard(),
    });

    const snapshot = plans.find((plan) => plan.stage === "coverage_snapshot");
    assert.ok(snapshot);
    assert.equal(snapshot?.parseMode, "Markdown");
    assert.match(snapshot?.text ?? "", /📋 \*Quadro SN 19:20\*/);
    assert.match(snapshot?.text ?? "", /Intervenção \*1\/3\*/);
    assert.match(snapshot?.text ?? "", /✅ PM04 - Ana \| 19:00/);
    assert.match(snapshot?.text ?? "", /🟡 BR05 - Joao \(SD 07:18\) \| sem confirmação p\/ SN/);
    assert.match(snapshot?.text ?? "", /🔴 IT30 - Aguardando avançada/);
    assert.match(snapshot?.text ?? "", /Sem aviso \(1\): 2032/);
    assert.doesNotMatch(snapshot?.text ?? "", /🔴 2032 - Aguardando ramal/);
    assert.match(snapshot?.text ?? "", /TARM segue sem todos os ramais/);
    assert.match(snapshot?.text ?? "", /🟡 = turno anterior sem confirmar continua\/P/);
    assert.match(snapshot?.text ?? "", /Chegada: `Vagner Costa 1363 SN 19:00`/);
    assert.match(snapshot?.text ?? "", /Continuação: `Vagner Costa 1363 continuando SN`/);
    assert.equal(snapshot?.payload.mode, "full");

    const state = snapshot?.payload.coverageState;
    assert.ok(isCoverageSnapshotPendingState(state));
    assert.deepEqual(state.awaitingInterventionCodes, ["BR05"]);
    assert.deepEqual(state.missingInterventionCodes, ["IT30"]);
    assert.deepEqual(state.missingRegulationCodes, ["2032"]);
    assert.equal(state.shiftStartedAt, "2026-03-25T22:00:00.000Z");
});

test("buildReminderPlans suppresses the coverage snapshot when pendências did not change", () => {
    const plans = buildReminderPlans({
        now: new Date("2026-03-25T19:30:00-03:00"),
        board: makeBoard(),
        previousCoverageState: makeCoverageState(),
    });

    assert.equal(plans.find((plan) => plan.stage === "coverage_snapshot"), undefined);
});

test("buildReminderPlans sends only the pendências delta from the second snapshot onwards", () => {
    const plans = buildReminderPlans({
        now: new Date("2026-03-25T19:30:00-03:00"),
        board: makeBoard(),
        previousCoverageState: makeCoverageState({
            awaitingInterventionCodes: [],
            missingRegulationCodes: ["2032", "2033"],
        }),
    });

    const snapshot = plans.find((plan) => plan.stage === "coverage_snapshot");
    assert.ok(snapshot);
    assert.equal(snapshot?.payload.mode, "delta");
    assert.match(snapshot?.text ?? "", /📋 \*Quadro SN 19:30\* — o que mudou desde 19:20:/);
    assert.match(snapshot?.text ?? "", /✅ Resolvidas: 2033/);
    assert.match(snapshot?.text ?? "", /⚠️ Novas pendências: BR05/);
    assert.match(snapshot?.text ?? "", /🔴 Intervenção sem confirmação \(1\): BR05/);
    assert.match(snapshot?.text ?? "", /🚑 Avançadas sem aviso \(1\): IT30/);
    assert.match(snapshot?.text ?? "", /☎️ Ramais sem aviso \(1\): 2032/);
    assert.match(snapshot?.text ?? "", /Chegada: `Vagner Costa 1363 SN 19:00`/);
    // Delta não repete o quadro completo.
    assert.doesNotMatch(snapshot?.text ?? "", /🚑 Intervenção:/);
    assert.doesNotMatch(snapshot?.text ?? "", /✅ PM04 - Ana/);
});

test("buildReminderPlans sends the full board again when the previous state belongs to another shift", () => {
    const plans = buildReminderPlans({
        now: new Date("2026-03-25T19:30:00-03:00"),
        board: makeBoard(),
        previousCoverageState: makeCoverageState({
            shiftStartedAt: "2026-03-25T10:00:00.000Z",
        }),
    });

    const snapshot = plans.find((plan) => plan.stage === "coverage_snapshot");
    assert.ok(snapshot);
    assert.equal(snapshot?.payload.mode, "full");
    assert.match(snapshot?.text ?? "", /🚑 Intervenção:/);
});

test("diffCoverageSnapshotStates reports no change for identical pendências", () => {
    const delta = diffCoverageSnapshotStates(makeCoverageState(), makeCoverageState({ bucketAt: "2026-03-25T22:30:00.000Z" }));
    assert.equal(delta.changed, false);
    assert.deepEqual(delta.resolvedCodes, []);
    assert.deepEqual(delta.addedCodes, []);
});

test("diffCoverageSnapshotStates separates resolved and added pendências", () => {
    const delta = diffCoverageSnapshotStates(
        makeCoverageState({ awaitingInterventionCodes: [], missingRegulationCodes: ["2032", "2033"] }),
        makeCoverageState(),
    );

    assert.equal(delta.changed, true);
    assert.deepEqual(delta.resolvedCodes, ["2033"]);
    assert.deepEqual(delta.addedCodes, ["BR05"]);
});

test("diffCoverageSnapshotStates counts a pendência that became disabled as change but not as resolved", () => {
    const delta = diffCoverageSnapshotStates(
        makeCoverageState(),
        makeCoverageState({ missingInterventionCodes: [], disabledInterventionCodes: ["IT30"] }),
    );

    assert.equal(delta.changed, true);
    assert.deepEqual(delta.resolvedCodes, []);
    assert.deepEqual(delta.addedCodes, []);
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
    assert.doesNotMatch(checkpoint?.text ?? "", /🚑 Avançadas sem aviso \(1\): IT30/);
});

test("buildReminderPlans publishes the 08h/20h closing with pendências first and confirmed counts", () => {
    const plans = buildReminderPlans({
        now: new Date("2026-03-25T20:05:00-03:00"),
        board: makeBoard(),
    });

    const checkpoint = plans.find((plan) => plan.stage === "coverage_checkpoint");
    assert.ok(checkpoint);
    assert.equal(checkpoint?.parseMode, "Markdown");
    assert.match(checkpoint?.text ?? "", /📋 \*Fechamento 20:00\* \(SN\)\./);
    assert.match(checkpoint?.text ?? "", /🟠 Pendências ainda abertas:/);
    assert.match(checkpoint?.text ?? "", /🔴 Intervenção sem confirmação \(1\): BR05/);
    assert.match(checkpoint?.text ?? "", /🚑 Avançadas sem aviso \(1\): IT30/);
    assert.match(checkpoint?.text ?? "", /☎️ Ramais sem aviso \(1\): 2032/);
    assert.match(checkpoint?.text ?? "", /Chegada: `Vagner Costa 1363 SN 19:00`/);
    assert.match(checkpoint?.text ?? "", /Confirmados: 🚑 \*1\* avançadas · ☎️ \*1\* ramais — lista completa no \/plantao\./);
    // Fusão com o snapshot: o fechamento não repete a lista nominal de confirmados.
    assert.doesNotMatch(checkpoint?.text ?? "", /PM04 - Ana \| 19:00/);
    assert.doesNotMatch(checkpoint?.text ?? "", /2031 - Bruno \| 19:02/);
});

test("buildReminderPlans publishes the 12h/00h payment checkpoint integral with arrival times", () => {
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
    assert.equal(checkpoint?.parseMode, "Markdown");
    assert.match(checkpoint?.text ?? "", /💰 Registro 00:00 para pagamento e banco de horas \(SN\)\./);
    assert.match(checkpoint?.text ?? "", /🚑 Intervenção confirmada:/);
    assert.match(checkpoint?.text ?? "", /☎️ Regulação confirmada:/);
    assert.match(checkpoint?.text ?? "", /🟠 Pendências que exigem conferência:/);
    assert.match(checkpoint?.text ?? "", /- PM04 - \*Ana\* \| chegada 19:00 \| SN/);
    assert.match(checkpoint?.text ?? "", /- 2031 - \*Bruno\* \| chegada 19:02 \| SN/);
    assert.match(checkpoint?.text ?? "", /🔴 Intervenção sem confirmação \(1\): BR05/);
    assert.match(checkpoint?.text ?? "", /🚑 Avançadas sem aviso \(1\): IT30/);
    assert.match(checkpoint?.text ?? "", /☎️ Ramais sem aviso \(2\): 2032, 2033/);
    assert.doesNotMatch(checkpoint?.text ?? "", /2032 \| Sem aviso de ramal/);

    // Às 00:00 o grupo não recebe resumo público de pagamento.
    assert.equal(plans.find((plan) => plan.stage === "payment_checkpoint_public"), undefined);
});

test("buildReminderPlans publishes a short public payment summary at noon only when pendências exist", () => {
    const plans = buildReminderPlans({
        now: new Date("2026-03-26T12:05:00-03:00"),
        board: makeBoard(),
    });

    const publicSummary = plans.find((plan) => plan.stage === "payment_checkpoint_public");
    assert.ok(publicSummary);
    assert.equal(publicSummary?.parseMode, "Markdown");
    assert.match(publicSummary?.noticeKey ?? "", /^payment-public:/);
    assert.match(publicSummary?.text ?? "", /💰 12:00: \*\d+\* pendências? p\/ pagamento: /);
    assert.match(publicSummary?.text ?? "", /2032/);
    assert.match(publicSummary?.text ?? "", /IT30/);
    assert.match(publicSummary?.text ?? "", /Regularize: `Vagner Costa 1363 SD 07:00`/);
    assert.ok((publicSummary?.text ?? "").length <= 160);

    const integral = plans.find((plan) => plan.stage === "payment_checkpoint");
    assert.ok(integral);
});

test("buildReminderPlans skips the public payment summary when the board is clean", () => {
    const board: ReminderBoardSnapshot = {
        generatedAt: "2026-03-26T15:05:00.000Z",
        intervention: [
            {
                baseId: 1,
                occupancyId: "int-1",
                baseCode: "PM04",
                baseLabel: "PM04",
                doctorId: "doc-1",
                doctorName: "Ana Souza",
                displayName: "Ana",
                startedAt: "2026-03-26T10:00:00.000Z",
                boardStartedAt: "2026-03-26T10:00:00.000Z",
                scheduledEndAt: "2026-03-26T22:00:00.000Z",
                shiftLabel: "SD",
                roleLabel: null,
                status: "active",
                liveSource: "operations_v2",
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
                doctorId: "doc-2",
                doctorName: "Bruno Lima",
                displayName: "Bruno",
                startedAt: "2026-03-26T10:02:00.000Z",
                boardStartedAt: "2026-03-26T10:02:00.000Z",
                scheduledEndAt: "2026-03-26T22:15:00.000Z",
                shiftLabel: "SD",
                roleLabel: "MR",
                ramalLabel: "2031",
                status: "active",
                liveSource: "operations_v2",
                liveUpdatedAt: null,
            },
        ],
    };

    const plans = buildReminderPlans({
        now: new Date("2026-03-26T12:05:00-03:00"),
        board,
    });

    assert.equal(plans.find((plan) => plan.stage === "payment_checkpoint_public"), undefined);
    assert.ok(plans.find((plan) => plan.stage === "payment_checkpoint"));
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
        now: new Date("2026-03-25T19:45:00-03:00"),
        board,
    });

    const snapshot = plans.find((plan) => plan.stage === "coverage_snapshot");
    assert.ok(snapshot);
    const text = snapshot?.text ?? "";
    assert.ok(text.indexOf("✅ SM01 - Primeiro") < text.indexOf("✅ BR05 - Segundo"));
    assert.match(text, /🔴 IT30 - Aguardando avançada/);
    assert.ok(text.indexOf("✅ 2031 - Chefia") < text.indexOf("✅ 1366 - Ultimo"));
    assert.match(text, /Sem aviso \(1\): 2032/);
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

test("buildReminderPlans publishes the 11:00 regulation check in the group only with what is missing", () => {
    const plans = buildReminderPlans({
        now: new Date("2026-03-26T11:05:00-03:00"),
        board: makeBoard(),
    });

    const confirmation = plans.find((plan) => plan.stage === "regulation_confirmation");
    assert.ok(confirmation);
    assert.equal(confirmation?.parseMode, "Markdown");
    assert.match(confirmation?.text ?? "", /☎️ Checagem 11:00: sem médico em ramais 2032 e USAs IT30\./);
    assert.match(confirmation?.text ?? "", /Se você está aí, avise agora: `Vagner Costa 2032 SD 11:00`/);
    // Contagens e regra interna migraram para o privado da chefia.
    assert.doesNotMatch(confirmation?.text ?? "", /Reguladores logados/);
    assert.doesNotMatch(confirmation?.text ?? "", /Não conta 2031/);
    assert.doesNotMatch(confirmation?.text ?? "", /☎️🧭/);
});

test("buildReminderPlans publishes 22:30 regulation check", () => {
    const plans = buildReminderPlans({
        now: new Date("2026-03-26T22:34:00-03:00"),
        board: makeBoard(),
    });

    const confirmation = plans.find((plan) => plan.stage === "regulation_confirmation");
    assert.ok(confirmation);
    assert.match(confirmation?.text ?? "", /☎️ Checagem 22:30: sem médico em ramais 2032 e USAs IT30\./);
    assert.match(confirmation?.text ?? "", /`Vagner Costa 2032 SN 22:30`/);
});

test("buildReminderPlans publishes 22:00 regulation check", () => {
    const plans = buildReminderPlans({
        now: new Date("2026-03-26T22:05:00-03:00"),
        board: makeBoard(),
    });

    const confirmation = plans.find((plan) => plan.stage === "regulation_confirmation");
    assert.ok(confirmation);
    assert.match(confirmation?.text ?? "", /☎️ Checagem 22:00: sem médico em ramais 2032 e USAs IT30\./);
});

test("buildReminderPlans publishes 13:00 regulation check", () => {
    const plans = buildReminderPlans({
        now: new Date("2026-03-26T13:05:00-03:00"),
        board: makeBoard(),
    });

    const confirmation = plans.find((plan) => plan.stage === "regulation_confirmation");
    assert.ok(confirmation);
    assert.match(confirmation?.text ?? "", /☎️ Checagem 13:00: sem médico em ramais 2032 e USAs IT30\./);
});

test("buildReminderPlans publishes 15:00 regulation check", () => {
    const plans = buildReminderPlans({
        now: new Date("2026-03-26T15:05:00-03:00"),
        board: makeBoard(),
    });

    const confirmation = plans.find((plan) => plan.stage === "regulation_confirmation");
    assert.ok(confirmation);
    assert.match(confirmation?.text ?? "", /☎️ Checagem 15:00: sem médico em ramais 2032 e USAs IT30\./);
});

test("buildReminderPlans publishes 21:30 regulation check", () => {
    const plans = buildReminderPlans({
        now: new Date("2026-03-26T21:34:00-03:00"),
        board: makeBoard(),
    });

    const confirmation = plans.find((plan) => plan.stage === "regulation_confirmation");
    assert.ok(confirmation);
    assert.match(confirmation?.text ?? "", /☎️ Checagem 21:30: sem médico em ramais 2032 e USAs IT30\./);
});

test("buildChiefPrivateRegulationAlertPlan ignores chief, NUCLEO and PIAM in regulation headcount", () => {
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

    const plan = buildChiefPrivateRegulationAlertPlan({
        now: new Date("2026-03-26T15:05:00-03:00"),
        board,
    });

    assert.ok(plan);
    assert.match(plan?.text ?? "", /Só \*1\* reguladores logados além da chefia — o mínimo é \*9\*/);
    assert.match(plan?.text ?? "", /Não conto 2031, NUCLEO nem PIAM/);
});

test("buildChiefPrivateRegulationAlertPlan warns on missing USAs and low MR headcount", () => {
    const board = makeBoard();
    board.intervention = [
        {
            baseId: 1,
            occupancyId: null,
            baseCode: "SM01",
            baseLabel: "SM01",
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
            baseId: 2,
            occupancyId: null,
            baseCode: "PM40",
            baseLabel: "PM40",
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
            baseId: 3,
            occupancyId: null,
            baseCode: "CZ50",
            baseLabel: "CZ50",
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
    ];

    board.regulation = [
        ...board.regulation,
        {
            postId: 99,
            occupancyId: null,
            postCode: "PIAM",
            postLabel: "PIAM",
            defaultRole: "MR",
            doctorId: null,
            doctorName: null,
            displayName: null,
            startedAt: null,
            boardStartedAt: null,
            scheduledEndAt: null,
            shiftLabel: null,
            roleLabel: null,
            ramalLabel: "PIAM",
            status: "waiting",
            liveSource: "none",
            liveUpdatedAt: null,
        },
        ...Array.from({ length: 8 }, (_, index) => ({
            postId: 200 + index,
            occupancyId: `reg-extra-${index}`,
            postCode: `${1361 + index}`,
            postLabel: `${1361 + index}`,
            defaultRole: "MR",
            doctorId: `doc-extra-${index}`,
            doctorName: `Reg ${index}`,
            displayName: `Reg ${index}`,
            startedAt: "2026-03-26T13:50:00.000Z",
            boardStartedAt: "2026-03-26T13:50:00.000Z",
            scheduledEndAt: "2026-03-26T22:15:00.000Z",
            shiftLabel: "SD" as const,
            roleLabel: "MR",
            ramalLabel: `${1361 + index}`,
            status: "active" as const,
            liveSource: "operations_v2" as const,
            liveUpdatedAt: null,
        })),
    ];

    const plan = buildChiefPrivateRegulationAlertPlan({
        now: new Date("2026-03-26T11:05:00-03:00"),
        board,
    });

    assert.ok(plan);
    assert.equal(plan?.stage, "regulation_confirmation_private");
    assert.equal(plan?.parseMode, "Markdown");
    assert.match(plan?.text ?? "", /☎️ Checagem interna 11:00 \(SD\)/);
    assert.match(plan?.text ?? "", /⚠️ USAs sem médico p\/ pagamento: SM01, PM40 e CZ50\./);
    assert.match(plan?.text ?? "", /⚠️ Ramais sem médico na regulação:/);
    assert.match(plan?.text ?? "", /👥 Só \*8\* reguladores logados além da chefia — o mínimo é \*9\*\. Confere\?/);
    assert.match(plan?.text ?? "", /cobre no grupo: nome completo \+ ramal \+ turno/);
});

test("buildChiefPrivateRegulationAlertPlan skips alert when all thresholds are healthy", () => {
    const board: ReminderBoardSnapshot = {
        generatedAt: "2026-03-26T11:00:00.000Z",
        intervention: [
            {
                baseId: 1,
                occupancyId: "int-pm04",
                baseCode: "PM04",
                baseLabel: "PM04",
                doctorId: "doc-int-pm04",
                doctorName: "PM04 Doctor",
                displayName: "PM04",
                startedAt: "2026-03-26T13:50:00.000Z",
                boardStartedAt: "2026-03-26T13:50:00.000Z",
                scheduledEndAt: "2026-03-26T22:00:00.000Z",
                shiftLabel: "SD",
                roleLabel: null,
                status: "active",
                liveSource: "operations_v2",
                liveUpdatedAt: null,
            },
        ],
        regulation: [
            {
                postId: 1,
                occupancyId: "reg-2031",
                postCode: "2031",
                postLabel: "2031",
                defaultRole: "MR",
                doctorId: "doc-chief",
                doctorName: "Chefe",
                displayName: "Chefe",
                startedAt: "2026-03-26T13:50:00.000Z",
                boardStartedAt: "2026-03-26T13:50:00.000Z",
                scheduledEndAt: "2026-03-26T22:15:00.000Z",
                shiftLabel: "SD",
                roleLabel: "MR",
                ramalLabel: "2031",
                status: "active",
                liveSource: "operations_v2",
                liveUpdatedAt: null,
            },
            {
                postId: 2,
                occupancyId: "reg-nucleo",
                postCode: "NUCLEO",
                postLabel: "NUCLEO",
                defaultRole: "MR",
                doctorId: "doc-nucleo",
                doctorName: "Nucleo",
                displayName: "Nucleo",
                startedAt: "2026-03-26T13:50:00.000Z",
                boardStartedAt: "2026-03-26T13:50:00.000Z",
                scheduledEndAt: "2026-03-26T22:15:00.000Z",
                shiftLabel: "SD",
                roleLabel: "MR",
                ramalLabel: "NUCLEO",
                status: "active",
                liveSource: "operations_v2",
                liveUpdatedAt: null,
            },
            {
                postId: 3,
                occupancyId: "reg-piam",
                postCode: "PIAM",
                postLabel: "PIAM",
                defaultRole: "MR",
                doctorId: "doc-piam",
                doctorName: "Piam",
                displayName: "Piam",
                startedAt: "2026-03-26T13:50:00.000Z",
                boardStartedAt: "2026-03-26T13:50:00.000Z",
                scheduledEndAt: "2026-03-26T22:15:00.000Z",
                shiftLabel: "SD",
                roleLabel: "MR",
                ramalLabel: "PIAM",
                status: "active",
                liveSource: "operations_v2",
                liveUpdatedAt: null,
            },
            ...Array.from({ length: 9 }, (_, index) => ({
                postId: 100 + index,
                occupancyId: `reg-${index}`,
                postCode: `${1321 + index}`,
                postLabel: `${1321 + index}`,
                defaultRole: "MR",
                doctorId: `doc-${index}`,
                doctorName: `Reg ${index}`,
                displayName: `Reg ${index}`,
                startedAt: "2026-03-26T13:50:00.000Z",
                boardStartedAt: "2026-03-26T13:50:00.000Z",
                scheduledEndAt: "2026-03-26T22:15:00.000Z",
                shiftLabel: "SD" as const,
                roleLabel: "MR",
                ramalLabel: `${1321 + index}`,
                status: "active" as const,
                liveSource: "operations_v2" as const,
                liveUpdatedAt: null,
            })),
        ],
    };

    const plan = buildChiefPrivateRegulationAlertPlan({
        now: new Date("2026-03-26T11:05:00-03:00"),
        board,
    });

    assert.equal(plan, null);

    // Sem falta de gente, o grupo também fica em silêncio na checagem.
    const plans = buildReminderPlans({
        now: new Date("2026-03-26T11:05:00-03:00"),
        board,
    });
    assert.equal(plans.find((item) => item.stage === "regulation_confirmation"), undefined);
});

test("buildTakeoverConflictPlan writes a private one-liner with both names and elapsed minutes", () => {
    const plan = buildTakeoverConflictPlan({
        now: new Date("2026-03-26T15:23:00.000Z"),
        conflict: {
            id: "log-1",
            createdAt: new Date("2026-03-26T15:00:00.000Z"),
            chatId: "-1001591556887",
            sector: "REGULATION",
            targetCode: "2034",
            arrivingDoctorName: "Luan Sampaio",
            occupantDoctorName: "Kêmylla Braga",
        },
    });

    assert.equal(plan.stage, "takeover_conflict_alert");
    assert.equal(plan.parseMode, "Markdown");
    assert.match(plan.text, /⚠️ Tomada pendente em Regulação \*2034\*: \*Luan Sampaio\* × \*Kêmylla Braga\* há \*23 min\*\./);
    assert.match(plan.text, /`confirmo 2034`/);
    assert.equal(plan.payload.elapsedMinutes, 23);
});

test("buildTakeoverConflictPlan falls back to neutral labels when names are unknown", () => {
    const plan = buildTakeoverConflictPlan({
        now: new Date("2026-03-26T15:05:00.000Z"),
        conflict: {
            id: "log-2",
            createdAt: new Date("2026-03-26T15:00:00.000Z"),
            chatId: "-1001591556887",
            sector: "INTERVENTION",
            targetCode: "PM04",
            arrivingDoctorName: null,
            occupantDoctorName: null,
        },
    });

    assert.match(plan.text, /Tomada pendente em Intervenção \*PM04\*: \*médico chegando\* × \*ocupante atual\*/);
});
