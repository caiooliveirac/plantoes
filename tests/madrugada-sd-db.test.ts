import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";

/**
 * Madrugada → SD (docs/madrugada.md, "Quem cobre e segue no SD"): quem cobriu
 * 03:00–07:00 e continua no plantão diurno ganha um SD pagável, com banco de
 * horas pela régua normal e chegada 07:00 (ou a hora real) — nunca a das 03:00.
 * Tudo pelo bot, contra Postgres real.
 *
 * SÓ roda quando DATABASE_URL aponta para um banco `*_test` (mesma trava de
 * tests/madrugada-db.test.ts). Cria médicos com nome aleatório e apaga tudo.
 */

function bancoDeTeste(): string | null {
    const raw = process.env.DATABASE_URL;
    if (!raw) return null;
    try {
        const nome = new URL(raw).pathname.replace(/^\//, "");
        return /_test$/.test(nome) ? nome : null;
    } catch {
        return null;
    }
}

const banco = bancoDeTeste();
const skip = banco ? false : "DATABASE_URL não aponta para um banco *_test";
const medicos: string[] = [];
const chats: string[] = [];
const local = (iso: string) => new Date(`${iso}-03:00`);
const originalCutoff = process.env.ARRIVAL_TIME_CUTOFF;
const originalToken = process.env.TELEGRAM_BOT_TOKEN;
let criouLegado = false;

async function modulos() {
    const [{ getDb, closeDb }, schema] = await Promise.all([import("@/db"), import("@/db/schema")]);
    return { getDb, closeDb, schema };
}

// O pagamento lê o estado ao vivo do legado (public.*), que só existe em
// produção. Num banco de teste limpo, cria tabelas vazias — e apaga no fim.
async function garantirTabelasLegadas() {
    const { getDb } = await modulos();
    const { sql } = await import("drizzle-orm");
    const db = getDb();
    const existe = await db.execute(sql`select to_regclass('public.shift_current_state')::text as rel`) as unknown as { rel: string | null }[];
    if (existe[0]?.rel) return;
    criouLegado = true;
    await db.execute(sql`create table public.users (id uuid primary key, name text)`);
    await db.execute(sql`create table public.bases (id uuid primary key, code text, sector text)`);
    await db.execute(sql`create table public.shift_instances (
        id uuid primary key, base_id uuid, role_function text,
        scheduled_start_at timestamptz, scheduled_end_at timestamptz)`);
    await db.execute(sql`create table public.shift_current_state (
        shift_instance_id uuid, ramal text, executor_user_id uuid, arrival_time timestamptz,
        departure_time timestamptz, role_function_detected text, status text, updated_at timestamptz)`);
}

async function criarMedico(nome: string) {
    const { getDb, schema } = await modulos();
    // Só letras: dígito no nome vira ramal ou horário para o parser do bot.
    const sufixo = Array.from(randomBytes(8), (b) => String.fromCharCode(65 + (b % 26))).join("");
    const [doctor] = await getDb().insert(schema.doctors)
        .values({ fullName: `${nome} ${sufixo}`, normalizedName: `MADRUGADA SD ${nome} ${sufixo}` })
        .returning({ id: schema.doctors.id, fullName: schema.doctors.fullName });
    medicos.push(doctor.id);
    return doctor;
}

async function postId(code: string) {
    const { getDb, schema } = await modulos();
    const post = await getDb().query.regulationPosts.findFirst({ where: eq(schema.regulationPosts.code, code) });
    assert.ok(post, `ramal ${code} existe`);
    return post.id;
}

function botFalso() {
    const chatId = -(2_000_000_000_000 + Math.floor(Math.random() * 1_000_000_000));
    chats.push(String(chatId));
    let messageId = Math.floor(Math.random() * 1_000_000);
    const respostas: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (typeof body.text === "string") respostas.push(body.text);
        return new Response(JSON.stringify({ ok: true, result: { message_id: ++messageId, chat: { id: chatId, type: "group" }, date: 0 } }));
    }) as typeof fetch;
    return {
        respostas,
        restaurar: () => { globalThis.fetch = originalFetch; },
        async enviar(text: string, sentAt: Date) {
            const { processTelegramUpdate } = await import("@/modules/telegram/service");
            const id = ++messageId;
            await processTelegramUpdate({
                update_id: id,
                message: { message_id: id, date: Math.floor(sentAt.getTime() / 1000), chat: { id: chatId, type: "group" }, from: { id: 900_888, first_name: "X" }, text },
            } as never);
        },
    };
}

/**
 * Noite `dia` → manhã seguinte: o coberto é titular SN no `ramalCoberto` desde
 * 19:00 e `cora` cobre a madrugada 03:00–07:00 por ele no `ramalCobertura`.
 */
