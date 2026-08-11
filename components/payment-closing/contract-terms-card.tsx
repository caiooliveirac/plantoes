"use client";

/**
 * Termos do contrato no modal do médico: teto (R$) e mês em que passou a valer.
 *
 * É a porta de correção do dado que veio torto da planilha (e de troca /
 * renovação antecipada): o admin escolhe um dos tetos habituais (24/36/48h,
 * generalista ou especialista) ou digita outro valor, informa o mês, e o
 * servidor redefine o contrato — ciclo novo a partir do mês, abertura igual ao
 * teto, consumo dos meses seguintes descontando (rota
 * /api/admin/contracts/[id]/redefine).
 */
import { useState } from "react";

// Tetos habituais por CH/categoria — mesma tabela de referência do backfill
// (scripts/backfill-saldo-contrato.ts, REFERENCE_CEILINGS).
const CEILING_PRESETS: { label: string; brl: number }[] = [
    { label: "24h generalista", brl: 165732 },
    { label: "24h especialista", brl: 174858 },
    { label: "36h generalista", brl: 248598 },
    { label: "36h especialista", brl: 262287 },
    { label: "48h generalista", brl: 331464 },
    { label: "48h especialista", brl: 349716 },
];

const MONTH_NAMES = [
    "janeiro", "fevereiro", "março", "abril", "maio", "junho",
    "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

function formatBrl(cents: number | null): string {
    if (cents === null) return "—";
    return (cents / 100).toLocaleString("pt-BR", {
        style: "currency",
        currency: "BRL",
        minimumFractionDigits: 2,
    });
}

/** "2025-09-01" -> "setembro/2025". */
function formatMonth(cycleStart: string): string {
    const month = Number(cycleStart.slice(5, 7));
    return `${MONTH_NAMES[month - 1]}/${cycleStart.slice(0, 4)}`;
}

export interface ContractTermsCardProps {
    contractId: string;
    contractNumber: string;
    /** Início do ciclo vigente (AAAA-MM-DD). */
    cycleStart: string;
    ceilingCents: number | null;
    canManage: boolean;
    onSaved?: () => void;
}

export function ContractTermsCard({
    contractId,
    contractNumber,
    cycleStart,
    ceilingCents,
    canManage,
    onSaved,
}: ContractTermsCardProps) {
    const [editing, setEditing] = useState(false);
    const [valueDraft, setValueDraft] = useState("");
    const [monthDraft, setMonthDraft] = useState(cycleStart.slice(0, 7));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function submit() {
        const value = Number(valueDraft.replace(",", "."));
        if (!Number.isFinite(value) || value <= 0) {
            setError("Informe o valor do contrato em reais.");
            return;
        }
        if (!/^\d{4}-\d{2}$/.test(monthDraft)) {
            setError("Informe o mês em que o contrato passou a valer.");
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const response = await fetch(`/api/admin/contracts/${contractId}/redefine`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ceilingBrl: value, startMonth: monthDraft }),
            });
            const body = await response.json().catch(() => null) as { error?: string } | null;
            if (!response.ok) throw new Error(body?.error ?? "Não foi possível redefinir o contrato.");
            setEditing(false);
            onSaved?.();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Falha ao redefinir o contrato.");
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="contract-terms-card">
            <div className="contract-terms-summary">
                <span>
                    Contrato {contractNumber} · teto <strong>{formatBrl(ceilingCents)}</strong>
                    {" "}· vale desde <strong>{formatMonth(cycleStart)}</strong>
                </span>
                {canManage ? (
                    <button
                        type="button"
                        className="payment-button subtle"
                        onClick={() => {
                            setEditing((open) => !open);
                            setError(null);
                        }}
                    >
                        {editing ? "Cancelar" : "Corrigir valor/mês"}
                    </button>
                ) : null}
            </div>

            {editing ? (
                <div className="contract-terms-editor">
                    <div className="contract-terms-presets">
                        {CEILING_PRESETS.map((preset) => (
                            <button
                                key={preset.label}
                                type="button"
                                className={Number(valueDraft) === preset.brl ? "active" : ""}
                                onClick={() => setValueDraft(String(preset.brl))}
                                disabled={busy}
                            >
                                <span>{preset.label}</span>
                                <strong>{formatBrl(preset.brl * 100)}</strong>
                            </button>
                        ))}
                    </div>
                    <div className="contract-terms-fields">
                        <label>
                            <span>Valor do contrato (R$)</span>
                            <input
                                type="number"
                                min="0"
                                step="0.01"
                                value={valueDraft}
                                onChange={(event) => setValueDraft(event.target.value)}
                                placeholder="ex.: 331464.00"
                                disabled={busy}
                            />
                        </label>
                        <label>
                            <span>Vale desde</span>
                            <input
                                type="month"
                                value={monthDraft}
                                onChange={(event) => setMonthDraft(event.target.value)}
                                disabled={busy}
                            />
                        </label>
                        <button
                            type="button"
                            className="payment-button"
                            onClick={() => void submit()}
                            disabled={busy || valueDraft.trim() === ""}
                        >
                            {busy ? "Redefinindo..." : "Redefinir contrato"}
                        </button>
                    </div>
                    <p className="contract-terms-note">
                        O acompanhamento recomeça no mês informado com o valor cheio e vai
                        descontando os gastos registrados mês a mês. O histórico anterior fica
                        no razão do contrato substituído.
                    </p>
                    {error ? <p className="chief-payable-extra-feedback danger">{error}</p> : null}
                </div>
            ) : null}
        </div>
    );
}
