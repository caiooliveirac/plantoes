import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { AdminGlobalNavigationLinks } from "@/components/admin-global-navigation-links";
import { getOperationalSlotAuditReport } from "@/services/slot-audit.service";

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

function formatDateInput(value: string) {
    return value.slice(0, 10);
}

function formatDateLabel(value: string) {
    return new Intl.DateTimeFormat("pt-BR", {
        dateStyle: "full",
        timeZone: "America/Sao_Paulo",
    }).format(new Date(`${value}T12:00:00.000Z`));
}

function domainLabel(domain: "regulation" | "intervention") {
    return domain === "regulation" ? "Regulação" : "Intervenção";
}

export default async function AdminSlotAuditPage({
    searchParams,
}: {
    searchParams: Promise<{ start?: string; end?: string; shift?: string }>;
}) {
    if (!hasDatabaseUrl()) {
        return <SlotAuditUnavailable title="Banco indisponível" copy="Sem DATABASE_URL não existe base para auditar os slots anteriores." />;
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

    const { start, end, shift } = await searchParams;
    let loadError: string | null = null;
    let report;

    try {
        report = await getOperationalSlotAuditReport({
            startDate: start ?? null,
            endDate: end ?? null,
            shiftLabel: shift === "SD" || shift === "SN" ? shift : null,
        });
    } catch (error) {
        loadError = error instanceof Error ? error.message : "Nao foi possivel montar a auditoria.";
        report = await getOperationalSlotAuditReport();
    }

    return (
        <main className="payment-shell slot-audit-shell">
            <section className="payment-hero slot-audit-hero">
                <div>
                    <p className="payment-eyebrow">Auditoria operacional</p>
                    <h1>Slots retrospectivos para cruzar vazios, nomes e posto por turno.</h1>
                    <p className="payment-subtitle">
                        Esta leitura usa o mesmo board consolidado do fechamento, então o privado do Telegram e a tela admin
                        enxergam o mesmo retrato de SD e SN. O foco aqui é detectar onde o posto ficou vazio e quem estava em cada alvo nos dias anteriores.
                    </p>

                    <div className="payment-summary-grid">
                        <article className="payment-summary-card ready">
                            <span>Turnos no recorte</span>
                            <strong>{report.summary.slotCount}</strong>
                        </article>
                        <article className="payment-summary-card ready">
                            <span>Postos ocupados</span>
                            <strong>{report.summary.occupiedCount}</strong>
                        </article>
                        <article className="payment-summary-card empty">
                            <span>Slots vazios</span>
                            <strong>{report.summary.emptyCount}</strong>
                        </article>
                        <article className="payment-summary-card review">
                            <span>Bases desativadas</span>
                            <strong>{report.summary.disabledCount}</strong>
                        </article>
                    </div>
                </div>

                <div className="slot-audit-hero-meta">
                    <span className="payment-status-pill large ready">{report.dayCount} dia(s)</span>
                    <span className="slot-audit-range-label">{formatDateLabel(report.startDate)} até {formatDateLabel(report.endDate)}</span>
                    <AdminGlobalNavigationLinks current="slot-audit" containerClassName="payment-hero-actions" />
                </div>
            </section>

            <form className="payment-filter-bar" method="get">
                <label className="payment-filter-field compact">
                    <span>Data inicial</span>
                    <input type="date" name="start" defaultValue={formatDateInput(report.startDate)} />
                </label>

                <label className="payment-filter-field compact">
                    <span>Data final</span>
                    <input type="date" name="end" defaultValue={formatDateInput(report.endDate)} />
                </label>

                <label className="payment-filter-field compact">
                    <span>Turno</span>
                    <select name="shift" defaultValue={report.shiftLabel ?? ""}>
                        <option value="">SD + SN</option>
                        <option value="SD">Somente SD</option>
                        <option value="SN">Somente SN</option>
                    </select>
                </label>

                <div className="payment-filter-actions">
                    <button type="submit" className="payment-button primary">Aplicar recorte</button>
                    <a className="payment-button" href="/admin/slot-audit">Ultimos 7 dias</a>
                </div>
            </form>

            {loadError && (
                <div className="payment-inline-banner danger">
                    <strong>Filtro ajustado para o padrao</strong>
                    <span>{loadError}</span>
                </div>
            )}

            <section className="slot-audit-grid">
                {report.slots.map((slot) => (
                    <article key={`${slot.operationalDate}:${slot.shiftLabel}`} className="slot-audit-slot-card">
                        <header className="slot-audit-slot-header">
                            <div>
                                <p className="payment-eyebrow">{formatDateLabel(slot.operationalDate)}</p>
                                <h2>{slot.shiftLabel}</h2>
                            </div>

                            <div className="slot-audit-slot-kpis">
                                <span className="payment-status-pill ready">{slot.occupiedCount} ocupados</span>
                                <span className="payment-status-pill empty">{slot.emptyCount} vazios</span>
                                <span className="payment-status-pill disabled">{slot.disabledCount} desativadas</span>
                            </div>
                        </header>

                        <div className="slot-audit-columns">
                            {[slot.regulation, slot.intervention].map((entries) => (
                                <section key={`${slot.operationalDate}:${slot.shiftLabel}:${entries[0]?.domain ?? "none"}`} className="slot-audit-domain-card">
                                    <div className="slot-audit-domain-header">
                                        <strong>{domainLabel(entries[0]?.domain ?? "regulation")}</strong>
                                        <span>{entries.length} alvo(s)</span>
                                    </div>

                                    <ul className="slot-audit-entry-list">
                                        {entries.map((entry) => (
                                            <li key={`${entry.domain}:${entry.targetCode}`} className={`slot-audit-entry ${entry.status}`.trim()}>
                                                <span className="slot-audit-entry-code">{entry.targetCode}</span>
                                                <span className="slot-audit-entry-name">{entry.doctorLabel}</span>
                                            </li>
                                        ))}
                                    </ul>
                                </section>
                            ))}
                        </div>
                    </article>
                ))}
            </section>
        </main>
    );
}