/**
 * Os documentos de docs/saldo-contrato/ apontam para linhas exatas do código, e
 * essas âncoras envelhecem em silêncio: basta alguém inserir um comentário acima
 * para o link passar a apontar para outra coisa. Aconteceu em 2026-08-04, quando
 * os próprios comentários "leia o dossiê" deslocaram as seis referências.
 *
 * Este teste amarra cada âncora ao SÍMBOLO que ela deveria estar mostrando. Se o
 * código andar, ele falha e diz para onde a linha foi.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

/** Âncora esperada: arquivo, linha, e um trecho que precisa estar nela. */
const ANCORAS: { arquivo: string; linha: number; contem: string }[] = [
    { arquivo: "scripts/backfill-saldo-contrato.ts", linha: 91, contem: "REFERENCE_CEILINGS" },
    { arquivo: "scripts/backfill-saldo-contrato.ts", linha: 321, contem: 'category === "psiquiatria"' },
    { arquivo: "scripts/backfill-saldo-contrato.ts", linha: 384, contem: "firstLegible" },
    { arquivo: "scripts/backfill-saldo-contrato.ts", linha: 410, contem: "sawReset" },
    { arquivo: "services/contract-balance.service.ts", linha: 416, contem: "awaitingOpeningBalance" },
    { arquivo: "modules/telegram/contract-balance-alerts.ts", linha: 127, contem: "awaitingOpeningBalance" },
];

test("cada âncora citada nos docs mostra mesmo o símbolo que promete", () => {
    for (const ancora of ANCORAS) {
        const linhas = readFileSync(ancora.arquivo, "utf8").split("\n");
        const conteudo = linhas[ancora.linha - 1] ?? "";
        assert.ok(
            conteudo.includes(ancora.contem),
            `${ancora.arquivo}#L${ancora.linha} deveria conter "${ancora.contem}",`
            + ` mas tem: ${conteudo.trim() || "(linha vazia)"}`
            + ` — procure a linha nova e atualize os docs de docs/saldo-contrato/`,
        );
    }
});

test("os docs não citam nenhuma âncora fora da lista acima", () => {
    // Se alguém adicionar um link novo, ele entra na lista e passa a ser vigiado.
    const conhecidas = new Set(ANCORAS.map((a) => `${a.arquivo.split("/").pop()}#L${a.linha}`));
    const dir = "docs/saldo-contrato";
    const citadas = new Set<string>();
    for (const nome of readdirSync(dir)) {
        if (!nome.endsWith(".md") && !nome.endsWith(".json")) continue;
        const texto = readFileSync(`${dir}/${nome}`, "utf8");
        for (const achado of texto.matchAll(/([a-z0-9-]+\.(?:service\.)?ts)#L(\d+)/g)) {
            citadas.add(`${achado[1]}#L${achado[2]}`);
        }
    }
    // 00-levantamento.md é um retrato histórico do código pré-0038: as âncoras
    // dele descrevem um estado que não existe mais e não devem ser "consertadas".
    const historicas = new Set(
        [...(readFileSync(`${dir}/00-levantamento.md`, "utf8"))
            .matchAll(/([a-z0-9-]+\.(?:service\.)?ts)#L(\d+)/g)]
            .map((m) => `${m[1]}#L${m[2]}`),
    );

    const orfas = [...citadas].filter((c) => !conhecidas.has(c) && !historicas.has(c));
    assert.deepEqual(orfas, [], `âncoras novas não vigiadas — some-as a ANCORAS neste teste: ${orfas.join(", ")}`);
});
