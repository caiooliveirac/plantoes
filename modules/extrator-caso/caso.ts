/**
 * Monta o caso desidentificado de UM médico em UM mês: pagamento do fechamento
 * e banco de horas, com a prova e a trilha de cada plantão
 * (docs/extrator-caso.md). Lista branca: só sai o campo que está escrito aqui.
 */
import { isPremiumRateDate } from "@/modules/operational/holidays";
import type { BankHoursDoctorHistory, BankHoursHistoryShift } from "@/modules/reporting/bank-hours-history";
import {
    resolveShiftDueAmountCents,
    type ChiefPayableDoctorRow,
    type PayableShift,
} from "@/modules/reporting/payable-shifts";
import type { Mascara } from "@/modules/extrator-caso/mascara";

export const FORMATO_DO_CASO = "plantoes/caso-desidentificado/v1";

export interface EntradaDoCaso {
    medicoId: string;
    /** AAAA-MM. */
    mes: string;
    /** false troca as anotações escritas à mão por "[texto omitido]". */
    comTextos: boolean;
    pagamento: ChiefPayableDoctorRow | null;
    bancoDeHoras: BankHoursDoctorHistory | null;
}

const LEIA_ME = [
    "Caso real desidentificado do app plantoes. Não há nome, e-mail, unidade nem data civil.",
    "MED-/PESSOA- = pessoa; CONTA- = login; REG- = ramal da regulação; USA- = base de ambulância; ID- = registro.",
    "REG-CHEFIA é o ramal da chefia de plantão; REG-EVENTUAL-* são os ramais eventuais da madrugada.",
    "D+00 é o dia 1 do mês do caso (M0); D-02 é dois dias antes. Horas no relógio operacional (UTC-3).",
    "Valores em centavos ou reais conforme o nome do campo; minutos são minutos.",
    "Para saber quem é quem, o admin consulta a legenda na tela do extrator. Não tente adivinhar.",
];

