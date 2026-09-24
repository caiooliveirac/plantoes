// Passagem de ocorrências na saída para almoço/descanso (regulação, turno diurno).
//
// Quem sai passa o que tem para quem fica. Regras (definidas pela chefia, 2026-09):
// - Entram na conta MR, RECIP, COI, IES e RMT. CP, DISP, PIAM e Núcleo ficam de
//   fora: não passam nem recebem.
// - MRV só passa, nunca recebe. Informa só as amarelas; o resto fica com ele.
// - PSIQ só passa e NUNCA para o RECIP: o dele vai para os colegas, só para
//   equilibrar. O RECIP enche com o dos outros.
// - Sem RECIP presente (11:30, ele está no primeiro descanso): Regulado vai para
//   quem sai às 12:30, Aguardando para quem sai às 13:30.
// - Com RECIP presente: ele recebe até 15, Aguardando primeiro, depois Regulado. O excedente vai para quem está voltando do intervalo nesse
//   horário (volta "vazio"); sem ninguém voltando, para quem fica.
// - Entre os receptores não-RECIP a divisão é equânime por tipo (diferença máxima
//   de 1) e, dentro disso, cada médico passa para o menor número possível de
//   colegas. Em empate, fica a divisão anterior (uma tecla não embaralha tudo);
//   sem anterior, sorteio com semente fixa (data + horário), para painel e bot
//   mostrarem sempre a mesma divisão.
//
// Módulo puro: não toca banco nem relógio.

export type HandoffKind = "aguardando" | "regulado";

export const RECIP_HANDOFF_CAP = 15;

/** "Aguardando" é invariável; "Regulado" vai ao plural quando há quantidade diferente de 1. */
export function handoffKindLabel(kind: HandoffKind, count?: number): string {
    if (kind === "aguardando") return "Aguardando";
    return count !== undefined && count !== 1 ? "Regulados" : "Regulado";
}

export interface HandoffRosterEntry {
    ramal: string;
    name: string;
    /** Função resolvida (resolveOperationalRoleLabel); null/MR = regulador comum. */
    role: string | null;
    /** true para postos Núcleo/PIAM, que ficam fora da conta pelo posto, não pela função. */
    excludedPost?: boolean;
    lunch: string | null;
    rest: string | null;
    /** Horário não confirmado (ex.: PSIQ, que o fluxo de refeições presume 12:30). */
    lunchAssumed?: boolean;
}

export interface HandoffCounts {
    aguardando: number;
    regulado: number;
}

export interface HandoffParticipant {
    ramal: string;
    name: string;
    role: string;
}

export interface HandoffTransfer {
    from: string;
    to: string;
    kind: HandoffKind;
    count: number;
}

export interface OccurrenceHandoffPlan {
    slot: string;
    mode: "recip" | "sem_recip";
    givers: HandoffParticipant[];
    /** Quem sai e ainda não informou a contagem. */
    pendingGivers: string[];
    recip: HandoffParticipant | null;
    /** Receptores não-RECIP por tipo. */
    pools: Record<HandoffKind, HandoffParticipant[]>;
    /** Quem está voltando do intervalo neste horário. */
    returning: HandoffParticipant[];
    transfers: HandoffTransfer[];
    recipLoad: number;
    total: number;
    /** Ocorrências sem destino (ninguém para receber) — o painel avisa. */
    unassigned: number;
}

const EXCLUDED_ROLES = new Set(["CP", "PIAM", "DISP"]);
const GIVER_ONLY_ROLES = new Set(["PSIQ", "MRV"]);
/** Nunca passa para o RECIP. */
const RECIP_EXCLUDED_ROLE = "PSIQ";
const BREAK_MINUTES = 60;

function toMinutes(hhmm: string): number {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m;
}

function normalizeRole(role: string | null): string {
    const value = (role ?? "").trim().toUpperCase();
    return value === "" || value === "SEM_FUNCAO" ? "MR" : value;
}

