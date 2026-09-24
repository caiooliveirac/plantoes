import assert from "node:assert/strict";
import test from "node:test";

import { planOccurrenceHandoff } from "../modules/operational/occurrence-handoff";
import { isOccurrenceHandoffBotEnabled } from "../modules/telegram/occurrence-handoff-cycle";
import {
    buildHandoffDivisionMessage,
    buildHandoffNoticeMessage,
    buildHandoffPendingMessage,
} from "../modules/telegram/occurrence-handoff-messages";
import type { MealBreakSession } from "../modules/telegram/meal-breaks";
import { buildHandoffRoster } from "../services/occurrence-handoff.service";

function session(): MealBreakSession {
    const doctor = (ramal: string, name: string, roleLabel: string | null) => ({
        doctorId: `d-${ramal}`, ramal, name, domain: "regulation" as const, startedAt: "2026-09-24T10:00:00Z", shiftLabel: "SD" as const, roleLabel,
    });
    return {
        roster: [
            doctor("2040", "Recip", null),
            doctor("2032", "Mrv", null),
            doctor("2045", "Psiq", "PSIQ"),
            doctor("2050", "Mr A", null),
            doctor("2052", "Mr B", null),
            doctor("2262", "Coi", "COI"),
        ],
        recipRamal: "2040",
        mrvRamals: ["2032"],
        lunchAssignments: { "2040": "11:30", "2032": "12:30", "2050": "11:30", "2052": "12:30" },
        restAssignments: { "2040": "18:00", "2032": "18:00", "2050": "15:30" },
        operationalDate: "2026-09-24",
    } as unknown as MealBreakSession;
}

test("roster da passagem vem da sessão de refeições: RECIP/MRV da sessão, PSIQ presumido", () => {
    const roster = buildHandoffRoster(session());
    const byRamal = new Map(roster.map((e) => [e.ramal, e]));
    assert.equal(byRamal.get("2040")!.role, "RECIP");
    assert.equal(byRamal.get("2032")!.role, "MRV");
    assert.deepEqual(
        [byRamal.get("2045")!.lunch, byRamal.get("2045")!.rest, byRamal.get("2045")!.lunchAssumed],
        ["12:30", "18:00", true],
    );
    assert.equal(byRamal.get("2052")!.rest, null);
    assert.equal(byRamal.get("2262")!.lunch, null);
});

test("bot da passagem liga por padrão e desliga com OCCURRENCE_HANDOFF_BOT_ENABLED=0", () => {
    assert.equal(isOccurrenceHandoffBotEnabled({} as unknown as NodeJS.ProcessEnv), true);
    assert.equal(isOccurrenceHandoffBotEnabled({ OCCURRENCE_HANDOFF_BOT_ENABLED: "0" } as unknown as NodeJS.ProcessEnv), false);
    assert.equal(isOccurrenceHandoffBotEnabled({ OCCURRENCE_HANDOFF_BOT_ENABLED: "false" } as unknown as NodeJS.ProcessEnv), false);
});

test("mensagens do bot: aviso, cobrança com @, divisão com plural de Regulado", () => {
    const roster = buildHandoffRoster(session());
    const plan = planOccurrenceHandoff({
        roster,
        slot: "12:30",
        counts: { "2032": { aguardando: 12, regulado: 5 }, "2045": { aguardando: 1, regulado: 1 } },
        seed: "2026-09-24",
    });
    const link = "https://plantoes.mnrs.com.br/";
    const notice = buildHandoffNoticeMessage({ plan, link });
    assert.match(notice, /Saída das 12:30 em 15 min/);
    assert.match(notice, /MRV: só amarelas/);
    assert.match(notice, /PSIQ distribui entre os colegas/);

    const pending = buildHandoffPendingMessage({ plan, link, mention: (r) => (r === "2052" ? "@mr\\_b" : null) });
    assert.ok(pending);
    assert.match(pending!, /@mr\\_b/);

    const division = buildHandoffDivisionMessage({ plan, link });
    assert.match(division, /12 Aguardando → Recip \(RECIP\)/);
    assert.match(division, /Regulados →|1 Regulado →/);
    assert.doesNotMatch(division, /Psiq\*? passa:\n {2}• \d+ \w+ → Recip/);
    assert.match(division, /Correções no painel até 12:40/);
});
