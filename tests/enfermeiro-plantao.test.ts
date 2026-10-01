import test from "node:test";
import assert from "node:assert/strict";
import { decidirPortao } from "@/modules/acessos/portao";
import { normalizarEmails, turnoDoMomento, turnosDoPortao } from "@/modules/operational/enfermeiro-plantao";
import { filtrarCandidatos } from "@/components/board/enfermeiro-busca";

// Salvador = UTC-3 (sem horário de verão).
const salvador = (iso: string) => new Date(`${iso}-03:00`);
const rotulos = (agora: Date) => turnosDoPortao(agora).map((t) => `${t.data} ${t.turno}`).sort();

// ── Portão ───────────────────────────────────────────────────────────────────
test("portão: enfermeiro(a) do turno passa no quadro com motivo próprio", () => {
    assert.deepEqual(
        decidirPortao({ roles: ["portal"], emTurno: false, naCentral: false, enfermeiroDoTurno: true }),
        { liberado: true, motivo: "enfermeiro" },
    );
});

test("portão: sem registro do enfermeiro(a), conta de portal fora da Central continua barrada", () => {
    assert.deepEqual(
        decidirPortao({ roles: ["portal"], emTurno: false, naCentral: false, enfermeiroDoTurno: false }),
        { liberado: false, motivo: "fora_do_plantao" },
    );
});

test("portão: Tabela (sem o campo do enfermeiro) decide igual a antes", () => {
    assert.deepEqual(decidirPortao({ roles: ["portal"], emTurno: false, naCentral: false }), { liberado: false, motivo: "fora_do_plantao" });
    assert.deepEqual(decidirPortao({ roles: ["doctor"], emTurno: true, naCentral: false }), { liberado: true, motivo: "plantao" });
    assert.deepEqual(decidirPortao({ roles: ["doctor"], emTurno: false, naCentral: true }), { liberado: true, motivo: "central" });
});

test("portão: médico em turno e Central continuam com o motivo deles mesmo sendo enfermeiro(a) registrado", () => {
    assert.equal(decidirPortao({ roles: ["doctor"], emTurno: true, naCentral: false, enfermeiroDoTurno: true }).motivo, "plantao");
    assert.equal(decidirPortao({ roles: ["admin"], emTurno: false, naCentral: false, enfermeiroDoTurno: true }).motivo, "admin");
});

// ── Turno ────────────────────────────────────────────────────────────────────
test("turno: SD de dia, SN da noite e SN da madrugada pertence à data anterior", () => {
    assert.deepEqual(
        { data: turnoDoMomento(salvador("2026-10-01T10:00:00")).data, turno: turnoDoMomento(salvador("2026-10-01T10:00:00")).turno },
        { data: "2026-10-01", turno: "SD" },
    );
    assert.equal(turnoDoMomento(salvador("2026-10-01T19:00:00")).turno, "SN");
    assert.equal(turnoDoMomento(salvador("2026-10-01T19:00:00")).data, "2026-10-01");
    const madrugada = turnoDoMomento(salvador("2026-10-02T02:30:00"));
    assert.equal(madrugada.turno, "SN");
    assert.equal(madrugada.data, "2026-10-01");
});

test("turno: no meio do turno vale só o corrente", () => {
    assert.deepEqual(rotulos(salvador("2026-10-01T12:00:00")), ["2026-10-01 SD"]);
    assert.deepEqual(rotulos(salvador("2026-10-02T01:00:00")), ["2026-10-01 SN"]);
});

test("turno: até 60 min depois da virada vale também o turno que acabou", () => {
    assert.deepEqual(rotulos(salvador("2026-10-01T07:59:00")), ["2026-09-30 SN", "2026-10-01 SD"]);
    assert.deepEqual(rotulos(salvador("2026-10-01T19:30:00")), ["2026-10-01 SD", "2026-10-01 SN"]);
    assert.deepEqual(rotulos(salvador("2026-10-01T08:01:00")), ["2026-10-01 SD"]);
});

test("turno: 30 min antes da virada vale também o turno que vai começar", () => {
    assert.deepEqual(rotulos(salvador("2026-10-01T18:30:00")), ["2026-10-01 SD", "2026-10-01 SN"]);
    assert.deepEqual(rotulos(salvador("2026-10-02T06:40:00")), ["2026-10-01 SN", "2026-10-02 SD"]);
    assert.deepEqual(rotulos(salvador("2026-10-01T18:29:00")), ["2026-10-01 SD"]);
});

test("e-mails: minúsculos, sem repetição, só o que parece e-mail", () => {
    assert.deepEqual(normalizarEmails([" Ana@Exemplo.invalid ", "ana@exemplo.invalid", "", 3, "sem-arroba"]), ["ana@exemplo.invalid"]);
});

// ── Busca do seletor ─────────────────────────────────────────────────────────
const candidatos = [
    { id: "1", nome: "Ângela Conceição Brandão", matricula: "40123" },
    { id: "2", nome: "José Antônio Lima", matricula: "50888" },
    { id: "3", nome: "Joana Prado", matricula: null },
];

test("busca: sem acento e sem caixa, por pedaço do nome", () => {
    assert.deepEqual(filtrarCandidatos(candidatos, "angela").map((c) => c.id), ["1"]);
    assert.deepEqual(filtrarCandidatos(candidatos, "CONCEICAO").map((c) => c.id), ["1"]);
    assert.deepEqual(filtrarCandidatos(candidatos, "jo").map((c) => c.id), ["2", "3"]);
});

test("busca: por matrícula e com várias palavras (todas têm de aparecer)", () => {
    assert.deepEqual(filtrarCandidatos(candidatos, "508").map((c) => c.id), ["2"]);
    assert.deepEqual(filtrarCandidatos(candidatos, "jose lima").map((c) => c.id), ["2"]);
    assert.deepEqual(filtrarCandidatos(candidatos, "jose prado"), []);
});

test("busca: termo vazio devolve a lista (até o limite)", () => {
    assert.equal(filtrarCandidatos(candidatos, "  ").length, 3);
    assert.equal(filtrarCandidatos(candidatos, "", 2).length, 2);
});
