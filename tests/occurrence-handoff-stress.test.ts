import assert from "node:assert/strict";
import test from "node:test";

import {
    RECIP_HANDOFF_CAP,
    contactsPerGiver,
    planOccurrenceHandoff,
    solveHandoffKind,
    type HandoffCounts,
    type HandoffRosterEntry,
} from "../modules/operational/occurrence-handoff";

// Gerador determinístico para o teste ser reprodutível.
function lcg(seed: number) {
    let s = seed >>> 0;
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 4294967296;
    };
}
const pick = <T,>(rng: () => number, items: readonly T[]) => items[Math.floor(rng() * items.length)];
const int = (rng: () => number, max: number) => Math.floor(rng() * (max + 1));

/** Menor número de conversas possível, por força bruta sobre todas as matrizes. */
function bruteMinEdges(supply: number[], fixedQuota: number | null, equalCount: number, restricted = -1): number {
    const R = (fixedQuota === null ? 0 : 1) + equalCount;
    const total = supply.reduce((a, b) => a + b, 0);
    let best = Infinity;
    const loads = new Array<number>(R).fill(0);
    const rec = (g: number, edges: number) => {
        if (edges >= best) return;
        if (g === supply.length) {
            if (fixedQuota !== null && loads[0] !== fixedQuota) return;
            const eq = loads.slice(fixedQuota === null ? 0 : 1);
            if (loads.reduce((a, b) => a + b, 0) !== total) return;
            if (eq.length && Math.max(...eq) - Math.min(...eq) > 1) return;
            best = edges;
            return;
        }
        const parts = (left: number, i: number, used: number) => {
            if (i === R - 1) {
                loads[i] += left;
                rec(g + 1, edges + used + (left > 0 ? 1 : 0));
                loads[i] -= left;
                return;
            }
            for (let x = 0; x <= left; x += 1) {
                if (x > 0 && g === restricted && fixedQuota !== null && i === 0) break;
                loads[i] += x;
                parts(left - x, i + 1, used + (x > 0 ? 1 : 0));
                loads[i] -= x;
            }
        };
        parts(supply[g], 0, 0);
    };
    rec(0, 0);
    return best;
}

test("estresse: divisão de um tipo sempre atinge o mínimo de conversas (força bruta)", () => {
    const rng = lcg(20260924);
    let checked = 0;
    for (let round = 0; round < 1500; round += 1) {
        const G = 1 + int(rng, 3);
        const E = 1 + int(rng, 2);
        const supply = Array.from({ length: G }, () => int(rng, 6));
        const total = supply.reduce((a, b) => a + b, 0);
        const withFixed = rng() < 0.5;
        // às vezes o primeiro é PSIQ: não pode passar para o RECIP
        const restricted = withFixed && G > 1 && rng() < 0.4 ? 0 : -1;
        const free = total - (restricted === 0 ? supply[0] : 0);
        const fixedQuota = withFixed ? int(rng, free) : null;
        const expected = bruteMinEdges(supply, fixedQuota, E, restricted);
        const candidates = solveHandoffKind({
            supply: supply.map((n, i) => ({ id: `g${i}`, n, restricted: i === restricted })),
            fixed: fixedQuota === null ? [] : [{ id: "RECIP", q: fixedQuota }],
            equal: Array.from({ length: E }, (_, i) => `r${i}`),
            rng,
        });
        const edges = candidates[0].filter((f) => f.to).length;
        assert.equal(edges, expected, JSON.stringify({ supply, fixedQuota, E, restricted, flows: candidates[0] }));
        if (restricted === 0) assert.ok(!candidates[0].some((f) => f.from === "g0" && f.to === "RECIP"));
        // a solução é válida: cada um passa exatamente o que tem, cotas equânimes
        for (let i = 0; i < G; i += 1) {
            assert.equal(candidates[0].filter((f) => f.from === `g${i}`).reduce((a, f) => a + f.count, 0), supply[i]);
        }
        const loads = Array.from({ length: E }, (_, i) => candidates[0].filter((f) => f.to === `r${i}`).reduce((a, f) => a + f.count, 0));
        assert.ok(Math.max(...loads) - Math.min(...loads) <= 1);
        checked += 1;
    }
    assert.equal(checked, 1500);
});

const ROLES = [null, null, null, null, "MRV", "RECIP", "PSIQ", "COI", "IES", "RMT", "CP", "DISP"] as const;
const LUNCH = ["11:30", "12:30", "13:30", null] as const;
const REST = ["14:30", "15:30", "16:30", "18:00", null] as const;

