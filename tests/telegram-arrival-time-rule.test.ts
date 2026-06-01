import assert from "node:assert/strict";
import test from "node:test";

import { resolveArrivalPhase, getArrivalTimeCutoff } from "@/modules/telegram/config";
import { resolveArrivalEventTimeForPhase, buildArrivalRuleReply } from "@/modules/telegram/service";

const CUTOFF = "2026-06-01T00:00:00-03:00";
const BEFORE = new Date("2026-05-31T22:00:00-03:00"); // FASE 1
const AFTER = new Date("2026-06-01T07:30:00-03:00"); // FASE 2

function withCutoff<T>(value: string | undefined, fn: () => T): T {
    const previous = process.env.ARRIVAL_TIME_CUTOFF;
    if (value === undefined) {
        delete process.env.ARRIVAL_TIME_CUTOFF;
    } else {
        process.env.ARRIVAL_TIME_CUTOFF = value;
    }
    try {
        return fn();
    } finally {
        if (previous === undefined) {
            delete process.env.ARRIVAL_TIME_CUTOFF;
        } else {
            process.env.ARRIVAL_TIME_CUTOFF = previous;
        }
    }
}

test("getArrivalTimeCutoff: ausente ou inválido => null (fail-safe FASE 1)", () => {
    withCutoff(undefined, () => assert.equal(getArrivalTimeCutoff(), null));
    withCutoff("not-a-date", () => assert.equal(getArrivalTimeCutoff(), null));
    withCutoff(CUTOFF, () => assert.equal(getArrivalTimeCutoff()?.toISOString(), "2026-06-01T03:00:00.000Z"));
});

test("resolveArrivalPhase: sem cutoff sempre FASE 1", () => {
    withCutoff(undefined, () => {
        assert.equal(resolveArrivalPhase(BEFORE), "phase1");
        assert.equal(resolveArrivalPhase(AFTER), "phase1");
    });
});

test("resolveArrivalPhase: antes do cutoff FASE 1, no/após o cutoff FASE 2", () => {
    withCutoff(CUTOFF, () => {
        assert.equal(resolveArrivalPhase(BEFORE), "phase1");
        assert.equal(resolveArrivalPhase(new Date(CUTOFF)), "phase2");
        assert.equal(resolveArrivalPhase(AFTER), "phase2");
    });
});

test("resolveArrivalEventTimeForPhase: FASE 1 mantém o horário declarado", () => {
    withCutoff(CUTOFF, () => {
        const eventAt = resolveArrivalEventTimeForPhase(BEFORE, "21:00", true);
        // 21:00 declarado != 22:00 da mensagem -> registra o declarado
        assert.notEqual(eventAt.getTime(), BEFORE.getTime());
        assert.equal(eventAt.toISOString(), "2026-06-01T00:00:00.000Z"); // 21:00 -03:00
    });
});

test("resolveArrivalEventTimeForPhase: FASE 2 ignora o declarado em chegada genuína", () => {
    withCutoff(CUTOFF, () => {
        const eventAt = resolveArrivalEventTimeForPhase(AFTER, "06:00", true);
        // ignora "06:00" e usa o timestamp da mensagem
        assert.equal(eventAt.getTime(), AFTER.getTime());
    });
});

test("resolveArrivalEventTimeForPhase: FASE 2 preserva o declarado quando NÃO é chegada (saída/continuação)", () => {
    withCutoff(CUTOFF, () => {
        const eventAt = resolveArrivalEventTimeForPhase(AFTER, "06:00", false);
        // saída/continuação mantêm o horário declarado
        assert.notEqual(eventAt.getTime(), AFTER.getTime());
        assert.equal(eventAt.toISOString(), "2026-06-01T09:00:00.000Z"); // 06:00 -03:00
    });
});

test("buildArrivalRuleReply: FASE 1 com horário declarado avisa que a regra muda", () => {
    withCutoff(CUTOFF, () => {
        const reply = buildArrivalRuleReply({
            name: "Ana",
            base: "SM01",
            messageReferenceAt: BEFORE,
            declaredArrivalTime: "21:00",
            isPcoverage: false,
        });
        assert.match(reply, /A partir de amanhã/);
        assert.match(reply, /desde 21:00/);
        assert.match(reply, /sua msg foi 22:00/);
    });
});

test("buildArrivalRuleReply: FASE 1 sem horário declarado confirma a hora da mensagem", () => {
    withCutoff(CUTOFF, () => {
        const reply = buildArrivalRuleReply({
            name: "Ana",
            base: "SM01",
            messageReferenceAt: BEFORE,
            declaredArrivalTime: null,
            isPcoverage: false,
        });
        assert.match(reply, /desde 22:00/);
        assert.match(reply, /A partir de amanhã/);
        assert.doesNotMatch(reply, /sua msg foi/);
    });
});

test("buildArrivalRuleReply: FASE 2 registra a hora do aviso e mostra a declarada como ignorada", () => {
    withCutoff(CUTOFF, () => {
        const reply = buildArrivalRuleReply({
            name: "Ana",
            base: "SM01",
            messageReferenceAt: AFTER,
            declaredArrivalTime: "06:00",
            isPcoverage: false,
        });
        assert.match(reply, /✅ Ana na SM01 desde 07:30/);
        assert.match(reply, /Não aceitamos mais aviso de chegada anterior/);
        assert.match(reply, /você avisou 06:00/);
    });
});

test("buildArrivalRuleReply: FASE 2 sem declarado não cita hora informada", () => {
    withCutoff(CUTOFF, () => {
        const reply = buildArrivalRuleReply({
            name: "Ana",
            base: "SM01",
            messageReferenceAt: AFTER,
            declaredArrivalTime: null,
            isPcoverage: false,
        });
        assert.match(reply, /desde 07:30/);
        assert.doesNotMatch(reply, /você avisou/);
    });
});

test("buildArrivalRuleReply: cobertura P acrescenta a nota de duplo plantão", () => {
    withCutoff(CUTOFF, () => {
        const reply = buildArrivalRuleReply({
            name: "Ana",
            base: "SM01",
            messageReferenceAt: AFTER,
            declaredArrivalTime: null,
            isPcoverage: true,
        });
        assert.match(reply, /Cobertura P/);
    });
});
