"use client";

import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { motion } from "framer-motion";
import { cellAuditLink } from "./chief-payment-shared";

export interface SlotActionDraft {
    payableShiftId: string;
    occupancyId: string;
    domain: "regulation" | "intervention";
    targetCode: string;
    targetLabel: string;
    day: string;
    shiftLabel: "SD" | "SN";
    doctorName: string;
    source: string | null;
    paymentTag: string | null;
    paymentUnit: number;
    amountLabel: string;
}

export interface ManualDraft {
    domain: "regulation" | "intervention";
    targetCode: string;
    targetLabel: string;
    day: string;
    shiftLabel: "SD" | "SN";
    sourceType: "disabled" | "uncovered" | "reassign";
    reason: string | null;
}

function DialogShell({ onClose, children, width = 400 }: { onClose: () => void; children: ReactNode; width?: number }) {
    if (typeof document === "undefined") {
        return null;
    }

    return createPortal(
        <motion.div
            className="chief-matrix-overlay"
            role="presentation"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.18 }}
        >
            <motion.section
                className="chief-matrix-dialog"
                role="dialog"
                aria-modal="true"
                style={{ width: `min(${width}px, 100%)` }}
                onClick={(event) => event.stopPropagation()}
                initial={{ opacity: 0, y: 10, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ duration: 0.2, ease: [0.32, 0.72, 0, 1] }}
            >
                {children}
            </motion.section>
        </motion.div>,
        document.body,
    );
}

export function SlotActionPopover({
    draft,
    monthKey,
    busy,
    error,
    canManageClosing,
    onReassign,
    onRemove,
    onClose,
}: {
    draft: SlotActionDraft;
    monthKey: string;
    busy: boolean;
    error: string | null;
    canManageClosing: boolean;
    onReassign: () => void;
    onRemove: () => void;
    onClose: () => void;
}) {
    const isExtra = draft.source === "admin_extra";
    const isPenalty = isExtra && draft.paymentUnit < 0;

    return (
        <DialogShell onClose={() => !busy && onClose()}>
            <header className="chief-matrix-dialog-header">
                <div>
                    <span className="chief-matrix-eyebrow">Ações do plantão</span>
                    <strong>{draft.targetCode} · {draft.shiftLabel} · dia {draft.day}/{monthKey.slice(5, 7)}</strong>
                    <small>
                        {draft.doctorName}
                        {draft.paymentTag ? " · meio plantão" : ""}
                        {isExtra ? (isPenalty ? " · punição banco de horas" : " · plantão extra (admin)") : ""}
                    </small>
                </div>
                <button type="button" className="chief-matrix-icon-btn" onClick={onClose} disabled={busy} aria-label="Fechar">✕</button>
            </header>

            {error ? (
                <div className="payment-inline-banner danger">
                    <strong>Falha ao aplicar</strong>
                    <span>{error}</span>
                </div>
            ) : null}

            <div className="chief-matrix-dialog-value">
                <span>Valor deste plantão</span>
                <strong>{draft.amountLabel}</strong>
            </div>

            <div className="chief-matrix-dialog-actions">
                {!isExtra ? (
                    <a className="chief-matrix-action info" href={cellAuditLink(monthKey, draft.day, draft.shiftLabel)}>
                        Ver auditoria do slot →
                    </a>
                ) : null}
                {canManageClosing && !isExtra ? (
                    <button type="button" className="chief-matrix-action" onClick={onReassign} disabled={busy}>
                        Reatribuir a outro médico
                    </button>
                ) : null}
                {canManageClosing ? (
                    <button type="button" className="chief-matrix-action danger" onClick={onRemove} disabled={busy}>
                        {busy ? "Removendo..." : "Remover plantão do fechamento"}
                    </button>
                ) : null}
            </div>

            <p className="chief-matrix-dialog-hint">
                {canManageClosing
                    ? (isExtra
                        ? "Remover apaga este plantão extra adicionado pelo admin (sai do quadro e do valor a pagar)."
                        : (draft.source === "admin_correction" || draft.source === "manual"
                            ? "Remover apaga a correção manual deste plantão."
                            : "Remover encerra o plantão no início deste turno (recalcula banco de horas). Use quando o médico não estava de fato no plantão."))
                    : "Perfil somente leitura para plantões: remoções e correções manuais ficam bloqueadas."}
            </p>
        </DialogShell>
    );
}

