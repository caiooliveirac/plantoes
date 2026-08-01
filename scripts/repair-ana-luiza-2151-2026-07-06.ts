/**
 * Reparo pontual: SD de 06/07/2026 no 2151 (Ana Luiza) e na PM04 (Willy).
 *
 * O que aconteceu, pelo rastro em produção:
 *   06:56:41  "ana luiza na 2151 SD" — o bot abre a ocupação ba4542e9 no 2151,
 *             função MRV, turno SD, janela 07:00–19:15. Correto.
 *   07:29     "Willy rivera / PM 04 turno SD" — o bot abre a ocupação 648cfb27
 *             na base PM04 (intervenção), com board. Correto.
 *   11:33     Uma correção administrativa remaneja Willy de PM04 para o 2151
 *             ("ocupou subPA de interno 21513"), com conflictResolution
 *             remove_destination: a ocupação da Ana Luiza é APAGADA como
 *             deslocada do movimento. Ela não é avisada e segue trabalhando.
 *   11:34     Alguém reavisa por ela ("2151 ana luiza sd"). A mensagem cai na
 *             janela de meia jornada e o bot cria a ocupação 28b3c323 como
 *             MEIO_PLANTAO 11:30–17:00. A chefia corrige a função para MRV, mas
 *             a janela de meia jornada fica — e às 17:00 o auto-checkout do meio
 *             plantão encerra o plantão dela.
 *
 * Resultado na aba de pagamento: o 06/07 some para a Ana Luiza (o plantão dela
 * não cobre o slot SD do 2151 nem como inteiro nem como metade) e a linha do
 * 2151 SD aparece no nome do Willy, que na verdade estava na PM04.
 *
 * O reparo desfaz as duas pontas:
 *   1. Willy volta para a PM04 como titular, com a chegada, a janela e a saída
 *      que ele já tinha (07:29, 07:00–19:00, saída 19:00 confirmada). O clone do
 *      remanejamento não copia endedAt/actualEndedAt, então a saída é regravada
 *      logo depois — senão o plantão dele ficaria aberto num dia passado.
 *   2. Ana Luiza recupera o SD inteiro no 2151: chegada 06:56:41 e função MRV
 *      vêm do snapshot da ocupação apagada (ba4542e9); a janela volta sozinha
 *      para 07:00–19:15 quando a função sai da meia jornada.
 *
 * A saída dela é uma DECISÃO, não um dado: não existe aviso de saída dela nesse
 * dia. Padrão 19:00 (fim do SD), ajustável com --saida=HH:MM.
 *
 * A confirmação de saída da chefia é mantida nos dois casos (chiefConfirmed),
 * senão a mudança de horário jogaria os plantões de volta para a fila.
 *
 * Uso (LOCAL, com DATABASE_URL apontando para o alvo):
 *   npx tsx scripts/repair-ana-luiza-2151-2026-07-06.ts                # dry-run
 *   npx tsx scripts/repair-ana-luiza-2151-2026-07-06.ts --apply
 *   ... --saida=18:30                                                  # outra saída dela
 *   ... --somente-ana                                                  # não mexe no Willy
 *
 * O script se recusa a rodar se os registros não estiverem no estado descrito
 * acima: é um reparo de caso único, não uma rotina.
 */
import { eq } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { interventionOccupancies, regulationOccupancies, regulationPosts } from "@/db/schema";
import {
    correctInterventionOccupancy,
    correctRegulationOccupancy,
    removeRegulationOccupancyRecord,
} from "@/modules/operational/corrections";
import { startInterventionOccupancy } from "@/modules/intervention/service";

const ANA_OCCUPANCY_ID = "28b3c323-2434-45d7-8991-d1f58b4ff61e";
const ANA_DOCTOR_ID = "f12d1ff1-f340-400a-9414-62fae6019e71";
const ANA_POST_CODE = "2151";
/** Chegada real dela, do snapshot da ocupação apagada no remanejamento das 11:33. */
const ANA_ARRIVAL_AT = new Date("2026-07-06T09:56:41.000Z");
const ANA_DEFAULT_DEPARTURE_HHMM = "19:00";

const WILLY_OCCUPANCY_ID = "b3954c56-b621-432b-b99f-02ca8d067364";
const WILLY_DOCTOR_ID = "b8ae2a02-7e6f-4bcc-975a-fb80720e63e9";
const PM04_BASE_ID = 4;
/** Saída dele já confirmada pela chefia às 23:58 do próprio dia. */
const WILLY_DEPARTURE_AT = new Date("2026-07-06T22:00:00.000Z");

