// Fecha a auditoria PJ x Estatutário de julho/2026 para PRODUÇÃO:
//   1) Funde "Oswaldo Alves Bastos Neves" + "Oswaldo Alves Bastos Neto" num só
//      registro, nome final "Oswaldo Alves Bastos Neto" (grafia confirmada
//      pelo usuário), com employmentType=estatutario.
//   2) Funde "Ana Beatriz Bonfim Nunes" + "Ana Beatriz Nunes Bonfim" num só
//      registro, nome final "Ana Beatriz Nunes Bomfim" (grafia da planilha PJ).
//   2b) Funde "Kethertnne Cabral Ferreira de Oliveira" + "Ketherynne Cabral
//      Ferrreira de Oliveira" num só, nome final "Ketherynne Cabral Ferreira de
//      Oliveira" (grafia da planilha PJ — as duas do banco têm erro de digitação).
//      Acrescentado em 2026-07-31, durante o backfill do saldo contratual: os
//      dados desta dupla estão PARTIDOS — um registro tem os plantões e o
//      atestado, o outro tem a conta de login. Fundir é o que evita o saldo
//      entrar num registro e o consumo no outro.
//   3) Apaga os médicos de demonstração ("Dr./Dra. <papel>", @plantoes.local,
//      sem role) — EXCETO "Admin Sistema", que é a conta real de admin.
//
// Diferente do script que rodou em dev (onde por coincidência um dos dois
// registros de cada dupla não tinha nenhum dado ligado), aqui NÃO assumimos
// que um lado está vazio: banco de horas, contrato/faturamento, nota fiscal e
// atestados podem existir dos dois lados em produção. Por isso todo merge
// passa por mergeDoctorRecords(), que:
//   - move (UPDATE doctor_id) tudo que não tem risco de conflito de unicidade
//     (plantões, lançamentos de banco de horas, trocas, etc.);
//   - para tabelas com UNIQUE por médico (contrato, acesso de pagamento,
//     nota/processo do mês, atestado do mês, preferências, plantão fixo) só
//     move se o registro sobrevivente NÃO tiver uma linha equivalente; se os
//     dois lados tiverem dado no mesmo lugar, a fusão inteira é ABORTADA
//     (nada é gravado) e o conflito é reportado para decisão manual — nunca
//     escolhe um lado e descarta o outro silenciosamente.
//   - só apaga o registro perdedor depois que TODAS as tabelas foram movidas
//     sem conflito, dentro de uma única transação.
//
// Uso (contra o DATABASE_URL do ambiente onde rodar):
//   tsx scripts/merge-duplicate-doctors-2026-07.ts            # preview / detecta conflitos
//   tsx scripts/merge-duplicate-doctors-2026-07.ts --apply    # executa (só se não houver conflito)
//   tsx scripts/merge-duplicate-doctors-2026-07.ts --apply --only=Ana Beatriz,Ketherynne
//
// --only roda apenas as duplas listadas (pelo label) e PULA a limpeza dos
// médicos de demonstração. Serve para não deixar uma dupla com conflito
// pendente travar as outras: como tudo roda numa transação só, sem o filtro um
// conflito no Oswaldo impede o merge da Ana Beatriz e da Ketherynne.

import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { doctors, users } from "@/db/schema";
import { normalizeDoctorName } from "@/modules/doctors/importer";

function hasFlag(flag: string) {
    return process.argv.includes(flag);
}

/** --only=Label,Outro -> ["Label", "Outro"]; vazio = roda tudo. */
function onlyLabels(): string[] {
    const raw = process.argv.find((arg) => arg.startsWith("--only="));
    if (!raw) return [];
    return raw.slice("--only=".length).split(",").map((label) => label.trim()).filter(Boolean);
}

// Tabelas sem risco de conflito de unicidade por médico: sempre seguro mover.
const FREE_MOVE_TABLES: Array<{ table: string; col: string }> = [
    { table: "chief_access_requests", col: "doctor_id" },
    { table: "regulation_occupancies", col: "doctor_id" },
    { table: "intervention_occupancies", col: "doctor_id" },
    { table: "admin_extra_shifts", col: "doctor_id" },
    { table: "bank_hours_settlements", col: "doctor_id" },
    { table: "bank_hours_entries", col: "doctor_id" },
    { table: "bank_hours_balance_overrides", col: "doctor_id" },
    { table: "payment_attestation_slot_entries", col: "doctor_id" },
    { table: "shift_offer_bids", col: "doctor_id" },
];
const FREE_MOVE_DUAL_COLUMN_TABLES: Array<{ table: string; cols: string[] }> = [
    { table: "shift_swaps", cols: ["from_doctor_id", "to_doctor_id"] },
];
const FREE_MOVE_SINGLE_OTHER_COL_TABLES: Array<{ table: string; col: string }> = [
    { table: "shift_offers", col: "offered_by_doctor_id" },
];

