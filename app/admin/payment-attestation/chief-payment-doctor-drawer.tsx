"use client";

import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { isPremiumRateDate } from "@/modules/operational/holidays";
import {
    BANK_HOURS_THRESHOLD_MINUTES,
    cellAuditLink,
    dayKindLabel,
    formatCurrency,
    formatMinutesAsHours,
    formatUnits,
    paymentProfileLabel,
    resolveShiftAmount,
    weekdayShortLabel,
    type DoctorEmploymentType,
    type MatrixRowModel,
} from "./chief-payment-shared";

export interface DrawerConflictSegment {
    segmentId: string;
    operationalDate: string;
    shiftLabel: "SD" | "SN";
    domain: "regulation" | "intervention";
    targetCode: string;
    targetLabel: string;
    chosenDoctorName: string;
}

interface DoctorDrawerProps {
    doctor: MatrixRowModel;
    monthKey: string;
    monthLabel: string;
    days: string[];
    canManageClosing: boolean;
    conflictSegments: DrawerConflictSegment[];
    attestBusy: boolean;
    attestError: string | null;
    onToggleAttestation: (attested: boolean) => void;
    profileBusy: boolean;
    employmentBusy: boolean;
    onToggleSpecialist: (isSpecialist: boolean) => void;
    onToggleEmploymentType: (employmentType: DoctorEmploymentType) => void;
    invoiceDraft: string;
    processDraft: string;
    metaBusy: boolean;
    metaError: string | null;
    metaFeedback: string | null;
    onInvoiceChange: (value: string) => void;
    onProcessChange: (value: string) => void;
    onMetaBlur: () => void;
    contractDraft: string;
    contractBusy: boolean;
    contractError: string | null;
    onContractChange: (value: string) => void;
    onSubmitContract: () => void;
    bankBusy: boolean;
    bankError: string | null;
    onSettleBank: (kind: "bonus" | "penalty") => void;
    extraDay: string;
    extraShift: "SD" | "SN";
    extraCoverage: "full" | "half";
    extraLabel: string;
    extraBusy: boolean;
    extraError: string | null;
    extraFeedback: string | null;
    onExtraDayChange: (value: string) => void;
    onExtraShiftChange: (value: "SD" | "SN") => void;
    onExtraCoverageChange: (value: "full" | "half") => void;
    onExtraLabelChange: (value: string) => void;
    onSubmitExtra: () => void;
    onClose: () => void;
}

function bankTone(minutes: number | null | undefined) {
    const value = minutes ?? 0;
    if (Math.abs(value) >= BANK_HOURS_THRESHOLD_MINUTES) {
        return "alert";
    }
    return value >= 0 ? "positive" : "negative";
}

