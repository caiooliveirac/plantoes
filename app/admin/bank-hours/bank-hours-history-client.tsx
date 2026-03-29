"use client";

import { useDeferredValue, useEffect, useMemo, useState } from "react";
import type { BankHoursDoctorHistory, BankHoursHistoryModel, BankHoursHistoryShift } from "@/modules/reporting/bank-hours-history";
import { formatMinutesForHumans } from "@/modules/reporting/monthly-report";

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

function formatDate(value: string | null) {
    if (!value) {
        return "--";
    }

    return new Intl.DateTimeFormat("pt-BR", {
        dateStyle: "medium",
        timeZone: "America/Sao_Paulo",
    }).format(new Date(value));
}

function formatDomain(domain: BankHoursHistoryShift["domain"]) {
    return domain === "regulation" ? "Regulação" : "Intervenção";
}

function formatSource(source: BankHoursHistoryShift["source"]) {
    if (source === "admin_correction") {
        return "Correção";
    }

    if (source === "manual") {
        return "Manual";
    }

    if (source === "telegram") {
        return "Telegram";
    }

    return "Importação";
}

function normalizeSearch(value: string) {
    return value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .trim();
}

function shiftBalanceClass(value: number | null) {
    if (value === null || value === 0) {
        return "neutral";
    }

    return value > 0 ? "positive" : "negative";
}

function proofToneClass(mode: BankHoursHistoryShift["proof"]["mode"]) {
    if (mode === "handoff") {
        return "warn";
    }

    if (mode === "double_overtime") {
        return "ok";
    }

    if (mode === "simple_overtime") {
        return "info";
    }

    if (mode === "debit") {
        return "danger";
    }

    return "neutral";
}

function summarizeDoctorSearch(doctor: BankHoursDoctorHistory) {
    return normalizeSearch([
        doctor.displayName ?? doctor.doctorName,
        doctor.doctorName,
        ...doctor.shifts.flatMap((shift) => [shift.targetCode, shift.targetLabel]),
    ].join(" "));
}

function renderDoctorLead(doctor: BankHoursDoctorHistory) {
    if (doctor.handoffOverrideCount > 0) {
        return `${doctor.handoffOverrideCount} plantões com rendição prevalecendo sobre a saída física.`;
    }

    if (doctor.lateArrivalCount > 0) {
        return `${doctor.lateArrivalCount} plantões com atraso de chegada abatido no saldo.`;
    }

    if (doctor.correctionCount > 0) {
        return `${doctor.correctionCount} plantões com intervenção manual auditada.`;
    }

    return "Histórico limpo, sem divergência sensível recente.";
}

function renderProofLead(shift: BankHoursHistoryShift) {
    if (shift.proof.mode === "handoff") {
        return "A prova principal aqui é a separação entre quem saiu fisicamente e quando a responsabilidade já tinha sido transferida.";
    }

    if (shift.proof.mode === "double_overtime") {
        return "A leitura principal aqui é que a entrada ficou dentro da tolerância e preservou o crédito em dobro.";
    }

    if (shift.proof.mode === "simple_overtime") {
        return "A leitura principal aqui é que houve permanência extra, mas a chegada tardia tirou o bônus em dobro.";
    }

    if (shift.proof.mode === "debit") {
        return "A leitura principal aqui é que o débito de chegada pesou mais do que qualquer permanência adicional.";
    }

    return "A leitura principal aqui é que o registro permaneceu alinhado com a janela efetivamente contabilizada.";
}

interface Props {
    history: BankHoursHistoryModel;
}