export function ManualCorrectionDialog({
    draft,
    monthKey,
    mode,
    busy,
    error,
    doctorName,
    disableReason,
    allDoctorNames,
    onModeChange,
    onDoctorNameChange,
    onDisableReasonChange,
    onSubmitAssign,
    onSubmitDisable,
    onClose,
}: {
    draft: ManualDraft;
    monthKey: string;
    mode: "assign" | "disable";
    busy: boolean;
    error: string | null;
    doctorName: string;
    disableReason: string;
    allDoctorNames: string[];
    onModeChange: (mode: "assign" | "disable") => void;
    onDoctorNameChange: (value: string) => void;
    onDisableReasonChange: (value: string) => void;
    onSubmitAssign: () => void;
    onSubmitDisable: () => void;
    onClose: () => void;
}) {
    const originLabel = draft.sourceType === "disabled"
        ? "Desativada"
        : draft.sourceType === "uncovered"
            ? "Sem médico"
            : "Reatribuição";

    return (
        <DialogShell onClose={() => !busy && onClose()} width={460}>
            <header className="chief-matrix-dialog-header">
                <div>
                    <span className="chief-matrix-eyebrow">Correção manual de pagamento</span>
                    <strong>{draft.targetCode} · {draft.shiftLabel} · dia {draft.day}/{monthKey.slice(5, 7)}</strong>
                    <small>
                        {draft.targetLabel} · {originLabel}
                        {draft.reason ? ` · ${draft.reason}` : ""}
                    </small>
                </div>
                <button type="button" className="chief-matrix-icon-btn" onClick={onClose} disabled={busy} aria-label="Fechar">✕</button>
            </header>

            <p className="chief-matrix-dialog-note">
                Esta ação cria uma ocupação real no banco de dados, calcula banco de horas automaticamente e registra o pagamento.
                Use para médicos que trabalharam mas não foram capturados pelo bot.
            </p>

            {draft.sourceType === "uncovered" ? (
                <div className="chief-matrix-dialog-tabs" role="tablist">
                    <button
                        type="button"
                        role="tab"
                        aria-selected={mode === "assign"}
                        className={`chief-matrix-pill ${mode === "assign" ? "active" : ""}`.trim()}
                        onClick={() => onModeChange("assign")}
                        disabled={busy}
                    >
                        Atribuir médico
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={mode === "disable"}
                        className={`chief-matrix-pill ${mode === "disable" ? "active" : ""}`.trim()}
                        onClick={() => onModeChange("disable")}
                        disabled={busy}
                    >
                        Marcar como desativada
                    </button>
                </div>
            ) : null}

            {error ? (
                <div className="payment-inline-banner danger">
                    <strong>Falha na correção</strong>
                    <span>{error}</span>
                </div>
            ) : null}

            {mode === "assign" ? (
                <div className="chief-matrix-dialog-form">
                    <label className="chief-matrix-field">
                        <span>Médico para pagamento</span>
                        <input
                            type="text"
                            list="chief-matrix-doctor-names"
                            value={doctorName}
                            onChange={(event) => onDoctorNameChange(event.target.value)}
                            placeholder="Digite o nome do médico"
                            autoFocus
                            disabled={busy}
                        />
                    </label>
                    <datalist id="chief-matrix-doctor-names">
                        {allDoctorNames.map((name) => (
                            <option key={name} value={name} />
                        ))}
                    </datalist>
                    <button type="button" className="chief-matrix-action confirm" onClick={onSubmitAssign} disabled={busy}>
                        {busy ? "Salvando..." : "Salvar correção"}
                    </button>
                </div>
            ) : (
                <div className="chief-matrix-dialog-form">
                    <label className="chief-matrix-field">
                        <span>Motivo da desativação</span>
                        <input
                            type="text"
                            value={disableReason}
                            onChange={(event) => onDisableReasonChange(event.target.value)}
                            placeholder="Ex.: Sem demanda, veículo indisponível, escala reduzida"
                            autoFocus
                            disabled={busy}
                        />
                    </label>
                    <button type="button" className="chief-matrix-action warning" onClick={onSubmitDisable} disabled={busy}>
                        {busy ? "Salvando..." : "Confirmar desativação"}
                    </button>
                </div>
            )}
        </DialogShell>
    );
}
