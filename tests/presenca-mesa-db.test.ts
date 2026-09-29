import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, like } from "drizzle-orm";

/**
 * Presença na Mesa contra um Postgres de verdade (migration 0049 aplicada):
 * corrida de dois aparelhos pela vez, abas do mesmo aparelho, troca de
 * aparelho, bloqueio por ociosidade e desbloqueio. SÓ roda com DATABASE_URL
 * num banco `*_test` (como tests/monitor-acessos-db.test.ts). Contas com
 * e-mail @presenca-teste.invalid, apagadas no fim (cascata leva lease e presença).
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

async function modulos() {
    const [{ getDb, closeDb }, schema, presenca, auth] = await Promise.all([
        import("@/db"),
        import("@/db/schema"),
        import("@/services/mesa-presenca.service"),
        import("@/services/auth.service"),
    ]);
    return { getDb, closeDb, schema, presenca, auth };
}

async function criarConta() {
    const { getDb, schema, auth } = await modulos();
    const [user] = await getDb()
        .insert(schema.users)
        .values({ email: `medico-${randomUUID().slice(0, 8)}@presenca-teste.invalid`, passwordHash: await auth.hashPassword("senha-de-teste-123"), isActive: true })
        .returning({ id: schema.users.id });
    await getDb().insert(schema.userRoles).values({ userId: user.id, role: "doctor" });
    return user.id;
}

const conta = (userId: string, aparelhoId: string) => ({ userId, aparelhoId, sessaoId: "", contexto: null });
const visivel = { visivel: true, paradoSeg: 3, humanoAgora: false };

/* registrarEvento é disparado sem await: espera a linha chegar (até 3 s) em
   vez de um intervalo fixo — 50 ms às vezes não bastava no CI (0 !== 1). */
async function eventos(userId: string, tipo: string) {
    const { getDb, schema } = await modulos();
    const buscar = () => getDb().select().from(schema.authSessionEvents)
        .where(and(eq(schema.authSessionEvents.userId, userId), eq(schema.authSessionEvents.kind, tipo)));
    const limite = Date.now() + 3_000;
    let linhas = await buscar();
    while (linhas.length === 0 && Date.now() < limite) {
        await new Promise((r) => setTimeout(r, 25));
        linhas = await buscar();
    }
    return linhas;
}

after(async () => {
    if (!banco) return;
    const { getDb, closeDb, schema } = await modulos();
    const db = getDb();
    const ids = (await db.select({ id: schema.users.id }).from(schema.users).where(like(schema.users.email, "%@presenca-teste.invalid"))).map((r) => r.id);
    if (ids.length > 0) await db.delete(schema.users).where(inArray(schema.users.id, ids));
    await closeDb();
});

test("presença (banco): dois aparelhos abrindo juntos — exatamente um fica com a vez", { skip }, async () => {
    const { presenca } = await modulos();
    presenca.limparMemoriaDaPresenca();
    const userId = await criarConta();
    const pc = randomUUID();
    const celular = randomUUID();
    const respostas = await Promise.all(Array.from({ length: 20 }, (_, i) => (
        presenca.baterPresenca(conta(userId, i % 2 === 0 ? pc : celular), visivel, "valendo").then((r) => ({ aparelho: i % 2 === 0 ? pc : celular, estado: r.estado }))
    )));
    const vencedores = new Set(respostas.filter((r) => r.estado === "ok").map((r) => r.aparelho));
    assert.equal(vencedores.size, 1, "só um aparelho pode ficar com a vez");
    const perdedor = vencedores.has(pc) ? celular : pc;
    assert.ok(respostas.filter((r) => r.aparelho === perdedor).every((r) => r.estado === "ocupada"));

    // O vencedor confere ok; o outro, ocupada — é o que as rotas da Mesa usam.
    const vencedor = [...vencedores][0];
    assert.equal((await presenca.conferirPresenca(conta(userId, vencedor), "valendo")).estado, "ok");
    assert.equal((await presenca.conferirPresenca(conta(userId, perdedor), "valendo")).estado, "ocupada");
    // Sem cookie de aparelho nunca pega a vez.
    assert.equal((await presenca.baterPresenca(conta(userId, ""), visivel, "valendo")).estado, "ocupada");
});

test("presença (banco): fechar a aba solta a vez; o outro aparelho entra e vira troca", { skip }, async () => {
    const { presenca } = await modulos();
    presenca.limparMemoriaDaPresenca();
    const userId = await criarConta();
    const pc = randomUUID();
    const celular = randomUUID();
    assert.equal((await presenca.baterPresenca(conta(userId, pc), visivel, "valendo")).estado, "ok");
    // Segunda aba do mesmo PC: mesmo aparelho, mesma vez.
    assert.equal((await presenca.baterPresenca(conta(userId, pc), visivel, "valendo")).estado, "ok");
    const negado = await presenca.baterPresenca(conta(userId, celular), visivel, "valendo");
    assert.equal(negado.estado, "ocupada");
    assert.ok((negado.tenteEmSeg ?? 0) > 0 && (negado.tenteEmSeg ?? 0) <= 45);
    // Aba escondida não pega a vez.
    assert.equal((await presenca.baterPresenca(conta(userId, celular), { ...visivel, visivel: false }, "valendo")).estado, "ocupada");

    await presenca.liberarLease(conta(userId, pc));
    assert.equal((await presenca.baterPresenca(conta(userId, celular), visivel, "valendo")).estado, "ok");
    assert.equal((await presenca.conferirPresenca(conta(userId, pc), "valendo")).estado, "ocupada");
    assert.equal((await eventos(userId, "mesa_troca_de_aparelho")).length, 1);
    const negacoes = await eventos(userId, "mesa_ocupada_negada");
    assert.ok(negacoes.length >= 1);
    assert.equal(negacoes[0].deviceId, celular);
});

