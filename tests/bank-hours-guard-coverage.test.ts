import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * O banco de horas tem um teto (applyAnomalyGuard) e ele não é opcional.
 *
 * `calculateBankHours` é a matemática crua; `applyAnomalyGuard` é quem decide o
 * que daquilo vira crédito — zera atraso improvável e, acima de 6h de sobra,
 * troca o crédito por plantão a assinar na folha. Quem chamava a crua exibia
 * números que o servidor nunca gravou: o modal de saída oferecia ao chefe
 * "confirmar 23h30 de banco de horas" a quem tinha emendado o turno seguinte
 * (caso Felipe Carneiro), o histórico do turno anterior repetia o mesmo saldo
 * fantasma e os scripts de reparo acusavam divergência eterna nessas linhas.
 *
 * Regra: fora do próprio calculator e dos testes, a matemática crua só pode ser
 * chamada dentro de um applyAnomalyGuard(...) na mesma expressão. Preview e
 * gravação mostram o mesmo número ou não mostram nada.
 */

const root = process.cwd();

const ALLOWED_RAW_CALLERS = new Set([
    "modules/bank-hours/calculator.ts",
    // Único caminho de GRAVAÇÃO: guarda a crua em `rawCalculation` porque a
    // régua de saída antecipada precisa do atraso bruto, e aplica
    // applyAnomalyGuard algumas linhas abaixo, na atribuição de `calculation`.
    "modules/bank-hours/service.ts",
]);

function collectTs(dir: string, out: string[] = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            collectTs(full, out);
        } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
            out.push(full);
        }
    }
    return out;
}

test("nenhuma tela, service ou script usa calculateBankHours sem a guarda", () => {
    const sources = [
        ...collectTs(join(root, "modules")),
        ...collectTs(join(root, "services")),
        ...collectTs(join(root, "components")),
        ...collectTs(join(root, "app")),
        ...collectTs(join(root, "scripts")),
        ...collectTs(join(root, "lib")),
    ];

    const offenders: string[] = [];
    for (const file of sources) {
        const relative = file.slice(root.length + 1);
        if (ALLOWED_RAW_CALLERS.has(relative)) continue;

        const lines = readFileSync(file, "utf8").split("\n");
        lines.forEach((line, index) => {
            // Só a chamada; `calculateGuardedBankHours(` não casa por causa do
            // limite de palavra à esquerda.
            if (!/\bcalculateBankHours\(/.test(line)) return;
            if (/applyAnomalyGuard\(\s*calculateBankHours\(/.test(line)) return;
            offenders.push(`${relative}:${index + 1}`);
        });
    }

    assert.deepEqual(
        offenders,
        [],
        `use calculateGuardedBankHours (ou applyAnomalyGuard) em: ${offenders.join(", ")}`,
    );
});
