import test from "node:test";
import assert from "node:assert/strict";

import { splitTelegramMessage } from "@/modules/telegram/api";

test("mensagem curta sai inteira, sem numeração", () => {
    assert.deepEqual(splitTelegramMessage("linha 1\nlinha 2"), ["linha 1\nlinha 2"]);
});

test("mensagem longa é partida abaixo do limite do Telegram", () => {
    const linhas = Array.from({ length: 400 }, (_, i) => `Doutor ${i} — pendência de 12h`);
    const partes = splitTelegramMessage(linhas.join("\n"));

    assert.ok(partes.length > 1);
    for (const parte of partes) {
        assert.ok(parte.length <= 4096, `parte com ${parte.length} chars`);
    }
    assert.match(partes[0], /^\(1\/\d+\)\n/);
    // Nenhuma linha se perde no corte.
    const recomposto = partes.map((p) => p.replace(/^\(\d+\/\d+\)\n/, "")).join("\n");
    assert.equal(recomposto, linhas.join("\n"));
});

test("linha única gigante é cortada em vez de estourar", () => {
    const partes = splitTelegramMessage("x".repeat(9000));
    assert.ok(partes.length >= 3);
    for (const parte of partes) {
        assert.ok(parte.length <= 4096);
    }
});