async function cenario(dia: string, opts: { ramalCoberto?: string; ramalCobertura?: string } = {}) {
    await garantirTabelasLegadas();
    const { getDb, schema } = await modulos();
    const { startMadrugadaCoverage } = await import("@/modules/regulation/madrugada-cobertura");
    const amanha = new Date(local(`${dia}T12:00`).getTime() + 86_400_000).toISOString().slice(0, 10);
    const coberto = await criarMedico("COBERTO");
    const cora = await criarMedico("CORA");
    const ramalCoberto = opts.ramalCoberto ?? "1362";
    const [sn] = await getDb().insert(schema.regulationOccupancies).values({
        doctorId: coberto.id,
        continuityGroupId: randomUUID(),
        postId: await postId(ramalCoberto),
        scheduledStartAt: local(`${dia}T19:00`),
        scheduledEndAt: local(`${amanha}T07:15`),
        startedAt: local(`${dia}T19:00`),
        boardStartedAt: local(`${dia}T19:00`),
        shiftLabel: "SN",
        ramalLabel: ramalCoberto,
        source: "telegram",
    }).returning();
    const { occupancy: cobertura } = await startMadrugadaCoverage({
        covererDoctorId: cora.id,
        postCode: opts.ramalCobertura ?? "2266",
        coveredOccupancyId: sn.id,
        startedAt: local(`${amanha}T02:55`),
        scheduledStartAt: local(`${amanha}T03:00`),
        scheduledEndAt: local(`${amanha}T07:00`),
    });
    return { dia, amanha, coberto, cora, sn, cobertura, bot: botFalso() };
}

async function ocupacoes(doctorId: string) {
    const { getDb, schema } = await modulos();
    return getDb().query.regulationOccupancies.findMany({
        where: eq(schema.regulationOccupancies.doctorId, doctorId),
        orderBy: (o, { asc }) => [asc(o.startedAt)],
    });
}

/** O SD que nasceu para quem cobriu (a única ocupação dela fora da madrugada). */
async function sdDe(doctorId: string) {
    const sds = (await ocupacoes(doctorId)).filter((o) => !o.madrugadaCobertura);
    assert.equal(sds.length, 1, "um SD, fora da madrugada");
    return sds[0];
}

/** Fecha o SD às 19:15, confirmado, e devolve o banco de horas dele. */
async function fecharSdEBanco(occupancyId: string, amanha: string) {
    const { getDb, schema } = await modulos();
    const { syncRegulationBankHours } = await import("@/modules/bank-hours/service");
    await getDb().update(schema.regulationOccupancies)
        .set({ endedAt: local(`${amanha}T19:15`), actualEndedAt: local(`${amanha}T19:15`), departureConfirmedAt: local(`${amanha}T19:20`) })
        .where(eq(schema.regulationOccupancies.id, occupancyId));
    await syncRegulationBankHours(getDb(), occupancyId);
    const [entrada] = await getDb().select().from(schema.bankHoursEntries)
        .where(eq(schema.bankHoursEntries.regulationOccupancyId, occupancyId));
    return entrada;
}

async function pagosNo(dia: string, shiftLabel: "SD" | "SN") {
    const board = await import("@/services/board.service");
    const pagamento = await board.getPaymentAllocationBoard({ operationalDate: dia, shiftLabel });
    return pagamento.regulation.map((row) => row.doctorId);
}

async function expirarAs(at: Date) {
    const { expireStaleRegulationOccupancies } = await import("@/modules/regulation/service");
    await expireStaleRegulationOccupancies(at);
}

// Cada cenário fecha o que deixou aberto: o índice de um-titular-por-ramal é
// global e os cenários reusam ramais.
async function fecharAbertas(ids: string[]) {
    const { getDb, schema } = await modulos();
    await getDb().update(schema.regulationOccupancies)
        .set({ endedAt: new Date("2026-01-01T00:00:00Z"), boardStartedAt: null })
        .where(and(inArray(schema.regulationOccupancies.doctorId, ids), isNull(schema.regulationOccupancies.endedAt)));
}

before(() => {
    // Fase 2 (vale a hora do aviso), como em produção.
    process.env.ARRIVAL_TIME_CUTOFF = "2026-06-01T00:00:00-03:00";
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
});

