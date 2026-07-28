"use client";

import { useDeferredValue, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AdminBarNavMenu } from "@/components/admin-bar-nav-menu";
import type { BankHoursDoctorHistory, BankHoursHistoryModel, BankHoursHistoryShift } from "@/modules/reporting/bank-hours-history";
import { resolveBankHoursSettlementBalance } from "@/modules/reporting/bank-hours-settlement-rule";
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

function formatSignedMinutes(value: number) {
    return `${value > 0 ? "+" : ""}${formatMinutesForHumans(value)}`;
}

/** Gatilho do acerto de banco de horas: ±12h em minutos. */
const BANK_HOURS_SETTLEMENT_MINUTES = 12 * 60;

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
        doctor.doctorName,
        doctor.displayName ?? doctor.doctorName,
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

interface SettlementMonthOption {
    key: string;
    label: string;
}

interface Props {
    history: BankHoursHistoryModel;
    canManageOverrides: boolean;
    settlementMonths: SettlementMonthOption[];
}

function shiftKey(shift: BankHoursHistoryShift) {
    return `${shift.domain}:${shift.occupancyId}`;
}

export function BankHoursHistoryClient({ history, canManageOverrides, settlementMonths }: Props) {
    const router = useRouter();
    const [search, setSearch] = useState("");
    const deferredSearch = useDeferredValue(search);
    const [selectedDoctorId, setSelectedDoctorId] = useState(history.doctors[0]?.doctorId ?? null);
    const [overrideMinutesByShift, setOverrideMinutesByShift] = useState<Record<string, string>>({});
    const [overrideNotesByShift, setOverrideNotesByShift] = useState<Record<string, string>>({});
    const [overrideErrorsByShift, setOverrideErrorsByShift] = useState<Record<string, string>>({});
    const [savingShiftKey, setSavingShiftKey] = useState<string | null>(null);
    const [isSaving, startSavingTransition] = useTransition();
    const [settlementMonth, setSettlementMonth] = useState(settlementMonths[0]?.key ?? "");
    // Gaveta "Como ler" da faixa de comando (absorveu o herói e os princípios).
    const [guideOpen, setGuideOpen] = useState(false);
    const detailPanelRef = useRef<HTMLElement | null>(null);

    // Em layout empilhado (≤1180px) o detalhe fica ABAIXO da lista inteira de
    // médicos — sem isso o admin precisa arrastar a página toda após o clique.
    function selectDoctor(doctorId: string) {
        setSelectedDoctorId(doctorId);
        if (window.matchMedia("(max-width: 1180px)").matches) {
            // Timeout curto: espera o React commitar o novo detalhe antes de rolar.
            // behavior "auto" (salto): o smooth era abortado pelo re-render do painel.
            window.setTimeout(() => {
                detailPanelRef.current?.scrollIntoView({ behavior: "auto", block: "start" });
            }, 80);
        }
    }

    useEffect(() => {
        const nextMinutes: Record<string, string> = {};
        const nextNotes: Record<string, string> = {};

        for (const doctor of history.doctors) {
            for (const shift of doctor.shifts) {
                nextMinutes[shiftKey(shift)] = String(shift.manualBalanceMinutes ?? shift.balanceMinutes ?? 0);
                nextNotes[shiftKey(shift)] = shift.manualBalanceNotes ?? "";
            }
        }

        setOverrideMinutesByShift(nextMinutes);
        setOverrideNotesByShift(nextNotes);
        setOverrideErrorsByShift({});
        setSavingShiftKey(null);
    }, [history.generatedAt, history.doctors]);

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

    async function submitManualOverride(shift: BankHoursHistoryShift) {
        const key = shiftKey(shift);
        const rawMinutes = (overrideMinutesByShift[key] ?? "").trim();
        const minutes = Number(rawMinutes);
        const notes = (overrideNotesByShift[key] ?? "").trim();

        if (!Number.isInteger(minutes)) {
            throw new Error("Digite o saldo final em minutos inteiros, por exemplo 0, 30 ou -15.");
        }

        if (notes.length < 8) {
            throw new Error("Explique o motivo com pelo menos 8 caracteres.");
        }

        const response = await fetch("/api/admin/bank-hours/overrides", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                domain: shift.domain,
                occupancyId: shift.occupancyId,
                balanceMinutes: minutes,
                notes,
            }),
        });
        const body = await response.json().catch(() => null) as { error?: string } | null;
        if (!response.ok) {
            throw new Error(body?.error || "Nao foi possivel salvar o ajuste manual.");
        }

        router.refresh();
    }

    return (
        <main className="hours-shell">
            {/* Faixa de comando compacta: busca + KPIs + gaveta "Como ler" + navegação ••• */}
            <section className="admin-bar-frame standalone">
                <header className="admin-bar">
                    <span className="admin-bar-kicker">Banco de horas</span>
                    <input
                        type="search"
                        className="admin-bar-search"
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder="Buscar médico, base ou posto"
                        aria-label="Buscar médico"
                    />
                    <span className="admin-bar-divider" aria-hidden="true" />
                    <div className="admin-bar-kpis">
                        <div className="admin-bar-kpi">
                            <strong>{history.summary.doctorCount}</strong>
                            <span>médicos</span>
                        </div>
                        <div className="admin-bar-kpi">
                            <strong>{history.summary.shiftCount}</strong>
                            <span>plantões</span>
                        </div>
                        <div className="admin-bar-kpi" title={`${formatMinutesForHumans(history.summary.workedMinutes)} trabalhados`}>
                            <strong>{formatMinutesForHumans(history.summary.balanceMinutes)}</strong>
                            <span>saldo acumulado</span>
                        </div>
                        <div className="admin-bar-kpi warn" title="Plantões em que a prova precisou separar rendição de saída física">
                            <strong>{history.summary.handoffOverrideCount}</strong>
                            <span>rendição-prova</span>
                        </div>
                        <div
                            className="admin-bar-kpi danger"
                            title={`${history.summary.lateArrivalCount} atrasos e ${history.summary.correctionCount} correções auditadas`}
                        >
                            <strong>{history.summary.correctionCount + history.summary.lateArrivalCount}</strong>
                            <span>atrasos + correções</span>
                        </div>
                    </div>
                    <div className="admin-bar-actions">
                        <button
                            type="button"
                            className={`admin-bar-filters-toggle ${guideOpen ? "open" : ""}`.trim()}
                            onClick={() => setGuideOpen((prev) => !prev)}
                            aria-expanded={guideOpen}
                        >
                            Como ler
                            <span aria-hidden="true">{guideOpen ? "▴" : "▾"}</span>
                        </button>
                        <AdminBarNavMenu current="bank-hours" />
                    </div>
                </header>

                {guideOpen ? (
                    <div className="admin-bar-drawer">
                        <div className="admin-bar-drawer-inner">
                            <div className="admin-bar-drawer-grid">
                                <div className="admin-bar-drawer-group">
                                    <span>Leitura principal</span>
                                    <p>Primeiro o saldo acumulado do médico. Depois, a prova fina plantão por plantão: janela prevista, entrada contada, rendição, saída física e regra aplicada.</p>
                                </div>
                                <div className="admin-bar-drawer-group">
                                    <span>Princípio 1 · rendição encerra a permanência</span>
                                    <p>Quando a rendição acontece antes da saída física, a prova mostra os dois horários e deixa claro que o banco para na transferência da cobertura.</p>
                                </div>
                                <div className="admin-bar-drawer-group">
                                    <span>Princípio 2 · entrada no prazo decide o dobro</span>
                                    <p>Se a chegada estourou a tolerância, a permanência pode continuar existindo, mas perde o bônus dobrado.</p>
                                </div>
                                <div className="admin-bar-drawer-group">
                                    <span>Princípio 3 · contestação com trilha</span>
                                    <p>Cada linha combina origem do registro, regra aplicada e histórico de edição para que a coordenação tenha defesa operacional pronta.</p>
                                </div>
                            </div>
                        </div>
                    </div>
                ) : null}
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
                            onClick={() => selectDoctor(doctor.doctorId)}
                        >
                            <div>
                                <strong>{doctor.doctorName}</strong>
                                <span>{doctor.displayName && doctor.displayName !== doctor.doctorName ? doctor.displayName : "Apelido não configurado"}</span>
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

                <aside className="hours-detail-panel" ref={detailPanelRef}>
                    {selectedDoctor ? (
                        <>
                            <header className="hours-detail-header">
                                <div>
                                    <p className="reports-kicker">Histórico do médico</p>
                                    <h2>{selectedDoctor.doctorName}</h2>
                                    <p>{selectedDoctor.displayName && selectedDoctor.displayName !== selectedDoctor.doctorName ? selectedDoctor.displayName : "Apelido não configurado"}</p>
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

                            {selectedDoctor.legacy ? (
                                <section className="hours-settlements">
                                    <p className="reports-summary-label">Composição do saldo</p>
                                    <ul className="hours-composition-list">
                                        <li className="hours-composition-row">
                                            <span className="hours-composition-label">Saldo até 30/abr/2025</span>
                                            <span className="hours-composition-origin">{selectedDoctor.legacy.source}</span>
                                            <span className={`hours-balance-pill ${shiftBalanceClass(selectedDoctor.legacy.preMay2025Minutes)}`}>{formatSignedMinutes(selectedDoctor.legacy.preMay2025Minutes)}</span>
                                        </li>
                                        <li className="hours-composition-row">
                                            <span className="hours-composition-label">Saldo mai/2025 → mai/2026</span>
                                            <span className="hours-composition-origin">{selectedDoctor.legacy.source}</span>
                                            <span className={`hours-balance-pill ${shiftBalanceClass(selectedDoctor.legacy.spreadsheetPeriodMinutes)}`}>{formatSignedMinutes(selectedDoctor.legacy.spreadsheetPeriodMinutes)}</span>
                                        </li>
                                        <li className="hours-composition-row">
                                            <span className="hours-composition-label">Saldo apurado pela aplicação (desde o corte)</span>
                                            <span className="hours-composition-origin">Registros da aplicação, incluindo acertos do fechamento</span>
                                            <span className={`hours-balance-pill ${shiftBalanceClass(selectedDoctor.applicationBalanceMinutes)}`}>{formatSignedMinutes(selectedDoctor.applicationBalanceMinutes)}</span>
                                        </li>
                                        <li className="hours-composition-row total">
                                            <span className="hours-composition-label">Saldo final</span>
                                            <span className="hours-composition-origin">Planilha ({selectedDoctor.legacy.spreadsheetName}) + aplicação</span>
                                            <span className={`hours-balance-pill ${shiftBalanceClass(selectedDoctor.balanceMinutes)}`}>{formatSignedMinutes(selectedDoctor.balanceMinutes)}</span>
                                        </li>
                                    </ul>
                                    {selectedDoctor.legacy.notes ? (
                                        <p className="hours-settlement-hint" title={selectedDoctor.legacy.notes}>
                                            Observação da auditoria da planilha: {selectedDoctor.legacy.notes}
                                        </p>
                                    ) : null}
                                </section>
                            ) : null}

                            {selectedDoctor.settlements.length > 0 ? (
                                <section className="hours-settlements">
                                    <p className="reports-summary-label">Acertos lançados no fechamento</p>
                                    <ul className="hours-settlements-list">
                                        {selectedDoctor.settlements.map((settlement) => (
                                            <li
                                                key={settlement.id}
                                                className={`hours-settlement-row ${settlement.kind === "bonus" ? "bonus" : "penalty"}`}
                                            >
                                                <span className="hours-settlement-tag">
                                                    {settlement.kind === "bonus" ? "Bônus" : "Punição"}
                                                </span>
                                                <span className="hours-settlement-month">{settlement.monthKey}</span>
                                                <span className="hours-settlement-delta">
                                                    {settlement.deltaMinutes > 0 ? "+" : ""}
                                                    {formatMinutesForHumans(settlement.deltaMinutes)}
                                                </span>
                                                <span className="hours-settlement-notes">{settlement.notes}</span>
                                            </li>
                                        ))}
                                    </ul>
                                    <p className="hours-settlement-hint">
                                        Cada acerto move o saldo 12h em direção a zero e gera um plantão {""}
                                        <strong>verde</strong> (bônus) ou <strong>vermelho</strong> (punição) no fechamento daquele mês.
                                    </p>
                                </section>
                            ) : null}

                            {canManageOverrides ? (
                                <section className="hours-settlements hours-settlement-action">
                                    <p className="reports-summary-label">Abater banco de horas (±12h)</p>
                                    <p className="hours-settlement-hint">
                                        O acerto gera um plantão <strong>verde</strong> (bônus, remunera o crédito e abate 12h do saldo) ou <strong>vermelho</strong> (punição, desconta no pagamento e devolve 12h ao saldo). Como o plantão nasce no fechamento — onde ele de fato aparece e conta no pagamento —, o lançamento é feito no <strong>payment-closing</strong>. Repita a cada 12h enquanto o saldo passar de ±12h.
                                    </p>

                                    <label className="hours-settlement-month-field">
                                        <span>Mês do fechamento (onde o plantão vai aparecer)</span>
                                        <select
                                            value={settlementMonth}
                                            onChange={(event) => setSettlementMonth(event.target.value)}
                                            disabled={settlementMonths.length === 0}
                                        >
                                            {settlementMonths.map((month) => (
                                                <option key={month.key} value={month.key}>{month.label}</option>
                                            ))}
                                        </select>
                                    </label>

                                    {(() => {
                                        // Régua do acerto: só horas desde mai/2025 pagam/punem; dívida
                                        // anterior a mai/2025 é amortizada antes de qualquer bônus.
                                        const settleBalance = resolveBankHoursSettlementBalance({
                                            oldMinutes: selectedDoctor.legacy?.preMay2025Minutes ?? 0,
                                            recentMinutes: (selectedDoctor.legacy?.spreadsheetPeriodMinutes ?? 0) + selectedDoctor.applicationBalanceMinutes,
                                        });
                                        if (settleBalance.bonusEligibleMinutes >= BANK_HOURS_SETTLEMENT_MINUTES) {
                                            return (
                                                <a
                                                    className="payment-button bank-bonus"
                                                    href={`/admin/payment-closing?month=${encodeURIComponent(settlementMonth)}&doctor=${encodeURIComponent(selectedDoctor.doctorId)}`}
                                                >
                                                    Lançar bônus (+1 plantão verde) no fechamento →
                                                </a>
                                            );
                                        }
                                        if (settleBalance.penaltyEligibleMinutes <= -BANK_HOURS_SETTLEMENT_MINUTES) {
                                            return (
                                                <a
                                                    className="payment-button bank-penalty"
                                                    href={`/admin/payment-closing?month=${encodeURIComponent(settlementMonth)}&doctor=${encodeURIComponent(selectedDoctor.doctorId)}`}
                                                >
                                                    Lançar punição (1 plantão vermelho) no fechamento →
                                                </a>
                                            );
                                        }
                                        if (settleBalance.oldMinutes < 0 && settleBalance.recentMinutes > 0) {
                                            return (
                                                <p className="hours-settlement-hint">
                                                    As horas formadas desde mai/2025 ({formatSignedMinutes(settleBalance.recentMinutes)}) ainda amortizam a dívida
                                                    anterior a mai/2025 ({formatSignedMinutes(settleBalance.oldMinutes)}) — sem bônus até quitar. Saldo elegível:{" "}
                                                    {formatSignedMinutes(settleBalance.bonusEligibleMinutes)}.
                                                </p>
                                            );
                                        }
                                        return (
                                            <p className="hours-settlement-hint">
                                                Saldo elegível (desde mai/2025) dentro de ±12h — sem acerto disponível. A parcela anterior a mai/2025 não entra na régua.
                                            </p>
                                        );
                                    })()}
                                </section>
                            ) : null}

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

                                        {canManageOverrides && (
                                            <section className="hours-override-box">
                                                <div className="hours-override-header">
                                                    <div>
                                                        <span className="hours-proof-label">Ajuste manual do saldo</span>
                                                        <strong>Forçar o saldo final desse plantão em minutos</strong>
                                                    </div>
                                                    {shift.manualBalanceMinutes !== null && (
                                                        <span className="reports-badge warn">override ativo</span>
                                                    )}
                                                </div>

                                                <p>
                                                    Use quando o plantão deve permanecer no histórico, mas o saldo final precisa ser corrigido por decisão administrativa. O valor digitado passa a valer em saídas, na leitura de pagamento e nesta prova do banco.
                                                </p>

                                                <div className="hours-override-grid">
                                                    <label className="hours-override-field compact">
                                                        <span>Saldo final em minutos</span>
                                                        <input
                                                            type="number"
                                                            value={overrideMinutesByShift[shiftKey(shift)] ?? ""}
                                                            onChange={(event) => setOverrideMinutesByShift((current) => ({ ...current, [shiftKey(shift)]: event.target.value }))}
                                                            disabled={isSaving}
                                                        />
                                                    </label>

                                                    <label className="hours-override-field">
                                                        <span>Motivo operacional</span>
                                                        <textarea
                                                            value={overrideNotesByShift[shiftKey(shift)] ?? ""}
                                                            onChange={(event) => setOverrideNotesByShift((current) => ({ ...current, [shiftKey(shift)]: event.target.value }))}
                                                            rows={3}
                                                            placeholder="Ex.: saída existiu, mas esse plantão não gera banco por decisão auditada da coordenação"
                                                            disabled={isSaving}
                                                        />
                                                    </label>
                                                </div>

                                                {overrideErrorsByShift[shiftKey(shift)] && (
                                                    <div className="hours-override-error">{overrideErrorsByShift[shiftKey(shift)]}</div>
                                                )}

                                                <div className="hours-override-actions">
                                                    <button
                                                        type="button"
                                                        className="payment-button primary"
                                                        disabled={isSaving}
                                                        onClick={() => {
                                                            const key = shiftKey(shift);
                                                            setSavingShiftKey(key);
                                                            setOverrideErrorsByShift((current) => ({ ...current, [key]: "" }));
                                                            startSavingTransition(() => {
                                                                void submitManualOverride(shift).catch((error) => {
                                                                    setOverrideErrorsByShift((current) => ({
                                                                        ...current,
                                                                        [key]: error instanceof Error ? error.message : "Falha ao salvar override do banco.",
                                                                    }));
                                                                    setSavingShiftKey(null);
                                                                });
                                                            });
                                                        }}
                                                    >
                                                        {isSaving && savingShiftKey === shiftKey(shift) ? "Salvando..." : "Salvar saldo manual"}
                                                    </button>
                                                </div>
                                            </section>
                                        )}

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