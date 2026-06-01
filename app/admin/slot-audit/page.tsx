import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { AdminGlobalNavigationLinks } from "@/components/admin-global-navigation-links";
import { getSlotAuditReport, type SlotAuditPanel, type SlotAuditPosition } from "@/services/slot-audit.service";

export const dynamic = "force-dynamic";

function SlotAuditUnavailable({ title, copy }: { title: string; copy: string }) {
    return (
        <main className="payment-shell">
            <section className="payment-empty-state standalone large">
                <strong>{title}</strong>
                <span>{copy}</span>
                <AdminGlobalNavigationLinks current="slot-audit" containerClassName="payment-actions split" />
            </section>
        </main>
    );
}

function formatDateLabel(value: string) {
    return new Intl.DateTimeFormat("pt-BR", {
        dateStyle: "full",
        timeZone: "America/Bahia",
    }).format(new Date(`${value}T12:00:00.000Z`));
}

function formatClock(value: string | null) {
    if (!value) {
        return "--:--";
    }

    return new Intl.DateTimeFormat("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "America/Bahia",
    }).format(new Date(value));
}

const STATE_LABELS: Record<SlotAuditPosition["state"], string> = {
    occupied: "OCUPADO",
    pending: "PENDENTE",
    empty: "VAGO",
    disabled: "DESATIVADO",
};

function formatBalance(minutes: number | null) {
    if (minutes === null || minutes === undefined) {
        return null;
    }

    const sign = minutes > 0 ? "+" : minutes < 0 ? "-" : "";
    const absolute = Math.abs(minutes);
    const hours = Math.floor(absolute / 60);
    const remainder = absolute % 60;
    const body = hours > 0 ? `${hours}h${String(remainder).padStart(2, "0")}` : `${remainder}min`;
    return `${sign}${body}`;
}

function balanceTone(minutes: number | null) {
    if (minutes === null || minutes === undefined) {
        return "neutral";
    }

    if (minutes > 0) {
        return "positive";
    }

    if (minutes < 0) {
        return "negative";
    }

    return "neutral";
}

