import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldJoinDoctorTurnoGroup } from "@/modules/operational/turno";

const d = (v: string) => new Date(v);

describe("shouldJoinDoctorTurnoGroup (ADR-007 R1)", () => {
    it("posição anterior aberta: entra no grupo (remanejo implícito)", () => {
        assert.equal(shouldJoinDoctorTurnoGroup({
            previousStartedAt: d("2026-09-15T07:10:00-03:00"), previousEndedAt: null, arrivalAt: d("2026-09-15T11:00:00-03:00"),
        }), true);
    });

    it("mesmo slot com intervalo (saiu do 2154 às 09:00, chegou na CZ50 às 11:00): mesmo turno", () => {
        assert.equal(shouldJoinDoctorTurnoGroup({
            previousStartedAt: d("2026-09-15T07:10:00-03:00"), previousEndedAt: d("2026-09-15T09:00:00-03:00"), arrivalAt: d("2026-09-15T11:00:00-03:00"),
        }), true);
    });

    it("encostada na virada: SD fechou 19:09, 'continua na SM01 SN' 19:09 entra no grupo (caso Uemerson)", () => {
        assert.equal(shouldJoinDoctorTurnoGroup({
            previousStartedAt: d("2026-06-28T07:49:00-03:00"), previousEndedAt: d("2026-06-28T19:09:00-03:00"), arrivalAt: d("2026-06-28T19:09:30-03:00"),
        }), true);
    });

    it("chegada antecipada às 06:45 no ramal errado, expulsa 07:13, chegada 07:20 em outro: mesmo turno SD", () => {
        assert.equal(shouldJoinDoctorTurnoGroup({
            previousStartedAt: d("2026-08-02T06:47:00-03:00"), previousEndedAt: d("2026-08-02T07:13:00-03:00"), arrivalAt: d("2026-08-02T07:20:00-03:00"),
        }), true);
    });

    it("SN de ontem fechou 07:00; chegada hoje 07:45 em outra base: turno novo, grupo novo", () => {
        assert.equal(shouldJoinDoctorTurnoGroup({
            previousStartedAt: d("2026-09-14T19:03:00-03:00"), previousEndedAt: d("2026-09-15T07:00:00-03:00"), arrivalAt: d("2026-09-15T07:45:00-03:00"),
        }), false);
    });

    it("SD de ontem; chegada hoje no mesmo horário: outro turno", () => {
        assert.equal(shouldJoinDoctorTurnoGroup({
            previousStartedAt: d("2026-09-14T07:10:00-03:00"), previousEndedAt: d("2026-09-14T19:00:00-03:00"), arrivalAt: d("2026-09-15T07:10:00-03:00"),
        }), false);
    });

    it("chegada anterior à posição prévia (correção retroativa) nunca junta", () => {
        assert.equal(shouldJoinDoctorTurnoGroup({
            previousStartedAt: d("2026-09-15T09:00:00-03:00"), previousEndedAt: null, arrivalAt: d("2026-09-15T07:00:00-03:00"),
        }), false);
    });
});
