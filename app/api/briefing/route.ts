/**
 * Briefing operacional para o secretário (app `tom`), que entrega no WhatsApp.
 *
 * Só LEITURA, e nenhuma regra nova: o furo de base vem de listInterventionBoard
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
import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import { hasDatabaseUrl } from "@/db";
import { findPendingRenewals } from "@/lib/contracts/renewal";
import { buildContractAlerts, isImmediateAlert } from "@/modules/telegram/contract-balance-alerts";
import { listInterventionBoard } from "@/services/board.service";
import { loadContractBalances } from "@/services/contract-balance.service";

export const dynamic = "force-dynamic";

function tokenOk(received: string, expected: string): boolean {
    const a = Buffer.from(received);
    const b = Buffer.from(expected);
    // timingSafeEqual exige o mesmo tamanho; comparar antes já vaza o tamanho,
    // e tamanho de token não é o segredo.
    return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: NextRequest) {
    const expected = process.env.BRIEFING_TOKEN?.trim();
    if (!expected) {
        return NextResponse.json({ error: "BRIEFING_TOKEN is not configured." }, { status: 503 });
    }
    if (!tokenOk(request.headers.get("x-briefing-token") ?? "", expected)) {
        return NextResponse.json({ error: "Invalid briefing token." }, { status: 401 });
    }
    if (!hasDatabaseUrl()) {
        return NextResponse.json({ error: "DATABASE_URL is not configured for operations-v2." }, { status: 503 });
    }

    const asOf = new Date();
    // ?parte=bases pula a apuração mês a mês de todos os contratos. O quadro
    // precisa estar fresco a cada pergunta; o contrato não muda em uma hora, e
    // pagar a apuração inteira para responder "quem está na IT30" é desperdício.
    const soBases = request.nextUrl.searchParams.get("parte") === "bases";

    const [board, saldos] = await Promise.all([
        listInterventionBoard(),
        soBases ? Promise.resolve({ rows: [] }) : loadContractBalances({ asOf }),
    ]);
    const { rows } = saldos;

    const semMedico = board
        .filter((row) => row.status === "waiting")
        .map((row) => ({ code: row.baseCode, label: row.baseLabel }));
    const desativadas = board
        .filter((row) => row.status === "disabled")
        .map((row) => ({ code: row.baseCode, label: row.baseLabel, motivo: row.disabledReason ?? null }));

    const alerts = buildContractAlerts(rows, asOf).filter(isImmediateAlert);
    const porContrato = new Map(rows.map((row) => [row.contractId, row]));
    const contrato = (contractId: string) => {
        const row = porContrato.get(contractId)!;
        return {
            doctorName: row.doctorName,
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

    // Um registro por contrato ativo, com o que responde "quanto o fulano ainda
    // pode dar de plantão". Sai inteiro porque quem consome guarda em cache e
    // responde de lá: refazer a apuração a cada pergunta custa segundos.
    const medicos = rows.map((row) => ({
        doctorName: row.doctorName,
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
            renovacaoPendente: findPendingRenewals(rows, asOf),
        },
    });
}