export function DoctorDrawer(props: DoctorDrawerProps) {
    const { doctor } = props;

    if (typeof document === "undefined") {
        return null;
    }

    const flatShifts = doctor.cells
        .flatMap((cell) => cell.shifts)
        .slice()
        .sort((left, right) => {
            const byDate = left.operationalDate.localeCompare(right.operationalDate);
            if (byDate !== 0) return byDate;
            if (left.shiftLabel !== right.shiftLabel) return left.shiftLabel === "SD" ? -1 : 1;
            return left.targetCode.localeCompare(right.targetCode, "pt-BR");
        });

    const bankMinutes = doctor.bankHoursMinutes ?? 0;
    const bankLabel = `${bankMinutes > 0 ? "+" : ""}${formatMinutesAsHours(doctor.bankHoursMinutes)}`;

    return createPortal(
        <>
            <motion.div
                className="chief-matrix-overlay drawer"
                role="presentation"
                onClick={props.onClose}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.18 }}
            />
            <motion.aside
                className="chief-matrix-drawer"
                role="dialog"
                aria-modal="true"
                aria-label={`Resumo do médico ${doctor.doctorName}`}
                initial={{ x: "100%" }}
                animate={{ x: 0 }}
                transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
            >
                <header className="chief-matrix-drawer-header">
                    <div>
                        <span className="chief-matrix-eyebrow">Resumo do médico · {props.monthLabel}</span>
                        <h3>{doctor.doctorName}</h3>
                        <div className="chief-matrix-drawer-badges">
                            {doctor.paymentProfile === "psychiatry" ? (
                                <em className="chief-matrix-badge psiq large">PSIQ · {paymentProfileLabel(doctor.paymentProfile)}</em>
                            ) : (
                                <button
                                    type="button"
                                    className={`chief-matrix-badge-toggle esp ${doctor.paymentProfile === "specialist" ? "on" : ""}`.trim()}
                                    onClick={() => props.onToggleSpecialist(doctor.paymentProfile !== "specialist")}
                                    disabled={!props.canManageClosing || props.profileBusy}
                                    title="Alterna a tarifa entre generalista e especialista"
                                >
                                    ESP {doctor.paymentProfile === "specialist" ? "✓" : ""}
                                </button>
                            )}
                            <button
                                type="button"
                                className={`chief-matrix-badge-toggle estat ${doctor.employmentType === "estatutario" ? "on" : ""}`.trim()}
                                onClick={() => props.onToggleEmploymentType(doctor.employmentType === "estatutario" ? "pj" : "estatutario")}
                                disabled={!props.canManageClosing || props.employmentBusy}
                                title="Estatutário/REDA não gera valor a pagar por plantão"
                            >
                                {doctor.employmentType === "estatutario" ? "ESTATUTÁRIO ✓" : "PJ"}
                            </button>
                            {doctor.pendingCount > 0 ? <em className="chief-matrix-badge pend large">{doctor.pendingCount} PEND</em> : null}
                        </div>
                    </div>
                    <div className="chief-matrix-drawer-header-actions">
                        <a
                            className="chief-matrix-action info compact"
                            href={`/folha-ponto/${doctor.doctorId}/${props.monthKey.slice(0, 4)}/${props.monthKey.slice(5, 7)}`}
                            target="_blank"
                            rel="noopener"
                        >
                            Folha de ponto ↧
                        </a>
                        <button type="button" className="chief-matrix-icon-btn" onClick={props.onClose} aria-label="Fechar">✕</button>
                    </div>
                </header>

                {props.conflictSegments.length > 0 ? (
                    <section className="chief-matrix-drawer-card conflict">
                        <strong>Possível deslocamento por conflito de alocação</strong>
                        <p>
                            {props.conflictSegments.length} caso(s) no mês: segmento deste médico descartado por sobreposição no
                            mesmo dia/turno/alvo de um conflito. Revise para não perder pagamento.
                        </p>
                        <ul>
                            {props.conflictSegments.slice(0, 6).map((segment) => {
                                const day = segment.operationalDate.slice(8, 10);
                                const month = segment.operationalDate.slice(5, 7);
                                return (
                                    <li key={segment.segmentId}>
                                        <a href={cellAuditLink(props.monthKey, day, segment.shiftLabel)}>
                                            {day}/{month} {segment.shiftLabel} {segment.targetCode}
                                        </a>{" "}
                                        — escolhido no slot: {segment.chosenDoctorName}
                                    </li>
                                );
                            })}
                        </ul>
                        {props.conflictSegments.length > 6 ? (
                            <small>+{props.conflictSegments.length - 6} ocorrência(s) na <a href="/admin/payment-attestation/audit">auditoria técnica</a>.</small>
                        ) : null}
                    </section>
                ) : null}

                <div className="chief-matrix-drawer-stats">
                    <div className="chief-matrix-stat">
                        <span>SD × SN</span>
                        <strong>{formatUnits(doctor.totalSD)} · {formatUnits(doctor.totalSN)}</strong>
                    </div>
                    <div className="chief-matrix-stat">
                        <span>Útil / FDS</span>
                        <strong>{formatUnits(doctor.weekdayShiftCount)} · {formatUnits(doctor.weekendShiftCount)}</strong>
                    </div>
                    <div className="chief-matrix-stat gold">
                        <span>Total do mês</span>
                        <strong>{formatCurrency(doctor.employmentType === "estatutario" ? 0 : doctor.totalDue)}</strong>
                    </div>
                </div>

                <label className={`chief-matrix-attest ${doctor.attested ? "on" : ""}`.trim()}>
                    <input
                        type="checkbox"
                        checked={doctor.attested}
                        onChange={(event) => props.onToggleAttestation(event.target.checked)}
                        disabled={!props.canManageClosing || props.attestBusy}
                    />
                    <span>
                        <strong>Produtividade conferida e atestada</strong>
                        <small>
                            {doctor.attested
                                ? "Assinado — desmarque se algo mudar."
                                : "Libera o médico para o lote de pagamento do mês. Antes de assinar, confira se falta lançar plantão extra."}
                        </small>
                    </span>
                </label>
                {props.attestError ? <p className="chief-matrix-feedback danger">{props.attestError}</p> : null}

                <section className="chief-matrix-drawer-card">
                    <span className="chief-matrix-card-label">Nota fiscal e processo</span>
                    <div className="chief-matrix-meta-grid">
                        <input
                            type="text"
                            value={props.invoiceDraft}
                            onChange={(event) => props.onInvoiceChange(event.target.value)}
                            onBlur={props.onMetaBlur}
                            placeholder="Nº da nota fiscal"
                            maxLength={60}
                            disabled={props.metaBusy}
                        />
                        <input
                            type="text"
                            value={props.processDraft}
                            onChange={(event) => props.onProcessChange(event.target.value)}
                            onBlur={props.onMetaBlur}
                            placeholder="Nº do processo"
                            maxLength={60}
                            disabled={props.metaBusy}
                        />
                    </div>
                    <small>{props.metaBusy ? "Salvando..." : "Salva automaticamente ao sair do campo"}</small>
                    {props.metaError ? <p className="chief-matrix-feedback danger">{props.metaError}</p> : null}
                    {props.metaFeedback ? <p className="chief-matrix-feedback ok">{props.metaFeedback}</p> : null}
                </section>

                <div className="chief-matrix-drawer-duo">
                    <section className="chief-matrix-drawer-card">
                        <span className="chief-matrix-card-label">Saldo contratual</span>
                        {doctor.contractCeilingBrl == null ? (
                            <>
                                <small>
                                    {props.canManageClosing
                                        ? "Informe o teto do contrato (R$). A partir daí vira cálculo automático."
                                        : "Teto de contrato ainda não definido."}
                                </small>
                                {props.canManageClosing ? (
                                    <div className="chief-matrix-contract-seed">
                                        <input
                                            type="number"
                                            min="0"
                                            step="0.01"
                                            value={props.contractDraft}
                                            onChange={(event) => props.onContractChange(event.target.value)}
                                            placeholder="ex.: 120000.00"
                                            disabled={props.contractBusy}
                                        />
                                        <button type="button" className="chief-matrix-action compact" onClick={props.onSubmitContract} disabled={props.contractBusy}>
                                            {props.contractBusy ? "Salvando..." : "Definir teto"}
                                        </button>
                                    </div>
                                ) : null}
                                {props.contractError ? <p className="chief-matrix-feedback danger">{props.contractError}</p> : null}
                            </>
                        ) : (
                            <>
                                <strong className={(doctor.contractBalanceBrl ?? 0) < 0 ? "negative" : ""}>
                                    {formatCurrency(doctor.contractBalanceBrl)}
                                </strong>
                                <small>
                                    teto {formatCurrency(doctor.contractCeilingBrl)}
                                    {doctor.contractSeedMonth ? ` · semente ${doctor.contractSeedMonth}` : ""}
                                </small>
                            </>
                        )}
                    </section>

                    <section className="chief-matrix-drawer-card">
                        <span className="chief-matrix-card-label">Banco de horas</span>
                        <strong className={`chief-matrix-bank ${bankTone(doctor.bankHoursMinutes)}`.trim()}>{bankLabel}</strong>
                        {doctor.bankHoursSettlement ? (
                            <small>
                                {doctor.bankHoursSettlement.kind === "bonus" ? "Bônus" : "Punição"} de 12h lançado neste mês
                                {doctor.bankHoursSettlement.operationalDate ? ` (dia ${doctor.bankHoursSettlement.operationalDate.slice(8, 10)})` : ""}.{" "}
                                <a href="/admin/bank-hours" target="_blank" rel="noopener">ver banco de horas</a>
                            </small>
                        ) : bankMinutes >= BANK_HOURS_THRESHOLD_MINUTES ? (
                            <>
                                <small>acerto a partir de ±12 h — bonifique com 1 plantão verde e debite 12h.</small>
                                {props.canManageClosing ? (
                                    <button type="button" className="chief-matrix-action confirm compact" onClick={() => props.onSettleBank("bonus")} disabled={props.bankBusy}>
                                        {props.bankBusy ? "Lançando..." : "Bonificar +1 plantão (verde)"}
                                    </button>
                                ) : null}
                            </>
                        ) : bankMinutes <= -BANK_HOURS_THRESHOLD_MINUTES ? (
                            <>
                                <small>acerto a partir de ±12 h — debite 1 plantão vermelho e zere 12h.</small>
                                {props.canManageClosing ? (
                                    <button type="button" className="chief-matrix-action danger compact" onClick={() => props.onSettleBank("penalty")} disabled={props.bankBusy}>
                                        {props.bankBusy ? "Lançando..." : "Debitar 1 plantão (vermelho)"}
                                    </button>
                                ) : null}
                            </>
                        ) : (
                            <small>acerto a partir de ±12 h — dentro da faixa, sem acerto sugerido.</small>
                        )}
                        {props.bankError ? <p className="chief-matrix-feedback danger">{props.bankError}</p> : null}
                    </section>
                </div>

                {props.canManageClosing ? (
                    <section className="chief-matrix-drawer-card dashed">
                        <span className="chief-matrix-card-label">Adicionar plantão extra</span>
                        <div className="chief-matrix-extra-fields">
                            <select value={props.extraDay} onChange={(event) => props.onExtraDayChange(event.target.value)} disabled={props.extraBusy} aria-label="Dia">
                                <option value="">Dia</option>
                                {props.days.map((day) => (
                                    <option key={day} value={day}>{day}</option>
                                ))}
                            </select>
                            <select value={props.extraShift} onChange={(event) => props.onExtraShiftChange(event.target.value === "SN" ? "SN" : "SD")} disabled={props.extraBusy} aria-label="Turno">
                                <option value="SD">SD</option>
                                <option value="SN">SN</option>
                            </select>
                            <select value={props.extraCoverage} onChange={(event) => props.onExtraCoverageChange(event.target.value === "half" ? "half" : "full")} disabled={props.extraBusy} aria-label="Cobertura">
                                <option value="full">Inteiro</option>
                                <option value="half">Meio</option>
                            </select>
                            <input
                                type="text"
                                value={props.extraLabel}
                                onChange={(event) => props.onExtraLabelChange(event.target.value)}
                                placeholder="Motivo / descrição"
                                minLength={2}
                                maxLength={40}
                                disabled={props.extraBusy}
                            />
                            <button type="button" className="chief-matrix-action confirm compact" onClick={props.onSubmitExtra} disabled={props.extraBusy}>
                                {props.extraBusy ? "Adicionando..." : "Adicionar"}
                            </button>
                        </div>
                        <small>Entra em verde no quadro e conta no valor a pagar. Use para plantões que o bot não registrou.</small>
                        {props.extraError ? <p className="chief-matrix-feedback danger">{props.extraError}</p> : null}
                        {props.extraFeedback ? <p className="chief-matrix-feedback ok">{props.extraFeedback}</p> : null}
                    </section>
                ) : null}

                <section className="chief-matrix-drawer-shifts">
                    <span className="chief-matrix-card-label">Plantões do mês ({flatShifts.length})</span>
                    {flatShifts.length === 0 ? (
                        <p className="chief-matrix-drawer-empty">Nenhum plantão pagável neste mês com os filtros atuais.</p>
                    ) : (
                        <ol>
                            {flatShifts.map((shift) => {
                                const premium = isPremiumRateDate(shift.operationalDate);
                                const isExtra = shift.source === "admin_extra";
                                const value = resolveShiftAmount(shift, doctor.paymentProfile, doctor.employmentType);
                                return (
                                    <li key={shift.payableShiftId} title={dayKindLabel(shift.operationalDate)}>
                                        <span className={`chief-matrix-shift-date ${premium ? "premium" : ""}`.trim()}>
                                            {shift.operationalDate.slice(8, 10)}/{shift.operationalDate.slice(5, 7)}
                                            <small>{weekdayShortLabel(shift.operationalDate)}</small>
                                        </span>
                                        <span className={`chief-matrix-shift-turn ${shift.shiftLabel === "SD" ? "sd" : "sn"}`.trim()}>{shift.shiftLabel}</span>
                                        <span className="chief-matrix-shift-target">
                                            {isExtra ? (shift.tagCode || "EXTRA") : shift.targetCode}
                                            {isExtra ? <em>{shift.paymentUnit < 0 ? "punição" : "extra"}</em> : null}
                                            {shift.paymentTag ? <em>meio plantão</em> : null}
                                        </span>
                                        <span className={`chief-matrix-shift-value ${value < 0 ? "negative" : ""}`.trim()}>{formatCurrency(value)}</span>
                                    </li>
                                );
                            })}
                        </ol>
                    )}
                </section>
            </motion.aside>
        </>,
        document.body,
    );
}
