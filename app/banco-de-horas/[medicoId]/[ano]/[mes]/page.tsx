/**
 * Painel do médico — o link que o bot manda no /pagamento.
 *
 * Reúne, em leitura pura, o que antes só existia em duas telas de admin:
 * o fechamento do mês (/admin/payment-closing, ao clicar no nome dele), o saldo
 * de contrato, e o banco de horas completo (/admin/bank-hours) com a validação
 * da chefia — que é o que vinha gerando questionamento.
 *
 * Exceção de escrita: o autoatendimento do banco de horas (registrar plantão
 * extra / retirar um plantão da folha), servido por
 * /api/medico/bank-hours-self-service — que revalida identidade, saldo e
 * competência no servidor. Todo o resto é leitura pura.
 *
 * Acesso: token assinado do bot (validade de 7 dias) OU sessão admin.
 */
import { notFound } from "next/navigation";
import { readAuthenticatedSession, requireAuthenticatedSession } from "@/lib/auth/server";
import { isValidFolhaToken } from "@/lib/folha-ponto/token";
import { dataMinimaEmissao, formatarDataExtenso, hojeEmSaoPaulo } from "@/lib/folha-ponto/emissao";
import { hasDatabaseUrl } from "@/db";
import { getBankHoursHistory } from "@/services/bank-hours-history.service";
import { getChiefPayableShiftsBoard } from "@/services/payable-shifts.service";
import { formatMinutesForHumans } from "@/modules/reporting/monthly-report";
import type { BankHoursHistoryShift } from "@/modules/reporting/bank-hours-history";
import { ContractBalanceCard } from "@/components/payment-closing/contract-balance-card";
import { ApprovalBadge } from "@/components/doctor-panel/approval-badge";
import { SelfServiceBankHours, type SelfServiceShiftOption } from "@/components/doctor-panel/self-service-bank-hours";
import { resolveBankHoursSettlementBalance } from "@/modules/reporting/bank-hours-settlement-rule";
import { getSaoPauloParts } from "@/modules/operational/board-rules";
import {
    BANK_HOURS_SETTLEMENT_THRESHOLD_MINUTES,
    canSelfDeclareExtraShift,
    loadSelfDeclaredExtras,
} from "@/services/bank-hours-settlements.service";

export const dynamic = "force-dynamic";

/** Quantos plantões abrem já visíveis. O resto fica atrás de um <details>. */
const RECENT_SHIFT_LIMIT = 30;

function formatDateTime(value: string | null) {
    if (!value) return "—";
    return new Intl.DateTimeFormat("pt-BR", {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: "America/Sao_Paulo",
    }).format(new Date(value));
}

