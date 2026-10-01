import test, { after } from "node:test";
import assert from "node:assert/strict";
import { eq, inArray, like, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import type { ContextoRequisicao } from "@/lib/acessos/contexto";

/**
 * Enfermeiro(a) do plantão contra Postgres de verdade: registro com histórico,
 * lista da escala (fetch simulado), portão do quadro.mnrs.com.br e o
 * endpoint de serviço do quadro. Só roda com DATABASE_URL num banco `*_test`.
 * Contas @enfermeiro-teste.invalid e linhas do turno corrente, apagadas no fim.
 */
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
process.env.ESCALA_SSO_TOKEN ??= "token-de-teste-quadro";
const TOKEN = process.env.ESCALA_SSO_TOKEN;
const DOMINIO = "@enfermeiro-teste.invalid";

async function modulos() {
    const [{ getDb, closeDb }, schema, servico, turno, portal, portao, rota] = await Promise.all([
        import("@/db"),
        import("@/db/schema"),
        import("@/services/enfermeiro-plantao.service"),
        import("@/modules/operational/enfermeiro-plantao"),
        import("@/services/acessos-portal.service"),
        import("@/services/acessos-portao.service"),
        import("@/app/api/servicos/quadro/plantao/route"),
    ]);
    return { getDb, closeDb, schema, servico, turno, portal, portao, rota };
}

const contexto: ContextoRequisicao = {
    ip: null,
    userAgent: "teste",
    geo: {},
    metodo: "GET",
    caminho: "/",
    rsc: false,
    prefetch: false,
    usoMesa: null,
};

const fetchOriginal = globalThis.fetch;
function simularEscala(enfermeiros: unknown[] | null) {
    process.env.ESCALA_API_URL = "https://escala.exemplo.invalid";
    globalThis.fetch = (async (entrada: RequestInfo | URL) => {
        const url = String(entrada);
        if (!url.endsWith("/api/servicos/enfermeiros")) throw new Error(`fetch inesperado: ${url}`);
        if (!enfermeiros) return new Response("erro", { status: 502 });
        return Response.json({ ok: true, enfermeiros });
    }) as typeof fetch;
}

async function limparTurnoCorrente() {
    const { getDb, schema, turno } = await modulos();
    const atual = turno.turnoDoMomento();
    await getDb().delete(schema.enfermeirosPlantao).where(eq(schema.enfermeirosPlantao.turnoData, atual.data));
}

async function criarConta(email: string, roles: Array<"portal" | "doctor">) {
    const { getDb, schema } = await modulos();
    const [conta] = await getDb().insert(schema.users).values({ email, passwordHash: "x" }).returning({ id: schema.users.id });
    await getDb().insert(schema.userRoles).values(roles.map((role) => ({ userId: conta.id, role })));
    return conta.id;
}

after(async () => {
    globalThis.fetch = fetchOriginal;
    if (!banco) return;
    const { getDb, closeDb, schema } = await modulos();
    await limparTurnoCorrente();
    const db = getDb();
    const ids = (await db.select({ id: schema.users.id }).from(schema.users).where(like(schema.users.email, `%${DOMINIO}`))).map((r) => r.id);
    if (ids.length > 0) {
        await db.delete(schema.enfermeirosPlantao).where(inArray(schema.enfermeirosPlantao.registradoPor, ids));
        await db.delete(schema.userRoles).where(inArray(schema.userRoles.userId, ids));
        await db.delete(schema.users).where(inArray(schema.users.id, ids));
    }
    if (basesCriadas.length > 0) await db.execute(sql`delete from operations_v2.intervention_bases where id in ${basesCriadas}`);
    if (criouStubLegado) await db.execute(sql`drop table public.shift_current_state, public.shift_instances, public.users, public.bases`);
    await closeDb();
});

test("enfermeiro (banco): registrar outro substitui o anterior e guarda o histórico; limpar marca substituído", { skip }, async () => {
    const { getDb, schema, servico, turno } = await modulos();
    await limparTurnoCorrente();
    const chefe = await criarConta(`chefe-${Date.now()}${DOMINIO}`, ["doctor"]);
    const atual = turno.turnoDoMomento();

    const primeiro = await servico.registrarEnfermeiro({ turno: atual, nome: "  Maria   da Silva ", userId: chefe });
    assert.equal(primeiro.nome, "Maria da Silva");
    assert.deepEqual(primeiro.emails, []);
    const segundo = await servico.registrarEnfermeiro({ turno: atual, nome: "João Souza", userId: chefe });
    assert.equal((await servico.enfermeiroDoTurno(atual))?.id, segundo.id);

    const linhas = await getDb().select().from(schema.enfermeirosPlantao).where(eq(schema.enfermeirosPlantao.turnoData, atual.data));
    assert.equal(linhas.length, 2);
    assert.ok(linhas.find((l) => l.id === primeiro.id)?.substituidoEm, "o primeiro ficou como substituído");

    assert.equal(await servico.limparEnfermeiro(atual), true);
    assert.equal(await servico.enfermeiroDoTurno(atual), null);
    assert.equal(await servico.limparEnfermeiro(atual), false);
    await assert.rejects(servico.registrarEnfermeiro({ turno: atual, nome: "ab", userId: chefe }), /Informe o nome/);
});

test("enfermeiro (banco): da lista da escala grava e-mails (minúsculos) e telefone; id desconhecido e escala fora recusam", { skip }, async () => {
    const { servico, turno } = await modulos();
    await limparTurnoCorrente();
    const chefe = await criarConta(`chefe2-${Date.now()}${DOMINIO}`, ["doctor"]);
    const atual = turno.turnoDoMomento();

    servico.esquecerListaDeEnfermeiros();
    simularEscala([
        { id: "p-1", nome: "Ana Enfermeira", matricula: "123", emails: ["ANA@Enfermeiro-Teste.invalid"], telefone: "71999990000", baseId: null },
        { id: "", nome: "sem id" },
    ]);
    const lista = await servico.listarEnfermeirosDaEscala();
    assert.equal(lista?.length, 1);
    const registro = await servico.registrarEnfermeiro({ turno: atual, profissionalId: "p-1", userId: chefe });
    assert.deepEqual(registro.emails, [`ana${DOMINIO}`]);
    assert.equal(registro.telefone, "71999990000");
    await assert.rejects(servico.registrarEnfermeiro({ turno: atual, profissionalId: "nao-existe", userId: chefe }), /não encontrad/);

    servico.esquecerListaDeEnfermeiros();
    simularEscala(null);
    assert.equal(await servico.listarEnfermeirosDaEscala(), null);
    await assert.rejects(servico.registrarEnfermeiro({ turno: atual, profissionalId: "p-1", userId: chefe }), /escala não respondeu/);
    globalThis.fetch = fetchOriginal;
});

test("enfermeiro (banco): portão do quadro libera o e-mail do enfermeiro(a) do turno; Tabela continua barrada", { skip }, async () => {
    const { servico, turno, portal, portao } = await modulos();
    await limparTurnoCorrente();
    portao.limparMemoriaDoPortao();
    const email = `enf-${Date.now()}${DOMINIO}`;
    const chefe = await criarConta(`chefe3-${Date.now()}${DOMINIO}`, ["doctor"]);
    await criarConta(email, ["portal"]);
    const atual = turno.turnoDoMomento();

    // Sem registro: barrado no quadro.
    assert.deepEqual(await portal.conferirSessaoDoPortal(email, 0, { sistema: "quadro", contexto }), { ok: false, motivo: "fora_do_plantao", userId: (await portal.conferirSessaoDoPortal(email, 0)).userId });

    servico.esquecerListaDeEnfermeiros();
    simularEscala([{ id: "p-9", nome: "Enf Teste", matricula: "9", emails: [email.toUpperCase()], telefone: null }]);
    await servico.registrarEnfermeiro({ turno: atual, profissionalId: "p-9", userId: chefe });
    globalThis.fetch = fetchOriginal;

    assert.equal(await servico.emailDeEnfermeiroDoTurno(email), true);
    assert.equal(await servico.emailDeEnfermeiroDoTurno(`outra${DOMINIO}`), false);
    assert.equal((await portal.conferirSessaoDoPortal(email, 0, { sistema: "quadro", contexto })).ok, true);
    assert.equal((await portal.conferirSessaoDoPortal(email, 0, { sistema: "tabela", contexto })).motivo, "fora_do_plantao");
    assert.equal((await portal.conferirSessaoDoPortal(email, 0, { sistema: "portal", contexto })).ok, true);

    // Substituído: perde o acesso.
    await servico.registrarEnfermeiro({ turno: atual, nome: "Outra Pessoa", userId: chefe });
    assert.equal((await portal.conferirSessaoDoPortal(email, 0, { sistema: "quadro", contexto })).ok, false);
});

// O quadro lê também o legado (public.shift_current_state & cia.), que não
// existe no banco de teste: stub vazio só se faltar (como em
// quadro-leitura-sem-escrita.test.ts), apagado no fim.
let criouStubLegado = false;
const basesCriadas: number[] = [];
async function garantirStubLegado() {
    const { getDb } = await modulos();
    const [linha] = await getDb().execute(sql`select to_regclass('public.shift_current_state') is not null as existe`) as unknown as { existe: boolean }[];
    if (linha.existe) return;
    criouStubLegado = true;
    await getDb().execute(sql`
        create table public.bases (id uuid primary key, code text, sector text);
        create table public.users (id uuid primary key, name text);
        create table public.shift_instances (
            id uuid primary key, base_id uuid, scheduled_start_at timestamptz,
            scheduled_end_at timestamptz, role_function text
        );
        create table public.shift_current_state (
            shift_instance_id uuid, executor_user_id uuid, status text, ramal text,
            arrival_time timestamptz, departure_time timestamptz,
            role_function_detected text, updated_at timestamptz
        );
    `);
}

test("enfermeiro (banco): /api/servicos/quadro/plantao exige token e devolve turno, enfermeiro(a), chefe e bases", { skip }, async () => {
    const { getDb, servico, turno, rota } = await modulos();
    await limparTurnoCorrente();
    await garantirStubLegado();
    const codigo = `QT${Date.now() % 100000}`;
    const [base] = await getDb().execute(sql`
        insert into operations_v2.intervention_bases (code, label) values (${codigo}, ${"Base de teste do quadro"}) returning id
    `) as unknown as { id: number }[];
    basesCriadas.push(base.id);
    const chefe = await criarConta(`chefe4-${Date.now()}${DOMINIO}`, ["doctor"]);
    const atual = turno.turnoDoMomento();
    await servico.registrarEnfermeiro({ turno: atual, nome: "Carla Quadro", userId: chefe });

    const pedir = (token: string | null) => rota.GET(new NextRequest("http://localhost/api/servicos/quadro/plantao", {
        headers: token ? { "x-escala-token": token } : {},
    }));
    assert.equal((await pedir(null)).status, 401);
    assert.equal((await pedir("errado")).status, 401);
    const resposta = await pedir(TOKEN!);
    assert.equal(resposta.status, 200);
    const corpo = await resposta.json() as {
        ok: boolean; turno: { data: string; turno: string };
        enfermeiro: { nome: string; telefone: string | null } | null;
        chefe: { nome: string } | null;
        bases: Array<{ codigo: string; nome: string; ativa: boolean; medico: string | null }>;
    };
    assert.equal(corpo.ok, true);
    assert.deepEqual(corpo.turno, { data: atual.data, turno: atual.turno });
    assert.deepEqual(corpo.enfermeiro, { nome: "Carla Quadro", telefone: null });
    assert.ok(corpo.chefe === null || typeof corpo.chefe.nome === "string");
    assert.deepEqual(corpo.bases.find((b) => b.codigo === codigo), { codigo, nome: "Base de teste do quadro", ativa: true, medico: null });
    assert.equal(JSON.stringify(corpo).includes("@"), false, "nenhum e-mail sai para o quadro");
});
