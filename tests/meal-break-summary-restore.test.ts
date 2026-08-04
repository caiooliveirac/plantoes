import assert from "node:assert/strict";
import test from "node:test";
import { parseMealBreakDaySummary } from "@/modules/telegram/meal-breaks";

// Balão real publicado no grupo (divisão de 04/08/2026 perdida no incidente da
// rebobina). É a serialização que o script de restauração lê de volta.
const SUMMARY = `✅ Divisão fechada!

🍽️ ALMOÇO
11:30
• Ana Alves (RECIP)
• José Marini
• Gabriel Jesus (RMT)
12:30
• Carolina Restrepo (COI)
• Briang Seguir (MRV)
• Uenderson Barbosa (RMT)
13:30
• Mariana Bahia (COI)
• Ronaldo Acacio (MRV)
• Angelo Sposito (IES)

😴 DESCANSO
14:30
• Mariana Bahia (COI)
• Angelo Sposito (IES)
15:30
• José Marini
• Uenderson Barbosa (RMT)
16:30
• Gabriel Jesus (RMT)
• Carolina Restrepo (COI)
18:00
• Ronaldo Acacio (MRV)
• Ana Alves (RECIP)
• Briang Seguir (MRV)

👑 CHEFIA
• Almoço a critério
• Descanso a critério

ℹ️ 14:30: descanso automático de quem almoçou 13:30 · 18:00: fixo de RECIP, MRV e PSIQ.

Se precisar refazer: /almoco reiniciar`;

test("lê o balão do grupo de volta: 9 almoços e 9 descansos, nos horários certos", () => {
    const parsed = parseMealBreakDaySummary(SUMMARY);
    assert.ok(parsed);

    assert.equal(parsed.lunch.length, 9);
    assert.equal(parsed.rest.length, 9);

    const lunchBySlot = (slot: string) => parsed.lunch.filter((entry) => entry.slot === slot).map((entry) => entry.name);
    assert.deepEqual(lunchBySlot("11:30"), ["Ana Alves", "José Marini", "Gabriel Jesus"]);
    assert.deepEqual(lunchBySlot("12:30"), ["Carolina Restrepo", "Briang Seguir", "Uenderson Barbosa"]);
    assert.deepEqual(lunchBySlot("13:30"), ["Mariana Bahia", "Ronaldo Acacio", "Angelo Sposito"]);

    const restBySlot = (slot: string) => parsed.rest.filter((entry) => entry.slot === slot).map((entry) => entry.name);
    assert.deepEqual(restBySlot("14:30"), ["Mariana Bahia", "Angelo Sposito"]);
    assert.deepEqual(restBySlot("15:30"), ["José Marini", "Uenderson Barbosa"]);
    assert.deepEqual(restBySlot("16:30"), ["Gabriel Jesus", "Carolina Restrepo"]);
    assert.deepEqual(restBySlot("18:00"), ["Ronaldo Acacio", "Ana Alves", "Briang Seguir"]);
});

test("as etiquetas viram RECIP/MRV — é delas que sai a fase de MRV no sync", () => {
    const parsed = parseMealBreakDaySummary(SUMMARY);
    assert.ok(parsed);

    const recip = parsed.lunch.filter((entry) => entry.tags.includes("RECIP")).map((entry) => entry.name);
    const mrv = parsed.lunch.filter((entry) => entry.tags.includes("MRV")).map((entry) => entry.name);
    assert.deepEqual(recip, ["Ana Alves"]);
    assert.deepEqual(mrv, ["Briang Seguir", "Ronaldo Acacio"]);
    // Quem não tem etiqueta nenhuma continua entrando na divisão.
    assert.deepEqual(parsed.lunch.find((entry) => entry.name === "José Marini")?.tags, []);
});

test("rodapé (chefia, legenda, dica de reiniciar) não vira médico", () => {
    const parsed = parseMealBreakDaySummary(SUMMARY);
    assert.ok(parsed);

    const allNames = [...parsed.lunch, ...parsed.rest].map((entry) => entry.name);
    assert.equal(allNames.some((name) => name.toLowerCase().includes("critério")), false);
    assert.equal(allNames.some((name) => name.includes("/almoco")), false);
    assert.equal(parsed.excludedBlocks.length, 0);
});