/** Intervalos do dia em minutos, com almoço e descanso colados fundidos (13:30 + 14:30 volta 15:30). */
export function breakSegments(entry: Pick<HandoffRosterEntry, "lunch" | "rest">): Array<[number, number]> {
    const starts = [entry.lunch, entry.rest]
        .filter((value): value is string => Boolean(value && /^\d{2}:\d{2}$/.test(value)))
        .map(toMinutes)
        .sort((a, b) => a - b);
    const segments: Array<[number, number]> = [];
    for (const start of starts) {
        const last = segments[segments.length - 1];
        if (last && last[1] === start) {
            last[1] = start + BREAK_MINUTES;
        } else {
            segments.push([start, start + BREAK_MINUTES]);
        }
    }
    return segments;
}

function participant(entry: HandoffRosterEntry): HandoffParticipant {
    return { ramal: entry.ramal, name: entry.name, role: normalizeRole(entry.role) };
}

export function resolveHandoffParticipants(roster: HandoffRosterEntry[], slot: string) {
    const t = toMinutes(slot);
    const role = (e: HandoffRosterEntry) => normalizeRole(e.role);
    const counts = (e: HandoffRosterEntry) => !e.excludedPost && !EXCLUDED_ROLES.has(role(e));
    const receives = (e: HandoffRosterEntry) => counts(e) && !GIVER_ONLY_ROLES.has(role(e));
    const segs = new Map(roster.map((e) => [e.ramal, breakSegments(e)]));
    const leavesNow = (e: HandoffRosterEntry) => segs.get(e.ramal)!.some(([a]) => a === t);
    const awayNow = (e: HandoffRosterEntry) => segs.get(e.ramal)!.some(([a, b]) => a <= t && t < b);
    const returnsNow = (e: HandoffRosterEntry) => segs.get(e.ramal)!.some(([, b]) => b === t);

    const givers = roster.filter((e) => counts(e) && leavesNow(e));
    const staying = roster.filter((e) => receives(e) && !awayNow(e));
    const recipEntry = staying.find((e) => role(e) === "RECIP") ?? null;
    const returning = roster.filter((e) => receives(e) && returnsNow(e) && role(e) !== "RECIP");

    let pools: Record<HandoffKind, HandoffRosterEntry[]>;
    if (!recipEntry) {
        const nonRecip = staying.filter((e) => role(e) !== "RECIP");
        const byLunch = (hhmm: string) => nonRecip.filter((e) => e.lunch === hhmm);
        const regulado = byLunch("12:30");
        const aguardando = byLunch("13:30");
        pools = {
            regulado: regulado.length ? regulado : nonRecip,
            aguardando: aguardando.length ? aguardando : nonRecip,
        };
    } else {
        const fallback = staying.filter((e) => e !== recipEntry);
        const pool = returning.length ? returning : fallback;
        pools = { regulado: pool, aguardando: pool };
    }

    return {
        mode: recipEntry ? ("recip" as const) : ("sem_recip" as const),
        givers: givers.map(participant),
        recip: recipEntry ? participant(recipEntry) : null,
        returning: returning.map(participant),
        pools: { regulado: pools.regulado.map(participant), aguardando: pools.aguardando.map(participant) },
    };
}

// ---------------------------------------------------------------------------
// Sorteio determinístico