// Uma linha só por médico no total (não por mês/base/etc): conflito se os dois lados tiverem uma.
const ONE_PER_DOCTOR_TABLES: Array<{ table: string; col: string; label: string }> = [
    { table: "doctor_contracts", col: "doctor_id", label: "contrato/teto de faturamento" },
    { table: "doctor_payment_access", col: "doctor_id", label: "acesso de pagamento (codinome Telegram)" },
    { table: "users", col: "doctor_id", label: "conta de login" },
];

// Uma linha por médico + chave secundária: conflito só se os dois lados tiverem a MESMA chave.
const KEYED_TABLES: Array<{ table: string; col: string; keyCols: string[]; label: string }> = [
    { table: "payment_closing_meta", col: "doctor_id", keyCols: ["month_key"], label: "nota fiscal / processo de pagamento do mês" },
    { table: "payment_closing_attestations", col: "doctor_id", keyCols: ["month_key"], label: "atestado de fechamento do mês" },
    { table: "doctor_base_preferences", col: "doctor_id", keyCols: ["base_id"], label: "preferência de base" },
    { table: "doctor_weekday_preferences", col: "doctor_id", keyCols: ["weekday"], label: "preferência de dia da semana" },
    { table: "doctor_fixed_shifts", col: "doctor_id", keyCols: ["weekday", "shift_label"], label: "plantão fixo" },
    { table: "scheduled_shifts", col: "doctor_id", keyCols: ["operational_date", "shift_label"], label: "plantão agendado" },
];

interface Conflict {
    table: string;
    label: string;
    detail: string;
}

/**
 * A lista de tabelas deste script é estática, mas o schema anda. A produção já
 * tinha a migration 0037 aplicada — que derruba scheduled_shifts, shift_swaps e
 * companhia — enquanto o código que remove essas tabelas ainda não estava na
 * main, e o merge quebrava inteiro em "relation does not exist". Tabela que não
 * existe mais não tem linha para mover: pula, avisando.
 */
const tabelasConhecidas = new Map<string, boolean>();
async function tableExists(db: ReturnType<typeof getDb>, table: string) {
    const cache = tabelasConhecidas.get(table);
    if (cache !== undefined) return cache;
    const result = await db.execute(sql.raw(`select to_regclass('operations_v2.${table}') is not null as existe`));
    const existe = Boolean((result as unknown as { existe: boolean }[])[0]?.existe);
    tabelasConhecidas.set(table, existe);
    if (!existe) console.log(`  (tabela ${table} não existe mais neste banco — ignorada)`);
    return existe;
}

async function countRows(db: ReturnType<typeof getDb>, table: string, col: string, id: string) {
    const result = await db.execute(sql.raw(`select count(*)::int as n from operations_v2.${table} where ${col} = '${id}'`));
    return (result as unknown as { n: number }[])[0]?.n ?? 0;
}

/**
 * Funde dropId em keepId. Só grava se não houver NENHUM conflito de unicidade
 * — caso contrário retorna a lista de conflitos e não toca no banco.
 */
