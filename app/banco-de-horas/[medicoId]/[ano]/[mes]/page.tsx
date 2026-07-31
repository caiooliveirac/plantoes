import { notFound } from "next/navigation";
import { requireAuthenticatedSession } from "@/lib/auth/server";
import { isValidFolhaToken } from "@/lib/folha-ponto/token";
import { hasDatabaseUrl } from "@/db";
import { getBankHoursHistory } from "@/services/bank-hours-history.service";
import { formatMinutesForHumans } from "@/modules/reporting/monthly-report";
import type { BankHoursHistoryShift } from "@/modules/reporting/bank-hours-history";

export const dynamic = "force-dynamic";

// Quantos plantões recentes o médico vê. O saldo mostrado é sempre o total, não o
// somatório dessa fatia.
const RECENT_SHIFT_LIMIT = 30;

function formatDateTime(value: string | null) {
    if (!value) {
        return "--";
    }

    return new Intl.DateTimeFormat("pt-BR", {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: "America/Sao_Paulo",
    }).format(new Date(value));
}

function balanceClass(value: number | null) {
    if (value === null || value === 0) {
        return "neutral";
    }

    return value > 0 ? "positive" : "negative";
}

function formatSignedMinutes(value: number) {
    return `${value > 0 ? "+" : ""}${formatMinutesForHumans(value)}`;
}

function formatDomain(domain: BankHoursHistoryShift["domain"]) {
    return domain === "regulation" ? "Regulação" : "Intervenção";
}