function PositionPanel({ panel }: { panel: SlotAuditPanel }) {
    return (
        <section className="slot-audit-panel">
            <header className="slot-audit-panel-header">
                <strong>{panel.title}</strong>
                <span className="payment-status-pill ready">{panel.activeCount} ativos</span>
            </header>

            <div className="slot-audit-table-head" aria-hidden="true">
                <span>Chegada</span>
                <span>Posição</span>
                <span>Vai receber</span>
                <span>Saída</span>
            </div>

            <ul className="slot-audit-position-list">
                {panel.positions.length === 0 && (
                    <li className="slot-audit-position empty-state">Sem posições para este turno.</li>
                )}

                {panel.positions.map((position) => {
                    const balance = formatBalance(position.balanceMinutes);
                    return (
                        <li
                            key={`${position.domain}:${position.targetCode}`}
                            className={`slot-audit-position ${position.state}${position.isInactiveTarget ? " inactive-target" : ""}`}
                        >
                            <span className="slot-audit-cell clock arrival">{formatClock(position.arrivalAt)}</span>

                            <span className="slot-audit-cell code">
                                {position.targetCode}
                                {position.isInactiveTarget && <em className="slot-audit-inactive-flag">desativada</em>}
                            </span>

                            <span className="slot-audit-cell occupant">
                                <span className="slot-audit-name">{position.doctorLabel}</span>
                                <span className={`slot-audit-state ${position.state}`}>{STATE_LABELS[position.state]}</span>
                            </span>

                            <span className="slot-audit-cell clock departure">{formatClock(position.departureAt)}</span>

                            {balance !== null && (
                                <span className={`slot-audit-balance ${balanceTone(position.balanceMinutes)}`} title="Saldo de banco de horas deste plantão">
                                    {balance}
                                </span>
                            )}
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}

export default async function AdminSlotAuditPage({
    searchParams,
}: {
    searchParams: Promise<{ date?: string; shift?: string }>;
}) {
    if (!hasDatabaseUrl()) {
        return <SlotAuditUnavailable title="Banco indisponível" copy="Sem DATABASE_URL não existe base para auditar o fechamento por posição." />;
    }

    try {
        await requireAuthenticatedSession(["admin"]);
    } catch (error) {
        if (error instanceof AuthError) {
            return (
                <SlotAuditUnavailable
                    title={error.status === 403 ? "Acesso restrito" : "Autenticação necessária"}
                    copy={error.message}
                />
            );
        }

        throw error;
    }

    const { date, shift } = await searchParams;
    let loadError: string | null = null;
    let report;

    try {
        report = await getSlotAuditReport({
            date: date ?? null,
            shiftLabel: shift === "SD" || shift === "SN" ? shift : null,
        });
    } catch (error) {
        loadError = error instanceof Error ? error.message : "Não foi possível montar a auditoria.";
        report = await getSlotAuditReport();
    }

    return (
        <main className="payment-shell slot-audit-shell">
            <section className="payment-hero slot-audit-hero">
                <div>
                    <p className="payment-eyebrow">Auditoria de fechamento por posição</p>
                    <h1>Quem ficou em cada ramal e base — e quem vai receber por isso.</h1>
                    <p className="payment-subtitle">
                        Cada linha é uma POSIÇÃO. O nome exibido é exatamente quem o fechamento de pagamento (payment-closing)
                        aponta como pagável naquele ramal/base no turno. A TAG mostra o saldo de banco de horas do plantão,
                        igual à tela de banco de horas. Use para conferir, numa olhada, se o plantão fechou certo.
                    </p>

                    <div className="payment-summary-grid">
                        <article className="payment-summary-card ready">
                            <span>Posições pagáveis</span>
                            <strong>{report.summary.payableCount}</strong>
                        </article>
                        <article className="payment-summary-card review">
                            <span>Pendentes</span>
                            <strong>{report.summary.pendingCount}</strong>
                        </article>
                        <article className="payment-summary-card empty">
                            <span>Vagas</span>
                            <strong>{report.summary.emptyCount}</strong>
                        </article>
                        <article className="payment-summary-card review">
                            <span>Desativadas</span>
                            <strong>{report.summary.disabledCount}</strong>
                        </article>
                    </div>
                </div>

                <div className="slot-audit-hero-meta">
                    <span className={`payment-status-pill large ${report.isClosed ? "ready" : "review"}`}>
                        {report.shiftLabel} · {report.isClosed ? "encerrado" : "em andamento"}
                    </span>
                    <span className="slot-audit-range-label">{formatDateLabel(report.operationalDate)}</span>
                    <span className="slot-audit-range-label">{formatClock(report.slotStartedAt)} às {formatClock(report.slotEndedAt)}</span>
                    <AdminGlobalNavigationLinks current="slot-audit" containerClassName="payment-hero-actions" />
                </div>
            </section>

            <form className="payment-filter-bar" method="get">
                <label className="payment-filter-field compact">
                    <span>Data do plantão</span>
                    <input type="date" name="date" defaultValue={report.operationalDate} />
                </label>

                <label className="payment-filter-field compact">
                    <span>Turno</span>
                    <select name="shift" defaultValue={report.shiftLabel}>
                        <option value="SD">SD (07h–19h)</option>
                        <option value="SN">SN (19h–07h)</option>
                    </select>
                </label>

                <div className="payment-filter-actions">
                    <button type="submit" className="payment-button primary">Auditar plantão</button>
                    <a className="payment-button" href="/admin/slot-audit">Plantão mais recente</a>
                </div>
            </form>

            {loadError && (
                <div className="payment-inline-banner danger">
                    <strong>Filtro ajustado para o padrão</strong>
                    <span>{loadError}</span>
                </div>
            )}

            <section className="slot-audit-board">
                <PositionPanel panel={report.regulation} />
                <PositionPanel panel={report.intervention} />
            </section>
        </main>
    );
}
