import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// O ChiefExitGate chegou a produção usando .board-modal / .board-modal-title /
// .board-modal-button, que não existiam no globals.css: o painel do Radix caía
// sem estilo no fim do documento e a tela do admin ficava só com o backdrop.
// Classe de modal sem regra CSS é sempre esse bug — este teste é o alarme.

const root = process.cwd();
const css = readFileSync(join(root, "app/globals.css"), "utf8");

function collectTsx(dir: string, out: string[] = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) collectTsx(full, out);
        else if (entry.name.endsWith(".tsx")) out.push(full);
    }
    return out;
}

test("toda classe board-modal* usada no JSX tem regra no globals.css", () => {
    const used = new Map<string, string>();
    for (const file of [...collectTsx(join(root, "components")), ...collectTsx(join(root, "app"))]) {
        const source = readFileSync(file, "utf8");
        for (const match of source.matchAll(/className=\{?["`]([^"`]+)["`]/g)) {
            for (const token of match[1].split(/\s+/)) {
                if (token.startsWith("board-modal")) used.set(token, file.slice(root.length + 1));
            }
        }
    }

    assert.ok(used.size > 5, "esperava encontrar classes board-modal no JSX");

    const missing = [...used]
        .filter(([token]) => !new RegExp(`^\\.${token}[\\s,{:.]`, "m").test(css))
        .map(([token, file]) => `${token} (${file})`);

    assert.deepEqual(missing, [], `classes de modal sem CSS: ${missing.join(", ")}`);
});