function randomDay(rng: () => number): HandoffRosterEntry[] {
    const size = 5 + int(rng, 8);
    const roster: HandoffRosterEntry[] = [];
    let hasRecip = false;
    for (let i = 0; i < size; i += 1) {
        let role: string | null = pick(rng, ROLES);
        if (role === "RECIP") {
            if (hasRecip) role = null;
            hasRecip = true;
        }
        const noBreak = role === "COI" || role === "IES" || role === "RMT" || role === "CP" || role === "DISP";
        roster.push({
            ramal: String(2000 + i),
            name: `M${i}`,
            role,
            excludedPost: rng() < 0.05,
            lunch: noBreak ? null : role === "RECIP" ? "11:30" : pick(rng, LUNCH),
            rest: noBreak ? null : pick(rng, REST),
        });
    }
    return roster;
}

test("estresse: invariantes da passagem em 3.000 cenários sorteados", () => {
    const rng = lcg(7);
    const neverReceive = (e: HandoffRosterEntry) => e.excludedPost || ["MRV", "PSIQ", "CP", "DISP", "PIAM"].includes(e.role ?? "");
    const neverGive = (e: HandoffRosterEntry) => e.excludedPost || ["CP", "DISP", "PIAM"].includes(e.role ?? "");

    for (let day = 0; day < 500; day += 1) {
        const roster = randomDay(rng);
        const byRamal = new Map(roster.map((e) => [e.ramal, e]));
        for (const slot of ["11:30", "12:30", "13:30", "14:30", "15:30", "16:30"]) {
            const counts: Record<string, HandoffCounts> = {};
            for (const e of roster) {
                if (rng() < 0.9) counts[e.ramal] = { aguardando: int(rng, 14), regulado: int(rng, 14) };
            }
            const plan = planOccurrenceHandoff({ roster, slot, counts, seed: `d${day}` });
            const ctx = `dia ${day} ${slot}`;

            // conservação: cada um passa exatamente o que declarou (ou sobra sem destino)
            const sent = plan.transfers.reduce((a, t) => a + t.count, 0);
            assert.equal(sent + plan.unassigned, plan.total, ctx);
            const hasSomeone = plan.recip || plan.pools.aguardando.length || plan.pools.regulado.length;
            if (plan.pools.aguardando.length && plan.pools.regulado.length) assert.equal(plan.unassigned, 0, ctx);
            if (!hasSomeone) assert.equal(sent, 0, ctx);
            for (const g of plan.givers) {
                if (!counts[g.ramal] || plan.unassigned > 0) continue;
                for (const kind of ["aguardando", "regulado"] as const) {
                    const out = plan.transfers.filter((t) => t.from === g.ramal && t.kind === kind).reduce((a, t) => a + t.count, 0);
                    assert.equal(out, counts[g.ramal][kind], `${ctx} ${g.ramal} ${kind}`);
                }
            }

            // quem nunca recebe / nunca passa
            for (const t of plan.transfers) {
                assert.ok(!neverReceive(byRamal.get(t.to)!), `${ctx}: ${t.to} recebeu`);
                assert.ok(!neverGive(byRamal.get(t.from)!), `${ctx}: ${t.from} passou`);
                assert.notEqual(t.from, t.to, ctx);
                assert.ok(t.count > 0, ctx);
            }

            if (plan.recip) {
                const recip = plan.recip.ramal;
                assert.ok(plan.recipLoad <= RECIP_HANDOFF_CAP, ctx);
                const isPsiq = (ramal: string) => byRamal.get(ramal)!.role === "PSIQ";
                // PSIQ nunca passa para o RECIP
                assert.ok(!plan.transfers.some((t) => t.to === recip && isPsiq(t.from)), `${ctx}: PSIQ → RECIP`);
                // RECIP enche até o teto com o que não é do PSIQ
                const psiqTotal = plan.givers
                    .filter((g) => g.role === "PSIQ" && counts[g.ramal])
                    .reduce((a, g) => a + counts[g.ramal].aguardando + counts[g.ramal].regulado, 0);
                assert.equal(plan.recipLoad, Math.min(RECIP_HANDOFF_CAP, plan.total - psiqTotal), ctx);
                // Aguardando antes de Regulado no RECIP
                const agToOthers = plan.transfers.some((t) => t.kind === "aguardando" && t.to !== recip && !isPsiq(t.from));
                const reToRecip = plan.transfers.some((t) => t.kind === "regulado" && t.to === recip);
                assert.ok(!(agToOthers && reToRecip), `${ctx}: RECIP levou Regulado com Aguardando sobrando`);
            }

            // equidade por tipo entre os receptores comuns (a regra mais importante)
            for (const kind of ["aguardando", "regulado"] as const) {
                const pool = plan.pools[kind].map((p) => p.ramal);
                if (pool.length < 2) continue;
                const loads = pool.map((r) => plan.transfers.filter((t) => t.to === r && t.kind === kind).reduce((a, t) => a + t.count, 0));
                assert.ok(Math.max(...loads) - Math.min(...loads) <= 1, `${ctx} ${kind} ${loads}`);
            }

            // limite teórico: nunca mais conversas que uma árvore ligando todos
            const contacts = contactsPerGiver(plan.transfers);
            const pairs = [...contacts.values()].reduce((a, b) => a + b, 0);
            const receivers = new Set(plan.transfers.map((t) => t.to)).size;
            if (plan.transfers.length) assert.ok(pairs <= 2 * (contacts.size + receivers - 1), ctx);
        }
    }
});

