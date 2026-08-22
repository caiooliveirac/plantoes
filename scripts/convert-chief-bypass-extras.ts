/**
 * Conserta o passivo do gate de chefia.
 *
 * Enquanto quem já deu plantão na 2031 (e a allowlist nominal) declarava turno
 * de chefia pelo autoatendimento do BANCO DE HORAS, cada registro criava um
 * settlement de -12h: o plantão era pago, mas o saldo do chefe era debitado sem
 * que ninguém tivesse pedido isso. Esses lançamentos carregam, em notes, o
 * marcador "sem gate de saldo".
 *
 * A conversão: apaga o settlement (o saldo volta sozinho, porque saldo é a soma
 * do razão) e transforma o plantão verde em plantão de CHEFIA (kind 'chief').
 * O pagamento não muda — só a relação com o banco de horas, que deixa de existir.
 *
 * Uso:
 *   tsx scripts/convert-chief-bypass-extras.ts            # só lista (dry-run)
 *   tsx scripts/convert-chief-bypass-extras.ts --apply    # grava
 */
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { CHIEF_EXTRA_SHIFT_KIND, CHIEF_EXTRA_SHIFT_LABEL } from "@/modules/reporting/payable-shifts";

const apply = process.argv.includes("--apply");

interface Row {
    settlementId: string;
    adminExtraShiftId: string | null;
    doctorName: string;
    monthKey: string;
    operationalDate: string | null;
    shiftLabel: string | null;
    deltaMinutes: number;
    notes: string;
}

async function main() {
    const db = getDb();
    const rows = (await db.execute(sql`
        select s.id as "settlementId",
               s.admin_extra_shift_id as "adminExtraShiftId",
               d.full_name as "doctorName",
               s.month_key as "monthKey",
               e.operational_date as "operationalDate",
               e.shift_label as "shiftLabel",
               s.delta_minutes as "deltaMinutes",
               s.notes as "notes"
        from operations_v2.bank_hours_settlements s
        join operations_v2.doctors d on d.id = s.doctor_id
        left join operations_v2.admin_extra_shifts e on e.id = s.admin_extra_shift_id
        where s.notes like '%sem gate de saldo%'
        order by d.full_name, e.operational_date
    `)) as unknown as Row[];

    if (rows.length === 0) {
        console.log("Nenhum lançamento com bypass de chefia encontrado.");
        return;
    }

    for (const row of rows) {
        console.log(
            `${row.doctorName} · ${row.operationalDate ?? "sem data"} ${row.shiftLabel ?? ""}`
            + ` · saldo devolvido: ${-row.deltaMinutes} min · ${row.notes}`,
        );
    }
    console.log(`\n${rows.length} lançamento(s).`);

    if (!apply) {
        console.log("Dry-run. Rode com --apply para converter.");
        return;
    }

    for (const row of rows) {
        await db.transaction(async (tx) => {
            if (row.adminExtraShiftId) {
                await tx.execute(sql`
                    update operations_v2.admin_extra_shifts
                    set kind = ${CHIEF_EXTRA_SHIFT_KIND},
                        label = ${CHIEF_EXTRA_SHIFT_LABEL},
                        unit = 1
                    where id = ${row.adminExtraShiftId}
                `);
            }
            await tx.execute(sql`
                delete from operations_v2.bank_hours_settlements where id = ${row.settlementId}
            `);
        });
    }
    console.log(`Convertidos ${rows.length} lançamento(s) em plantão de chefia.`);
}

main()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => closeDb());
