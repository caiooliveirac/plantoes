import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { and, eq, inArray, isNull, like } from "drizzle-orm";

/**
 * Chegada, saída, estado, remanejo e pedido de continuação pelo PRÓPRIO
 * médico na web (app/api/medico/*), mais a decisão da chefia
 * (app/api/mesa/pedidos-do-medico), contra Postgres de verdade. Só roda com
 * DATABASE_URL num banco `*_test` (cita getDb( para o test-gate serializar).
 * Contas @medico-web-teste.invalid, apagadas no fim.
 *
 * As rotas leem a sessão por cookies()/headers() do Next; aqui o pedido é
 * forjado abrindo o mesmo contexto de requisição que o servidor abre
 * (workAsyncStorage + workUnitAsyncStorage), com o cookie assinado.
 */
// O Next cria os AsyncLocalStorage a partir do global; fora do servidor dele
// esse global não existe. Tem de vir ANTES de qualquer import do next.
(globalThis as { AsyncLocalStorage?: typeof AsyncLocalStorage }).AsyncLocalStorage ??= AsyncLocalStorage;

function bancoDeTeste(): string | null {
    try {
        const nome = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "");
        return /_test$/.test(nome) ? nome : null;
    } catch {
        return null;
    }
}

const banco = bancoDeTeste();
const skip = banco ? false : "DATABASE_URL não aponta para um banco *_test";
process.env.AUTH_SECRET ??= "test-secret-medico-web";
// Sem token do bot, os avisos (deslocamento, pedido) viram no-op.
delete process.env.TELEGRAM_BOT_TOKEN;

const SUFIXO = "@medico-web-teste.invalid";

async function modulos() {
    const [{ getDb, closeDb }, schema, auth, token, chegada, saida, estado, continuar, remanejar, lista, decidir, boardRules] = await Promise.all([
        import("@/db"),
        import("@/db/schema"),
        import("@/services/auth.service"),
        import("@/lib/auth/token"),
        import("@/app/api/medico/chegada/route"),
        import("@/app/api/medico/saida/route"),
        import("@/app/api/medico/estado/route"),
        import("@/app/api/medico/continuar/route"),
        import("@/app/api/medico/remanejar/route"),
        import("@/app/api/mesa/pedidos-do-medico/route"),
        import("@/app/api/mesa/pedidos-do-medico/[id]/decidir/route"),
        import("@/modules/operational/board-rules"),
    ]);
    return { getDb, closeDb, schema, auth, token, chegada, saida, estado, continuar, remanejar, lista, decidir, boardRules };
}

/** Roda `fn` dentro de um contexto de requisição do Next com o cookie da sessão de `userId`. */
async function comoUsuario<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const [{ createSessionToken }, { workUnitAsyncStorage }, { workAsyncStorage }, { RequestCookies }] = await Promise.all([
        import("@/lib/auth/token"),
        import("next/dist/server/app-render/work-unit-async-storage.external.js"),
        import("next/dist/server/app-render/work-async-storage.external.js"),
        import("next/dist/server/web/spec-extension/cookies.js"),
    ]);
    const token = createSessionToken({ sub: userId, exp: Date.now() + 60_000, sv: 0 }, process.env.AUTH_SECRET!);
    const headers = new Headers({ cookie: `operations_v2_session=${token}`, "x-forwarded-for": "203.0.113.10" });
    const unidade = {
        type: "request",
        phase: "action",
        implicitTags: { tags: [], expirationsByCacheKind: new Map() },
        url: { pathname: "/api/medico", search: "" },
        rootParams: {},
        headers,
        cookies: new RequestCookies(headers),
        mutableCookies: new RequestCookies(headers),
        userspaceMutableCookies: new RequestCookies(headers),
        isHmrRefresh: false,
        serverComponentsHmrCache: undefined,
        devFallbackParams: null,
        renderResumeDataCache: null,
        prerenderResumeDataCache: null,
        draftMode: undefined,
    };
    const trabalho = {
        route: "/api/medico",
        page: "/api/medico",
        isStaticGeneration: false,
        forceStatic: false,
        dynamicShouldError: false,
        isDraftMode: false,
        isRevalidate: false,
        isPrerendering: false,
        dev: false,
        buildId: "teste",
        reactLoadableManifest: {},
        assetPrefix: "",
        isOnDemandRevalidate: false,
    };
    return workAsyncStorage.run(trabalho as never, () => workUnitAsyncStorage.run(unidade as never, fn));
}

