import assert from "node:assert/strict";
import test from "node:test";

import {
    breakSegments,
    checkHandoffSchedule,
    handoffKindLabel,
    resolveBreakLabel,
    resolveHandoffWindow,
    planOccurrenceHandoff,
    type HandoffCounts,
    type HandoffRosterEntry,
    type HandoffTransfer,
} from "../modules/operational/occurrence-handoff";

const ROSTER: HandoffRosterEntry[] = [
    { ramal: "2031", name: "CP", role: "CP", lunch: null, rest: null },
    { ramal: "2032", name: "MRV A", role: "MRV", lunch: "12:30", rest: "18:00" },
    { ramal: "2151", name: "MRV B", role: "MRV", lunch: "13:30", rest: "18:00" },
    { ramal: "2040", name: "Recip", role: "RECIP", lunch: "11:30", rest: "18:00" },
    { ramal: "2045", name: "Psiq", role: "PSIQ", lunch: "12:30", rest: "18:00" },
    { ramal: "2050", name: "MR 1", role: null, lunch: "11:30", rest: "15:30" },
    { ramal: "2051", name: "MR 2", role: null, lunch: "11:30", rest: "16:30" },
    { ramal: "2052", name: "MR 3", role: null, lunch: "12:30", rest: "15:30" },
    { ramal: "2053", name: "MR 4", role: null, lunch: "12:30", rest: "16:30" },
    { ramal: "2054", name: "MR 5", role: null, lunch: "13:30", rest: "14:30" },
    { ramal: "2055", name: "MR 6", role: null, lunch: "13:30", rest: "14:30" },
    { ramal: "2056", name: "MR 7", role: null, lunch: "13:30", rest: "16:30" },
    { ramal: "2262", name: "COI", role: "COI", lunch: null, rest: null },
    { ramal: "4091", name: "DISP", role: "DISP", lunch: null, rest: null },
    { ramal: "NUC", name: "Núcleo", role: null, excludedPost: true, lunch: "12:30", rest: "16:30" },
];

const c = (aguardando: number, regulado: number): HandoffCounts => ({ aguardando, regulado });

function received(transfers: HandoffTransfer[], kind?: HandoffTransfer["kind"]) {
    const map = new Map<string, number>();
    for (const t of transfers) {
        if (kind && t.kind !== kind) continue;
        map.set(t.to, (map.get(t.to) ?? 0) + t.count);
    }
    return map;
}

function sent(transfers: HandoffTransfer[], from: string) {
    return transfers.filter((t) => t.from === from).reduce((a, t) => a + t.count, 0);
}

function spread(values: number[]) {
    return Math.max(...values) - Math.min(...values);
}

test("almoço 13:30 + descanso 14:30 vira um bloco só, volta 15:30", () => {
    assert.deepEqual(breakSegments({ lunch: "13:30", rest: "14:30" }), [[810, 930]]);
    assert.deepEqual(breakSegments({ lunch: "12:30", rest: "16:30" }), [[750, 810], [990, 1050]]);
});

test("11:30 sem RECIP: Regulado vai para quem sai 12:30, Aguardando para quem sai 13:30", () => {
    const plan = planOccurrenceHandoff({
        roster: ROSTER,
        slot: "11:30",
        counts: { "2040": c(4, 3), "2050": c(3, 5), "2051": c(2, 4) },
        seed: "2026-09-24",
    });
    assert.equal(plan.mode, "sem_recip");
    assert.deepEqual(plan.givers.map((g) => g.ramal).sort(), ["2040", "2050", "2051"]);

    // MRV (2032 às 12:30, 2151 às 13:30) nunca recebe
    const lunch1230 = new Set(["2052", "2053"]);
    const lunch1330 = new Set(["2054", "2055", "2056"]);
    for (const t of plan.transfers) {
        assert.ok((t.kind === "regulado" ? lunch1230 : lunch1330).has(t.to), `${t.kind} -> ${t.to}`);
    }
    assert.ok(spread([...lunch1230].map((r) => received(plan.transfers, "regulado").get(r) ?? 0)) <= 1);
    assert.ok(spread([...lunch1330].map((r) => received(plan.transfers, "aguardando").get(r) ?? 0)) <= 1);
    assert.equal(plan.unassigned, 0);
    assert.equal(plan.total, 21);
});

test("12:30 com total até 15 (fora o PSIQ): o RECIP fica com tudo dos outros", () => {
    const plan = planOccurrenceHandoff({
        roster: ROSTER,
        slot: "12:30",
        counts: { "2032": c(2, 1), "2052": c(2, 2), "2053": c(3, 2) },
        seed: "2026-09-24",
    });
    assert.equal(plan.mode, "recip");
    assert.equal(plan.recipLoad, 12);
    assert.ok(plan.transfers.every((t) => t.to === "2040"));
});