test("quem passa os dois tipos fala com uma pessoa só quando a conta fecha", () => {
    const roster: HandoffRosterEntry[] = [
        { ramal: "A", name: "A", role: null, lunch: "12:30", rest: null },
        { ramal: "B", name: "B", role: null, lunch: "12:30", rest: null },
        { ramal: "C", name: "C", role: null, lunch: "12:30", rest: null },
        { ramal: "X", name: "X", role: null, lunch: "11:30", rest: null },
        { ramal: "Y", name: "Y", role: null, lunch: "11:30", rest: null },
        { ramal: "Z", name: "Z", role: null, lunch: "11:30", rest: null },
        { ramal: "R", name: "R", role: "RECIP", lunch: "11:30", rest: null },
    ];
    // RECIP leva 15 Aguardando (5+5+5 inteiros), sobram 3 Aguardando + Regulado
    const plan = planOccurrenceHandoff({
        roster,
        slot: "12:30",
        counts: { A: { aguardando: 6, regulado: 3 }, B: { aguardando: 6, regulado: 3 }, C: { aguardando: 6, regulado: 3 } },
        seed: "s",
    });
    const contacts = contactsPerGiver(plan.transfers);
    // cada um fala com o RECIP e com um colega — nunca com dois colegas
    for (const g of ["A", "B", "C"]) assert.ok(contacts.get(g)! <= 2, `${g}: ${contacts.get(g)}`);
    assert.equal([...contacts.values()].reduce((a, b) => a + b, 0), 6);
});

test("recalcula rápido o bastante para cada tecla (7 saem × 7 recebem)", () => {
    const roster: HandoffRosterEntry[] = [
        { ramal: "R", name: "R", role: "RECIP", lunch: "11:30", rest: null },
        ...Array.from({ length: 7 }, (_, i) => ({ ramal: `S${i}`, name: `S${i}`, role: null, lunch: "15:30", rest: null })),
        ...Array.from({ length: 7 }, (_, i) => ({ ramal: `V${i}`, name: `V${i}`, role: null, lunch: "13:30", rest: "14:30" })),
    ];
    const rng = lcg(99);
    const started = performance.now();
    for (let i = 0; i < 20; i += 1) {
        const counts = Object.fromEntries(Array.from({ length: 7 }, (_, k) => [`S${k}`, { aguardando: int(rng, 12), regulado: int(rng, 12) }]));
        planOccurrenceHandoff({ roster, slot: "15:30", counts, seed: `p${i}` });
    }
    const perPlan = (performance.now() - started) / 20;
    assert.ok(perPlan < 100, `${perPlan.toFixed(1)} ms por divisão`);
});

/** Todas as matrizes de um tipo (quem passa × [RECIP, receptores comuns]) que respeitam cotas e ±1. */
function allMatrices(supply: number[], R: number, ok: (loads: number[]) => boolean): number[][][] {
    const out: number[][][] = [];
    const cur: number[][] = [];
    const loads = new Array<number>(R).fill(0);
    const rec = (g: number) => {
        if (g === supply.length) {
            if (ok(loads)) out.push(cur.map((row) => row.slice()));
            return;
        }
        const row = new Array<number>(R).fill(0);
        const parts = (left: number, i: number) => {
            if (i === R - 1) {
                row[i] = left;
                loads[i] += left;
                cur.push(row.slice());
                rec(g + 1);
                cur.pop();
                loads[i] -= left;
                return;
            }
            for (let x = 0; x <= left; x += 1) {
                row[i] = x;
                loads[i] += x;
                parts(left - x, i + 1);
                loads[i] -= x;
            }
        };
        parts(supply[g], 0);
    };
    rec(0);
    return out;
}