export function BankHoursHistoryClient({ history }: Props) {
    const [search, setSearch] = useState("");
    const deferredSearch = useDeferredValue(search);
    const [selectedDoctorId, setSelectedDoctorId] = useState(history.doctors[0]?.doctorId ?? null);

    const filteredDoctors = useMemo(() => {
        const normalized = normalizeSearch(deferredSearch);
        if (!normalized) {
            return history.doctors;
        }

        return history.doctors.filter((doctor) => summarizeDoctorSearch(doctor).includes(normalized));
    }, [deferredSearch, history.doctors]);

    const selectedDoctor = filteredDoctors.find((doctor) => doctor.doctorId === selectedDoctorId)
        ?? history.doctors.find((doctor) => doctor.doctorId === selectedDoctorId)
        ?? filteredDoctors[0]
        ?? history.doctors[0]
        ?? null;

    useEffect(() => {
        if (!selectedDoctor && filteredDoctors[0]) {
            setSelectedDoctorId(filteredDoctors[0].doctorId);
            return;
        }

        if (selectedDoctor && selectedDoctor.doctorId !== selectedDoctorId) {
            setSelectedDoctorId(selectedDoctor.doctorId);
        }
    }, [filteredDoctors, selectedDoctor, selectedDoctorId]);

    return (
        <main className="hours-shell">
            <section className="hours-hero">
                <div>
                    <p className="reports-kicker">Banco de horas</p>
                    <h1>Prova operacional por médico, com saldo acumulado e justificativa por plantão.</h1>
                    <p className="hours-subtitle">
                        Esta visão foi desenhada para responder contestação com prova. A coordenadora vê o histórico completo, o saldo acumulado e, em cada plantão, qual horário entrou no cálculo e por que ele pode ser diferente do horário físico registrado depois.
                    </p>
                </div>

                <div className="hours-hero-actions">
                    <a className="reports-secondary-link" href="/admin/reports">Abrir auditoria mensal</a>
                    <a className="reports-secondary-link" href="/">Voltar ao quadro</a>
                </div>
            </section>

            <section className="hours-summary-grid">
                <article className="hours-summary-card">
                    <span className="reports-summary-label">Médicos com histórico</span>
                    <strong>{history.summary.doctorCount}</strong>
                    <span>{history.summary.shiftCount} plantões consolidados</span>
                </article>
                <article className="hours-summary-card">
                    <span className="reports-summary-label">Saldo acumulado</span>
                    <strong>{formatMinutesForHumans(history.summary.balanceMinutes)}</strong>
                    <span>{formatMinutesForHumans(history.summary.workedMinutes)} trabalhados</span>
                </article>
                <article className="hours-summary-card warn">
                    <span className="reports-summary-label">Rendição prevaleceu</span>
                    <strong>{history.summary.handoffOverrideCount}</strong>
                    <span>plantões em que a prova precisou separar rendição de saída física</span>
                </article>
                <article className="hours-summary-card danger">
                    <span className="reports-summary-label">Correções e atrasos</span>
                    <strong>{history.summary.correctionCount + history.summary.lateArrivalCount}</strong>
                    <span>{history.summary.lateArrivalCount} atrasos e {history.summary.correctionCount} correções auditadas</span>
                </article>
            </section>

            <section className="hours-filter-bar">
                <label className="hours-filter-field hours-filter-search">
                    <span>Buscar médico</span>
                    <input
                        type="search"
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder="Nome, base ou posto"
                    />
                </label>
                <div className="hours-filter-copy">
                    <span className="reports-summary-label">Leitura principal</span>
                    <p>Primeiro o saldo acumulado do médico. Depois, a prova fina plantão por plantão: janela prevista, entrada contada, rendição, saída física e regra aplicada.</p>
                </div>
            </section>

            <section className="hours-principles-grid">
                <article className="hours-principle-card">
                    <span className="hours-proof-label">Princípio 1</span>
                    <strong>Quem assume o posto encerra a permanência válida de quem saiu.</strong>
                    <p>Quando a rendição acontece antes da saída física, a prova precisa mostrar os dois horários e deixar claro que o banco para na transferência da cobertura.</p>
                </article>
                <article className="hours-principle-card">
                    <span className="hours-proof-label">Princípio 2</span>
                    <strong>Entrada no prazo decide se a permanência final pode valer em dobro.</strong>
                    <p>Se a chegada estourou a tolerância, a permanência pode continuar existindo, mas perde o bônus dobrado. A tela precisa deixar esse ponto impossível de confundir.</p>
                </article>
                <article className="hours-principle-card accent">
                    <span className="hours-proof-label">Princípio 3</span>
                    <strong>A contestação deve ser respondida com trilha e não com interpretação.</strong>
                    <p>Cada linha combina origem do registro, regra aplicada e histórico de edição para que a coordenação tenha defesa operacional pronta.</p>
                </article>
            </section>

            <section className="hours-grid">
                <div className="hours-directory-column">
                    <header className="hours-directory-header">
                        <div>
                            <p className="reports-kicker">Médicos</p>
                            <h2>Escolha o histórico que precisa ser defendido.</h2>
                        </div>
                        <span className="reports-badge neutral">{filteredDoctors.length} resultados</span>
                    </header>

                    {filteredDoctors.length === 0 ? (
                        <article className="hours-empty-state">
                            <strong>Nenhum médico encontrado.</strong>
                            <span>Ajuste a busca para abrir outro histórico.</span>
                        </article>
                    ) : filteredDoctors.map((doctor) => (
                        <button
                            key={doctor.doctorId}
                            type="button"
                            className={`hours-doctor-card ${selectedDoctor?.doctorId === doctor.doctorId ? "selected" : ""}`.trim()}
                            onClick={() => setSelectedDoctorId(doctor.doctorId)}
                        >
                            <div>
                                <strong>{doctor.displayName || doctor.doctorName}</strong>
                                <span>{doctor.doctorName}</span>
                            </div>

                            <p className="hours-doctor-lead">{renderDoctorLead(doctor)}</p>

                            <div className="hours-doctor-badges">
                                <span className={`hours-balance-pill ${shiftBalanceClass(doctor.balanceMinutes)}`}>{formatMinutesForHumans(doctor.balanceMinutes)}</span>
                                <span className="reports-badge neutral">{doctor.shiftCount} plantões</span>
                                {doctor.handoffOverrideCount > 0 && (
                                    <span className="reports-badge warn">{doctor.handoffOverrideCount} rendições-prova</span>
                                )}
                                {doctor.lateArrivalCount > 0 && (
                                    <span className="reports-badge danger">{doctor.lateArrivalCount} atrasos</span>
                                )}
                            </div>

                            <div className="hours-doctor-footer">
                                <span>Último plantão: {formatDate(doctor.lastShiftAt)}</span>
                                <span>{formatMinutesForHumans(doctor.creditedOvertimeMinutes)} em crédito</span>
                            </div>
                        </button>
                    ))}
                </div>

                <aside className="hours-detail-panel">
                    {selectedDoctor ? (
                        <>
                            <header className="hours-detail-header">
                                <div>
                                    <p className="reports-kicker">Histórico do médico</p>
                                    <h2>{selectedDoctor.displayName || selectedDoctor.doctorName}</h2>
                                    <p>{selectedDoctor.doctorName}</p>
                                </div>
                                <span className={`hours-balance-pill large ${shiftBalanceClass(selectedDoctor.balanceMinutes)}`}>{formatMinutesForHumans(selectedDoctor.balanceMinutes)}</span>
                            </header>

                            <section className="hours-kpi-grid">
                                <article className="hours-kpi-card">
                                    <span className="reports-summary-label">Trabalhado</span>
                                    <strong>{formatMinutesForHumans(selectedDoctor.workedMinutes)}</strong>
                                </article>
                                <article className="hours-kpi-card">
                                    <span className="reports-summary-label">Crédito total</span>
                                    <strong>{formatMinutesForHumans(selectedDoctor.creditedOvertimeMinutes)}</strong>
                                </article>
                                <article className="hours-kpi-card">
                                    <span className="reports-summary-label">Débito por atraso</span>
                                    <strong>{formatMinutesForHumans(selectedDoctor.arrivalDelayMinutes)}</strong>
                                </article>
                                <article className="hours-kpi-card">
                                    <span className="reports-summary-label">Último plantão</span>
                                    <strong>{formatDateTime(selectedDoctor.lastShiftAt)}</strong>
                                </article>
                            </section>

                            <section className="hours-doctor-summary-strip">
                                <article className="hours-mini-note">
                                    <span className="hours-proof-label">Saldo executivo</span>
                                    <strong>{formatMinutesForHumans(selectedDoctor.balanceMinutes)}</strong>
                                    <p>Resultado acumulado pronto para leitura gerencial.</p>
                                </article>
                                <article className="hours-mini-note">
                                    <span className="hours-proof-label">Ponto mais sensível</span>
                                    <strong>{renderDoctorLead(selectedDoctor)}</strong>
                                    <p>Este é o argumento que tende a ser mais questionado neste histórico.</p>
                                </article>
                                <article className="hours-mini-note">
                                    <span className="hours-proof-label">Base de prova</span>
                                    <strong>Janela, contagem e auditoria lado a lado.</strong>
                                    <p>Nunca só o horário visível no quadro. Sempre o horário efetivamente contado no banco.</p>
                                </article>
                            </section>

                            <section className="hours-plan-box">
                                <p className="reports-summary-label">O que esta tela prova</p>
                                <h3>Quando houver divergência aparente, a prova vem do horário realmente contado no banco.</h3>
                                <p>
                                    Exemplo típico: se alguém saiu fisicamente às 19:50, mas já tinha sido rendido às 19:20, o plantão deixa de gerar permanência válida depois da rendição. A linha abaixo deixa esse raciocínio explícito, com os horários lado a lado.
                                </p>
                            </section>

                            <div className="hours-shift-list">
                                {selectedDoctor.shifts.map((shift) => (
                                    <article key={`${shift.domain}-${shift.occupancyId}`} className="hours-shift-card">
                                        <header className="hours-shift-header">
                                            <div>
                                                <div className="hours-shift-title">
                                                    <span className={`reports-badge ${shift.domain === "regulation" ? "warn" : "ok"}`.trim()}>{formatDomain(shift.domain)}</span>
                                                    <strong>{shift.targetCode} · {shift.targetLabel}</strong>
                                                </div>
                                                <span className="hours-shift-subtitle">{formatDateTime(shift.startedAt)} · {formatSource(shift.source)} · {shift.shiftLabel ?? "sem turno"}</span>
                                            </div>
                                            <span className={`hours-balance-pill ${shiftBalanceClass(shift.balanceMinutes)}`}>{formatMinutesForHumans(shift.balanceMinutes)}</span>
                                        </header>

                                        <div className="hours-metric-strip">
                                            <span>Trabalhado: {formatMinutesForHumans(shift.workedMinutes)}</span>
                                            <span>Atraso: {formatMinutesForHumans(shift.arrivalDelayMinutes)}</span>
                                            <span>Crédito: {formatMinutesForHumans(shift.creditedOvertimeMinutes)}</span>
                                            <span>Regra: {shift.ruleCode ?? "sem regra"}</span>
                                        </div>

                                        <div className="hours-reading-lead">
                                            <span className="hours-proof-label">Como ler este plantão</span>
                                            <p>{renderProofLead(shift)}</p>
                                        </div>

                                        <div className="hours-evidence-grid timeline">
                                            <div className="timeline-step">
                                                <span className="hours-evidence-label">Janela do banco</span>
                                                <strong>{formatDateTime(shift.bankScheduledStartAt)} até {formatDateTime(shift.bankScheduledEndAt)}</strong>
                                            </div>
                                            <div className="timeline-step emphasis-start">
                                                <span className="hours-evidence-label">Entrada contada</span>
                                                <strong>{formatDateTime(shift.countedStartAt)}</strong>
                                            </div>
                                            <div className={`timeline-step ${shift.proof.mode === "handoff" ? "emphasis-handoff" : ""}`.trim()}>
                                                <span className="hours-evidence-label">Rendição do quadro</span>
                                                <strong>{formatDateTime(shift.handoffEndedAt)}</strong>
                                            </div>
                                            <div className="timeline-step">
                                                <span className="hours-evidence-label">Saída física</span>
                                                <strong>{formatDateTime(shift.actualEndedAt)}</strong>
                                            </div>
                                            <div className={`timeline-step emphasis-end ${shift.proof.mode === "handoff" ? "counted" : ""}`.trim()}>
                                                <span className="hours-evidence-label">Saída usada no cálculo</span>
                                                <strong>{formatDateTime(shift.countedEndAt)}</strong>
                                            </div>
                                            <div className="timeline-step meta">
                                                <span className="hours-evidence-label">Criado por / atualizado por</span>
                                                <strong>{shift.createdByEmail ?? "sistema"} / {shift.updatedByEmail ?? "sem editor humano"}</strong>
                                            </div>
                                        </div>

                                        <section className={`hours-proof-box ${proofToneClass(shift.proof.mode)}`.trim()}>
                                            <span className="hours-proof-label">Por que o cálculo ficou assim</span>
                                            <strong>{shift.proof.summary}</strong>
                                            <ul className="hours-proof-list">
                                                {shift.proof.items.map((item) => <li key={item}>{item}</li>)}
                                            </ul>
                                        </section>

                                        {shift.auditTrail.length > 0 && (
                                            <section className="hours-audit-box">
                                                <span className="hours-proof-label">Trilha de auditoria</span>
                                                <div className="hours-audit-list">
                                                    {shift.auditTrail.map((entry) => (
                                                        <div className="hours-audit-item" key={entry.id}>
                                                            <div className="hours-audit-dot" />
                                                            <div>
                                                                <strong>{entry.action}</strong>
                                                                <span>{formatDateTime(entry.createdAt)} · {entry.actorEmail ?? "sistema"}</span>
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            </section>
                                        )}
                                    </article>
                                ))}
                            </div>
                        </>
                    ) : (
                        <article className="hours-empty-state">
                            <strong>Selecione um médico para abrir o histórico.</strong>
                            <span>O painel da direita mostra saldo acumulado, explicação por plantão e trilha de auditoria.</span>
                        </article>
                    )}
                </aside>
            </section>
        </main>
    );
}