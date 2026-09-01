import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { EXTRA_COM_ACERTO_ERROR } from "@/services/admin-extra-shifts.service";

/**
 * Apagar uma linha de `admin_extra_shifts` pode custar 12h do saldo de alguém.
 *
 * A FK `bank_hours_settlements.admin_extra_shift_id` é ON DELETE SET NULL: se o
 * plantão morre e o acerto fica, o médico perde o plantão pago E continua com o
 * débito de 12h. Por isso só existem três deletadores, cada um com o seu motivo:
 *
 *  - removeAdminExtraShift  — recusa o extra que tem acerto casado (estorno é
 *    em /admin/bank-hours, com justificativa);
 *  - deleteChiefExtraShift  — só alcança kind chief/chief_half, que nunca têm
 *    acerto de banco de horas;
 *  - deleteSelfDeclaredExtra — apaga o PAR (acerto + plantão) na mesma transação.
 *
 * Um quarto deletador entra aqui e este teste quebra: é o ponto de parar e
 * pensar, não de acrescentar o arquivo à lista sem ler o parágrafo acima.
 */

const root = process.cwd();

const DELETADORES_AUTORIZADOS = new Set([
    "services/admin-extra-shifts.service.ts",
    "services/chief-extra-shifts.service.ts",
    "services/bank-hours-settlements.service.ts",
]);

function collectTs(dir: string, out: string[] = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) collectTs(full, out);
        else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(full);
    }
    return out;
}

test("removeAdminExtraShift recusa o extra que tem acerto de banco de horas", () => {
    const source = readFileSync(join(root, "services/admin-extra-shifts.service.ts"), "utf8");
    const corpo = source.slice(source.indexOf("export async function removeAdminExtraShift"));

    // A checagem precisa vir ANTES do delete, e na mesma transação.
    const consulta = corpo.indexOf("bankHoursSettlements.adminExtraShiftId");
    const recusa = corpo.indexOf("throw new Error(EXTRA_COM_ACERTO_ERROR)");
    const remocao = corpo.indexOf(".delete(adminExtraShifts)");
    assert.ok(consulta > -1, "sumiu a consulta ao acerto casado");
    assert.ok(recusa > consulta, "sumiu a recusa depois da consulta");
    assert.ok(remocao > recusa, "o delete passou a rodar antes da recusa");
    assert.ok(corpo.includes("getDb().transaction"), "a checagem saiu da transação do delete");
    assert.match(EXTRA_COM_ACERTO_ERROR, /\/admin\/bank-hours/);
});

test("só os três deletadores conhecidos apagam plantão extra", () => {
    const sources = [
        ...collectTs(join(root, "services")),
        ...collectTs(join(root, "modules")),
        ...collectTs(join(root, "app")),
        ...collectTs(join(root, "lib")),
        ...collectTs(join(root, "scripts")),
    ];

    const intrusos = sources
        .map((file) => file.slice(root.length + 1))
        .filter((relative) => !DELETADORES_AUTORIZADOS.has(relative))
        .filter((relative) => {
            const source = readFileSync(join(root, relative), "utf8");
            return source.includes(".delete(adminExtraShifts)")
                || /delete\s+from\s+operations_v2\.admin_extra_shifts/i.test(source);
        });

    assert.deepEqual(intrusos, [], `apagam admin_extra_shifts sem guarda: ${intrusos.join(", ")}`);
});