function hasFlag(flag: string) {
    return process.argv.includes(flag);
}

function getFlagValue(flag: string) {
    const prefix = `${flag}=`;
    return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function parseDeparture() {
    const raw = getFlagValue("--saida") ?? ANA_DEFAULT_DEPARTURE_HHMM;
    const match = /^(\d{2}):(\d{2})$/.exec(raw.trim());
    if (!match) {
        throw new Error(`Horario invalido para --saida: ${raw} (use HH:MM)`);
    }
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) {
        throw new Error(`Horario invalido para --saida: ${raw}`);
    }
    // Salvador/Sao Paulo = UTC-3 estavel, sem horario de verao.
    return { at: new Date(Date.UTC(2026, 6, 6, hour + 3, minute, 0)), label: raw };
}

function fmt(value: Date | null | undefined) {
    if (!value) return "—";
    return value.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" });
}

async function main() {
    const apply = hasFlag("--apply");
    const anaOnly = hasFlag("--somente-ana");
    const departure = parseDeparture();
    const db = getDb();

    const ana = await db.query.regulationOccupancies.findFirst({
        where: eq(regulationOccupancies.id, ANA_OCCUPANCY_ID),
    });
    if (!ana) {
        throw new Error(`Ocupacao ${ANA_OCCUPANCY_ID} (Ana Luiza) nao existe neste banco.`);
    }
    const anaPost = await db.query.regulationPosts.findFirst({ where: eq(regulationPosts.id, ana.postId) });

    const willy = anaOnly ? null : await db.query.regulationOccupancies.findFirst({
        where: eq(regulationOccupancies.id, WILLY_OCCUPANCY_ID),
    });
    if (!anaOnly && !willy) {
        throw new Error(`Ocupacao ${WILLY_OCCUPANCY_ID} (Willy no 2151) nao existe neste banco.`);
    }

    // Guardas: caso unico, estado conhecido. Qualquer divergencia aborta em vez
    // de escrever por cima de um registro que outra pessoa ja mexeu.
    const problems: string[] = [];
    if (ana.doctorId !== ANA_DOCTOR_ID) problems.push(`ana: medico inesperado ${ana.doctorId}`);
    if (anaPost?.code !== ANA_POST_CODE) problems.push(`ana: ramal inesperado ${anaPost?.code ?? ana.postId}`);
    if (ana.roleLabel !== "MRV") problems.push(`ana: funcao inesperada ${ana.roleLabel ?? "—"}`);
    if (ana.startedAt.getTime() === ANA_ARRIVAL_AT.getTime()) problems.push("ana: chegada ja e 06:56 — reparo provavelmente ja aplicado");
    if (willy) {
        if (willy.doctorId !== WILLY_DOCTOR_ID) problems.push(`willy: medico inesperado ${willy.doctorId}`);
        if (willy.postId !== ana.postId) problems.push("willy: nao esta no mesmo ramal da Ana (2151)");
        if (willy.boardStartedAt !== null) problems.push("willy: nao esta como sombra no 2151");
    }

    console.log(`\n1) Ana Luiza · ${ANA_POST_CODE} · 06/07/2026 — ${ANA_OCCUPANCY_ID}`);
    console.log(`   antes  chegada ${fmt(ana.startedAt)} · board ${fmt(ana.boardStartedAt)} · saida ${fmt(ana.actualEndedAt ?? ana.endedAt)}`);
    console.log(`          janela  ${fmt(ana.scheduledStartAt)} -> ${fmt(ana.scheduledEndAt)} · funcao ${ana.roleLabel ?? "—"} · turno ${ana.shiftLabel ?? "—"}`);
    console.log(`   depois chegada ${fmt(ANA_ARRIVAL_AT)} · board ${fmt(ANA_ARRIVAL_AT)} · saida ${fmt(departure.at)} (--saida=${departure.label})`);
    console.log("          janela  07:00 -> 19:15 · funcao MRV · turno SD");
    if (willy) {
        console.log(`\n2) Willy · 2151 (sombra) -> PM04 (titular) — ${WILLY_OCCUPANCY_ID}`);
        console.log(`   antes  regulacao 2151 · chegada ${fmt(willy.startedAt)} · janela ${fmt(willy.scheduledStartAt)} -> ${fmt(willy.scheduledEndAt)}`);
        console.log(`   depois intervencao PM04 · mesma chegada e janela · saida ${fmt(WILLY_DEPARTURE_AT)} (a que a chefia ja tinha confirmado)`);
    } else {
        console.log("\n2) Willy: pulado (--somente-ana)");
    }
    console.log("");

    if (problems.length > 0) {
        console.log("ABORTADO — os registros nao estao no estado esperado:");
        for (const problem of problems) console.log(`  · ${problem}`);
        console.log("");
        process.exitCode = 1;
        return;
    }

    if (!apply) {
        console.log("DRY-RUN. Nada foi alterado. Rode de novo com --apply para gravar.\n");
        return;
    }

    // Willy primeiro: libera o slot do 2151 antes de a Ana virar titular do dia
    // inteiro, para o quadro nunca ter dois donos do mesmo posto no mesmo turno.
    //
    // Não dá para usar transferOperationalOccupancy aqui: o remanejamento só
    // aceita ocupação ABERTA e a dele já foi encerrada às 19:00. Então o caminho
    // é recriar na PM04 com os valores do snapshot da ocupação original (648cfb27,
    // apagada no próprio remanejamento das 11:33) e só depois apagar a do 2151.
    if (willy) {
        const willyCreated = await startInterventionOccupancy({
            doctorId: WILLY_DOCTOR_ID,
            baseId: PM04_BASE_ID,
            continuityGroupId: willy.continuityGroupId,
            startedAt: willy.startedAt,
            boardStartedAt: willy.startedAt,
            scheduledStartAt: willy.scheduledStartAt,
            scheduledEndAt: willy.scheduledEndAt,
            shiftLabel: "SD",
            source: "admin_correction",
            notes: [
                "Willy rivera",
                "PM 04 turno SD",
                "[reparo 2026-08] Recriado na PM04: o remanejamento das 11:33 para o 2151 apagou a ocupacao"
                + " da Ana Luiza, que era quem estava no ramal. Valores do snapshot original (648cfb27).",
            ].join("\n"),
        });

        // startInterventionOccupancy abre a ocupacao; a saida dele ja era
        // conhecida e confirmada pela chefia, entao e regravada em seguida.
        const willyMoved = await correctInterventionOccupancy(willyCreated.id, {
            endedAt: WILLY_DEPARTURE_AT,
            actualEndedAt: WILLY_DEPARTURE_AT,
            chiefConfirmed: true,
        }, null);

        await removeRegulationOccupancyRecord(WILLY_OCCUPANCY_ID, null);

        console.log(`Willy gravado na PM04 — ${willyMoved.id} (ocupacao dele no 2151 removida)`);
        console.log(`  chegada ${fmt(willyMoved.startedAt)} · saida ${fmt(willyMoved.actualEndedAt)} · janela ${fmt(willyMoved.scheduledStartAt)} -> ${fmt(willyMoved.scheduledEndAt)}`);
    }

    const anaUpdated = await correctRegulationOccupancy(ANA_OCCUPANCY_ID, {
        startedAt: ANA_ARRIVAL_AT,
        boardStartedAt: ANA_ARRIVAL_AT,
        endedAt: departure.at,
        actualEndedAt: departure.at,
        shiftLabel: "SD",
        roleLabel: "MRV",
        chiefConfirmed: true,
        notes: [
            ana.notes?.trim(),
            "[reparo 2026-08] SD inteiro de MRV restaurado: a ocupacao das 06:56 foi apagada como deslocada"
            + " no remanejamento das 11:33 e o reaviso das 11:34 virou meio plantao. Chegada e funcao vem do"
            + ` snapshot apagado (ba4542e9); saida arbitrada em ${departure.label}.`,
        ].filter(Boolean).join("\n"),
    }, null);

    console.log(`Ana Luiza gravada no ${ANA_POST_CODE} — ${anaUpdated.id}`);
    console.log(`  chegada ${fmt(anaUpdated.startedAt)} · board ${fmt(anaUpdated.boardStartedAt)} · saida ${fmt(anaUpdated.actualEndedAt)}`);
    console.log(`  janela  ${fmt(anaUpdated.scheduledStartAt)} -> ${fmt(anaUpdated.scheduledEndAt)} · funcao ${anaUpdated.roleLabel ?? "—"} · turno ${anaUpdated.shiftLabel ?? "—"}\n`);
}

main()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await closeDb();
    });
