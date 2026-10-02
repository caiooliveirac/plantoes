import assert from "node:assert/strict";
import test from "node:test";
import { resolveDepartureAutonomy, type DepartureAutonomyInput } from "@/modules/operational/departure-autonomy";

const sp = (value: string) => new Date(`${value}-03:00`).toISOString();

// SD de regulação: quadro 07:00–19:15, banco 07:00–19:00.
function sd(overrides: Partial<DepartureAutonomyInput> = {}): DepartureAutonomyInput {
    return {
        origin: "verbalized",
        startedAt: sp("2026-09-29T07:00"),
        actualEndedAt: sp("2026-09-29T19:05"),
        recordedAt: sp("2026-09-29T19:05"),
        scheduledStartAt: sp("2026-09-29T07:00"),
        scheduledEndAt: sp("2026-09-29T19:15"),
        bankScheduledStartAt: sp("2026-09-29T07:00"),
        bankScheduledEndAt: sp("2026-09-29T19:00"),
        roleLabel: null,
        delayMinutes: -10,
        reasonCode: null,
        occurrenceNumberMissing: false,
        reasonOccurrenceCount30d: 0,
        ...overrides,
    };
}

test("rotina avisada pelo médico: o sistema confirma sozinho na virada seguinte", () => {
    const result = resolveDepartureAutonomy(sd());
    assert.equal(result.autonomy, "auto");
    assert.equal(result.suggestion?.label, "Confirmar saída 19:05");
    assert.equal(result.suggestion?.effect, "sem efeito em pagamento e banco");
    assert.equal(result.dueAt.toISOString(), sp("2026-09-30T07:00"));
});

test("rotina explicada pela chegada de quem assumiu também é automática", () => {
    assert.equal(resolveDepartureAutonomy(sd({ origin: "successor" })).autonomy, "auto");
});

test("quem sai minutos antes da virada tem pelo menos 1h de fila antes do automático", () => {
    // Saiu 06:58 do SN: a virada das 07:00 não conta — próxima é 19:00.
    const result = resolveDepartureAutonomy(sd({
        startedAt: sp("2026-09-28T19:00"),
        actualEndedAt: sp("2026-09-29T06:58"),
        recordedAt: sp("2026-09-29T06:58"),
        scheduledStartAt: sp("2026-09-28T19:00"),
        scheduledEndAt: sp("2026-09-29T07:15"),
        bankScheduledStartAt: sp("2026-09-28T19:00"),
        bankScheduledEndAt: sp("2026-09-29T07:00"),
    }));
    assert.equal(result.autonomy, "auto");
    assert.equal(result.dueAt.toISOString(), sp("2026-09-29T19:00"));
});

test("janela vencida sem aviso: só olhar, sugestão aplicada em 24h", () => {
    const result = resolveDepartureAutonomy(sd({
        origin: "window",
        actualEndedAt: sp("2026-09-29T19:15"),
        recordedAt: sp("2026-09-29T19:20"),
        delayMinutes: 0,
    }));
    assert.equal(result.autonomy, "glance");
    assert.equal(result.suggestion?.label, "Saiu no fim da janela, 19:15");
    assert.equal(result.dueAt.toISOString(), sp("2026-09-30T19:20"));
});

test("crédito tardio acima de 1h: sugestão creditar, com o número que o banco vai gravar", () => {
    const result = resolveDepartureAutonomy(sd({
        actualEndedAt: sp("2026-09-29T20:30"),
        recordedAt: sp("2026-09-29T20:30"),
        delayMinutes: 90,
    }));
    assert.equal(result.triage.kind, "late_credit");
    assert.equal(result.autonomy, "glance");
    assert.equal(result.suggestion?.label, "Creditar saída 20:30");
    // 90 min além das 19:00, chegada no horário: em dobro.
    assert.equal(result.suggestion?.effect, "banco +3h00");
    assert.equal(result.suggestion?.outcome, null);
});

test("motivo livre nunca é aplicado sozinho: a chefia decide", () => {
    const result = resolveDepartureAutonomy(sd({
        actualEndedAt: sp("2026-09-29T21:45"),
        recordedAt: sp("2026-09-29T21:46"),
        delayMinutes: 165,
        freeJustificationText: "após finalização da comitiva do presidente",
    }));
    assert.equal(result.triage.kind, "justification_review");
    assert.equal(result.autonomy, "decide");
    assert.equal(result.suggestion, null);
});

test("saída faltando ≤2h: sugestão plantão inteiro, gravado como desfecho", () => {
    const result = resolveDepartureAutonomy(sd({
        actualEndedAt: sp("2026-09-29T17:30"),
        recordedAt: sp("2026-09-29T17:30"),
        delayMinutes: -105,
    }));
    assert.equal(result.triage.kind, "early_full");
    assert.equal(result.autonomy, "glance");
    assert.equal(result.suggestion?.outcome, "full_shift");
    assert.equal(result.suggestion?.effect, "saiu 1h30 antes do fim");
});

test("dinheiro em jogo ou contradição é sempre decisão humana, sem sugestão", () => {
    const antesDe6h = resolveDepartureAutonomy(sd({
        actualEndedAt: sp("2026-09-29T11:00"),
        recordedAt: sp("2026-09-29T11:00"),
        delayMinutes: -495,
    }));
    assert.equal(antesDe6h.triage.kind, "early_bank_only");
    assert.equal(antesDe6h.autonomy, "decide");
    assert.equal(antesDe6h.suggestion, null);

    const anomalia = resolveDepartureAutonomy(sd({
        actualEndedAt: sp("2026-09-29T07:10"),
        recordedAt: sp("2026-09-29T07:10"),
    }));
    assert.equal(anomalia.triage.kind, "short_anomaly");
    assert.equal(anomalia.autonomy, "decide");

    const sistema = resolveDepartureAutonomy(sd({ origin: "system" }));
    assert.equal(sistema.triage.kind, "routine");
    assert.equal(sistema.autonomy, "decide", "fechado pelo sistema sem origem conhecida");
    assert.equal(sistema.dueAt.toISOString(), sp("2026-09-30T19:05"));
});
