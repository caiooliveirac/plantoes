import assert from "node:assert/strict";
import test from "node:test";
import { buildReminderPlans, type ReminderShiftSnapshot } from "@/modules/telegram/reminders";

function makeShift(overrides: Partial<ReminderShiftSnapshot>): ReminderShiftSnapshot {
    return {
        shiftInstanceId: "shift-1",
        targetCode: "PM04",
        targetLabel: "PM04",
        sector: "INTERVENTION",
        scheduledStartAt: null,
        scheduledEndAt: null,
        arrivalTime: null,
        departureTime: null,
        ...overrides,
    };
}

test("buildReminderPlans creates greeting and inactivity nudge before unresolved start and end", () => {
    const now = new Date("2026-03-25T18:56:00-03:00");
    const plans = buildReminderPlans({
        now,
        lastActivityAt: new Date("2026-03-25T18:48:00-03:00"),
        shifts: [
            makeShift({
                shiftInstanceId: "start-1",
                targetCode: "PM04",
                scheduledStartAt: new Date("2026-03-25T19:00:00-03:00"),
            }),
            makeShift({
                shiftInstanceId: "end-1",
                targetCode: "2031",
                targetLabel: "2031",
                sector: "REGULATION",
                scheduledEndAt: new Date("2026-03-25T19:00:00-03:00"),
                arrivalTime: new Date("2026-03-25T07:00:00-03:00"),
            }),
        ],
    });

    assert.equal(plans.some((plan) => plan.stage === "greeting"), true);
    assert.equal(plans.some((plan) => plan.stage === "nudge"), true);
    assert.equal(plans.some((plan) => plan.stage === "escalation"), false);
    assert.match(plans.find((plan) => plan.stage === "nudge")?.text ?? "", /Avisem as chegadas|Avisem as saidas/);
});

test("buildReminderPlans escalates overdue unknown arrivals and departures", () => {
    const now = new Date("2026-03-25T19:12:00-03:00");
    const plans = buildReminderPlans({
        now,
        lastActivityAt: new Date("2026-03-25T19:00:00-03:00"),
        shifts: [
            makeShift({
                shiftInstanceId: "start-1",
                targetCode: "BR60",
                scheduledStartAt: new Date("2026-03-25T19:00:00-03:00"),
            }),
            makeShift({
                shiftInstanceId: "end-1",
                targetCode: "2032",
                targetLabel: "2032",
                sector: "REGULATION",
                scheduledEndAt: new Date("2026-03-25T19:00:00-03:00"),
                arrivalTime: new Date("2026-03-25T07:00:00-03:00"),
            }),
        ],
    });

    const escalation = plans.find((plan) => plan.stage === "escalation");
    assert.ok(escalation);
    assert.match(escalation?.text ?? "", /Chegadas ainda sem confirmacao/);
    assert.match(escalation?.text ?? "", /Saidas ainda sem confirmacao/);
    assert.match(escalation?.text ?? "", /BR60/);
    assert.match(escalation?.text ?? "", /2032/);
});