test("PSIQ nunca passa para o RECIP: o dele vai para quem volta, só para equilibrar", () => {
    const plan = planOccurrenceHandoff({
        roster: ROSTER,
        slot: "12:30",
        counts: { "2032": c(4, 3), "2045": c(3, 2), "2052": c(5, 6), "2053": c(6, 4) },
        seed: "2026-09-24",
    });
    const psiq = plan.transfers.filter((t) => t.from === "2045");
    assert.ok(psiq.length > 0);
    assert.ok(psiq.every((t) => t.to !== "2040"));
    assert.equal(sent(plan.transfers, "2045"), 5);
    // RECIP enche 15 só com Aguardando dos outros (15 disponíveis)
    assert.equal(plan.recipLoad, 15);
    assert.equal(received(plan.transfers, "regulado").get("2040") ?? 0, 0);
    // quem volta às 12:30: os MR das 11:30; carga equânime por tipo
    assert.deepEqual(plan.returning.map((p) => p.ramal).sort(), ["2050", "2051"]);
    const others = plan.transfers.filter((t) => t.to !== "2040");
    for (const kind of ["aguardando", "regulado"] as const) {
        const got = received(others, kind);
        assert.ok(Math.abs((got.get("2050") ?? 0) - (got.get("2051") ?? 0)) <= 1, kind);
    }
    assert.equal(plan.unassigned, 0);
});

test("MRV, PSIQ, CP, DISP e Núcleo nunca recebem", () => {
    for (const slot of ["11:30", "12:30", "13:30", "15:30", "16:30"]) {
        const counts = Object.fromEntries(ROSTER.map((e) => [e.ramal, c(5, 5)]));
        const plan = planOccurrenceHandoff({ roster: ROSTER, slot, counts, seed: "x" });
        for (const t of plan.transfers) {
            assert.ok(!["2032", "2151", "2045", "2031", "4091", "NUC"].includes(t.to), `${slot}: ${t.to}`);
            assert.ok(!["2031", "4091", "NUC"].includes(t.from), `${slot}: ${t.from}`);
        }
    }
});

test("15:30: quem almoçou 13:30 e descansou 14:30 está voltando", () => {
    const plan = planOccurrenceHandoff({
        roster: ROSTER,
        slot: "15:30",
        counts: { "2050": c(12, 4), "2052": c(6, 5) },
        seed: "2026-09-24",
    });
    assert.deepEqual(plan.returning.map((p) => p.ramal).sort(), ["2054", "2055"]);
    assert.equal(plan.recipLoad, 15);
    assert.equal(plan.unassigned, 0);
});

test("médico passa tudo para um só colega quando a conta fecha", () => {
    const roster: HandoffRosterEntry[] = [
        { ramal: "R", name: "Recip", role: "RECIP", lunch: "11:30", rest: "18:00" },
        { ramal: "A", name: "A", role: null, lunch: "12:30", rest: null },
        { ramal: "B", name: "B", role: null, lunch: "12:30", rest: null },
        { ramal: "C", name: "C", role: null, lunch: "12:30", rest: null },
        { ramal: "X", name: "X", role: null, lunch: "11:30", rest: null },
        { ramal: "Y", name: "Y", role: null, lunch: "11:30", rest: null },
        { ramal: "Z", name: "Z", role: null, lunch: "11:30", rest: null },
    ];
    // 15 Aguardando cabem inteiras no RECIP; sobram Regulado 4/4/4 para 3 que voltam
    const plan = planOccurrenceHandoff({
        roster,
        slot: "12:30",
        counts: { A: c(5, 4), B: c(5, 4), C: c(5, 4) },
        seed: "qualquer",
    });
    const regulado = plan.transfers.filter((t) => t.kind === "regulado");
    assert.equal(regulado.length, 3);
    assert.deepEqual([...received(regulado).values()].sort(), [4, 4, 4]);
    for (const from of ["A", "B", "C"]) {
        assert.equal(regulado.filter((t) => t.from === from).length, 1);
    }
});

test("mesma entrada, mesma divisão (painel e bot concordam)", () => {
    const args = {
        roster: ROSTER,
        slot: "12:30",
        counts: { "2032": c(4, 3), "2045": c(3, 0), "2052": c(5, 6), "2053": c(6, 4) },
        seed: "2026-09-24",
    };
    assert.deepEqual(planOccurrenceHandoff(args), planOccurrenceHandoff(args));
});