test("presença (banco): tela parada 20 min bloqueia; F5 não desbloqueia; senha sim", { skip }, async () => {
    const { presenca, getDb, schema } = await modulos();
    presenca.limparMemoriaDaPresenca();
    const userId = await criarConta();
    const pc = randomUUID();
    const celular = randomUUID();
    assert.equal((await presenca.baterPresenca(conta(userId, pc), visivel, "valendo")).estado, "ok");

    // Ninguém mexe há 20 min; a batida diz o mesmo.
    await getDb().update(schema.viewPresence)
        .set({ lastHumanAt: new Date(Date.now() - 20 * 60_000) })
        .where(eq(schema.viewPresence.userId, userId));
    const parado = await presenca.baterPresenca(conta(userId, pc), { visivel: true, paradoSeg: 1_200, humanoAgora: false }, "valendo");
    assert.equal(parado.estado, "bloqueada");
    assert.equal((await presenca.conferirPresenca(conta(userId, pc), "valendo")).estado, "bloqueada");
    // A vez ficou livre na hora: o dono abre no celular sem esperar.
    assert.equal((await presenca.baterPresenca(conta(userId, celular), visivel, "valendo")).estado, "ok");
    // Recarregar a página (abertura = interação) não desbloqueia.
    assert.equal((await presenca.baterPresenca(conta(userId, pc), { visivel: true, paradoSeg: 0, humanoAgora: true }, "valendo")).estado, "bloqueada");
    assert.equal((await eventos(userId, "mesa_bloqueada_ociosa")).length, 1);

    await presenca.desbloquearAparelho(conta(userId, pc));
    assert.equal((await eventos(userId, "mesa_desbloqueada")).length, 1);
    await presenca.liberarLease(conta(userId, celular));
    assert.equal((await presenca.baterPresenca(conta(userId, pc), visivel, "valendo")).estado, "ok");
});

test("presença (banco): Mesa esquecida aberta de ontem pede senha ao ser reaberta", { skip }, async () => {
    const { presenca, getDb, schema } = await modulos();
    presenca.limparMemoriaDaPresenca();
    const userId = await criarConta();
    const pcCentral = randomUUID();
    assert.equal((await presenca.baterPresenca(conta(userId, pcCentral), visivel, "valendo")).estado, "ok");
    await presenca.liberarLease(conta(userId, pcCentral));
    await getDb().update(schema.viewPresence)
        .set({ lastHumanAt: new Date(Date.now() - 12 * 3_600_000) })
        .where(eq(schema.viewPresence.userId, userId));
    const reaberta = await presenca.baterPresenca(conta(userId, pcCentral), { visivel: true, paradoSeg: 0, humanoAgora: true }, "valendo");
    assert.equal(reaberta.estado, "bloqueada");
});

test("presença (banco): em sombra nada bloqueia, mas o que teria acontecido é registrado", { skip }, async () => {
    const { presenca, getDb, schema } = await modulos();
    presenca.limparMemoriaDaPresenca();
    const userId = await criarConta();
    const pc = randomUUID();
    const celular = randomUUID();
    assert.equal((await presenca.baterPresenca(conta(userId, pc), visivel, "sombra")).estado, "ok");
    const outro = await presenca.baterPresenca(conta(userId, celular), visivel, "sombra");
    assert.equal(outro.estado, "ok");
    assert.equal(outro.seria, "ocupada");
    assert.equal((await presenca.conferirPresenca(conta(userId, celular), "sombra")).estado, "ok");

    await getDb().update(schema.viewPresence)
        .set({ lastHumanAt: new Date(Date.now() - 20 * 60_000) })
        .where(and(eq(schema.viewPresence.userId, userId), eq(schema.viewPresence.deviceId, pc)));
    const parado = await presenca.baterPresenca(conta(userId, pc), { visivel: true, paradoSeg: 1_200, humanoAgora: false }, "sombra");
    assert.equal(parado.estado, "ok");
    assert.equal((await eventos(userId, "mesa_ocupada_negada_sombra")).length, 1);
    assert.equal((await eventos(userId, "mesa_bloqueada_ociosa_sombra")).length, 1);
    const [linha] = await getDb().select().from(schema.viewPresence)
        .where(and(eq(schema.viewPresence.userId, userId), eq(schema.viewPresence.deviceId, pc)));
    assert.equal(linha.lockedAt, null, "sombra nunca grava bloqueio");
});