function hashSeed(text: string): number {
    let h = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

function mulberry32(seed: number) {
    let a = seed;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function shuffled<T>(items: T[], rng: () => number): T[] {
    const copy = items.slice();
    for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}

// ---------------------------------------------------------------------------
// Divisão de um tipo (Aguardando ou Regulado).
//
// Cada receptor tem uma cota: o RECIP, cota fixa; os demais, cota equânime
// (base ou base+1). Com as cotas fixadas, o menor número de conversas possível é
// (quem passa) + (quem recebe) − (grupos), onde um grupo é um conjunto de quem
// passa cuja soma bate exatamente com a soma das cotas de um conjunto de quem
// recebe. Por isso buscamos, por programação dinâmica, a partição com o maior
// número de grupos — e, dentro de cada grupo, despejamos em sequência (cada
// passagem esvazia alguém), o que atinge o mínimo. Testamos todas as escolhas de
// quem leva o "+1" e ficamos com todas as de menor custo, para depois cruzar os
// dois tipos e reaproveitar conversas (quem já passa Aguardando para alguém,
// passa Regulado para a mesma pessoa).

export const HANDOFF_EXACT_LIMIT = 7;

export interface HandoffFlow {
    from: string;
    to: string;
    count: number;
}

/** `restricted`: não pode passar para receptor `blocked` (PSIQ → RECIP). */
interface Supply { id: string; n: number; restricted?: boolean }
interface Demand { id: string; q: number; blocked?: boolean }

/**
 * Partição de (fornecedores, demandas) com o maior número de grupos de soma igual.
 * Grupo com receptor bloqueado só vale se quem pode passar para ele cobre a cota.
 */
function bestGroups(supply: Supply[], demand: Demand[]): Array<[number[], number[]]> {
    const G = supply.length;
    const D = demand.length;
    const sumS = new Array<number>(1 << G).fill(0);
    const freeS = new Array<number>(1 << G).fill(0);
    const sumD = new Array<number>(1 << D).fill(0);
    const blockedD = new Array<number>(1 << D).fill(0);
    for (let m = 1; m < 1 << G; m += 1) {
        const low = m & -m;
        const s = supply[31 - Math.clz32(low)];
        sumS[m] = sumS[m ^ low] + s.n;
        freeS[m] = freeS[m ^ low] + (s.restricted ? 0 : s.n);
    }
    for (let m = 1; m < 1 << D; m += 1) {
        const low = m & -m;
        const d = demand[31 - Math.clz32(low)];
        sumD[m] = sumD[m ^ low] + d.q;
        blockedD[m] = blockedD[m ^ low] + (d.blocked ? d.q : 0);
    }
    const memo = new Map<number, { count: number; gs: number; ds: number }>();
    const solve = (gm: number, dm: number): number => {
        if (gm === 0) return dm === 0 ? 0 : -Infinity;
        const key = gm * (1 << D) + dm;
        const hit = memo.get(key);
        if (hit) return hit.count;
        const low = gm & -gm;
        const rest = gm ^ low;
        let best = { count: -Infinity, gs: gm, ds: dm };
        // submáscaras de rest (inclui 0), sempre com o menor fornecedor no grupo
        for (let sub = rest; ; sub = (sub - 1) & rest) {
            const gs = sub | low;
            const target = sumS[gs];
            for (let ds = dm; ds > 0; ds = (ds - 1) & dm) {
                if (sumD[ds] !== target || blockedD[ds] > freeS[gs]) continue;
                const value = 1 + solve(gm ^ gs, dm ^ ds);
                if (value > best.count) best = { count: value, gs, ds };
            }
            if (sub === 0) break;
        }
        memo.set(key, best);
        return best.count;
    };
    const full = [(1 << G) - 1, (1 << D) - 1] as const;
    if (solve(full[0], full[1]) === -Infinity) return [[[...Array(G).keys()], [...Array(D).keys()]]];
    const groups: Array<[number[], number[]]> = [];
    let [gm, dm] = full;
    while (gm !== 0) {
        const step = memo.get(gm * (1 << D) + dm)!;
        const bits = (mask: number, n: number) => [...Array(n).keys()].filter((i) => mask & (1 << i));
        groups.push([bits(step.gs, G), bits(step.ds, D)]);
        gm ^= step.gs;
        dm ^= step.ds;
    }
    return groups;
}

/**
 * Despeja em sequência: cada passagem esvazia quem passa ou completa quem recebe.
 * Quem pode tudo vai primeiro e os bloqueados são preenchidos primeiro — assim o
 * restrito nunca cai no bloqueado quando a cota dele cabe nos livres.
 */
function pour(supply: Supply[], demand: Demand[]): HandoffFlow[] {
    const flows: HandoffFlow[] = [];
    const s = [...supply.filter((x) => !x.restricted), ...supply.filter((x) => x.restricted)].map((x) => ({ ...x }));
    const d = [...demand.filter((x) => x.blocked), ...demand.filter((x) => !x.blocked)].map((x) => ({ ...x }));
    let i = 0;
    let j = 0;
    while (i < s.length && j < d.length) {
        const give = Math.min(s[i].n, d[j].q);
        if (give > 0) flows.push({ from: s[i].id, to: d[j].id, count: give });
        s[i].n -= give;
        d[j].q -= give;
        if (s[i].n === 0) i += 1;
        if (d[j].q === 0) j += 1;
    }
    return flows;
}

function combinations(n: number, k: number, limit: number, rng: () => number): number[][] {
    const all: number[][] = [];
    const rec = (start: number, acc: number[]) => {
        if (all.length > limit) return;
        if (acc.length === k) { all.push(acc.slice()); return; }
        for (let i = start; i < n; i += 1) { acc.push(i); rec(i + 1, acc); acc.pop(); }
    };
    rec(0, []);
    if (all.length <= limit) return all;
    return Array.from({ length: limit }, () => shuffled([...Array(n).keys()], rng).slice(0, k).sort((a, b) => a - b));
}

/**
 * Candidatos de divisão de um tipo, todos equânimes (±1 entre os receptores
 * comuns) e com no máximo `slack` conversas acima do mínimo. `fixed` são os
 * receptores de cota fixa (RECIP); o PSIQ (`restricted`) nunca passa para eles.
 */
export function solveHandoffKind(params: {
    supply: Supply[];
    fixed: Demand[];
    equal: string[];
    rng: () => number;
    slack?: number;
}): HandoffFlow[][] {
    const supply = params.supply.filter((s) => s.n > 0);
    const total = supply.reduce((a, s) => a + s.n, 0);
    if (total === 0) return [[]];
    const fixed = params.fixed.filter((f) => f.q > 0).map((f) => ({ ...f, blocked: true }));
    const rest = total - fixed.reduce((a, f) => a + f.q, 0);
    const equal = params.equal;
    if (equal.length === 0) {
        // ninguém para dividir: o que sobra fica sem destino (pseudo-receptor descartado)
        fixed.push({ id: "", q: rest, blocked: false });
    }
    const base = equal.length ? Math.floor(rest / equal.length) : 0;
    const extras = equal.length ? rest % equal.length : 0;
    const orderSets = [supply, shuffled(supply, params.rng)];

    const results: Array<{ flows: HandoffFlow[]; edges: number }> = [];
    for (const combo of equal.length ? combinations(equal.length, extras, 60, params.rng) : [[]]) {
        const demand: Demand[] = [
            ...fixed,
            ...equal.map((id, i) => ({ id, q: base + (combo.includes(i) ? 1 : 0) })),
        ].filter((d) => d.q > 0);
        for (const order of orderSets) {
            let flows: HandoffFlow[];
            if (order.length <= HANDOFF_EXACT_LIMIT && demand.length <= HANDOFF_EXACT_LIMIT) {
                const groups = bestGroups(order, demand);
                flows = groups.flatMap(([gi, di]) => pour(gi.map((i) => order[i]), di.map((i) => demand[i])));
            } else {
                flows = pour(order, demand);
            }
            results.push({ flows, edges: flows.filter((f) => f.to !== "").length });
        }
    }
    const min = Math.min(...results.map((r) => r.edges));
    const seen = new Set<string>();
    return results
        .filter((r) => r.edges <= min + (params.slack ?? 1))
        .sort((a, b) => a.edges - b.edges)
        .filter((r) => {
            const key = r.flows.map((f) => `${f.from}>${f.to}:${f.count}`).sort().join("|");
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .slice(0, 40)
        .map((r) => r.flows);
}

function lexLess(a: number[], b: number[]) {
    for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) return a[i] < b[i];
    }
    return false;
}

/** Com quantas pessoas cada um que sai precisa falar. */
export function contactsPerGiver(transfers: Array<Pick<HandoffFlow, "from" | "to">>): Map<string, number> {
    const pairs = new Map<string, Set<string>>();
    for (const t of transfers) {
        if (!t.to) continue;
        if (!pairs.has(t.from)) pairs.set(t.from, new Set());
        pairs.get(t.from)!.add(t.to);
    }
    return new Map([...pairs].map(([from, to]) => [from, to.size]));
}

// ---------------------------------------------------------------------------
// Busca local sobre os dois tipos juntos.

type Matrix = Map<string, number>; // "from>to" → quantidade

function toMatrix(flows: HandoffFlow[]): Matrix {
    const m: Matrix = new Map();
    for (const f of flows) m.set(`${f.from}>${f.to}`, (m.get(`${f.from}>${f.to}`) ?? 0) + f.count);
    return m;
}

function toFlows(m: Matrix): HandoffFlow[] {
    return [...m].filter(([, n]) => n > 0).map(([key, count]) => {
        const [from, to] = key.split(">");
        return { from, to, count };
    });
}

interface SearchContext {
    equalIds: Record<HandoffKind, Set<string>>;
    allEqual: Set<string>;
    /** Par proibido (PSIQ → RECIP). */
    forbidden: (from: string, to: string) => boolean;
    /** Divisão anterior, para desempatar a favor dela. */
    previous: Record<HandoffKind, Matrix> | null;
}

function distance(m: Matrix, prev: Matrix): number {
    let d = 0;
    for (const key of new Set([...m.keys(), ...prev.keys()])) d += Math.abs((m.get(key) ?? 0) - (prev.get(key) ?? 0));
    return d;
}

/**
 * [conversas distintas, pior caso por médico, diferença de carga total entre
 * receptores comuns, distância da divisão anterior]. A equidade por tipo não entra
 * aqui porque é garantida por construção: nenhum movimento a quebra.
 */
function matrixScore(a: Matrix, r: Matrix, ctx: SearchContext): number[] {
    const pairs = new Set<string>();
    const perGiver = new Map<string, number>();
    const load = new Map<string, number>();
    for (const m of [a, r]) {
        for (const [key, n] of m) {
            if (n <= 0) continue;
            const cut = key.indexOf(">");
            const to = key.slice(cut + 1);
            if (!to) continue;
            load.set(to, (load.get(to) ?? 0) + n);
            if (pairs.has(key)) continue;
            pairs.add(key);
            const from = key.slice(0, cut);
            perGiver.set(from, (perGiver.get(from) ?? 0) + 1);
        }
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (const id of ctx.allEqual) {
        const v = load.get(id) ?? 0;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
    }
    const drift = ctx.previous ? distance(a, ctx.previous.aguardando) + distance(r, ctx.previous.regulado) : 0;
    return [pairs.size, Math.max(0, ...perGiver.values()), ctx.allEqual.size ? hi - lo : 0, drift];
}

// Movimentos que preservam o que cada um passa e a equidade:
// - ciclo: g1→r1 −d, g1→r2 +d, g2→r2 −d, g2→r1 +d (cotas intactas);
// - desvio: g→r1 −1, g→r2 +1, quando r1 está no "+1" e r2 não (equidade intacta).
// Nunca cria par proibido.
function* neighbours(m: Matrix, equalIds: Set<string>, forbidden: SearchContext["forbidden"]): Generator<Matrix> {
    const givers = new Set<string>();
    const receivers = new Set<string>();
    const load = new Map<string, number>();
    for (const [key, n] of m) {
        if (n <= 0) continue;
        const [g, r] = key.split(">");
        if (!r) continue;
        givers.add(g);
        receivers.add(r);
        load.set(r, (load.get(r) ?? 0) + n);
    }
    const get = (g: string, r: string) => m.get(`${g}>${r}`) ?? 0;
    const move = (changes: Array<[string, string, number]>) => {
        const next = new Map(m);
        for (const [g, r, d] of changes) next.set(`${g}>${r}`, (next.get(`${g}>${r}`) ?? 0) + d);
        return next;
    };
    const G = [...givers];
    const R = [...receivers];
    for (const g1 of G) {
        for (const g2 of G) {
            if (g1 === g2) continue;
            for (const r1 of R) {
                const x = get(g1, r1);
                if (x === 0 || forbidden(g2, r1)) continue;
                for (const r2 of R) {
                    if (r1 === r2 || forbidden(g1, r2)) continue;
                    const y = get(g2, r2);
                    if (y === 0) continue;
                    for (const d of new Set([Math.min(x, y), 1])) {
                        yield move([[g1, r1, -d], [g1, r2, d], [g2, r2, -d], [g2, r1, d]]);
                    }
                }
            }
        }
    }
    const eq = [...equalIds];
    if (eq.length < 2) return;
    const loads = eq.map((id) => load.get(id) ?? 0);
    const lo = Math.min(...loads);
    const hi = Math.max(...loads);
    if (hi === lo) return;
    for (const g of G) {
        for (const r1 of eq) {
            if ((load.get(r1) ?? 0) !== hi || get(g, r1) === 0) continue;
            for (const r2 of eq) {
                if ((load.get(r2) ?? 0) === lo) yield move([[g, r1, -1], [g, r2, 1]]);
            }
        }
    }
}

/** Teto de avaliações por divisão: mantém o recálculo instantâneo a cada tecla. */
export const HANDOFF_SEARCH_BUDGET = 12000;

interface Budget { left: number }

function climb(a: Matrix, r: Matrix, ctx: SearchContext, budget: Budget) {
    let score = matrixScore(a, r, ctx);
    for (let pass = 0; pass < 80 && budget.left > 0; pass += 1) {
        let improved = false;
        for (const kind of ["aguardando", "regulado"] as const) {
            for (const next of neighbours(kind === "aguardando" ? a : r, ctx.equalIds[kind], ctx.forbidden)) {
                if (--budget.left <= 0) break;
                const cand = kind === "aguardando" ? matrixScore(next, r, ctx) : matrixScore(a, next, ctx);
                if (lexLess(cand, score)) {
                    score = cand;
                    if (kind === "aguardando") a = next; else r = next;
                    improved = true;
                    break;
                }
            }
        }
        if (!improved) break;
    }
    return { a, r, score };
}

/** Subida + chutes aleatórios (busca local iterada) para escapar de platôs. */
function improveJoint(a0: Matrix, r0: Matrix, ctx: SearchContext, rng: () => number, budget: Budget) {
    let current = climb(a0, r0, ctx, budget);
    let best = current;
    for (let kick = 0; kick < 25 && budget.left > 0; kick += 1) {
        const kind = rng() < 0.5 ? "aguardando" : "regulado";
        const options = [...neighbours(kind === "aguardando" ? current.a : current.r, ctx.equalIds[kind], ctx.forbidden)];
        if (options.length === 0) continue;
        const jump = options[Math.floor(rng() * options.length)];
        const next = climb(kind === "aguardando" ? jump : current.a, kind === "aguardando" ? current.r : jump, ctx, budget);
        if (!lexLess(best.score, next.score)) current = next;
        if (lexLess(next.score, best.score)) best = next;
    }
    return best;
}

/**
 * Tenta reaproveitar a divisão anterior com as contagens novas: mantém cada
 * passagem antiga no que ainda couber e despeja o resto. Serve de ponto de
 * partida para a busca — é o que faz uma mudança pequena mexer pouco.
 */
function repairPrevious(prev: Matrix, supply: Supply[], fixed: Demand[], equal: string[]): Matrix | null {
    const supplyLeft = new Map(supply.map((s) => [s.id, s.n]));
    const total = supply.reduce((a, s) => a + s.n, 0);
    const fixedQ = fixed.filter((f) => f.q > 0);
    const rest = total - fixedQ.reduce((a, f) => a + f.q, 0);
    if (equal.length === 0 && rest > 0) return null;
    const base = equal.length ? Math.floor(rest / equal.length) : 0;
    const extras = equal.length ? rest % equal.length : 0;
    const prevLoad = (id: string) => [...prev].reduce((a, [k, n]) => a + (k.endsWith(`>${id}`) ? n : 0), 0);
    const plus = new Set([...equal].sort((x, y) => prevLoad(y) - prevLoad(x)).slice(0, extras));
    const quota = new Map<string, number>([
        ...fixedQ.map((f) => [f.id, f.q] as [string, number]),
        ...equal.map((id) => [id, base + (plus.has(id) ? 1 : 0)] as [string, number]),
    ]);
    const next: Matrix = new Map();
    for (const [key, n] of prev) {
        const [g, r] = key.split(">");
        const keep = Math.min(n, supplyLeft.get(g) ?? 0, quota.get(r) ?? 0);
        if (keep <= 0) continue;
        next.set(key, keep);
        supplyLeft.set(g, supplyLeft.get(g)! - keep);
        quota.set(r, quota.get(r)! - keep);
    }
    const blocked = new Set(fixedQ.map((f) => f.id));
    const flows = pour(
        supply.map((s) => ({ ...s, n: supplyLeft.get(s.id) ?? 0 })).filter((s) => s.n > 0),
        [...quota].filter(([, q]) => q > 0).map(([id, q]) => ({ id, q, blocked: blocked.has(id) })),
    );
    for (const f of flows) {
        if (blocked.has(f.to) && supply.find((s) => s.id === f.from)?.restricted) return null;
        next.set(`${f.from}>${f.to}`, (next.get(`${f.from}>${f.to}`) ?? 0) + f.count);
    }
    const placed = [...next.values()].reduce((a, n) => a + n, 0);
    return placed === total ? next : null;
}

// ---------------------------------------------------------------------------

export function planOccurrenceHandoff(params: {
    roster: HandoffRosterEntry[];
    slot: string;
    /** Contagem declarada por ramal; ausente = ainda não informou. */
    counts: Record<string, HandoffCounts | undefined>;
    /** Semente do sorteio de empates — use a data operacional. */
    seed: string;
    recipCap?: number;
    /** Divisão mostrada antes desta mudança: em empate, fica a anterior. */
    previous?: HandoffTransfer[];
}): OccurrenceHandoffPlan {
    const { roster, slot, counts } = params;
    const cap = params.recipCap ?? RECIP_HANDOFF_CAP;
    const parts = resolveHandoffParticipants(roster, slot);
    const rng = mulberry32(hashSeed(`${params.seed}|${slot}`));

    const declared = parts.givers.filter((g) => counts[g.ramal]);
    const pendingGivers = parts.givers.filter((g) => !counts[g.ramal]).map((g) => g.ramal);
    const amount = (ramal: string, kind: HandoffKind) => Math.max(0, Math.floor(counts[ramal]![kind] || 0));
    const total = declared.reduce((a, g) => a + amount(g.ramal, "aguardando") + amount(g.ramal, "regulado"), 0);
    const recip = parts.recip?.ramal ?? null;
    const psiq = new Set(declared.filter((g) => g.role === RECIP_EXCLUDED_ROLE).map((g) => g.ramal));

    const supplyOf = (kind: HandoffKind): Supply[] =>
        declared.map((g) => ({ id: g.ramal, n: amount(g.ramal, kind), restricted: psiq.has(g.ramal) }));
    // RECIP: até o teto, Aguardando primeiro, só com o que não é do PSIQ
    const freeSum = (kind: HandoffKind) => supplyOf(kind).reduce((a, s) => a + (s.restricted ? 0 : s.n), 0);
    const recipAg = recip ? Math.min(cap, freeSum("aguardando")) : 0;
    const recipRe = recip ? Math.min(cap - recipAg, freeSum("regulado")) : 0;
    const fixedOf = (q: number): Demand[] => (recip ? [{ id: recip, q, blocked: true }] : []);

    const ctx: SearchContext = {
        equalIds: {
            aguardando: new Set(parts.pools.aguardando.map((p) => p.ramal)),
            regulado: new Set(parts.pools.regulado.map((p) => p.ramal)),
        },
        allEqual: new Set([...parts.pools.aguardando, ...parts.pools.regulado].map((p) => p.ramal)),
        forbidden: (from, to) => to === recip && psiq.has(from),
        previous: params.previous
            ? {
                aguardando: toMatrix(params.previous.filter((t) => t.kind === "aguardando")),
                regulado: toMatrix(params.previous.filter((t) => t.kind === "regulado")),
            }
            : null,
    };

    const ag = solveHandoffKind({ supply: supplyOf("aguardando"), fixed: fixedOf(recipAg), equal: [...ctx.equalIds.aguardando], rng });
    const re = solveHandoffKind({ supply: supplyOf("regulado"), fixed: fixedOf(recipRe), equal: [...ctx.equalIds.regulado], rng });

    // 1) Busca principal, sem olhar a divisão anterior: acha o mínimo de conversas.
    const fresh: SearchContext = { ...ctx, previous: null };
    const starts = ag.flatMap((a) => re.map((r) => {
        const A = toMatrix(a);
        const R = toMatrix(r);
        return { a: A, r: R, score: matrixScore(A, R, fresh) };
    }))
        .sort((x, y) => (lexLess(x.score, y.score) ? -1 : lexLess(y.score, x.score) ? 1 : 0))
        .slice(0, 6);
    let best: { a: Matrix; r: Matrix; score: number[] } | null = null;
    const budget = { left: HANDOFF_SEARCH_BUDGET };
    for (const start of starts) {
        const share = { left: Math.ceil(budget.left / 2) };
        budget.left -= share.left;
        const refined = improveJoint(start.a, start.r, fresh, rng, share);
        if (!best || lexLess(refined.score, best.score)) best = refined;
    }

    // 2) Empate: entre divisões com as mesmas conversas, pior caso e carga, fica a
    //    mais próxima da anterior. Busca própria, com orçamento próprio, partindo
    //    da anterior reaproveitada e da melhor achada — nunca piora o passo 1.
    if (ctx.previous && best) {
        const options = [{ a: best.a, r: best.r }];
        const a = repairPrevious(ctx.previous.aguardando, supplyOf("aguardando"), fixedOf(recipAg), [...ctx.equalIds.aguardando]);
        const r = repairPrevious(ctx.previous.regulado, supplyOf("regulado"), fixedOf(recipRe), [...ctx.equalIds.regulado]);
        if (a && r) options.push({ a, r });
        let sticky = { ...best, score: matrixScore(best.a, best.r, ctx) };
        for (const option of options) {
            const refined = improveJoint(option.a, option.r, ctx, rng, { left: HANDOFF_SEARCH_BUDGET / 4 });
            if (lexLess(refined.score, sticky.score)) sticky = refined;
        }
        best = sticky;
    }

    const transfers: HandoffTransfer[] = [];
    for (const [kind, m] of [["aguardando", best?.a], ["regulado", best?.r]] as const) {
        for (const f of m ? toFlows(m) : []) if (f.to) transfers.push({ ...f, kind });
    }

    return {
        slot,
        mode: parts.mode,
        givers: parts.givers,
        pendingGivers,
        recip: parts.recip,
        pools: parts.pools,
        returning: parts.returning,
        transfers,
        recipLoad: transfers.filter((t) => t.to === recip).reduce((a, t) => a + t.count, 0),
        total,
        unassigned: total - transfers.reduce((a, t) => a + t.count, 0),
    };
}

// ---------------------------------------------------------------------------
// Janela: aparece 15 min antes; contagem abre 10 min antes e aceita mudanças até
// 10 min depois da saída (a divisão recalcula); depois congela até sumir, aos 15.

export const HANDOFF_SLOTS = ["11:30", "12:30", "13:30", "14:30", "15:30", "16:30"] as const;

export type HandoffPhase = "aviso" | "contagem" | "divisao" | "encerrada";

export function resolveHandoffWindow(nowHHMM: string): { slot: string; phase: HandoffPhase; editable: boolean } | null {
    const now = toMinutes(nowHHMM);
    for (const slot of HANDOFF_SLOTS) {
        const t = toMinutes(slot);
        if (now < t - 15 || now > t + 15) continue;
        const phase: HandoffPhase = now < t - 10 ? "aviso" : now < t ? "contagem" : now <= t + 10 ? "divisao" : "encerrada";
        return { slot, phase, editable: phase === "contagem" || phase === "divisao" };
    }
    return null;
}

// ---------------------------------------------------------------------------
// Estado de cada linha e conferência de horários

/** ALMOÇO/DESCANSO enquanto o médico está fora; null se está no posto. */
export function resolveBreakLabel(entry: Pick<HandoffRosterEntry, "lunch" | "rest">, nowHHMM: string): "ALMOÇO" | "DESCANSO" | null {
    const now = toMinutes(nowHHMM);
    const inside = (slot: string | null) => Boolean(slot && /^\d{2}:\d{2}$/.test(slot) && now >= toMinutes(slot) && now < toMinutes(slot) + BREAK_MINUTES);
    if (inside(entry.lunch)) return "ALMOÇO";
    if (inside(entry.rest)) return "DESCANSO";
    return null;
}

export interface HandoffScheduleWarning {
    ramal: string;
    name: string;
    problem: "sem_almoco" | "presumido";
}

/**
 * O que a chefia precisa conferir para a divisão sair certa: quem entra na conta
 * e está sem horário de almoço, ou com horário presumido (PSIQ). Troca de horário
 * no meio do plantão não se detecta — por isso o aviso pede conferência sempre.
 */
export function checkHandoffSchedule(roster: HandoffRosterEntry[]): HandoffScheduleWarning[] {
    const breakRoles = new Set(["MR", "MRV", "RECIP", "PSIQ"]);
    const warnings: HandoffScheduleWarning[] = [];
    for (const e of roster) {
        if (e.excludedPost || !breakRoles.has(normalizeRole(e.role))) continue;
        if (!e.lunch) warnings.push({ ramal: e.ramal, name: e.name, problem: "sem_almoco" });
        else if (e.lunchAssumed) warnings.push({ ramal: e.ramal, name: e.name, problem: "presumido" });
    }
    return warnings;
}