test("bloco de exclusão é sinalizado em vez de virar horário", () => {
    const parsed = parseMealBreakDaySummary(`🍽️ ALMOÇO
11:30
• Ana Alves (RECIP)
🚫 FORA DO ALMOÇO
• Pedro Fora (PSIQ)

😴 DESCANSO
18:00
• Ana Alves (RECIP)`);

    assert.ok(parsed);
    assert.equal(parsed.lunch.length, 1);
    assert.equal(parsed.rest.length, 1);
    assert.equal(parsed.excludedBlocks.length, 1);
});

test("texto sem divisão nenhuma devolve null (não restaura pela metade)", () => {
    assert.equal(parseMealBreakDaySummary("bom dia, alguém viu a escala?"), null);
    assert.equal(parseMealBreakDaySummary(""), null);
});

test("horário fora da grade do almoço aborta o parse inteiro", () => {
    assert.equal(
        parseMealBreakDaySummary(`🍽️ ALMOÇO
10:00
• Ana Alves (RECIP)`),
        null,
    );
});

test("slot vazio do resumo (• --) não vira médico", () => {
    const parsed = parseMealBreakDaySummary(`🍽️ ALMOÇO
11:30
• --
12:30
• Ana Alves (RECIP)`);

    assert.ok(parsed);
    assert.deepEqual(parsed.lunch.map((entry) => `${entry.slot}:${entry.name}`), ["12:30:Ana Alves"]);
});

// Variante que o Telegram entrega no copiar/colar: sem linhas em branco, sem o
// cabeçalho "✅ Divisão fechada!" e terminando na legenda — que fala em
// "descanso automático" e não pode ser lida como cabeçalho de seção.
const SUMMARY_COLADO = `🍽️ ALMOÇO
11:30
• Ana Alves (RECIP)
• José Marini
• Gabriel Jesus (RMT)
12:30
• Carolina Restrepo (COI)
• Briang Seguir (MRV)
• Uenderson Barbosa (RMT)
13:30
• Mariana Bahia (COI)
• Ronaldo Acacio (MRV)
• Angelo Sposito (IES)
😴 DESCANSO
14:30
• Mariana Bahia (COI)
• Angelo Sposito (IES)
15:30
• José Marini
• Uenderson Barbosa (RMT)
16:30
• Gabriel Jesus (RMT)
• Carolina Restrepo (COI)
18:00
• Ronaldo Acacio (MRV)
• Ana Alves (RECIP)
• Briang Seguir (MRV)
👑 CHEFIA
• Almoço a critério
• Descanso a critério
ℹ️ 14:30: descanso automático de quem almoçou 13:30 · 18:00: fixo de RECIP, MRV e PSIQ`;

test("balão colado do Telegram (sem linhas em branco) lê igual ao original", () => {
    const parsed = parseMealBreakDaySummary(SUMMARY_COLADO);
    assert.ok(parsed);

    assert.equal(parsed.lunch.length, 9);
    assert.equal(parsed.rest.length, 9);
    assert.equal(new Set([...parsed.lunch, ...parsed.rest].map((entry) => entry.name)).size, 9);
    // "• Almoço a critério" / "• Descanso a critério" da chefia não viram médico.
    assert.equal([...parsed.lunch, ...parsed.rest].some((entry) => entry.name.includes("critério")), false);
});

test("a legenda final não reabre a seção de descanso", () => {
    // Linha solta depois da legenda (mudança futura de texto) não pode entrar
    // na divisão: a legenda encerra a seção.
    const parsed = parseMealBreakDaySummary(`${SUMMARY_COLADO}\n18:00\n• Fantasma Intruso (MRV)`);
    assert.ok(parsed);
    assert.equal(parsed.rest.length, 9);
    assert.equal([...parsed.rest].some((entry) => entry.name === "Fantasma Intruso"), false);
});