export async function mergeDoctorRecords(params: {
    tx: any;
    keepId: string;
    dropId: string;
    finalFullName: string;
    /**
     * Tabelas de ONE_PER_DOCTOR onde a decisão manual JÁ foi tomada: em vez de
     * abortar, apaga a linha do registro perdedor e fica com a do sobrevivente.
     * Só entra aqui o que o usuário decidiu nominalmente — o default continua
     * sendo abortar. Ver o comentário de cada chamada.
     */
    resolveByKeeping?: string[];
}): Promise<{ conflicts: Conflict[] }> {
    const { tx, keepId, dropId, finalFullName, resolveByKeeping = [] } = params;
    const conflicts: Conflict[] = [];
    const resolved: string[] = [];

    for (const { table, col, label } of ONE_PER_DOCTOR_TABLES) {
        if (!await tableExists(tx, table)) continue;
        const keepCount = await countRows(tx, table, col, keepId);
        const dropCount = await countRows(tx, table, col, dropId);
        if (keepCount > 0 && dropCount > 0) {
            if (resolveByKeeping.includes(table)) {
                await tx.execute(sql.raw(`delete from operations_v2.${table} where ${col} = '${dropId}'`));
                resolved.push(`${label}: mantida a linha do registro sobrevivente, apagada a do perdedor`);
                continue;
            }
            conflicts.push({ table, label, detail: `os dois registros têm ${label} — precisa decisão manual sobre qual manter` });
        }
    }
    for (const entry of resolved) {
        console.log(`  resolvido por decisão prévia -> ${entry}`);
    }

    for (const { table, col, keyCols, label } of KEYED_TABLES) {
        if (!await tableExists(tx, table)) continue;
        const keyExpr = keyCols.join(", ");
        const result = await tx.execute(sql.raw(`
            select k.${keyCols[0]} ${keyCols.slice(1).map((c) => `, k.${c}`).join("")}
            from operations_v2.${table} k
            where k.${col} = '${dropId}'
              and exists (
                select 1 from operations_v2.${table} kk
                where kk.${col} = '${keepId}'
                  and ${keyCols.map((c) => `kk.${c} = k.${c}`).join(" and ")}
              )
        `));
        const rows = result as unknown as Record<string, unknown>[];
        if (rows.length > 0) {
            conflicts.push({
                table,
                label,
                detail: `${rows.length} linha(s) com a mesma chave (${keyExpr}) nos dois registros — precisa decisão manual`,
            });
        }
    }

    if (conflicts.length > 0) {
        return { conflicts };
    }

    for (const { table, col } of FREE_MOVE_TABLES) {
        if (!await tableExists(tx, table)) continue;
        await tx.execute(sql.raw(`update operations_v2.${table} set ${col} = '${keepId}' where ${col} = '${dropId}'`));
    }
    for (const { table, cols } of FREE_MOVE_DUAL_COLUMN_TABLES) {
        if (!await tableExists(tx, table)) continue;
        for (const col of cols) {
            await tx.execute(sql.raw(`update operations_v2.${table} set ${col} = '${keepId}' where ${col} = '${dropId}'`));
        }
    }
    for (const { table, col } of FREE_MOVE_SINGLE_OTHER_COL_TABLES) {
        if (!await tableExists(tx, table)) continue;
        await tx.execute(sql.raw(`update operations_v2.${table} set ${col} = '${keepId}' where ${col} = '${dropId}'`));
    }
    for (const { table, col } of ONE_PER_DOCTOR_TABLES) {
        if (!await tableExists(tx, table)) continue;
        // Só um dos dois lados tem linha (senão teria conflitado acima) — move se for o drop.
        await tx.execute(sql.raw(`update operations_v2.${table} set ${col} = '${keepId}' where ${col} = '${dropId}'`));
    }
    for (const { table, col, keyCols } of KEYED_TABLES) {
        if (!await tableExists(tx, table)) continue;
        await tx.execute(sql.raw(`update operations_v2.${table} set ${col} = '${keepId}' where ${col} = '${dropId}'`));
    }

    await tx.update(doctors)
        .set({ fullName: finalFullName, normalizedName: normalizeDoctorName(finalFullName), updatedAt: new Date() })
        .where(eq(doctors.id, keepId));
    await tx.delete(doctors).where(eq(doctors.id, dropId));

    return { conflicts: [] };
}

async function resolvePair(db: ReturnType<typeof getDb>, nameA: string, nameB: string) {
    const [a] = await db.select().from(doctors).where(eq(doctors.fullName, nameA));
    const [b] = await db.select().from(doctors).where(eq(doctors.fullName, nameB));
    return { a, b };
}

const DEMO_NAME_PATTERN = /^(Dr\.|Dra\.)/;
const ADMIN_ACCOUNT_NAME = "Admin Sistema";