test("estresse: Aguardando + Regulado juntos atingem o mínimo de conversas (força bruta conjunta)", () => {
    const rng = lcg(3);
    for (let round = 0; round < 250; round += 1) {
        const G = 1 + int(rng, 2);
        const E = 1 + int(rng, 2);
        const cap = int(rng, 8);
        const ag = Array.from({ length: G }, () => int(rng, 5));
        const re = Array.from({ length: G }, () => int(rng, 5));
        const roster: HandoffRosterEntry[] = [
            { ramal: "R", name: "R", role: "RECIP", lunch: "11:30", rest: null },
            ...ag.map((_, i) => ({ ramal: `g${i}`, name: `g${i}`, role: null, lunch: "12:30", rest: null })),
            ...Array.from({ length: E }, (_, i) => ({ ramal: `e${i}`, name: `e${i}`, role: null, lunch: "11:30", rest: null })),
        ];
        const counts = Object.fromEntries(ag.map((a, i) => [`g${i}`, { aguardando: a, regulado: re[i] }]));
        const plan = planOccurrenceHandoff({ roster, slot: "12:30", counts, seed: `x${round}`, recipCap: cap });
        const got = [...contactsPerGiver(plan.transfers).values()].reduce((a, b) => a + b, 0);

        const sumA = ag.reduce((a, b) => a + b, 0);
        const sumR = re.reduce((a, b) => a + b, 0);
        const qA = Math.min(cap, sumA);
        const qR = Math.min(cap - qA, sumR);
        const valid = (q: number) => (l: number[]) => l[0] === q && (l.length < 3 || Math.max(...l.slice(1)) - Math.min(...l.slice(1)) <= 1);
        let best = Infinity;
        for (const a of allMatrices(ag, E + 1, valid(qA))) {
            for (const r of allMatrices(re, E + 1, valid(qR))) {
                let pairs = 0;
                for (let g = 0; g < G; g += 1) for (let k = 0; k <= E; k += 1) if (a[g][k] || r[g][k]) pairs += 1;
                best = Math.min(best, pairs);
            }
        }
        assert.equal(got, best, JSON.stringify({ ag, re, E, cap, transfers: plan.transfers }));
    }
});

test("estresse: mudar um número mexe pouco na divisão e nunca custa conversa a mais", () => {
    const rng = lcg(11);
    type T = ReturnType<typeof planOccurrenceHandoff>["transfers"];
    const moved = (a: T, b: T) => {
        const m = new Map<string, number>();
        for (const t of a) m.set(`${t.from}>${t.to}:${t.kind}`, (m.get(`${t.from}>${t.to}:${t.kind}`) ?? 0) + t.count);
        for (const t of b) m.set(`${t.from}>${t.to}:${t.kind}`, (m.get(`${t.from}>${t.to}:${t.kind}`) ?? 0) - t.count);
        return [...m.values()].reduce((x, y) => x + Math.abs(y), 0) / 2;
    };
    const pairs = (t: T) => [...contactsPerGiver(t).values()].reduce((a, b) => a + b, 0);
    let withPrev = 0;
    let withoutPrev = 0;
    const rounds = 200;
    for (let k = 0; k < rounds; k += 1) {
        const G = 2 + int(rng, 3);
        const E = 1 + int(rng, 3);
        const roster: HandoffRosterEntry[] = [
            { ramal: "R", name: "R", role: "RECIP", lunch: "11:30", rest: null },
            { ramal: "P", name: "P", role: "PSIQ", lunch: "12:30", rest: null },
            ...Array.from({ length: G }, (_, i) => ({ ramal: `g${i}`, name: `g${i}`, role: null, lunch: "12:30", rest: null })),
            ...Array.from({ length: E }, (_, i) => ({ ramal: `e${i}`, name: `e${i}`, role: null, lunch: "11:30", rest: null })),
        ];
        const counts: Record<string, HandoffCounts> = { P: { aguardando: int(rng, 3), regulado: int(rng, 3) } };
        for (let i = 0; i < G; i += 1) counts[`g${i}`] = { aguardando: int(rng, 9), regulado: int(rng, 9) };
        const before = planOccurrenceHandoff({ roster, slot: "12:30", counts, seed: "s" });
        const who = `g${int(rng, G - 1)}`;
        const kind = rng() < 0.5 ? "aguardando" : "regulado";
        const changed = { ...counts, [who]: { ...counts[who], [kind]: counts[who][kind] + 1 } };
        const sticky = planOccurrenceHandoff({ roster, slot: "12:30", counts: changed, seed: "s", previous: before.transfers });
        const fresh = planOccurrenceHandoff({ roster, slot: "12:30", counts: changed, seed: "s" });
        assert.ok(pairs(sticky.transfers) <= pairs(fresh.transfers), `rodada ${k}`);
        withPrev += moved(sticky.transfers, before.transfers);
        withoutPrev += moved(fresh.transfers, before.transfers);
    }
    assert.ok(withPrev / rounds < 3, `move em média ${(withPrev / rounds).toFixed(2)}`);
    assert.ok(withPrev < withoutPrev / 2);
});