function formatBrl(value: number | null | undefined) {
    if (value === null || value === undefined) return "—";
    return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function balanceClass(value: number | null) {
    if (value === null || value === 0) return "neutral";
    return value > 0 ? "positive" : "negative";
}

function formatSignedMinutes(value: number) {
    return `${value > 0 ? "+" : ""}${formatMinutesForHumans(value)}`;
}

function formatDomain(domain: BankHoursHistoryShift["domain"]) {
    return domain === "regulation" ? "Regulação" : "Intervenção";
}

function ShiftCard({ shift }: { shift: BankHoursHistoryShift }) {
    return (
        <article className="panel-shift">
            <header>
                <div className="panel-shift-title">
                    <span className={`reports-badge ${shift.domain === "regulation" ? "warn" : "ok"}`}>
                        {formatDomain(shift.domain)}
                    </span>
                    <strong>{shift.targetCode} · {shift.targetLabel}</strong>
                </div>
                <span className={`hours-balance-pill ${balanceClass(shift.balanceMinutes)}`}>
                    {formatMinutesForHumans(shift.balanceMinutes)}
                </span>
            </header>
            <p className="panel-shift-when">
                {formatDateTime(shift.startedAt)} · {shift.shiftLabel ?? "sem turno"}
            </p>

            <ApprovalBadge approval={shift.approval} />

            <dl className="panel-shift-metrics">
                <div><dt>Entrada contada</dt><dd>{formatDateTime(shift.countedStartAt)}</dd></div>
                <div><dt>Saída no cálculo</dt><dd>{formatDateTime(shift.countedEndAt)}</dd></div>
                <div><dt>Atraso</dt><dd>{formatMinutesForHumans(shift.arrivalDelayMinutes)}</dd></div>
                <div><dt>Crédito</dt><dd>{formatMinutesForHumans(shift.creditedOvertimeMinutes)}</dd></div>
            </dl>

            {shift.corrections.length > 0 ? (
                <section className="panel-corrections">
                    <p className="panel-corrections-head">
                        {shift.corrections.length === 1
                            ? "Este plantão foi corrigido:"
                            : `Este plantão foi corrigido ${shift.corrections.length} vezes:`}
                    </p>
                    {shift.corrections.map((correction) => (
                        <div key={correction.id} className={`panel-correction ${correction.undone ? "undone" : ""}`}>
                            <p className="panel-correction-when">
                                {formatDateTime(correction.createdAt)}
                                {correction.chiefOnDutyName ? ` · chefia na 2031: ${correction.chiefOnDutyName}` : ""}
                                {correction.undone ? " · desfeita" : ""}
                            </p>
                            <ul>
                                {correction.changes.map((change) => <li key={change}>{change}</li>)}
                            </ul>
                            {correction.notes ? <p className="panel-correction-note">“{correction.notes}”</p> : null}
                        </div>
                    ))}
                </section>
            ) : null}

            <details className="panel-proof">
                <summary>Por que ficou assim</summary>
                <strong>{shift.proof.summary}</strong>
                <ul>
                    {shift.proof.items.map((item) => <li key={item}>{item}</li>)}
                </ul>
            </details>
        </article>
    );
}

export default async function PainelDoMedicoPage({
    params,
    searchParams,
}: {
    params: Promise<{ medicoId: string; ano: string; mes: string }>;
    searchParams: Promise<{ t?: string }>;
}) {
    const { medicoId, ano: anoStr, mes: mesStr } = await params;
    const { t } = await searchParams;

    const ano = Number(anoStr);
    const mes = Number(mesStr);
    if (!Number.isInteger(ano) || ano < 2020 || ano > 2100) notFound();
    if (!Number.isInteger(mes) || mes < 1 || mes > 12) notFound();

    const tokenValido = isValidFolhaToken(t, { medicoId, ano, mes });
    if (!tokenValido) {
        // Sessão do PRÓPRIO médico (cadastro por codinome+email) também entra;
        // qualquer outra sessão continua exigindo admin.
        const session = await readAuthenticatedSession();
        if (!session || session.user.doctorId !== medicoId) {
            await requireAuthenticatedSession(["admin"]);
        }
    }
    if (!hasDatabaseUrl()) notFound();

    const monthKey = `${ano}-${String(mes).padStart(2, "0")}`;
    const [history, board] = await Promise.all([
        getBankHoursHistory({ doctorId: medicoId }),
        getChiefPayableShiftsBoard(monthKey),
    ]);

    const doctor = history.doctors.find((row) => row.doctorId === medicoId);
    const paymentRow = board.doctors.find((row) => row.doctorId === medicoId);
    const contracts = paymentRow?.contractBalances ?? [];

    // Navegação de mês só faz sentido para quem está logado: o token do bot vale
    // para UM mês, então mudar de mês com ele na URL derrubaria o acesso.
    const mesAnterior = mes === 1 ? { ano: ano - 1, mes: 12 } : { ano, mes: mes - 1 };
    const mesSeguinte = mes === 12 ? { ano: ano + 1, mes: 1 } : { ano, mes: mes + 1 };
    const painelHref = (alvo: { ano: number; mes: number }) =>
        `/banco-de-horas/${medicoId}/${alvo.ano}/${alvo.mes}`;
    const mesNav = !tokenValido ? (
        <nav className="panel-month-nav">
            <a href={painelHref(mesAnterior)}>← mês anterior</a>
            <a href={painelHref(mesSeguinte)}>próximo mês →</a>
        </nav>
    ) : null;

    if (!doctor && !paymentRow) {
        return (
            <main className="panel-shell">
                {mesNav}
                <section className="hours-empty-state standalone">
                    <strong>Ainda não há nada por aqui.</strong>
                    <span>Assim que seus plantões forem consolidados, tudo aparece nesta página.</span>
                </section>
            </main>
        );
    }

    // Folha de ponto: até agora só saía por comando no bot (codinome). Aqui ela
    // fica a um clique de quem está logado. O token do bot, quando é por ele que
    // a pessoa chegou, é repassado — senão o acesso sem login se perderia.
    const folhaHref = `/folha-ponto/${medicoId}/${ano}/${String(mes).padStart(2, "0")}`
        + (tokenValido && t ? `?t=${encodeURIComponent(t)}` : "");
    const dataMinimaFolha = dataMinimaEmissao(ano, mes);
    const folhaAindaNaoEmissivel = hojeEmSaoPaulo() <= dataMinimaFolha;

    // Autoatendimento: só no mês corrente (SP). Verde = data livre para o extra
    // (saldo elegível ≥ +12h, ou chefia 2031 sem gate); vermelho = escolher um
    // plantão real do mês para retirar (saldo elegível ≤ -12h).
    const nowParts = getSaoPauloParts(new Date());
    const isCurrentMonth = monthKey === `${nowParts.year}-${String(nowParts.month).padStart(2, "0")}`;
    const settleBalance = resolveBankHoursSettlementBalance({
        oldMinutes: doctor?.legacy?.preMay2025Minutes ?? 0,
        recentMinutes: (doctor?.legacy?.spreadsheetPeriodMinutes ?? 0) + (doctor?.applicationBalanceMinutes ?? 0),
    });
    const podeDeclararExtra = isCurrentMonth ? await canSelfDeclareExtraShift(medicoId) : false;
    const canBonus = isCurrentMonth
        && (settleBalance.bonusEligibleMinutes >= BANK_HOURS_SETTLEMENT_THRESHOLD_MINUTES || podeDeclararExtra);
    const canPenalty = isCurrentMonth
        && settleBalance.penaltyEligibleMinutes <= -BANK_HOURS_SETTLEMENT_THRESHOLD_MINUTES;
    const selfServiceShiftOptions: SelfServiceShiftOption[] = canPenalty
        ? board.payableShifts
            .filter((shift) => shift.doctorId === medicoId && shift.paymentUnit > 0 && shift.source !== "admin_extra")
            .map((shift) => ({
                operationalDate: shift.operationalDate,
                shiftLabel: shift.shiftLabel,
                label: `${shift.operationalDate.split("-").reverse().slice(0, 2).join("/")} · ${shift.shiftLabel} · ${shift.targetCode}`,
            }))
            .sort((a, b) => a.operationalDate.localeCompare(b.operationalDate))
        : [];

    // O que ele mesmo declarou no mês — é o que ele pode trocar de dia/turno ou tirar.
    const extrasDeclarados = isCurrentMonth ? await loadSelfDeclaredExtras(medicoId, monthKey) : [];

    // Crédito anterior a mai/2025 não paga nada (fora da régua do acerto), mas
    // segue no cálculo interno — só sai da VISÃO do médico para não inflar
    // expectativa. Dívida antiga continua visível: as horas novas a amortizam.
    const legacyOldMinutes = doctor?.legacy?.preMay2025Minutes ?? 0;
    const hiddenLegacyCredit = Math.max(legacyOldMinutes, 0);
    const displayedBalanceMinutes = (doctor?.balanceMinutes ?? 0) - hiddenLegacyCredit;

    const allShifts = doctor?.shifts ?? [];
    const recentShifts = allShifts.slice(0, RECENT_SHIFT_LIMIT);
    const olderShifts = allShifts.slice(RECENT_SHIFT_LIMIT);
    const pendencias = (doctor?.shifts ?? []).filter((shift) =>
        shift.approval.state === "aguardando_chefia" || shift.approval.state === "ocorrencia_nao_informada");

    return (
        <main className="panel-shell">
            <header className="panel-hero">
                <p className="reports-kicker">Seu painel</p>
                <h1>{doctor?.doctorName ?? paymentRow?.doctorName}</h1>
                <p className="panel-hero-sub">{board.monthLabel}</p>
                {mesNav}
            </header>

            {pendencias.length > 0 ? (
                <section className="panel-alert">
                    <strong>
                        {pendencias.length === 1
                            ? "1 plantão seu está esperando a chefia validar."
                            : `${pendencias.length} plantões seus estão esperando a chefia validar.`}
                    </strong>
                    <span>Eles estão marcados abaixo, no banco de horas, com o nome de quem estava na chefia na hora.</span>
                </section>
            ) : null}

            {/* ---------------- Pagamento do mês ---------------- */}
            {paymentRow ? (
                <section className="panel-section">
                    <h2>Pagamento de {board.monthLabel}</h2>
                    <div className="panel-kpi-grid">
                        <article className="panel-kpi">
                            <span>Plantões</span>
                            <strong>{paymentRow.total}</strong>
                            <small>{paymentRow.totalSD} diurnos · {paymentRow.totalSN} noturnos</small>
                        </article>
                        <article className="panel-kpi highlight">
                            <span>Valor da nota</span>
                            <strong>{formatBrl(paymentRow.totalDue)}</strong>
                            <small>
                                {paymentRow.weekdayShiftCount ?? 0} de semana · {paymentRow.weekendShiftCount ?? 0} de fim de semana
                            </small>
                        </article>
                        <article className="panel-kpi">
                            <span>Nota fiscal</span>
                            <strong>{paymentRow.invoiceNumber || "—"}</strong>
                            <small>{paymentRow.paymentProcessNumber ? `processo ${paymentRow.paymentProcessNumber}` : "processo não informado"}</small>
                        </article>
                        <article className="panel-kpi">
                            <span>Conferência da chefia</span>
                            <strong>{paymentRow.attestedAt ? "Assinada" : "Pendente"}</strong>
                            <small>{paymentRow.attestedAt ? formatDateTime(paymentRow.attestedAt) : "aguardando o fechamento"}</small>
                        </article>
                    </div>
                </section>
            ) : null}

            {/* ---------------- Folha de ponto ---------------- */}
            <section className="panel-section">
                <h2>Folha de ponto de {board.monthLabel}</h2>
                <p className="panel-note">
                    A folha de frequência e o relatório de atividades saem prontos, com os
                    plantões do mês já preenchidos. É só conferir, imprimir e assinar.
                </p>
                <a className="panel-action-btn" href={folhaHref}>
                    Gerar folha de ponto
                </a>
                <p className="panel-note">
                    {folhaAindaNaoEmissivel
                        ? `A data que sai impressa é ${formatarDataExtenso(dataMinimaFolha)} — o primeiro dia útil do mês seguinte, que é o mais cedo que a folha deste mês pode ser entregue.`
                        : "A data que sai impressa é a de hoje, o dia em que você gerou a folha."}
                </p>
            </section>

            {/* ---------------- Saldo de contrato ---------------- */}
            {contracts.length > 0 ? (
                <section className="panel-section">
                    <h2>Seu saldo de contrato</h2>
                    <ContractBalanceCard
                        contracts={contracts}
                        draft={{
                            amountCents: Math.round((paymentRow?.totalDue ?? 0) * 100),
                            weekdayShifts: paymentRow?.weekdayShiftCount ?? 0,
                            weekendShifts: paymentRow?.weekendShiftCount ?? 0,
                        }}
                        canManage={false}
                        readOnly
                        monthLabel={board.monthLabel}
                        monthKey={board.monthKey}
                        alreadyAttested={Boolean(paymentRow?.attestedAt)}
                    />
                </section>
            ) : null}

            {/* ---------------- Banco de horas ---------------- */}
            {doctor ? (
                <>
                    <section className="panel-section">
                        <div className="panel-balance-head">
                            <h2>Seu banco de horas</h2>
                            <span className={`hours-balance-pill large ${balanceClass(displayedBalanceMinutes)}`}>
                                {formatSignedMinutes(displayedBalanceMinutes)}
                            </span>
                        </div>
                        <p className="panel-note">
                            Saldo positivo é crédito a receber; negativo é hora a repor.
                        </p>

                        <ul className="panel-composition">
                            {doctor.legacy ? (
                                <>
                                    {legacyOldMinutes < 0 ? (
                                        <li>
                                            <span>Dívida até 30/abr/2025</span>
                                            <span className={`hours-balance-pill ${balanceClass(legacyOldMinutes)}`}>
                                                {formatSignedMinutes(legacyOldMinutes)}
                                            </span>
                                        </li>
                                    ) : null}
                                    <li>
                                        <span>Saldo mai/2025 → mai/2026</span>
                                        <span className={`hours-balance-pill ${balanceClass(doctor.legacy.spreadsheetPeriodMinutes)}`}>
                                            {formatSignedMinutes(doctor.legacy.spreadsheetPeriodMinutes)}
                                        </span>
                                    </li>
                                </>
                            ) : null}
                            <li>
                                <span>Apurado pelo sistema</span>
                                <span className={`hours-balance-pill ${balanceClass(doctor.applicationBalanceMinutes)}`}>
                                    {formatSignedMinutes(doctor.applicationBalanceMinutes)}
                                </span>
                            </li>
                            <li className="total">
                                <span>Saldo final</span>
                                <span className={`hours-balance-pill ${balanceClass(displayedBalanceMinutes)}`}>
                                    {formatSignedMinutes(displayedBalanceMinutes)}
                                </span>
                            </li>
                        </ul>
                    </section>

                    <SelfServiceBankHours
                        medicoId={medicoId}
                        monthKey={monthKey}
                        token={tokenValido && t ? t : null}
                        canBonus={canBonus}
                        canPenalty={canPenalty}
                        shiftOptions={selfServiceShiftOptions}
                        declaredExtras={extrasDeclarados}
                    />

                    {doctor.settlements.length > 0 ? (
                        <section className="panel-section">
                            <h2>Acertos lançados no fechamento</h2>
                            <ul className="panel-settlements">
                                {doctor.settlements.map((settlement) => (
                                    <li key={settlement.id} className={settlement.kind === "bonus" ? "bonus" : "penalty"}>
                                        <span className="panel-settlement-tag">
                                            {settlement.kind === "bonus" ? "Bônus" : "Punição"}
                                        </span>
                                        <span>{settlement.monthKey}</span>
                                        <span className="panel-settlement-delta">{formatSignedMinutes(settlement.deltaMinutes)}</span>
                                        <span className="panel-settlement-note">{settlement.notes}</span>
                                    </li>
                                ))}
                            </ul>
                            <p className="panel-note">
                                Cada acerto de 12h vira um plantão a mais (bônus) ou a menos (punição) no mês indicado.
                            </p>
                        </section>
                    ) : null}

                    <section className="panel-section">
                        <h2>Seus últimos plantões</h2>
                        <p className="panel-note">
                            O horário usado no cálculo pode ser diferente da saída física quando você já tinha sido rendido —
                            cada plantão explica a regra aplicada e diz se a chefia validou.
                        </p>

                        <div className="panel-shift-list">
                            {recentShifts.map((shift) => (
                                <ShiftCard key={`${shift.domain}-${shift.occupancyId}`} shift={shift} />
                            ))}
                        </div>

                        {olderShifts.length > 0 ? (
                            <details className="panel-older-shifts">
                                <summary>
                                    Ver os outros {olderShifts.length} plantões (todos desde o começo)
                                </summary>
                                <div className="panel-shift-list">
                                    {olderShifts.map((shift) => (
                                        <ShiftCard key={`${shift.domain}-${shift.occupancyId}`} shift={shift} />
                                    ))}
                                </div>
                            </details>
                        ) : null}
                    </section>
                </>
            ) : null}

            <footer className="panel-footer">
                Para corrigir qualquer coisa, fale com a chefia de plantão.
            </footer>
        </main>
    );
}
