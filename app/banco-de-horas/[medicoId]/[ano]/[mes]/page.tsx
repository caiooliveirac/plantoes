/**
 * Painel do médico — o link que o bot manda no /pagamento.
 *
 * Reúne, em leitura pura, o que antes só existia em duas telas de admin:
 * o fechamento do mês (/admin/payment-closing, ao clicar no nome dele), o saldo
 * de contrato, e o banco de horas completo (/admin/bank-hours) com a validação
 * da chefia — que é o que vinha gerando questionamento.
 *
 * Nada aqui edita nada. Não existe rota de mutação chamada por esta página, e o
 * card de contrato entra em modo readOnly.
 *
 * Acesso: token assinado do bot (validade de 7 dias) OU sessão admin.
 */
import { notFound } from "next/navigation";
import { readAuthenticatedSession, requireAuthenticatedSession } from "@/lib/auth/server";
import { isValidFolhaToken } from "@/lib/folha-ponto/token";
import { hasDatabaseUrl } from "@/db";
import { getBankHoursHistory } from "@/services/bank-hours-history.service";
import { getChiefPayableShiftsBoard } from "@/services/payable-shifts.service";
import { formatMinutesForHumans } from "@/modules/reporting/monthly-report";
import type { BankHoursHistoryShift } from "@/modules/reporting/bank-hours-history";
import { ContractBalanceCard } from "@/components/payment-closing/contract-balance-card";
import { ApprovalBadge } from "@/components/doctor-panel/approval-badge";

export const dynamic = "force-dynamic";

/** Quantos plantões recentes o médico vê. O saldo é sempre o total, não a fatia. */
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

    if (!isValidFolhaToken(t, { medicoId, ano, mes })) {
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

    if (!doctor && !paymentRow) {
        return (
            <main className="panel-shell">
                <section className="hours-empty-state standalone">
                    <strong>Ainda não há nada por aqui.</strong>
                    <span>Assim que seus plantões forem consolidados, tudo aparece nesta página.</span>
                </section>
            </main>
        );
    }

    const recentShifts = doctor?.shifts.slice(0, RECENT_SHIFT_LIMIT) ?? [];
    const pendencias = (doctor?.shifts ?? []).filter((shift) =>
        shift.approval.state === "aguardando_chefia" || shift.approval.state === "ocorrencia_nao_informada");

    return (
        <main className="panel-shell">
            <header className="panel-hero">
                <p className="reports-kicker">Seu painel</p>
                <h1>{doctor?.doctorName ?? paymentRow?.doctorName}</h1>
                <p className="panel-hero-sub">{board.monthLabel}</p>
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
                            <span className={`hours-balance-pill large ${balanceClass(doctor.balanceMinutes)}`}>
                                {formatSignedMinutes(doctor.balanceMinutes)}
                            </span>
                        </div>
                        <p className="panel-note">
                            Saldo positivo é crédito a receber; negativo é hora a repor.
                        </p>

                        <ul className="panel-composition">
                            {doctor.legacy ? (
                                <>
                                    <li>
                                        <span>Saldo até 30/abr/2025</span>
                                        <span className={`hours-balance-pill ${balanceClass(doctor.legacy.preMay2025Minutes)}`}>
                                            {formatSignedMinutes(doctor.legacy.preMay2025Minutes)}
                                        </span>
                                    </li>
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
                                <span className={`hours-balance-pill ${balanceClass(doctor.balanceMinutes)}`}>
                                    {formatSignedMinutes(doctor.balanceMinutes)}
                                </span>
                            </li>
                        </ul>
                    </section>

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
                                <article key={`${shift.domain}-${shift.occupancyId}`} className="panel-shift">
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
                            ))}
                        </div>

                        {doctor.shifts.length > recentShifts.length ? (
                            <p className="panel-note">
                                Mostrando os {RECENT_SHIFT_LIMIT} plantões mais recentes de {doctor.shiftCount}. O saldo acima considera todos.
                            </p>
                        ) : null}
                    </section>
                </>
            ) : null}

            <footer className="panel-footer">
                Esta página é só de leitura. Para corrigir qualquer coisa, fale com a chefia de plantão.
            </footer>
        </main>
    );
}