after(async () => {
    if (originalCutoff === undefined) delete process.env.ARRIVAL_TIME_CUTOFF;
    else process.env.ARRIVAL_TIME_CUTOFF = originalCutoff;
    if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = originalToken;
    if (!banco) return;
    const { getDb, closeDb, schema } = await modulos();
    const db = getDb();
    if (chats.length > 0) {
        await db.update(schema.telegramIngestedMessages).set({ relatedOccupancyId: null })
            .where(inArray(schema.telegramIngestedMessages.chatId, chats));
        await db.delete(schema.telegramIngestedMessages).where(inArray(schema.telegramIngestedMessages.chatId, chats));
    }
    if (medicos.length > 0) {
        const ids = db.select({ id: schema.regulationOccupancies.id }).from(schema.regulationOccupancies)
            .where(inArray(schema.regulationOccupancies.doctorId, medicos));
        await db.delete(schema.bankHoursEntries).where(inArray(schema.bankHoursEntries.regulationOccupancyId, ids));
        await db.update(schema.regulationOccupancies).set({ madrugadaCobreOcupacaoId: null })
            .where(inArray(schema.regulationOccupancies.doctorId, medicos));
        await db.delete(schema.regulationOccupancies).where(inArray(schema.regulationOccupancies.doctorId, medicos));
        await db.delete(schema.doctors).where(inArray(schema.doctors.id, medicos));
    }
    if (criouLegado) {
        const { sql } = await import("drizzle-orm");
        await db.execute(sql`drop table if exists public.shift_current_state, public.shift_instances, public.bases, public.users`);
    }
    await closeDb();
});

test("madrugada → SD: expirou 07:00 e avisou 07:40 — SD pago desde 07:00, sem atraso, fora do grupo da madrugada", { skip }, async () => {
    const { dia, amanha, cora, coberto, cobertura, bot } = await cenario("2026-08-19");
    try {
        await expirarAs(local(`${amanha}T07:01`));
        await bot.enviar(`${cora.fullName} 1363 SD`, local(`${amanha}T07:40`));

        const sd = await sdDe(cora.id);
        assert.equal(sd.shiftLabel, "SD");
        assert.equal(sd.madrugadaCobertura, false, "a marca de madrugada sai");
        assert.equal(sd.startedAt.toISOString(), local(`${amanha}T07:00`).toISOString(), "emendou: chegada 07:00");
        assert.equal(sd.boardStartedAt?.toISOString(), local(`${amanha}T07:00`).toISOString(), "no quadro desde 07:00, nunca 02:55");
        assert.notEqual(sd.continuityGroupId, cobertura.continuityGroupId, "SD não é continuação da madrugada");
        assert.match(bot.respostas.at(-1) ?? "", /desde 07:00 — emendou a madrugada/);

        const madrugada = (await ocupacoes(cora.id)).find((o) => o.madrugadaCobertura);
        assert.equal(madrugada?.endedAt?.toISOString(), local(`${amanha}T07:00`).toISOString());

        assert.ok((await pagosNo(amanha, "SD")).includes(cora.id), "SD dela pago");
        const pagosSn = await pagosNo(dia, "SN");
        assert.ok(pagosSn.includes(coberto.id) && !pagosSn.includes(cora.id), "SN só do coberto");
        const banco = await fecharSdEBanco(sd.id, amanha);
        assert.equal(banco?.arrivalDelayMinutes, 0);
        assert.equal(banco?.balanceMinutes, 0);
    } finally {
        bot.restaurar();
        await fecharAbertas([cora.id, coberto.id]);
    }
});

test("madrugada → SD: aviso depois das 08:00 vale a hora do aviso (com atraso)", { skip }, async () => {
    const { amanha, cora, coberto, bot } = await cenario("2026-08-21");
    try {
        await expirarAs(local(`${amanha}T07:01`));
        await bot.enviar(`${cora.fullName} 1363 SD`, local(`${amanha}T08:30`));
        const sd = await sdDe(cora.id);
        assert.equal(sd.startedAt.toISOString(), local(`${amanha}T08:30`).toISOString());
        const banco = await fecharSdEBanco(sd.id, amanha);
        assert.equal(banco?.arrivalDelayMinutes, 90);
    } finally {
        bot.restaurar();
        await fecharAbertas([cora.id, coberto.id]);
    }
});

test("madrugada → SD: aviso 06:40 com a madrugada aberta — encerra a cobertura e o SD vale da hora do aviso", { skip }, async () => {
    const { amanha, cora, coberto, cobertura, bot } = await cenario("2026-08-23");
    try {
        await bot.enviar(`${cora.fullName} 1363 SD`, local(`${amanha}T06:40`));
        const sd = await sdDe(cora.id);
        assert.equal(sd.startedAt.toISOString(), local(`${amanha}T06:40`).toISOString());
        assert.equal(sd.boardStartedAt?.toISOString(), local(`${amanha}T06:40`).toISOString());
        assert.equal(sd.madrugadaCobertura, false);
        assert.notEqual(sd.continuityGroupId, cobertura.continuityGroupId);
        const encerrada = (await ocupacoes(cora.id)).find((o) => o.madrugadaCobertura);
        assert.equal(encerrada?.endedAt?.toISOString(), local(`${amanha}T06:40`).toISOString());
        assert.ok(encerrada?.departureConfirmedAt, "madrugada não vai para a fila de saída");
        assert.doesNotMatch(bot.respostas.at(-1) ?? "", /02:55/);
        assert.ok((await pagosNo(amanha, "SD")).includes(cora.id));
    } finally {
        bot.restaurar();
        await fecharAbertas([cora.id, coberto.id]);
    }
});