function pedido(caminho: string, corpo?: unknown) {
    return new NextRequestCtor(`http://localhost${caminho}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(corpo ?? {}),
    });
}
// NextRequest é importado tarde (depois do global acima); guardamos o construtor.
let NextRequestCtor: typeof import("next/server").NextRequest;

const criados = { users: [] as string[], doctors: [] as string[], posts: [] as number[], bases: [] as number[] };

async function criarMedico(papel: "doctor" | "admin" | "chief" = "doctor", comFicha = true) {
    const { getDb, schema, auth } = await modulos();
    const db = getDb();
    const marca = randomUUID().slice(0, 6).toUpperCase();
    let doctorId: string | null = null;
    if (comFicha) {
        const [medico] = await db.insert(schema.doctors).values({ fullName: `Medico Web ${marca}`, normalizedName: `medico web ${marca.toLowerCase()}` }).returning({ id: schema.doctors.id });
        doctorId = medico.id;
        criados.doctors.push(medico.id);
    }
    const [user] = await db.insert(schema.users).values({
        email: `${papel}-${marca.toLowerCase()}${SUFIXO}`,
        passwordHash: await auth.hashPassword("senha-de-teste-123"),
        isActive: true,
        doctorId,
    }).returning({ id: schema.users.id });
    await db.insert(schema.userRoles).values({ userId: user.id, role: papel });
    criados.users.push(user.id);
    return { userId: user.id, doctorId: doctorId as string };
}

async function criarRamal(extra: { onDemand?: boolean; isActive?: boolean } = {}) {
    const { getDb, schema } = await modulos();
    const marca = randomUUID().slice(0, 4).toUpperCase();
    const [post] = await getDb().insert(schema.regulationPosts).values({ code: `W${marca}`, label: `Ramal web ${marca}`, ...extra }).returning({ id: schema.regulationPosts.id, code: schema.regulationPosts.code });
    criados.posts.push(post.id);
    return post;
}

async function criarBase() {
    const { getDb, schema } = await modulos();
    const marca = randomUUID().slice(0, 4).toUpperCase();
    const [base] = await getDb().insert(schema.interventionBases).values({ code: `WB${marca}`, label: `Base web ${marca}` }).returning({ id: schema.interventionBases.id, code: schema.interventionBases.code });
    criados.bases.push(base.id);
    return base;
}

/** Titular do turno CORRENTE no alvo: chegou no início da janela do turno, com board. */
async function titularDoTurno(alvo: { domain: "regulation" | "intervention"; id: number }, doctorId: string) {
    const { getDb, schema, boardRules } = await modulos();
    const janela = boardRules.resolveOperationalShiftWindow(new Date());
    const chegada = new Date(janela.startedAt.getTime() + 60_000);
    const comum = {
        doctorId,
        continuityGroupId: randomUUID(),
        startedAt: chegada,
        boardStartedAt: chegada,
        scheduledStartAt: janela.startedAt,
        scheduledEndAt: janela.nextBoundaryAt,
        shiftLabel: janela.shiftLabel,
        source: "manual" as const,
    };
    if (alvo.domain === "regulation") {
        const [row] = await getDb().insert(schema.regulationOccupancies).values({ ...comum, postId: alvo.id }).returning({ id: schema.regulationOccupancies.id });
        return row.id;
    }
    const [row] = await getDb().insert(schema.interventionOccupancies).values({ ...comum, baseId: alvo.id }).returning({ id: schema.interventionOccupancies.id });
    return row.id;
}

async function json(resposta: Response | Promise<Response>) {
    const res = await resposta;
    return { status: res.status, body: await res.json() as Record<string, unknown> & { ocupacao?: Record<string, unknown>; emTurno?: Record<string, unknown> | null } };
}

after(async () => {
    if (!banco) return;
    const { getDb, closeDb, schema } = await modulos();
    const db = getDb();
    // O registro de acesso corre depois da resposta (depoisDaResposta); dá um fôlego antes de limpar.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const users = [...new Set([...criados.users, ...(await db.select({ id: schema.users.id }).from(schema.users).where(like(schema.users.email, `%${SUFIXO}`))).map((r) => r.id)])];
    if (criados.doctors.length > 0) {
        await db.delete(schema.pedidosDoMedico).where(inArray(schema.pedidosDoMedico.doctorId, criados.doctors));
        await db.delete(schema.bankHoursEntries).where(inArray(schema.bankHoursEntries.doctorId, criados.doctors));
        await db.delete(schema.regulationOccupancies).where(inArray(schema.regulationOccupancies.doctorId, criados.doctors));
        await db.delete(schema.interventionOccupancies).where(inArray(schema.interventionOccupancies.doctorId, criados.doctors));
    }
    if (users.length > 0) {
        await db.delete(schema.auditLogs).where(inArray(schema.auditLogs.actorUserId, users));
        await db.delete(schema.users).where(inArray(schema.users.id, users)); // cascata: sessões, papéis
    }
    if (criados.doctors.length > 0) await db.delete(schema.doctors).where(inArray(schema.doctors.id, criados.doctors));
    if (criados.posts.length > 0) await db.delete(schema.regulationPosts).where(inArray(schema.regulationPosts.id, criados.posts));
    if (criados.bases.length > 0) await db.delete(schema.interventionBases).where(inArray(schema.interventionBases.id, criados.bases));
    await closeDb();
});

test("medico web (banco): chegada em ramal livre, segunda chegada recusada, estado, saída a confirmar", { skip }, async () => {
    const { getDb, schema, chegada, saida, estado } = await modulos();
    NextRequestCtor = (await import("next/server")).NextRequest;
    const eu = await criarMedico();
    const ramal = await criarRamal();

    const antes = await comoUsuario(eu.userId, () => json(estado.GET()));
    assert.equal(antes.status, 200);
    assert.equal(antes.body.emTurno, null);
    assert.equal(antes.body.previa, null);

    const r1 = await comoUsuario(eu.userId, () => json(chegada.POST(pedido("/api/medico/chegada", { domain: "regulation", targetId: ramal.id }))));
    assert.equal(r1.status, 201, JSON.stringify(r1.body));
    assert.equal(r1.body.ok, true);
    assert.equal(r1.body.ocupacao?.code, ramal.code);
    assert.equal(r1.body.ocupacao?.targetId, ramal.id);
    const occ = await getDb().query.regulationOccupancies.findFirst({ where: eq(schema.regulationOccupancies.id, String(r1.body.ocupacao?.occupancyId)) });
    assert.ok(occ);
    assert.equal(occ.source, "manual");
    assert.equal(occ.notes, "Chegada declarada pela web");
    assert.ok(occ.boardStartedAt);
    assert.ok(Math.abs(occ.startedAt.getTime() - Date.now()) < 60_000, "hora da chegada é a do servidor, agora");
    assert.equal(occ.createdByUserId, eu.userId);

    // Vale a primeira: segunda chegada não avança nem troca de posto.
    const outro = await criarRamal();
    const r2 = await comoUsuario(eu.userId, () => json(chegada.POST(pedido("/api/medico/chegada", { domain: "regulation", targetId: outro.id }))));
    assert.equal(r2.status, 409);
    assert.equal(r2.body.error, "ja_em_turno");
    assert.equal(r2.body.ocupacao?.code, ramal.code);

    const durante = await comoUsuario(eu.userId, () => json(estado.GET()));
    assert.equal(durante.body.emTurno?.code, ramal.code);
    assert.equal(durante.body.emTurno?.saidaDeclaradaAt, null);
    const previa = durante.body.previa as Record<string, unknown>;
    assert.ok(previa, "em turno vem com a prévia do banco de horas");
    for (const campo of ["atrasoMin", "excedenteMin", "multiplicador", "creditoMin", "saldoMin"]) assert.equal(typeof previa[campo], "number", campo);
    assert.ok(typeof previa.janelaInicio === "string" && typeof previa.janelaFim === "string" && typeof previa.agora === "string");

    // Saída solo: grava actual_ended_at e fica a confirmar pela chefia.
    const s1 = await comoUsuario(eu.userId, () => json(saida.POST()));
    assert.equal(s1.status, 200, JSON.stringify(s1.body));
    const saidaBody = s1.body.saida as Record<string, unknown>;
    assert.equal(saidaBody.aConfirmar, true);
    assert.ok(s1.body.previa, "a saída devolve a prévia calculada no instante da saída");
    const fechada = await getDb().query.regulationOccupancies.findFirst({ where: eq(schema.regulationOccupancies.id, occ.id) });
    assert.ok(fechada?.endedAt && fechada.actualEndedAt);
    assert.equal(fechada.departureConfirmedAt, null, "pendente de confirmação da chefia");

    const depois = await comoUsuario(eu.userId, () => json(estado.GET()));
    assert.equal(depois.body.emTurno?.code, ramal.code);
    assert.equal(depois.body.emTurno?.saidaDeclaradaAt, fechada.actualEndedAt.toISOString());

    const s2 = await comoUsuario(eu.userId, () => json(saida.POST()));
    assert.equal(s2.status, 409);
    assert.equal(s2.body.error, "fora_de_turno");
});

test("medico web (banco): ramal ocupado pede dupla confirmação e desloca o titular; ramal eventual é indisponível", { skip }, async () => {
    const { getDb, schema, chegada } = await modulos();
    NextRequestCtor = (await import("next/server")).NextRequest;
    const eu = await criarMedico();
    const titular = await criarMedico();
    const ramal = await criarRamal();
    const ocupTitular = await titularDoTurno({ domain: "regulation", id: ramal.id }, titular.doctorId);

    const semFlags = await comoUsuario(eu.userId, () => json(chegada.POST(pedido("/api/medico/chegada", { domain: "regulation", targetId: ramal.id }))));
    assert.equal(semFlags.status, 409, JSON.stringify(semFlags.body));
    assert.equal(semFlags.body.error, "posto_ocupado");
    assert.equal(semFlags.body.efeito, "deslocar");
    assert.equal(semFlags.body.precisaConfirmar, true);
    assert.ok((semFlags.body.ocupante as Record<string, unknown>).nome);

    const soUma = await comoUsuario(eu.userId, () => json(chegada.POST(pedido("/api/medico/chegada", { domain: "regulation", targetId: ramal.id, cienteOcupado: true }))));
    assert.equal(soUma.status, 409);

    const confirmada = await comoUsuario(eu.userId, () => json(chegada.POST(pedido("/api/medico/chegada", { domain: "regulation", targetId: ramal.id, cienteOcupado: true, assumirPosto: true }))));
    assert.equal(confirmada.status, 201, JSON.stringify(confirmada.body));
    const deslocado = await getDb().query.regulationOccupancies.findFirst({ where: eq(schema.regulationOccupancies.id, ocupTitular) });
    assert.ok(deslocado);
    assert.equal(deslocado.endedAt, null, "deslocado segue no plantão");
    assert.equal(deslocado.boardStartedAt, null, "mas fora do quadro");
    assert.match(deslocado.notes ?? "", /DESLOCADO/i);
    const minha = await getDb().query.regulationOccupancies.findFirst({ where: eq(schema.regulationOccupancies.id, String(confirmada.body.ocupacao?.occupancyId)) });
    assert.ok(minha?.boardStartedAt, "quem chegou assume o quadro");

    const eventual = await criarRamal({ onDemand: true });
    const terceiro = await criarMedico();
    const r = await comoUsuario(terceiro.userId, () => json(chegada.POST(pedido("/api/medico/chegada", { domain: "regulation", targetId: eventual.id }))));
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "posto_indisponivel");
});

test("medico web (banco): base ocupada vira dupla com confirmação; titular intocado", { skip }, async () => {
    const { getDb, schema, chegada } = await modulos();
    NextRequestCtor = (await import("next/server")).NextRequest;
    const eu = await criarMedico();
    const titular = await criarMedico();
    const base = await criarBase();
    const ocupTitular = await titularDoTurno({ domain: "intervention", id: base.id }, titular.doctorId);

    const semFlags = await comoUsuario(eu.userId, () => json(chegada.POST(pedido("/api/medico/chegada", { domain: "intervention", targetId: base.id }))));
    assert.equal(semFlags.status, 409, JSON.stringify(semFlags.body));
    assert.equal(semFlags.body.error, "posto_ocupado");
    assert.equal(semFlags.body.efeito, "dupla");

    const confirmada = await comoUsuario(eu.userId, () => json(chegada.POST(pedido("/api/medico/chegada", { domain: "intervention", targetId: base.id, cienteOcupado: true, assumirPosto: true }))));
    assert.equal(confirmada.status, 201, JSON.stringify(confirmada.body));
    const titularDepois = await getDb().query.interventionOccupancies.findFirst({ where: eq(schema.interventionOccupancies.id, ocupTitular) });
    assert.ok(titularDepois?.boardStartedAt && !titularDepois.endedAt, "titular segue no quadro");
    const minha = await getDb().query.interventionOccupancies.findFirst({ where: eq(schema.interventionOccupancies.id, String(confirmada.body.ocupacao?.occupancyId)) });
    assert.ok(minha);
    assert.equal(minha.endedAt, null);
    assert.equal(minha.boardStartedAt, null, "dupla entra fora do quadro");
    const abertas = await getDb().select({ id: schema.interventionOccupancies.id }).from(schema.interventionOccupancies)
        .where(and(eq(schema.interventionOccupancies.baseId, base.id), isNull(schema.interventionOccupancies.endedAt)));
    assert.equal(abertas.length, 2, "os dois ficam na base");
});

test("medico web (banco): remanejo pelo próprio médico move a ocupação; alvo ocupado exige confirmação", { skip }, async () => {
    const { getDb, schema, chegada, remanejar } = await modulos();
    NextRequestCtor = (await import("next/server")).NextRequest;
    const eu = await criarMedico();
    const origem = await criarRamal();
    const destino = await criarRamal();

    const fora = await comoUsuario(eu.userId, () => json(remanejar.POST(pedido("/api/medico/remanejar", { domain: "regulation", targetId: destino.id }))));
    assert.equal(fora.status, 409);
    assert.equal(fora.body.error, "fora_de_turno");

    const cheg = await comoUsuario(eu.userId, () => json(chegada.POST(pedido("/api/medico/chegada", { domain: "regulation", targetId: origem.id }))));
    assert.equal(cheg.status, 201);
    const origemId = String(cheg.body.ocupacao?.occupancyId);

    const mesmo = await comoUsuario(eu.userId, () => json(remanejar.POST(pedido("/api/medico/remanejar", { domain: "regulation", targetId: origem.id }))));
    assert.equal(mesmo.status, 409);
    assert.equal(mesmo.body.error, "mesmo_posto");

    const ok = await comoUsuario(eu.userId, () => json(remanejar.POST(pedido("/api/medico/remanejar", { domain: "regulation", targetId: destino.id }))));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.ocupacao?.code, destino.code);
    const antiga = await getDb().query.regulationOccupancies.findFirst({ where: eq(schema.regulationOccupancies.id, origemId) });
    assert.ok(antiga?.endedAt, "origem fechada pelo remanejo");
    const nova = await getDb().query.regulationOccupancies.findFirst({ where: eq(schema.regulationOccupancies.id, String(ok.body.ocupacao?.occupancyId)) });
    assert.ok(nova && !nova.endedAt && nova.boardStartedAt);
    assert.equal(nova.postId, destino.id);
    assert.match(nova.notes ?? "", /Remanejo pelo próprio médico/);

    // Destino com titular do turno: dupla confirmação; confirmado, o titular é deslocado.
    const titular = await criarMedico();
    const ocupado = await criarRamal();
    const ocupTitular = await titularDoTurno({ domain: "regulation", id: ocupado.id }, titular.doctorId);
    const recusa = await comoUsuario(eu.userId, () => json(remanejar.POST(pedido("/api/medico/remanejar", { domain: "regulation", targetId: ocupado.id }))));
    assert.equal(recusa.status, 409);
    assert.equal(recusa.body.error, "posto_ocupado");
    assert.equal(recusa.body.efeito, "deslocar");
    const movido = await comoUsuario(eu.userId, () => json(remanejar.POST(pedido("/api/medico/remanejar", { domain: "regulation", targetId: ocupado.id, cienteOcupado: true, assumirPosto: true }))));
    assert.equal(movido.status, 200, JSON.stringify(movido.body));
    const deslocado = await getDb().query.regulationOccupancies.findFirst({ where: eq(schema.regulationOccupancies.id, ocupTitular) });
    assert.ok(deslocado && !deslocado.endedAt && !deslocado.boardStartedAt, "titular deslocado, não encerrado");
});

test("medico web (banco): pedido de continuação fica pendente; chefia aceita e a continuação nasce", { skip }, async () => {
    const { getDb, schema, chegada, continuar, lista, decidir } = await modulos();
    NextRequestCtor = (await import("next/server")).NextRequest;
    const eu = await criarMedico();
    const chefe = await criarMedico("admin", false);
    const ramal = await criarRamal();

    const fora = await comoUsuario(eu.userId, () => json(continuar.POST()));
    assert.equal(fora.status, 409);
    assert.equal(fora.body.error, "fora_de_turno");

    const cheg = await comoUsuario(eu.userId, () => json(chegada.POST(pedido("/api/medico/chegada", { domain: "regulation", targetId: ramal.id }))));
    assert.equal(cheg.status, 201);
    const occId = String(cheg.body.ocupacao?.occupancyId);
    const antes = await getDb().query.regulationOccupancies.findFirst({ where: eq(schema.regulationOccupancies.id, occId) });

    const p1 = await comoUsuario(eu.userId, () => json(continuar.POST()));
    assert.equal(p1.status, 201, JSON.stringify(p1.body));
    const pedidoCriado = p1.body.pedido as Record<string, unknown>;
    assert.equal(pedidoCriado.status, "pendente");
    const p2 = await comoUsuario(eu.userId, () => json(continuar.POST()));
    assert.equal(p2.status, 409);
    assert.equal(p2.body.error, "pedido_ja_pendente");
    const aindaIgual = await getDb().query.regulationOccupancies.findFirst({ where: eq(schema.regulationOccupancies.id, occId) });
    assert.equal(aindaIgual?.scheduledEndAt?.toISOString(), antes?.scheduledEndAt?.toISOString(), "pedir não muda a ocupação");

    const pendentes = await comoUsuario(chefe.userId, () => json(lista.GET()));
    assert.equal(pendentes.status, 200, JSON.stringify(pendentes.body));
    const meu = (pendentes.body.pedidos as Array<Record<string, unknown>>).find((p) => p.id === pedidoCriado.id);
    assert.ok(meu, "pedido aparece para a chefia");
    assert.equal((meu.ocupacao as Record<string, unknown>).code, ramal.code);
    assert.ok((meu.medico as Record<string, unknown>).nome);

    const ctx = { params: Promise.resolve({ id: String(pedidoCriado.id) }) };
    const dec = await comoUsuario(chefe.userId, () => json(decidir.POST(pedido(`/api/mesa/pedidos-do-medico/${pedidoCriado.id}/decidir`, { decisao: "aceito", note: "dobra combinada" }), ctx)));
    assert.equal(dec.status, 200, JSON.stringify(dec.body));
    const decidido = dec.body.pedido as Record<string, unknown>;
    assert.equal(decidido.status, "aceito");
    assert.ok(decidido.continuacao, "aceitar cria a continuação");
    const continuada = await getDb().query.regulationOccupancies.findFirst({ where: eq(schema.regulationOccupancies.id, occId) });
    assert.ok(continuada?.scheduledEndAt && antes?.scheduledEndAt, "janelas conhecidas");
    assert.ok(
        continuada.scheduledEndAt.getTime() >= antes.scheduledEndAt.getTime() + 11 * 3_600_000,
        `janela estendida para o turno seguinte (antes ${antes.scheduledEndAt.toISOString()}, depois ${continuada.scheduledEndAt.toISOString()})`,
    );
    assert.equal(continuada.shiftLabel, "P");

    const deNovo = await comoUsuario(chefe.userId, () => json(decidir.POST(pedido(`/api/mesa/pedidos-do-medico/${pedidoCriado.id}/decidir`, { decisao: "recusado" }), ctx)));
    assert.equal(deNovo.status, 409);
    assert.equal(deNovo.body.error, "pedido_ja_decidido");

    // Médico sem sessão de admin não lista nem decide.
    const semPoder = await comoUsuario(eu.userId, () => json(lista.GET()));
    assert.equal(semPoder.status, 403);
});

test("medico web (banco): conta sem ficha de médico ou sem papel doctor recebe 403", { skip }, async () => {
    const { chegada, estado } = await modulos();
    NextRequestCtor = (await import("next/server")).NextRequest;
    const admin = await criarMedico("admin", false);
    const r = await comoUsuario(admin.userId, () => json(estado.GET()));
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "sem_medico_vinculado");

    const chefeComFicha = await criarMedico("chief", true);
    const c = await comoUsuario(chefeComFicha.userId, () => json(chegada.POST(pedido("/api/medico/chegada", { domain: "regulation", targetId: 1 }))));
    assert.equal(c.status, 403);
    assert.equal(c.body.error, "sem_papel_medico");
});
