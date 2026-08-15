import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    coversArrival,
    describeMergedArrival,
    resolveArrivalIdentity,
    type OccupancyIdentitySnapshot,
} from "@/modules/operational/occupancy-identity";

function d(value: string) {
    return new Date(value);
}

function ocupacao(overrides: Partial<OccupancyIdentitySnapshot> = {}): OccupancyIdentitySnapshot {
    return {
        id: "occ-1",
        doctorId: "doc-1",
        startedAt: d("2026-08-13T07:35:00-03:00"),
        endedAt: null,
        actualEndedAt: null,
        scheduledEndAt: d("2026-08-13T19:15:00-03:00"),
        ...overrides,
    };
}

describe("resolveArrivalIdentity", () => {
    it("sem ocupação anterior, cria", () => {
        const decisao = resolveArrivalIdentity({ startedAt: d("2026-08-13T07:35:00-03:00"), existing: [] });
        assert.equal(decisao.kind, "create");
    });

    it("redeclaração com o plantão aberto reusa a linha existente", () => {
        // Caso Perrone 2151: reenviou "Logouerrado" no meio do plantão.
        const decisao = resolveArrivalIdentity({
            startedAt: d("2026-08-13T12:00:00-03:00"),
            existing: [ocupacao()],
        });
        assert.equal(decisao.kind, "reuse");
        assert.equal(decisao.kind === "reuse" && decisao.occupancyId, "occ-1");
    });

    it("chegada depois de uma saída registrada, na mesma janela, JUNTA em vez de duplicar", () => {
        const decisao = resolveArrivalIdentity({
            startedAt: d("2026-08-13T19:14:00-03:00"),
            existing: [ocupacao({
                endedAt: d("2026-08-13T18:54:00-03:00"),
                actualEndedAt: d("2026-08-13T18:54:00-03:00"),
                scheduledEndAt: d("2026-08-14T07:00:00-03:00"),
            })],
        });
        assert.equal(decisao.kind, "merge");
        assert.equal(
            decisao.kind === "merge" && decisao.previousDepartureAt?.toISOString(),
            d("2026-08-13T18:54:00-03:00").toISOString(),
        );
    });

    it("fechamento sem saída verbalizada (rendido por engano) também junta", () => {
        // Caso Maria Juliana BR05 14/08: fechada 19:41 pela chegada de outro médico.
        const decisao = resolveArrivalIdentity({
            startedAt: d("2026-08-14T19:48:00-03:00"),
            existing: [ocupacao({
                startedAt: d("2026-08-14T06:58:00-03:00"),
                endedAt: d("2026-08-14T19:41:00-03:00"),
                actualEndedAt: null,
                scheduledEndAt: d("2026-08-15T07:00:00-03:00"),
            })],
        });
        assert.equal(decisao.kind, "merge");
        assert.equal(decisao.kind === "merge" && decisao.previousDepartureAt, null);
    });

    it("emendar SD e SN no mesmo ramal continua sendo dois plantões", () => {
        // Chegada 19:00 com a anterior programada até 19:15: está na cauda da
        // janela, é o turno seguinte.
        const decisao = resolveArrivalIdentity({
            startedAt: d("2026-08-13T19:00:00-03:00"),
            existing: [ocupacao({ scheduledEndAt: d("2026-08-13T19:15:00-03:00") })],
        });
        assert.equal(decisao.kind, "create");
    });

    it("chegada de outro dia não junta com o plantão de ontem", () => {
        const decisao = resolveArrivalIdentity({
            startedAt: d("2026-08-14T07:10:00-03:00"),
            existing: [ocupacao({
                endedAt: d("2026-08-13T19:00:00-03:00"),
                actualEndedAt: d("2026-08-13T19:00:00-03:00"),
            })],
        });
        assert.equal(decisao.kind, "create");
    });

    it("a chegada só corrige o início para trás, nunca para frente", () => {
        const maisCedo = resolveArrivalIdentity({
            startedAt: d("2026-08-13T07:05:00-03:00"),
            existing: [ocupacao()],
        });
        assert.equal(
            maisCedo.kind !== "create" && maisCedo.keptStartedAt.toISOString(),
            d("2026-08-13T07:05:00-03:00").toISOString(),
        );

        const maisTarde = resolveArrivalIdentity({
            startedAt: d("2026-08-13T12:30:00-03:00"),
            existing: [ocupacao()],
        });
        assert.equal(
            maisTarde.kind !== "create" && maisTarde.keptStartedAt.toISOString(),
            d("2026-08-13T07:35:00-03:00").toISOString(),
        );
    });

    it("sombra nunca é o mesmo plantão", () => {
        const decisao = resolveArrivalIdentity({
            startedAt: d("2026-08-13T12:00:00-03:00"),
            existing: [ocupacao({ isShadow: true })],
        });
        assert.equal(decisao.kind, "create");
    });

    it("com várias candidatas, escolhe a mais recente", () => {
        const decisao = resolveArrivalIdentity({
            startedAt: d("2026-08-13T12:00:00-03:00"),
            existing: [
                ocupacao({ id: "antiga", startedAt: d("2026-08-13T07:00:00-03:00") }),
                ocupacao({ id: "recente", startedAt: d("2026-08-13T11:00:00-03:00") }),
            ],
        });
        assert.equal(decisao.kind !== "create" && decisao.occupancyId, "recente");
    });

    it("meio plantão já no fim da janela não absorve a chegada seguinte", () => {
        assert.equal(
            coversArrival(
                ocupacao({
                    startedAt: d("2026-08-13T11:30:00-03:00"),
                    scheduledEndAt: d("2026-08-13T17:00:00-03:00"),
                }),
                d("2026-08-13T16:50:00-03:00"),
            ),
            false,
        );
    });
});

describe("describeMergedArrival", () => {
    it("nomeia a saída que a chegada contradiz", () => {
        const texto = describeMergedArrival({
            previousDepartureAt: d("2026-08-13T18:54:00-03:00"),
            arrivalAt: d("2026-08-13T19:14:00-03:00"),
        });
        assert.match(texto, /18:54/);
        assert.match(texto, /19:14/);
        assert.match(texto, /\[JUNTADO\]/);
    });

    it("diz quando não houve saída verbalizada", () => {
        const texto = describeMergedArrival({
            previousDepartureAt: null,
            arrivalAt: d("2026-08-14T19:48:00-03:00"),
        });
        assert.match(texto, /sem saída verbalizada/);
    });
});

describe("saída já confirmada pela chefia", () => {
    it("não é desfeita por uma chegada nova — vira plantão novo", () => {
        const decisao = resolveArrivalIdentity({
            startedAt: d("2026-08-13T19:14:00-03:00"),
            existing: [ocupacao({
                endedAt: d("2026-08-13T13:00:00-03:00"),
                actualEndedAt: d("2026-08-13T13:00:00-03:00"),
                scheduledEndAt: d("2026-08-14T07:00:00-03:00"),
                departureConfirmed: true,
            })],
        });
        assert.equal(decisao.kind, "create");
    });

    it("mas saída ainda não confirmada continua juntando", () => {
        const decisao = resolveArrivalIdentity({
            startedAt: d("2026-08-13T19:14:00-03:00"),
            existing: [ocupacao({
                endedAt: d("2026-08-13T13:00:00-03:00"),
                actualEndedAt: d("2026-08-13T13:00:00-03:00"),
                scheduledEndAt: d("2026-08-14T07:00:00-03:00"),
                departureConfirmed: false,
            })],
        });
        assert.equal(decisao.kind, "merge");
    });
});