export function montarCaso(entrada: EntradaDoCaso, mascara: Mascara) {
    const { pagamento, bancoDeHoras } = entrada;
    const plantoesDoBanco = (bancoDeHoras?.shifts ?? []).filter((shift) => shift.monthKey === entrada.mes);

    // Primeiro os nomes que vêm em campo próprio: assim o texto livre que citar
    // a mesma pessoa já sai com o mesmo pseudônimo.
    for (const shift of plantoesDoBanco) {
        for (const nome of [
            shift.successorDoctorName,
            shift.departureConfirmedByName,
            shift.lateArrivalAcknowledgedByName,
            shift.approval.chiefName,
            ...shift.corrections.map((correcao) => correcao.chiefOnDutyName),
        ]) {
            mascara.pessoaPorNome(nome);
        }
    }

    const gerado = (valor: string | null | undefined) => mascara.texto(valor);
    const escrito = (valor: string | null | undefined) => {
        if (!valor?.trim()) return null;
        return entrada.comTextos ? mascara.texto(valor) : "[texto omitido]";
    };
    const intervalo = (inicio: string | null | undefined, fim: string | null | undefined) => [mascara.instante(inicio), mascara.instante(fim)];

    const perfil = pagamento?.paymentProfile ?? "generalist";
    const vinculo = pagamento?.employmentType ?? bancoDeHoras?.employmentType ?? null;

    function plantaoPagavel(shift: PayableShift) {
        return {
            id: mascara.id(shift.occupancyId),
            dominio: shift.domain,
            alvo: mascara.alvo(shift.domain, shift.targetCode, shift.targetLabel),
            dia: mascara.dia(shift.operationalDate),
            tarifaDeFimDeSemanaOuFeriado: isPremiumRateDate(shift.operationalDate),
            turno: shift.shiftLabel,
            janela: intervalo(shift.slotStartedAt, shift.slotEndedAt),
            programado: intervalo(shift.scheduledStartAt, shift.scheduledEndAt),
            chegada: mascara.instante(shift.startedAt),
            rendicao: mascara.instante(shift.endedAt),
            saidaReal: mascara.instante(shift.actualEndedAt),
            minutos: shift.durationMinutes,
            unidadeDePagamento: shift.paymentUnit,
            valorCentavos: resolveShiftDueAmountCents({
                profile: perfil,
                operationalDate: shift.operationalDate,
                paymentUnit: shift.paymentUnit,
                employmentType: pagamento?.employmentType,
            }),
            situacao: shift.paymentStatus,
            auditoria: shift.auditStatus,
            pendencias: shift.issues.map(gerado),
            origem: shift.source,
            funcao: gerado(shift.roleLabel),
            etiqueta: gerado(shift.tagCode),
            etiquetaDePagamento: gerado(shift.paymentTag),
            extraDeChefia: shift.isChiefExtra ?? false,
            tipoDeExtra: shift.extraKind ?? null,
            retiradaAntecipada: shift.earlyDepartureOutcome,
            sombraPorTurno: shift.turnoShadow
                ? { ...shift.turnoShadow, divergence: gerado(shift.turnoShadow.divergence) }
                : null,
        };
    }

    function plantaoDoBanco(shift: BankHoursHistoryShift) {
        return {
            id: mascara.id(shift.occupancyId),
            grupoDeContinuidade: mascara.id(shift.continuityGroupId),
            dominio: shift.domain,
            alvo: mascara.alvo(shift.domain, shift.targetCode, shift.targetLabel),
            turno: shift.shiftLabel,
            origem: shift.source,
            chegada: mascara.instante(shift.startedAt),
            chegadaNoQuadro: mascara.instante(shift.boardStartedAt),
            rendicao: mascara.instante(shift.handoffEndedAt),
            saidaReal: mascara.instante(shift.actualEndedAt),
            saidaEfetiva: mascara.instante(shift.effectiveEndedAt),
            programadoDaOcupacao: intervalo(shift.occupancyScheduledStartAt, shift.occupancyScheduledEndAt),
            janelaDoBanco: {
                programado: intervalo(shift.bankScheduledStartAt, shift.bankScheduledEndAt),
                real: intervalo(shift.bankActualStartAt, shift.bankActualEndAt),
                contado: intervalo(shift.countedStartAt, shift.countedEndAt),
            },
            minutos: {
                trabalhados: shift.workedMinutes,
                atraso: shift.arrivalDelayMinutes,
                horaExtra: shift.overtimeMinutes,
                horaExtraCreditada: shift.creditedOvertimeMinutes,
                saldo: shift.balanceMinutes,
            },
            regra: shift.ruleCode,
            explicacao: gerado(shift.bankHoursExplanation),
            temLancamentoPersistido: shift.hasPersistedBankEntry,
            prova: { modo: shift.proof.mode, resumo: gerado(shift.proof.summary), itens: shift.proof.items.map(gerado) },
            aprovacao: {
                estado: shift.approval.state,
                rotulo: gerado(shift.approval.label),
                detalhe: gerado(shift.approval.detail),
                chefia: mascara.pessoaPorNome(shift.approval.chiefName),
                em: mascara.instante(shift.approval.at),
                nota: escrito(shift.approval.note),
            },
            saidaTardia: shift.lateDeparture
                ? { motivo: shift.lateDeparture.reasonCode, ocorrenciaInformada: Boolean(shift.lateDeparture.occurrenceNumber) }
                : null,
            confirmacaoDaSaida: {
                em: mascara.instante(shift.departureConfirmedAt),
                por: mascara.pessoaPorNome(shift.departureConfirmedByName),
                nota: escrito(shift.departureConfirmedNote),
            },
            atrasoReconhecido: {
                em: mascara.instante(shift.lateArrivalAcknowledgedAt),
                por: mascara.pessoaPorNome(shift.lateArrivalAcknowledgedByName),
                nota: escrito(shift.lateArrivalAcknowledgedNote),
            },
            ajusteManual: {
                minutos: shift.manualBalanceMinutes,
                em: mascara.instante(shift.manualBalanceUpdatedAt),
                por: mascara.conta(shift.manualBalanceActorEmail),
                nota: escrito(shift.manualBalanceNotes),
            },
            sucessor: {
                quem: mascara.pessoaPorNome(shift.successorDoctorName),
                assumiuEm: mascara.instante(shift.successorTookOverAt),
            },
            correcoes: shift.corrections.map((correcao) => ({
                id: mascara.id(correcao.id),
                em: mascara.instante(correcao.createdAt),
                por: mascara.conta(correcao.actorEmail),
                chefiaDePlantao: mascara.pessoaPorNome(correcao.chiefOnDutyName),
                mudancas: correcao.changes.map(gerado),
                nota: escrito(correcao.notes),
                desfeita: correcao.undone,
            })),
            trilha: shift.auditTrail.map((evento) => ({
                acao: evento.action,
                em: mascara.instante(evento.createdAt),
                por: mascara.conta(evento.actorEmail),
                detalhes: entrada.comTextos ? mascara.json(evento.details) : "[omitido]",
            })),
            registro: {
                criadoEm: mascara.instante(shift.createdAt),
                criadoPor: mascara.conta(shift.createdByEmail),
                atualizadoEm: mascara.instante(shift.updatedAt),
                atualizadoPor: mascara.conta(shift.updatedByEmail),
            },
            observacoes: escrito(shift.notes),
            marcas: shift.flags,
        };
    }

    const saldoPorMes = new Map<string, { plantoes: number; saldoMinutos: number }>();
    for (const shift of bancoDeHoras?.shifts ?? []) {
        const atual = saldoPorMes.get(shift.monthKey) ?? { plantoes: 0, saldoMinutos: 0 };
        saldoPorMes.set(shift.monthKey, {
            plantoes: atual.plantoes + 1,
            saldoMinutos: atual.saldoMinutos + (shift.manualBalanceMinutes ?? shift.balanceMinutes ?? 0),
        });
    }

    return {
        formato: FORMATO_DO_CASO,
        leiaMe: LEIA_ME,
        medico: { pseudonimo: mascara.pessoaPorId(entrada.medicoId), vinculo, perfilDePagamento: pagamento?.paymentProfile ?? null },
        mes: mascara.mes(entrada.mes),
        textosEscritosAMao: entrada.comTextos ? "mascarados" : "omitidos",
        pagamento: pagamento
            ? {
                situacao: pagamento.paymentStatus,
                pendencias: pagamento.pendingCount,
                plantoes: {
                    SD: pagamento.totalSD,
                    SN: pagamento.totalSN,
                    total: pagamento.total,
                    emDiaUtil: pagamento.weekdayShiftCount ?? null,
                    emFimDeSemanaOuFeriado: pagamento.weekendShiftCount ?? null,
                    emBase: pagamento.usaShiftCount,
                    emRegulacao: pagamento.cruShiftCount,
                },
                devidoReais: { SD: pagamento.totalSDDue ?? null, SN: pagamento.totalSNDue ?? null, total: pagamento.totalDue ?? null },
                atestadoEm: mascara.instante(pagamento.attestedAt),
                notaFiscalInformada: Boolean(pagamento.invoiceNumber),
                processoDePagamentoInformado: Boolean(pagamento.paymentProcessNumber),
                contratoSemente: {
                    tetoReais: pagamento.contractCeilingBrl ?? null,
                    saldoDeAberturaReais: pagamento.contractOpeningBalanceBrl ?? null,
                    mesSemente: mascara.mes(pagamento.contractSeedMonth),
                    saldoReais: pagamento.contractBalanceBrl ?? null,
                },
                renovacaoPendente: pagamento.contractPendingRenewal
                    ? {
                        tipo: pagamento.contractPendingRenewal.kind,
                        diasVencido: pagamento.contractPendingRenewal.daysOverdue,
                        fimDoCiclo: mascara.dia(pagamento.contractPendingRenewal.cycleEnd),
                    }
                    : null,
                contratos: (pagamento.contractBalances ?? []).map((contrato) => ({
                    id: mascara.id(contrato.contractId),
                    ciclo: [mascara.dia(contrato.cycleStart), mascara.dia(contrato.cycleEnd)],
                    tetoCentavos: contrato.ceilingCents,
                    saldoCentavos: contrato.balanceCents,
                    saldoAssinadoCentavos: contrato.settledBalanceCents,
                    consumoPendenteCentavos: contrato.pendingConsumptionCents,
                    consumidoCentavos: contrato.consumedCents,
                    consumidoPct: contrato.consumedPct,
                    decorridoPct: contrato.elapsedPct,
                    ritmo: contrato.paceIndex,
                    risco: contrato.riskLevel,
                    ritmoConfiavel: contrato.hasReliableBurnRate,
                    esgotamentoProjetado: mascara.dia(contrato.projectedDepletionDate),
                    orcamentoMensalSaudavelCentavos: contrato.healthyMonthlyBudgetCents,
                    plantoesDeDiaUtilPorMes: contrato.monthlyWeekdayShifts,
                    plantoesDeDiaUtilRestantes: contrato.remainingWeekdayShifts,
                    aguardandoSaldoDeAbertura: contrato.awaitingOpeningBalance,
                    extrato: mascara.json(contrato.statement),
                    tarifasCentavos: { diaUtil: contrato.metricsInput.weekdayRateCents, fimDeSemana: contrato.metricsInput.weekendRateCents },
                })),
                bancoDeHorasMinutos: {
                    efetivo: pagamento.bankHoursMinutes ?? null,
                    antesDeMai2025: pagamento.bankHoursOldMinutes ?? null,
                    desdeMai2025: pagamento.bankHoursRecentMinutes ?? null,
                },
                acertoDoMes: pagamento.bankHoursSettlement
                    ? {
                        tipo: pagamento.bankHoursSettlement.kind,
                        deltaMinutos: pagamento.bankHoursSettlement.deltaMinutes,
                        diaDoPlantao: mascara.dia(pagamento.bankHoursSettlement.operationalDate),
                        lancadoEm: mascara.instante(pagamento.bankHoursSettlement.createdAt),
                        nota: escrito(pagamento.bankHoursSettlement.notes),
                    }
                    : null,
                linhas: pagamento.cells.flatMap((cell) => cell.shifts.map(plantaoPagavel)),
            }
            : null,
        bancoDeHoras: bancoDeHoras
            ? {
                vinculo: bancoDeHoras.employmentType,
                minutos: {
                    saldoEfetivo: bancoDeHoras.balanceMinutes,
                    apuradoPelaAplicacao: bancoDeHoras.applicationBalanceMinutes,
                    trabalhados: bancoDeHoras.workedMinutes,
                    horaExtraCreditada: bancoDeHoras.creditedOvertimeMinutes,
                    atraso: bancoDeHoras.arrivalDelayMinutes,
                },
                legadoDaPlanilha: bancoDeHoras.legacy
                    ? {
                        antesDeMai2025: bancoDeHoras.legacy.preMay2025Minutes,
                        periodoDaPlanilha: bancoDeHoras.legacy.spreadsheetPeriodMinutes,
                        total: bancoDeHoras.legacy.totalMinutes,
                        nota: escrito(bancoDeHoras.legacy.notes),
                    }
                    : null,
                naVidaToda: {
                    plantoes: bancoDeHoras.shiftCount,
                    atrasos: bancoDeHoras.lateArrivalCount,
                    rendicoesSobrepostas: bancoDeHoras.handoffOverrideCount,
                    correcoes: bancoDeHoras.correctionCount,
                    plantoesAbertos: bancoDeHoras.openShiftCount,
                    ultimoPlantao: mascara.instante(bancoDeHoras.lastShiftAt),
                },
                saldoDosPlantoesPorMes: [...saldoPorMes]
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([mes, valor]) => ({ mes: mascara.mes(mes), ...valor })),
                acertos: bancoDeHoras.settlements.map((acerto) => ({
                    id: mascara.id(acerto.id),
                    mes: mascara.mes(acerto.monthKey),
                    tipo: acerto.kind,
                    deltaMinutos: acerto.deltaMinutes,
                    diaDoPlantao: mascara.dia(acerto.operationalDate),
                    lancadoEm: mascara.instante(acerto.createdAt),
                    nota: escrito(acerto.notes),
                })),
                plantoesDoMes: plantoesDoBanco.map(plantaoDoBanco),
            }
            : null,
    };
}

export type CasoDesidentificado = ReturnType<typeof montarCaso>;