async function main() {
    const apply = hasFlag("--apply");
    const db = getDb();

    const { a: oswaldoNeves, b: oswaldoNeto } = await resolvePair(db, "Oswaldo Alves Bastos Neves", "Oswaldo Alves Bastos Neto");
    const { a: anaBonfimNunes, b: anaNunesBonfim } = await resolvePair(db, "Ana Beatriz Bonfim Nunes", "Ana Beatriz Nunes Bonfim");
    // Mantém o registro que tem os plantões; a conta de login do outro lado é
    // movida por mergeDoctorRecords (o sobrevivente não tem login próprio).
    const { a: ketherynneComPlantoes, b: ketherynneComLogin } = await resolvePair(
        db,
        "Ketherynne Cabral Ferrreira de Oliveira",
        "Kethertnne Cabral Ferreira de Oliveira",
    );

    const selected = onlyLabels();
    const pairs = [
        oswaldoNeves && oswaldoNeto ? { keep: oswaldoNeves, drop: oswaldoNeto, finalName: "Oswaldo Alves Bastos Neto", label: "Oswaldo", resolveByKeeping: [] as string[] } : null,
        anaBonfimNunes && anaNunesBonfim ? { keep: anaNunesBonfim, drop: anaBonfimNunes, finalName: "Ana Beatriz Nunes Bomfim", label: "Ana Beatriz", resolveByKeeping: [] as string[] } : null,
        ketherynneComPlantoes && ketherynneComLogin
            ? {
                keep: ketherynneComPlantoes,
                drop: ketherynneComLogin,
                finalName: "Ketherynne Cabral Ferreira de Oliveira",
                label: "Ketherynne",
                // Os dois registros têm codinome de pagamento do Telegram, criados
                // no mesmo dia, nenhum com o codinome em claro — não há dado que
                // diga qual ela usa. Decisão do usuário em 2026-07-31: fica o do
                // registro que tem os plantões. Se ela usava o outro, o extrato
                // no bot para de responder até recadastrar o codinome.
                resolveByKeeping: ["doctor_payment_access"] as string[],
            }
            : null,
    ]
        .filter((p): p is NonNullable<typeof p> => Boolean(p))
        .filter((p) => selected.length === 0 || selected.includes(p.label));

    if (pairs.length === 0) {
        console.log("Nenhuma das duplas encontrada com esses nomes exatos neste banco — confira manualmente antes de seguir.");
        await closeDb();
        return;
    }

    const allDoctors = await db.select().from(doctors);
    // Com --only o alvo é uma dupla específica: não é hora de mexer no resto.
    const demoDoctors = selected.length > 0
        ? []
        : allDoctors.filter((d) => DEMO_NAME_PATTERN.test(d.fullName) && d.fullName !== ADMIN_ACCOUNT_NAME);

    console.log(`Duplas a fundir: ${pairs.length}`);
    for (const pair of pairs) {
        console.log(`  ${pair.label}: mantém ${pair.keep.fullName} (${pair.keep.id}), funde ${pair.drop.fullName} (${pair.drop.id}) -> nome final "${pair.finalName}"`);
    }
    console.log(`Demonstração a apagar: ${demoDoctors.length} (Admin Sistema preservado)`);

    if (!apply) {
        console.log("\nModo preview — rode com --apply para detectar conflitos e gravar (só grava se NÃO houver conflito).");
        await closeDb();
        return;
    }

    let aborted = false;
    await db.transaction(async (tx) => {
        for (const pair of pairs) {
            const { conflicts } = await mergeDoctorRecords({
                tx,
                keepId: pair.keep.id,
                dropId: pair.drop.id,
                finalFullName: pair.finalName,
                resolveByKeeping: pair.resolveByKeeping,
            });
            if (conflicts.length > 0) {
                aborted = true;
                console.log(`\nCONFLITO ao fundir ${pair.label} — NADA foi gravado para esta dupla nem para o resto do script:`);
                for (const c of conflicts) {
                    console.log(`  [${c.table}] ${c.detail}`);
                }
                throw new Error("merge_conflict_abort");
            }
            console.log(`\n${pair.label}: fundido sem conflito -> "${pair.finalName}" (${pair.keep.id})`);
        }

        for (const demoDoctor of demoDoctors) {
            await tx.delete(users).where(eq(users.doctorId, demoDoctor.id));
            await tx.delete(doctors).where(eq(doctors.id, demoDoctor.id));
        }
        console.log(`\n${demoDoctors.length} médicos de demonstração apagados.`);
    }).catch((error) => {
        if (!(error instanceof Error && error.message === "merge_conflict_abort")) {
            throw error;
        }
    });

    if (aborted) {
        console.log("\nTransação revertida — corrija os conflitos manualmente (ex.: decidir qual contrato/nota fiscal é o válido) e rode de novo.");
    } else {
        console.log("\nConcluído sem conflitos.");
    }

    await closeDb();
}

if (process.argv[1] && process.argv[1].endsWith("merge-duplicate-doctors-2026-07.ts")) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