test("empate: fica a divisão anterior", () => {
    // A e B iguais, X e Y voltando: A→X/B→Y empata com A→Y/B→X
    const base = {
        roster: [
            { ramal: "A", name: "A", role: null, lunch: "12:30", rest: null },
            { ramal: "B", name: "B", role: null, lunch: "12:30", rest: null },
            { ramal: "X", name: "X", role: null, lunch: "11:30", rest: null },
            { ramal: "Y", name: "Y", role: null, lunch: "11:30", rest: null },
            { ramal: "R", name: "R", role: "RECIP", lunch: "11:30", rest: null },
        ] satisfies HandoffRosterEntry[],
        slot: "12:30",
        counts: { A: c(4, 4), B: c(4, 4) },
        recipCap: 0,
    };
    const key = (transfers: HandoffTransfer[]) => transfers.map((t) => `${t.from}>${t.to}:${t.kind}:${t.count}`).sort().join("|");
    const first = planOccurrenceHandoff({ ...base, seed: "a" });
    assert.equal(first.transfers.length, 4); // cada um fala com uma pessoa só
    // a divisão espelhada é igualmente boa; passada como anterior, ela fica
    const mirrored = first.transfers.map((t) => ({ ...t, to: t.to === "X" ? "Y" : "X" }));
    assert.notEqual(key(mirrored), key(first.transfers));
    const kept = planOccurrenceHandoff({ ...base, seed: "a", previous: mirrored });
    assert.equal(key(kept.transfers), key(mirrored));
});

test("janela: aceita mudança até 10 min depois da saída, depois congela", () => {
    assert.deepEqual(resolveHandoffWindow("12:14"), null);
    assert.deepEqual(resolveHandoffWindow("12:15"), { slot: "12:30", phase: "aviso", editable: false });
    assert.deepEqual(resolveHandoffWindow("12:20"), { slot: "12:30", phase: "contagem", editable: true });
    assert.deepEqual(resolveHandoffWindow("12:40"), { slot: "12:30", phase: "divisao", editable: true });
    assert.deepEqual(resolveHandoffWindow("12:41"), { slot: "12:30", phase: "encerrada", editable: false });
    assert.deepEqual(resolveHandoffWindow("12:46"), null);
});

test("quem ainda não informou fica pendente e fora da divisão", () => {
    const plan = planOccurrenceHandoff({
        roster: ROSTER,
        slot: "13:30",
        counts: { "2054": c(9, 9) },
        seed: "2026-09-24",
    });
    assert.deepEqual(plan.pendingGivers.sort(), ["2055", "2056", "2151"]);
    assert.ok(plan.transfers.every((t) => t.from === "2054"));
    assert.equal(sent(plan.transfers, "2054"), 18);
});

test("COI entra na conta: recebe quando ninguém está voltando", () => {
    const roster: HandoffRosterEntry[] = [
        { ramal: "R", name: "Recip", role: "RECIP", lunch: "11:30", rest: "18:00" },
        { ramal: "A", name: "A", role: null, lunch: "16:30", rest: null },
        { ramal: "V", name: "MRV", role: "MRV", lunch: "13:30", rest: null },
        { ramal: "COI", name: "COI", role: "COI", lunch: null, rest: null },
        { ramal: "D", name: "DISP", role: "DISP", lunch: null, rest: null },
    ];
    const plan = planOccurrenceHandoff({ roster, slot: "16:30", counts: { A: c(15, 4) }, seed: "s" });
    assert.deepEqual(plan.returning, []);
    assert.deepEqual(plan.pools.regulado.map((p) => p.ramal), ["COI"]);
    assert.equal(received(plan.transfers).get("COI"), 4);
});

test("linha de quem está fora: ALMOÇO na primeira hora, DESCANSO na segunda", () => {
    assert.equal(resolveBreakLabel({ lunch: "13:30", rest: "14:30" }, "13:45"), "ALMOÇO");
    assert.equal(resolveBreakLabel({ lunch: "13:30", rest: "14:30" }, "14:30"), "DESCANSO");
    assert.equal(resolveBreakLabel({ lunch: "13:30", rest: "14:30" }, "15:30"), null);
    assert.equal(resolveBreakLabel({ lunch: null, rest: null }, "12:00"), null);
});

test("chefia é avisada de PSIQ com horário presumido e de quem está sem almoço", () => {
    const warnings = checkHandoffSchedule([
        { ramal: "P", name: "Psiq", role: "PSIQ", lunch: "12:30", rest: null, lunchAssumed: true },
        { ramal: "M", name: "MR", role: null, lunch: null, rest: "15:30" },
        { ramal: "C", name: "COI", role: "COI", lunch: null, rest: null },
        { ramal: "K", name: "CP", role: "CP", lunch: null, rest: null },
        { ramal: "N", name: "Núcleo", role: null, excludedPost: true, lunch: null, rest: null },
    ]);
    assert.deepEqual(warnings.map((w) => [w.ramal, w.problem]), [["P", "presumido"], ["M", "sem_almoco"]]);
});

test("plural só em Regulado, e só com quantidade diferente de 1", () => {
    assert.equal(handoffKindLabel("regulado", 1), "Regulado");
    assert.equal(handoffKindLabel("regulado", 2), "Regulados");
    assert.equal(handoffKindLabel("regulado", 0), "Regulados");
    assert.equal(handoffKindLabel("regulado"), "Regulado");
    assert.equal(handoffKindLabel("aguardando", 5), "Aguardando");
});
