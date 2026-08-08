/**
 * Briefing operacional para o secretário (app `tom`), que entrega no WhatsApp.
 *
 * Só LEITURA, e nenhuma regra nova: o furo de base vem de listInterventionBoard
 * e o da regulação de listRegulationBoard
 * (mesmo read model do quadro ao vivo), o risco de saldo vem de
 * buildContractAlerts e a pendência de renovação de findPendingRenewals. Se um
 * número aqui divergir do que a tela mostra, o defeito é da origem — este
 * arquivo não recalcula nada.
 *
 * O texto é problema de quem entrega. Aqui sai dado estruturado.
 *
 * Autenticação: header `x-briefing-token` contra BRIEFING_TOKEN. Sem a variável
 * a rota responde 503 — endpoint aberto com dado de contrato de médico, não.
 */
import { NextRequest, NextResponse } from "next/server";

import { sql } from "drizzle-orm";

import { getDb, hasDatabaseUrl } from "@/db";
import { doctors } from "@/db/schema";
import { loadBriefingBankHours } from "@/lib/briefing/bank-hours";
import { guardBriefingRequest } from "@/lib/briefing/token";
import { findPendingRenewals } from "@/lib/contracts/renewal";
import { tracksContractBalance } from "@/modules/reporting/payment-closing-pendencies";
import { formatDoctorSurfaceName } from "@/modules/doctors/directory";
import { buildContractAlerts, isImmediateAlert } from "@/modules/telegram/contract-balance-alerts";
import { listInterventionBoard, listRegulationBoard } from "@/services/board.service";
import { loadContractBalances } from "@/services/contract-balance.service";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
    const recusa = guardBriefingRequest(request);
    if (recusa) {
        return recusa;
    }

    const asOf = new Date();
    // ?parte=bases pula a apuração mês a mês de todos os contratos. O quadro
    // precisa estar fresco a cada pergunta; o contrato não muda em uma hora, e
    // pagar a apuração inteira para responder "quem está na IT30" é desperdício.
    const soBases = request.nextUrl.searchParams.get("parte") === "bases";

    const [board, regulacao, saldos, bancoDeHoras] = await Promise.all([
        listInterventionBoard(),
        // A regulação sai junto do quadro, inclusive em ?parte=bases: ramal
        // descoberto é furo de agora, mesma urgência da base sem médico. Mesmo
        // read model da tela ao vivo — nenhuma regra nova aqui.
        listRegulationBoard(),
        soBases ? Promise.resolve({ rows: [] }) : loadContractBalances({ asOf }),
        soBases ? Promise.resolve(null) : loadBriefingBankHours(),
    ]);
    // Mesmo corte do fechamento e dos avisos: estatutário e psiquiatra não têm
    // teto acompanhado, então não entram em saldo, alerta nem renovação pendente.
    const rows = saldos.rows.filter(tracksContractBalance);

    const semMedico = board
        .filter((row) => row.status === "waiting")
        .map((row) => ({ code: row.baseCode, label: row.baseLabel }));
    const desativadas = board
        .filter((row) => row.status === "disabled")
        .map((row) => ({ code: row.baseCode, label: row.baseLabel, motivo: row.disabledReason ?? null }));

    // O nome curto do painel (display_name), que é como o coordenador conhece
    // cada médico. `loadContractBalances` só traz o full_name — em vez de mexer
    // no serviço do saldo por causa de rótulo, o de-para vem numa consulta à
    // parte. Os dois nomes saem no payload: o curto para mostrar, o completo
    // para o secretário reconhecer quem foi citado na pergunta.
    const nomeCurto = new Map<string, string>();
    if (rows.length > 0) {
        const doctorRows = await getDb()
            .select({ id: doctors.id, fullName: doctors.fullName, displayName: doctors.displayName })
            .from(doctors)
            .where(sql`${doctors.id} = any(${sql.raw(`array[${[...new Set(rows.map((row) => `'${row.doctorId}'`))].join(",")}]::uuid[]`)})`);
        for (const doctor of doctorRows) {
            nomeCurto.set(doctor.id, formatDoctorSurfaceName(doctor));
        }
    }

    const alerts = buildContractAlerts(rows, asOf).filter(isImmediateAlert);
    const porContrato = new Map(rows.map((row) => [row.contractId, row]));
    const contrato = (contractId: string) => {
        const row = porContrato.get(contractId)!;
        return {
            doctorName: row.doctorName,
            displayName: nomeCurto.get(row.doctorId) ?? row.doctorName,
            contractNumber: row.contractNumber,
            balanceCents: row.metrics.balanceCents,
            cycleEnd: row.cycleEnd,
        };
    };

    // O quadro ao vivo, para responder "quem está na IT30 agora".
    const ocupadas = board
        .filter((row) => row.status === "active")
        .map((row) => ({
            code: row.baseCode,
            label: row.baseLabel,
            doctorName: row.displayName ?? row.doctorName,
            shiftLabel: row.shiftLabel,
            scheduledEndAt: row.scheduledEndAt,
        }));

    // A regulação, na mesma forma das bases — quem entrega não precisa de dois
    // formatos. Aqui `code` é o RAMAL, que é como o coordenador chama o posto, e
    // `roleLabel` é a função (CP, MRV, RECIP, COI, IES, RMT, PSIQ, PIAM): é o que
    // responde "quem está no COI" e "quem está remoto". Sem função lançada cai
    // no `defaultRole` do posto — o painel mostra o mesmo.
    const postos = {
        ocupados: regulacao
            .filter((row) => row.status === "active")
            .map((row) => ({
                code: row.postCode,
                label: row.postLabel,
                doctorName: row.displayName ?? row.doctorName,
                shiftLabel: row.shiftLabel,
                roleLabel: row.roleLabel ?? row.defaultRole,
                scheduledEndAt: row.scheduledEndAt,
            })),
        semMedico: regulacao
            .filter((row) => row.status === "waiting")
            .map((row) => ({ code: row.postCode, label: row.postLabel, roleLabel: row.defaultRole })),
        desativados: regulacao
            .filter((row) => row.status === "disabled")
            .map((row) => ({ code: row.postCode, label: row.postLabel, motivo: row.disabledReason ?? null })),
    };

    // Um registro por contrato ativo, com o que responde "quanto o fulano ainda
    // pode dar de plantão". Sai inteiro porque quem consome guarda em cache e
    // responde de lá: refazer a apuração a cada pergunta custa segundos.
    const medicos = rows.map((row) => ({
        doctorName: row.doctorName,
        displayName: nomeCurto.get(row.doctorId) ?? row.doctorName,
        contractNumber: row.contractNumber,
        cycleEnd: row.cycleEnd,
        ceilingCents: row.ceilingCents,
        balanceCents: row.metrics.balanceCents,
        consumedPct: row.metrics.consumedPct,
        paceIndex: row.metrics.paceIndex,
        riskLevel: row.metrics.riskLevel,
        awaitingOpeningBalance: row.awaitingOpeningBalance,
        hasReliableBurnRate: row.metrics.hasReliableBurnRate,
        projectedDepletionDate: row.metrics.projectedDepletionDate?.toISOString().slice(0, 10) ?? null,
        /** Quantos plantões cabem no saldo até o fim do ciclo, no mix do médico. */
        remainingShiftsAtOwnMix: row.metrics.remainingShiftsAtOwnMix,
        /** Ritmo que chega inteiro ao fim do ciclo. */
        monthlyShiftsAtOwnMix: row.metrics.monthlyShiftsAtOwnMix,
        healthyMonthlyBudgetCents: row.metrics.healthyMonthlyBudgetCents,
    }));

    return NextResponse.json({
        generatedAt: asOf.toISOString(),
        bases: { semMedico, desativadas, ocupadas },
        postos,
        bancoDeHoras,
        medicos,
        contratos: {
            zerados: alerts
                .filter((alert) => alert.trigger === "depleted")
                .map((alert) => contrato(alert.contractId)),
            projetandoEstouro: alerts
                .filter((alert) => alert.trigger === "exhaustion_projected")
                .map((alert) => ({
                    ...contrato(alert.contractId),
                    projectedDepletionDate:
                        porContrato.get(alert.contractId)!.metrics.projectedDepletionDate?.toISOString().slice(0, 10) ?? null,
                })),
            renovacaoPendente: findPendingRenewals(rows, asOf).map((item) => ({
                ...item,
                displayName: nomeCurto.get(item.doctorId) ?? item.doctorName,
            })),
        },
    });
}
