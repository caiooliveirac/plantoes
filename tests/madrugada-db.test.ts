import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";

/**
 * Madrugada (docs/madrugada.md) contra um Postgres de verdade: quem cobre
 * aparece no quadro, o coberto some, e a cobertura fica fora do pagamento e do
 * banco de horas.
 *
 * SÓ roda quando DATABASE_URL aponta para um banco cujo nome termina em
 * `_test` (mesma trava de tests/contas-portal-db.test.ts). Cria médicos com
 * nome aleatório e apaga tudo no fim.
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

const HOUR = 3_600_000;
const medicos: string[] = [];
let criouLegado = false;

// O quadro também lê o estado ao vivo do sistema legado (public.*), que só
// existe no banco de produção. Num banco de teste limpo, cria tabelas vazias
// com as colunas lidas — e as apaga no fim.
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

async function modulos() {
    const [{ getDb, closeDb }, schema, cobertura, board, bankHours] = await Promise.all([
        import("@/db"),
        import("@/db/schema"),
        import("@/modules/regulation/madrugada-cobertura"),
        import("@/services/board.service"),
        import("@/modules/bank-hours/service"),
    ]);
    return { getDb, closeDb, schema, cobertura, board, bankHours };
}

async function criarMedico(nome: string) {
    const { getDb, schema } = await modulos();
    const sufixo = randomUUID().slice(0, 8).toUpperCase();
    const [doctor] = await getDb()
        .insert(schema.doctors)
        .values({ fullName: `${nome} ${sufixo}`, normalizedName: `MADRUGADA TESTE ${nome} ${sufixo}` })
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

async function titular(doctorId: string, code: string) {
    const { getDb, schema } = await modulos();
    const now = Date.now();
    const [occupancy] = await getDb().insert(schema.regulationOccupancies).values({
        doctorId,
        continuityGroupId: randomUUID(),
        postId: await postId(code),
        scheduledStartAt: new Date(now - 5 * HOUR),
        scheduledEndAt: new Date(now + 6 * HOUR),
        startedAt: new Date(now - 5 * HOUR),
        boardStartedAt: new Date(now - 5 * HOUR),
        shiftLabel: "SN",
        ramalLabel: code,
        source: "telegram",
    }).returning();
    return occupancy;
}

after(async () => {
    if (!banco) return;
    const { getDb, closeDb, schema } = await modulos();
    const db = getDb();
    if (medicos.length > 0) {
        const ocupacoes = db.select({ id: schema.regulationOccupancies.id }).from(schema.regulationOccupancies)
            .where(inArray(schema.regulationOccupancies.doctorId, medicos));
        await db.delete(schema.bankHoursEntries).where(inArray(schema.bankHoursEntries.regulationOccupancyId, ocupacoes));
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

test("madrugada: cobridor no quadro, coberto some; pagamento e banco só do titular", { skip }, async () => {
    const { getDb, schema, cobertura, board, bankHours } = await modulos();
    await garantirTabelasLegadas();
    const ana = await criarMedico("ANA");
    const bia = await criarMedico("BIA");
    const coberta = await titular(ana.id, "2151");

    const now = Date.now();
    const { occupancy, coveredName } = await cobertura.startMadrugadaCoverage({
        covererDoctorId: bia.id,
        postCode: "2266",
        coveredOccupancyId: coberta.id,
        startedAt: new Date(now - 10 * 60_000),
        scheduledStartAt: new Date(now - HOUR),
        scheduledEndAt: new Date(now + 3 * HOUR),
    });
    assert.equal(coveredName, ana.fullName);
    assert.equal(occupancy.madrugadaCobertura, true);
    assert.equal(occupancy.boardStartedAt, null);

    const rows = await board.listRegulationBoard();
    const r2266 = rows.find((row) => row.postCode === "2266");
    assert.equal(r2266?.doctorId, bia.id, "quem cobre aparece no ramal declarado");
    assert.equal(r2266?.madrugadaCobertura, true);
    assert.equal(r2266?.madrugadaCobreNome, ana.fullName);
    assert.ok(r2266?.boardStartedAt, "cobertura tem hora no quadro");
    assert.ok(!rows.some((row) => row.doctorId === ana.id), "coberto some do quadro");

    // Fecha a cobertura e sincroniza: nada de banco de horas para quem cobre.
    await getDb().update(schema.regulationOccupancies)
        .set({ endedAt: new Date(now), actualEndedAt: new Date(now) })
        .where(eq(schema.regulationOccupancies.id, occupancy.id));
    await bankHours.syncRegulationBankHours(getDb(), occupancy.id);
    const entradas = await getDb().select().from(schema.bankHoursEntries)
        .where(eq(schema.bankHoursEntries.regulationOccupancyId, occupancy.id));
    assert.equal(entradas.length, 0);

    // Cobertura encerrada: o titular volta ao quadro.
    const depois = await board.listRegulationBoard();
    assert.equal(depois.find((row) => row.postCode === "2151")?.doctorId, ana.id);
});

test("madrugada: ramal de outro titular vale (temporário) — ele sai do quadro e volta no fim", { skip }, async () => {
    const { getDb, schema, cobertura, board } = await modulos();
    await garantirTabelasLegadas();
    const caio = await criarMedico("CAIO");
    const dani = await criarMedico("DANI");
    const edu = await criarMedico("EDU");
    const coberta = await titular(caio.id, "2152");
    const daDani = await titular(dani.id, "2153");

    const now = Date.now();
    const { occupancy, releasedName } = await cobertura.startMadrugadaCoverage({
        covererDoctorId: edu.id,
        coveredOccupancyId: coberta.id,
        postCode: "2153",
        startedAt: new Date(now),
        scheduledStartAt: new Date(now - HOUR),
        scheduledEndAt: new Date(now + 3 * HOUR),
    });
    assert.equal(releasedName, dani.fullName);

    const rows = await board.listRegulationBoard();
    assert.equal(rows.find((row) => row.postCode === "2153")?.doctorId, edu.id, "quem cobre fica no ramal ocupado");
    assert.ok(!rows.some((row) => row.doctorId === dani.id), "titular do ramal sai do quadro temporariamente");
    assert.ok(!rows.some((row) => row.doctorId === caio.id), "coberto sai do quadro");

    // Fim da madrugada: os dois voltam; a ocupação da Dani não foi tocada.
    await getDb().update(schema.regulationOccupancies)
        .set({ endedAt: new Date(now), actualEndedAt: new Date(now) })
        .where(eq(schema.regulationOccupancies.id, occupancy.id));
    const depois = await board.listRegulationBoard();
    assert.equal(depois.find((row) => row.postCode === "2153")?.doctorId, dani.id);
    assert.equal(depois.find((row) => row.postCode === "2152")?.doctorId, caio.id);
    const intacta = await getDb().query.regulationOccupancies.findFirst({ where: eq(schema.regulationOccupancies.id, daDani.id) });
    assert.equal(intacta?.endedAt, null);
    assert.equal(intacta?.boardStartedAt?.toISOString(), daDani.boardStartedAt?.toISOString());
});

test("madrugada: cobrir no próprio ramal do coberto vale; duas coberturas no mesmo ramal não", { skip }, async () => {
    const { cobertura, board } = await modulos();
    await garantirTabelasLegadas();
    const joao = await criarMedico("JOAO");
    const kaka = await criarMedico("KAKA");
    const lia = await criarMedico("LIA");
    const leo = await criarMedico("LEO");
    const coberta = await titular(joao.id, "2154");
    const outra = await titular(lia.id, "2035");

    const now = Date.now();
    const base = { startedAt: new Date(now), scheduledStartAt: new Date(now - HOUR), scheduledEndAt: new Date(now + 3 * HOUR) };
    await cobertura.startMadrugadaCoverage({ ...base, covererDoctorId: kaka.id, coveredOccupancyId: coberta.id, postCode: "2154" });
    const rows = await board.listRegulationBoard();
    assert.equal(rows.find((row) => row.postCode === "2154")?.doctorId, kaka.id);

    await assert.rejects(
        cobertura.startMadrugadaCoverage({ ...base, covererDoctorId: leo.id, coveredOccupancyId: outra.id, postCode: "2154" }),
        cobertura.MadrugadaCoverageError,
    );
});

test("madrugada: no fechamento do SN, só o titular é pago", { skip }, async () => {
    const { getDb, schema, cobertura, board } = await modulos();
    await garantirTabelasLegadas();
    const fabi = await criarMedico("FABI");
    const gabi = await criarMedico("GABI");
    const local = (iso: string) => new Date(`${iso}-03:00`);
    const [coberta] = await getDb().insert(schema.regulationOccupancies).values({
        doctorId: fabi.id,
        continuityGroupId: randomUUID(),
        postId: await postId("2034"),
        scheduledStartAt: local("2026-01-10T19:00"),
        scheduledEndAt: local("2026-01-11T07:00"),
        startedAt: local("2026-01-10T19:00"),
        boardStartedAt: local("2026-01-10T19:00"),
        shiftLabel: "SN",
        ramalLabel: "2034",
        source: "telegram",
    }).returning();
    const { occupancy } = await cobertura.startMadrugadaCoverage({
        covererDoctorId: gabi.id,
        postCode: "2267",
        coveredOccupancyId: coberta.id,
        startedAt: local("2026-01-11T02:55"),
        scheduledStartAt: local("2026-01-11T03:00"),
        scheduledEndAt: local("2026-01-11T07:00"),
    });
    for (const id of [coberta.id, occupancy.id]) {
        await getDb().update(schema.regulationOccupancies)
            .set({ endedAt: local("2026-01-11T07:00"), actualEndedAt: local("2026-01-11T07:00") })
            .where(eq(schema.regulationOccupancies.id, id));
    }

    const pagamento = await board.getPaymentAllocationBoard({ operationalDate: "2026-01-10", shiftLabel: "SN" });
    const pagos = pagamento.regulation.map((row) => row.doctorId);
    assert.ok(pagos.includes(fabi.id), "titular segue no pagamento");
    assert.ok(!pagos.includes(gabi.id), "cobertura fora do pagamento");

    // Fechamento mensal / folha de ponto (payable-shifts): mesma regra.
    const { getChiefPayableShiftsBoard } = await import("@/services/payable-shifts.service");
    const mensal = await getChiefPayableShiftsBoard("2026-01");
    // `doctors` lista o diretório inteiro; o que importa é o total de plantões.
    const totalDe = (doctorId: string) => mensal.doctors.find((doctor) => doctor.doctorId === doctorId)?.total ?? 0;
    assert.ok(totalDe(fabi.id) > 0, "titular pago no fechamento do mês");
    assert.equal(totalDe(gabi.id), 0, "cobertura fora do fechamento do mês");
});

test("madrugada pelo bot: mensagem pergunta por quem, botão grava a cobertura", { skip }, async () => {
    const { getDb, schema } = await modulos();
    await garantirTabelasLegadas();
    const { processTelegramUpdate } = await import("@/modules/telegram/service");
    const { buildMadrugadaCallbackData } = await import("@/modules/telegram/madrugada");

    const helo = await criarMedico("HELO");
    const iris = await criarMedico("IRIS");
    const coberta = await titular(helo.id, "2033");

    const chatId = -(2_000_000_000_000 + Math.floor(Math.random() * 1_000_000_000));
    const messageId = Math.floor(Math.random() * 1_000_000);
    const enviados: Array<Record<string, unknown>> = [];
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        enviados.push(init?.body ? JSON.parse(String(init.body)) : {});
        return new Response(JSON.stringify({ ok: true, result: { message_id: messageId + 1, chat: { id: chatId, type: "group" }, date: 0 } }));
    }) as typeof fetch;
    try {
        const sentAt = new Date("2026-09-30T02:58:00-03:00");
        await processTelegramUpdate({
            update_id: messageId,
            message: {
                message_id: messageId,
                date: Math.floor(sentAt.getTime() / 1000),
                chat: { id: chatId, type: "group" },
                from: { id: 900_777, first_name: "Iris" },
                text: `${iris.fullName} 2268 madrugada`,
            },
        } as never);

        const [log] = await getDb().select().from(schema.telegramIngestedMessages)
            .where(eq(schema.telegramIngestedMessages.chatId, String(chatId)));
        assert.equal(log.status, "pending_madrugada_cover");
        const pergunta = enviados.find((body) => typeof body.text === "string" && String(body.text).includes("Por quem"));
        assert.ok(pergunta, "bot pergunta por quem a pessoa está");
        assert.ok(JSON.stringify(pergunta.reply_markup).includes(helo.fullName), "titular aparece como botão");

        const posicao = ((log.resolutionData as { candidates: Array<{ doctorId: string }> }).candidates
            .findIndex((candidate) => candidate.doctorId === helo.id)) + 1;
        assert.ok(posicao > 0);
        await processTelegramUpdate({
            update_id: messageId + 2,
            callback_query: {
                id: "cb-madrugada",
                from: { id: 900_777, first_name: "Iris" },
                message: { message_id: messageId + 1, chat: { id: chatId, type: "group" }, date: 0 },
                data: buildMadrugadaCallbackData(posicao, log.id),
            },
        } as never);

        const cobertura = await getDb().query.regulationOccupancies.findFirst({
            where: eq(schema.regulationOccupancies.doctorId, iris.id),
        });
        assert.ok(cobertura, "cobertura gravada");
        assert.equal(cobertura.madrugadaCobertura, true);
        assert.equal(cobertura.madrugadaCobreOcupacaoId, coberta.id);
        assert.equal(cobertura.scheduledStartAt?.toISOString(), new Date("2026-09-30T03:00:00-03:00").toISOString());
        assert.equal(cobertura.scheduledEndAt?.toISOString(), new Date("2026-09-30T07:00:00-03:00").toISOString());
        const [aceito] = await getDb().select().from(schema.telegramIngestedMessages)
            .where(eq(schema.telegramIngestedMessages.id, log.id));
        assert.equal(aceito.status, "accepted");
    } finally {
        globalThis.fetch = originalFetch;
        if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
        else process.env.TELEGRAM_BOT_TOKEN = originalToken;
        await getDb().update(schema.telegramIngestedMessages).set({ relatedOccupancyId: null })
            .where(eq(schema.telegramIngestedMessages.chatId, String(chatId)));
        await getDb().delete(schema.telegramIngestedMessages).where(eq(schema.telegramIngestedMessages.chatId, String(chatId)));
    }
});