test("madrugada → SD: 'continua' no ramal da madrugada não estica a cobertura — vira SD pago ali", { skip }, async () => {
    const { amanha, cora, coberto, cobertura, bot } = await cenario("2026-08-25");
    try {
        await bot.enviar(`${cora.fullName} 2266 continua`, local(`${amanha}T06:55`));
        const antiga = (await ocupacoes(cora.id)).find((o) => o.id === cobertura.id);
        assert.equal(antiga?.madrugadaCobertura, true);
        assert.equal(antiga?.endedAt?.toISOString(), local(`${amanha}T06:55`).toISOString(), "madrugada encerrada, não estendida");

        const sd = await sdDe(cora.id);
        assert.equal(sd.shiftLabel, "SD", "nunca P: não paga o SN seguinte");
        assert.equal(sd.scheduledStartAt?.toISOString(), local(`${amanha}T07:00`).toISOString());
        assert.equal(sd.scheduledEndAt?.toISOString(), local(`${amanha}T19:15`).toISOString());
        assert.ok(sd.boardStartedAt, "ativa no quadro");
        assert.ok((await pagosNo(amanha, "SD")).includes(cora.id));
        const banco = await fecharSdEBanco(sd.id, amanha);
        assert.equal(banco?.arrivalDelayMinutes, 0);
    } finally {
        bot.restaurar();
        await fecharAbertas([cora.id, coberto.id]);
    }
});

test("madrugada → SD: 'Nome continua' sem ramal fica no ramal da madrugada", { skip }, async () => {
    const { amanha, cora, coberto, bot } = await cenario("2026-08-27", { ramalCobertura: "2267" });
    try {
        await bot.enviar(`${cora.fullName} continua`, local(`${amanha}T06:55`));
        const sd = await sdDe(cora.id);
        assert.equal(sd.postId, await postId("2267"), `respostas: ${JSON.stringify(bot.respostas)}`);
        assert.equal(sd.shiftLabel, "SD");
        assert.ok((await pagosNo(amanha, "SD")).includes(cora.id));
    } finally {
        bot.restaurar();
        await fecharAbertas([cora.id, coberto.id]);
    }
});

test("madrugada → SD: 'Nome continua' sem ramal depois das 07:00 acha o ramal pela madrugada e grava 07:00", { skip }, async () => {
    const { amanha, cora, coberto, bot } = await cenario("2026-09-02", { ramalCobertura: "2268" });
    try {
        await expirarAs(local(`${amanha}T07:01`));
        await bot.enviar(`${cora.fullName} continua`, local(`${amanha}T07:10`));
        const sd = await sdDe(cora.id);
        assert.equal(sd.postId, await postId("2268"), `respostas: ${JSON.stringify(bot.respostas)}`);
        assert.equal(sd.shiftLabel, "SD");
        assert.equal(sd.startedAt.toISOString(), local(`${amanha}T07:00`).toISOString());
        assert.equal(sd.madrugadaCobertura, false);
    } finally {
        bot.restaurar();
        await fecharAbertas([cora.id, coberto.id]);
    }
});

test("madrugada → SD: cobriu no ramal do coberto e segue ali no SD — coberto rendido segue pago no SN", { skip }, async () => {
    const { dia, amanha, cora, coberto, bot } = await cenario("2026-08-29", { ramalCobertura: "1362" });
    try {
        await bot.enviar(`${cora.fullName} 1362 SD`, local(`${amanha}T06:50`));
        const sd = await sdDe(cora.id);
        assert.equal(sd.postId, await postId("1362"));
        assert.equal(sd.madrugadaCobertura, false);
        assert.equal(sd.boardStartedAt?.toISOString(), local(`${amanha}T06:50`).toISOString());
        assert.ok((await pagosNo(amanha, "SD")).includes(cora.id));
        assert.ok((await pagosNo(dia, "SN")).includes(coberto.id), "coberto não perde o SN");
    } finally {
        bot.restaurar();
        await fecharAbertas([cora.id, coberto.id]);
    }
});

test("madrugada → SD: sem aviso, a madrugada expira 07:00 e nenhum SD nasce", { skip }, async () => {
    const { amanha, cora, coberto, bot } = await cenario("2026-08-31");
    try {
        await expirarAs(local(`${amanha}T07:01`));
        const todas = await ocupacoes(cora.id);
        assert.equal(todas.length, 1);
        assert.equal(todas[0].madrugadaCobertura, true);
        assert.equal(todas[0].endedAt?.toISOString(), local(`${amanha}T07:00`).toISOString());
    } finally {
        bot.restaurar();
        await fecharAbertas([cora.id, coberto.id]);
    }
});