export default async function BancoDeHorasDoMedicoPage({
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

    // Mesmo portão da folha de ponto: link assinado do bot OU sessão admin.
    if (!isValidFolhaToken(t, { medicoId, ano, mes })) {
        await requireAuthenticatedSession(["admin"]);
    }

    if (!hasDatabaseUrl()) notFound();

    const history = await getBankHoursHistory({ doctorId: medicoId });
    const doctor = history.doctors.find((row) => row.doctorId === medicoId);

    if (!doctor) {
        return (
            <main className="hours-shell">
                <section className="hours-empty-state standalone">
                    <strong>Ainda não há banco de horas para você.</strong>
                    <span>Assim que seus plantões forem consolidados, o saldo aparece aqui.</span>
                </section>
            </main>
        );
    }

    const recentShifts = doctor.shifts.slice(0, RECENT_SHIFT_LIMIT);

    return (
        <main className="hours-shell">
            <section className="hours-hero">
                <div>
                    <p className="reports-kicker">Seu banco de horas</p>
                    <h1>{doctor.doctorName}</h1>
                    <p className="hours-subtitle">
                        Saldo acumulado e o que cada plantão recente somou ou tirou. Confira antes de assinar a folha de ponto: saldo positivo é crédito a receber, negativo é hora a repor.
                    </p>
                </div>
                <span className={`hours-balance-pill large ${balanceClass(doctor.balanceMinutes)}`}>{formatSignedMinutes(doctor.balanceMinutes)}</span>
            </section>

            <section className="hours-settlements">
                <p className="reports-summary-label">Composição do saldo</p>
                <ul className="hours-composition-list">
                    {doctor.legacy ? (
                        <>
                            <li className="hours-composition-row">
                                <span className="hours-composition-label">Saldo até 30/abr/2025</span>
                                <span className="hours-composition-origin">{doctor.legacy.source}</span>
                                <span className={`hours-balance-pill ${balanceClass(doctor.legacy.preMay2025Minutes)}`}>{formatSignedMinutes(doctor.legacy.preMay2025Minutes)}</span>
                            </li>
                            <li className="hours-composition-row">
                                <span className="hours-composition-label">Saldo mai/2025 → mai/2026</span>
                                <span className="hours-composition-origin">{doctor.legacy.source}</span>
                                <span className={`hours-balance-pill ${balanceClass(doctor.legacy.spreadsheetPeriodMinutes)}`}>{formatSignedMinutes(doctor.legacy.spreadsheetPeriodMinutes)}</span>
                            </li>
                        </>
                    ) : null}
                    <li className="hours-composition-row">
                        <span className="hours-composition-label">Saldo apurado pela aplicação (desde o corte)</span>
                        <span className="hours-composition-origin">Registros do sistema, incluindo acertos do fechamento</span>
                        <span className={`hours-balance-pill ${balanceClass(doctor.applicationBalanceMinutes)}`}>{formatSignedMinutes(doctor.applicationBalanceMinutes)}</span>
                    </li>
                    <li className="hours-composition-row total">
                        <span className="hours-composition-label">Saldo final</span>
                        <span className="hours-composition-origin">{doctor.legacy ? `Planilha (${doctor.legacy.spreadsheetName}) + aplicação` : "Apuração da aplicação"}</span>
                        <span className={`hours-balance-pill ${balanceClass(doctor.balanceMinutes)}`}>{formatSignedMinutes(doctor.balanceMinutes)}</span>
                    </li>
                </ul>
            </section>

            {doctor.settlements.length > 0 ? (
                <section className="hours-settlements">
                    <p className="reports-summary-label">Acertos já lançados no fechamento</p>
                    <ul className="hours-settlements-list">
                        {doctor.settlements.map((settlement) => (
                            <li key={settlement.id} className={`hours-settlement-row ${settlement.kind === "bonus" ? "bonus" : "penalty"}`}>
                                <span className="hours-settlement-tag">{settlement.kind === "bonus" ? "Bônus" : "Punição"}</span>
                                <span className="hours-settlement-month">{settlement.monthKey}</span>
                                <span className="hours-settlement-delta">{formatSignedMinutes(settlement.deltaMinutes)}</span>
                                <span className="hours-settlement-notes">{settlement.notes}</span>
                            </li>
                        ))}
                    </ul>
                    <p className="hours-settlement-hint">
                        Cada acerto de 12h vira um plantão a mais (bônus) ou a menos (punição) no pagamento do mês indicado.
                    </p>
                </section>
            ) : null}

            <section className="hours-kpi-grid">
                <article className="hours-kpi-card">
                    <span className="reports-summary-label">Plantões consolidados</span>
                    <strong>{doctor.shiftCount}</strong>
                </article>
                <article className="hours-kpi-card">
                    <span className="reports-summary-label">Crédito total</span>
                    <strong>{formatMinutesForHumans(doctor.creditedOvertimeMinutes)}</strong>
                </article>
                <article className="hours-kpi-card">
                    <span className="reports-summary-label">Débito por atraso</span>
                    <strong>{formatMinutesForHumans(doctor.arrivalDelayMinutes)}</strong>
                </article>
                <article className="hours-kpi-card">
                    <span className="reports-summary-label">Último plantão</span>
                    <strong>{formatDateTime(doctor.lastShiftAt)}</strong>
                </article>
            </section>

            <section className="hours-plan-box">
                <p className="reports-summary-label">Seus últimos plantões</p>
                <h3>Quanto cada plantão somou (verde) ou tirou (vermelho) do seu banco.</h3>
                <p>O horário usado no cálculo pode ser diferente da saída física quando você já tinha sido rendido — cada linha explica a regra aplicada.</p>
            </section>

            <div className="hours-shift-list">
                {recentShifts.map((shift) => (
                    <article key={`${shift.domain}-${shift.occupancyId}`} className="hours-shift-card">
                        <header className="hours-shift-header">
                            <div>
                                <div className="hours-shift-title">
                                    <span className={`reports-badge ${shift.domain === "regulation" ? "warn" : "ok"}`}>{formatDomain(shift.domain)}</span>
                                    <strong>{shift.targetCode} · {shift.targetLabel}</strong>
                                </div>
                                <span className="hours-shift-subtitle">{formatDateTime(shift.startedAt)} · {shift.shiftLabel ?? "sem turno"}</span>
                            </div>
                            <span className={`hours-balance-pill ${balanceClass(shift.balanceMinutes)}`}>{formatMinutesForHumans(shift.balanceMinutes)}</span>
                        </header>

                        <div className="hours-metric-strip">
                            <span>Entrada contada: {formatDateTime(shift.countedStartAt)}</span>
                            <span>Saída usada no cálculo: {formatDateTime(shift.countedEndAt)}</span>
                            <span>Atraso: {formatMinutesForHumans(shift.arrivalDelayMinutes)}</span>
                            <span>Crédito: {formatMinutesForHumans(shift.creditedOvertimeMinutes)}</span>
                        </div>

                        <section className="hours-proof-box">
                            <span className="hours-proof-label">Por que ficou assim</span>
                            <strong>{shift.proof.summary}</strong>
                            <ul className="hours-proof-list">
                                {shift.proof.items.map((item) => <li key={item}>{item}</li>)}
                            </ul>
                        </section>
                    </article>
                ))}
            </div>

            {doctor.shifts.length > recentShifts.length ? (
                <p className="hours-settlement-hint">
                    Mostrando os {RECENT_SHIFT_LIMIT} plantões mais recentes de {doctor.shiftCount}. O saldo acima considera todos.
                </p>
            ) : null}
        </main>
    );
}
