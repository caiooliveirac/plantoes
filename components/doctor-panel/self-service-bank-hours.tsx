"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export interface SelfServiceShiftOption {
    operationalDate: string;
    shiftLabel: string;
    label: string;
}

interface Props {
    medicoId: string;
    monthKey: string;
    token: string | null;
    /** Saldo elegível ≥ +12h (ou chefia 2031, que registra sem gate). */
    canBonus: boolean;
    /** Saldo elegível ≤ -12h. */
    canPenalty: boolean;
    /** Plantões reais do mês, para a retirada escolher um. */
    shiftOptions: SelfServiceShiftOption[];
}

/**
 * Autoatendimento do banco de horas na área do médico. Sem texto explicativo,
 * de propósito: um campo de data (verde) e/ou um seletor de plantão (vermelho).
 * Auditoria e revisão vivem nas telas do coordenador.
 */
export function SelfServiceBankHours({ medicoId, monthKey, token, canBonus, canPenalty, shiftOptions }: Props) {
    const router = useRouter();
    const [bonusDate, setBonusDate] = useState("");
    const [penaltyPick, setPenaltyPick] = useState("");
    const [busy, setBusy] = useState<"bonus" | "penalty" | null>(null);
    const [error, setError] = useState<string | null>(null);

    if (!canBonus && !canPenalty) return null;

    const [ano, mes] = monthKey.split("-");
    const minDate = `${monthKey}-01`;
    const maxDate = `${monthKey}-${String(new Date(Number(ano), Number(mes), 0).getDate()).padStart(2, "0")}`;

    async function submit(action: "bonus" | "penalty") {
        const operationalDate = action === "bonus" ? bonusDate : penaltyPick.split("|")[0];
        const shiftLabel = action === "penalty" ? penaltyPick.split("|")[1] : undefined;
        if (!operationalDate) return;
        if (!window.confirm(`Confirmar dia ${operationalDate.split("-").reverse().join("/")}?`)) return;

        setBusy(action);
        setError(null);
        try {
            const response = await fetch("/api/medico/bank-hours-self-service", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    medicoId,
                    monthKey,
                    action,
                    operationalDate,
                    ...(shiftLabel ? { shiftLabel } : {}),
                    ...(token ? { t: token } : {}),
                }),
            });
            const body = await response.json().catch(() => null) as { error?: string } | null;
            if (!response.ok) {
                setError(body?.error ?? "Não foi possível registrar.");
                return;
            }
            setBonusDate("");
            setPenaltyPick("");
            router.refresh();
        } finally {
            setBusy(null);
        }
    }

    return (
        <section className="panel-section">
            <div className="panel-self-service">
                {canBonus ? (
                    <div className="panel-self-service-row bonus">
                        <input
                            type="date"
                            value={bonusDate}
                            min={minDate}
                            max={maxDate}
                            onChange={(event) => setBonusDate(event.target.value)}
                            aria-label="Data do plantão extra"
                        />
                        <button
                            type="button"
                            className="panel-action-btn bonus"
                            disabled={!bonusDate || busy !== null}
                            onClick={() => void submit("bonus")}
                        >
                            {busy === "bonus" ? "Registrando…" : "Registrar plantão extra (12h)"}
                        </button>
                    </div>
                ) : null}

                {canPenalty && shiftOptions.length > 0 ? (
                    <div className="panel-self-service-row penalty">
                        <select
                            value={penaltyPick}
                            onChange={(event) => setPenaltyPick(event.target.value)}
                            aria-label="Plantão a retirar"
                        >
                            <option value="">Escolher plantão…</option>
                            {shiftOptions.map((shift) => (
                                <option
                                    key={`${shift.operationalDate}|${shift.shiftLabel}`}
                                    value={`${shift.operationalDate}|${shift.shiftLabel}`}
                                >
                                    {shift.label}
                                </option>
                            ))}
                        </select>
                        <button
                            type="button"
                            className="panel-action-btn penalty"
                            disabled={!penaltyPick || busy !== null}
                            onClick={() => void submit("penalty")}
                        >
                            {busy === "penalty" ? "Retirando…" : "Retirar este plantão (12h)"}
                        </button>
                    </div>
                ) : null}

                {error ? <p className="panel-self-service-error">{error}</p> : null}
            </div>
        </section>
    );
}
