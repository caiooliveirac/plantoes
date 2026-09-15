import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    describeDepartureOrigin,
    resolveDepartureOrigin,
    shouldQueueDepartureForChief,
} from "@/modules/operational/departure-origin";

const d = (v: string) => new Date(v);

describe("resolveDepartureOrigin", () => {
    it("aviso do médico vence qualquer coincidência de horário", () => {
        assert.equal(resolveDepartureOrigin({
            hasDepartureMessage: true,
            actualEndedAt: d("2026-09-15T07:16:00-03:00"),
            successorStartedAt: d("2026-09-15T07:16:00-03:00"),
        }), "verbalized");
    });

    it("outro médico chegou no alvo no mesmo minuto: sucessor (caso 2152, 07:05→07:16)", () => {
        assert.equal(resolveDepartureOrigin({
            hasDepartureMessage: false,
            actualEndedAt: d("2026-09-15T07:16:00-03:00"),
            scheduledEndAt: d("2026-09-15T19:15:00-03:00"),
            successorStartedAt: d("2026-09-15T07:16:40-03:00"),
        }), "successor");
    });

    it("o próprio médico chegou em outro alvo: mudança de posto, e não entra na fila", () => {
        const origin = resolveDepartureOrigin({
            hasDepartureMessage: false,
            actualEndedAt: d("2026-09-11T07:01:00-03:00"),
            movedToStartedAt: d("2026-09-11T07:01:00-03:00"),
            successorStartedAt: d("2026-09-11T07:01:00-03:00"),
        });
        assert.equal(origin, "own_move");
        assert.equal(shouldQueueDepartureForChief(origin), false);
    });

    it("encerrado exatamente no fim previsto, sem aviso: janela", () => {
        assert.equal(resolveDepartureOrigin({
            hasDepartureMessage: false,
            actualEndedAt: d("2026-09-15T19:00:00-03:00"),
            scheduledEndAt: d("2026-09-15T19:00:00-03:00"),
        }), "window");
    });

    it("chegada fora da tolerância de 2 min não explica o encerramento", () => {
        assert.equal(resolveDepartureOrigin({
            hasDepartureMessage: false,
            actualEndedAt: d("2026-09-15T07:16:00-03:00"),
            scheduledEndAt: d("2026-09-15T19:15:00-03:00"),
            successorStartedAt: d("2026-09-15T07:30:00-03:00"),
        }), "system");
    });
});

describe("describeDepartureOrigin", () => {
    it("sucessor: diz quem assumiu e que ninguém avisou saída", () => {
        const texto = describeDepartureOrigin({
            origin: "successor",
            doctorName: "José",
            targetCode: "2152",
            actualEndedAt: d("2026-09-15T07:16:00-03:00"),
            successorName: "Kêmylla Machado",
        });
        assert.match(texto, /Kêmylla Machado chegou no 2152 às 07:16/);
        assert.match(texto, /sem aviso de saída/);
    });

    it("avisou: uma linha com a hora", () => {
        assert.equal(describeDepartureOrigin({
            origin: "verbalized", doctorName: "Ana", targetCode: "BR05",
            actualEndedAt: d("2026-09-15T18:55:00-03:00"),
        }), "Avisou a saída às 18:55.");
    });
});
