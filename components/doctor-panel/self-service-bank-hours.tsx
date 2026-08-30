"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export interface SelfServiceShiftOption {
    operationalDate: string;
    shiftLabel: string;
    label: string;
}

export interface SelfDeclaredExtra {
    settlementId: string;
    operationalDate: string;
    shiftLabel: "SD" | "SN";
}

interface Props {
    medicoId: string;
    monthKey: string;
    token: string | null;
    /** Saldo elegível ≥ +12h (ou liberado a declarar, que registra sem gate). */
    canBonus: boolean;
    /** Saldo elegível ≤ -12h. */
    canPenalty: boolean;
    /** Plantões reais do mês, para a retirada escolher um. */
    shiftOptions: SelfServiceShiftOption[];
    /** Extras que ele mesmo declarou no mês — pode trocar dia/turno ou tirar. */
    declaredExtras: SelfDeclaredExtra[];
}

function formatDia(operationalDate: string) {
    return operationalDate.split("-").reverse().slice(0, 2).join("/");
}

/**
 * Autoatendimento do banco de horas na área do médico: um campo de data + turno
 * (verde) e/ou um seletor de plantão (vermelho), mais a lista do que ele mesmo
 * declarou no mês — que ele pode remarcar ou tirar enquanto o mês está aberto.
 * Auditoria e revisão vivem nas telas do coordenador.
 */
export function SelfServiceBankHours({
    medicoId,
    monthKey,
    token,
    canBonus,
    canPenalty,
    shiftOptions,
    declaredExtras,
}: Props) {
    const router = useRouter();
    const [bonusDate, setBonusDate] = useState("");
    const [bonusShift, setBonusShift] = useState<"SD" | "SN">("SD");
    const [penaltyPick, setPenaltyPick] = useState("");
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [editing, setEditing] = useState<string | null>(null);
    const [editDate, setEditDate] = useState("");
    const [editShift, setEditShift] = useState<"SD" | "SN">("SD");

    if (!canBonus && !canPenalty && declaredExtras.length === 0) return null;

    const [ano, mes] = monthKey.split("-");
    const minDate = `${monthKey}-01`;
    const maxDate = `${monthKey}-${String(new Date(Number(ano), Number(mes), 0).getDate()).padStart(2, "0")}`;

    async function call(
        method: "POST" | "PATCH" | "DELETE",
        payload: Record<string, unknown>,
        busyKey: string,
    ): Promise<boolean> {
        setBusy(busyKey);
        setError(null);
        try {
            const response = await fetch("/api/medico/bank-hours-self-service", {
                method,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ medicoId, ...payload, ...(token ? { t: token } : {}) }),
            });
            const body = await response.json().catch(() => null) as { error?: string } | null;
            if (!response.ok) {
                setError(body?.error ?? "Não foi possível concluir.");
                return false;
            }
            router.refresh();
            return true;
        } finally {
            setBusy(null);
        }
    }

    async function submit(action: "bonus" | "penalty") {
        const operationalDate = action === "bonus" ? bonusDate : penaltyPick.split("|")[0];
        const shiftLabel = action === "bonus" ? bonusShift : penaltyPick.split("|")[1];
        if (!operationalDate) return;
        if (!window.confirm(`Confirmar dia ${formatDia(operationalDate)} (${shiftLabel})?`)) return;

        const ok = await call("POST", { monthKey, action, operationalDate, shiftLabel }, action);
        if (ok) {
            setBonusDate("");
            setPenaltyPick("");
        }
    }

    async function saveEdit(settlementId: string) {
        if (!editDate) return;
        const ok = await call("PATCH", {
            settlementId,
            operationalDate: editDate,
            shiftLabel: editShift,
        }, settlementId);
        if (ok) setEditing(null);
    }

    async function remove(extra: SelfDeclaredExtra) {
        if (!window.confirm(`Tirar o plantão extra de ${formatDia(extra.operationalDate)} (${extra.shiftLabel})?`)) {
            return;
        }
        await call("DELETE", { settlementId: extra.settlementId }, extra.settlementId);
    }

    return (
        <section className="panel-section panel-bank-extra">
            <div className="panel-bank-extra-head">
                <span className="panel-bank-extra-badge">BANCO DE HORAS</span>
                <h2>Trocar saldo por plantão</h2>
            </div>
            <p className="panel-bank-extra-warning">
                {canBonus
                    ? <>Seu saldo passou de <strong>+12h</strong>: você pode registrar um plantão extra em dia livre — ele entra na folha valendo um plantão e <strong>desconta 12h do seu saldo</strong>. </>
                    : null}
                {canPenalty
                    ? <>Seu saldo passou de <strong>−12h</strong>: um plantão do mês é retirado da folha e <strong>devolve 12h ao seu saldo</strong>. </>
                    : null}
                {!canBonus && !canPenalty
                    ? <>Aqui ficam os plantões extra que você declarou trocando saldo do banco de horas. </>
                    : null}
                Plantão de chefia não passa por aqui — ele tem o bloco roxo próprio e não mexe em saldo.
            </p>
            <div className="panel-self-service">
                {canBonus ? (
                    <div className="panel-self-service-row bonus">
                        <label className="panel-field">
                            <span className="panel-field-label">Dia do plantão extra</span>
                            <input
                                type="date"
                                value={bonusDate}
                                min={minDate}
                                max={maxDate}
                                onChange={(event) => setBonusDate(event.target.value)}
                            />
                        </label>
                        <label className="panel-field">
                            <span className="panel-field-label">Turno</span>
                            <select
                                value={bonusShift}
                                onChange={(event) => setBonusShift(event.target.value === "SN" ? "SN" : "SD")}
                            >
                                <option value="SD">Diurno (SD)</option>
                                <option value="SN">Noturno (SN)</option>
                            </select>
                        </label>
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

                {canPenalty && shiftOptions.length === 0 ? (
                    // Sem isto a seção renderizava como caixa vazia: elegível a
                    // punição, mas nenhum plantão pagável no mês para retirar.
                    <p className="panel-self-service-note">
                        A retirada tira um plantão da folha deste mês — e você ainda não tem
                        plantão pagável em {monthKey.split("-").reverse().join("/")}. Assim que
                        um plantão seu entrar na folha, a opção de retirada aparece aqui.
                    </p>
                ) : null}

                {canPenalty && shiftOptions.length > 0 ? (
                    <div className="panel-self-service-row penalty">
                        <label className="panel-field">
                            <span className="panel-field-label">Plantão a retirar da folha</span>
                            <select
                                value={penaltyPick}
                                onChange={(event) => setPenaltyPick(event.target.value)}
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
                        </label>
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

                {declaredExtras.length > 0 ? (
                    <div className="panel-declared-extras">
                        <p className="panel-declared-extras-head">
                            Plantões extra que você declarou neste mês
                        </p>
                        <ul>
                            {declaredExtras.map((extra) => (
                                <li key={extra.settlementId}>
                                    {editing === extra.settlementId ? (
                                        <div className="panel-self-service-row">
                                            <label className="panel-field">
                                                <span className="panel-field-label">Novo dia</span>
                                                <input
                                                    type="date"
                                                    value={editDate}
                                                    min={minDate}
                                                    max={maxDate}
                                                    onChange={(event) => setEditDate(event.target.value)}
                                                />
                                            </label>
                                            <label className="panel-field">
                                                <span className="panel-field-label">Novo turno</span>
                                                <select
                                                    value={editShift}
                                                    onChange={(event) => setEditShift(event.target.value === "SN" ? "SN" : "SD")}
                                                >
                                                    <option value="SD">Diurno (SD)</option>
                                                    <option value="SN">Noturno (SN)</option>
                                                </select>
                                            </label>
                                            <button
                                                type="button"
                                                className="panel-action-btn"
                                                disabled={!editDate || busy !== null}
                                                onClick={() => void saveEdit(extra.settlementId)}
                                            >
                                                {busy === extra.settlementId ? "Salvando…" : "Salvar"}
                                            </button>
                                            <button
                                                type="button"
                                                className="panel-link-btn"
                                                onClick={() => setEditing(null)}
                                            >
                                                Cancelar
                                            </button>
                                        </div>
                                    ) : (
                                        <>
                                            <span className="panel-declared-extra-when">
                                                {formatDia(extra.operationalDate)} · {extra.shiftLabel}
                                            </span>
                                            <button
                                                type="button"
                                                className="panel-link-btn"
                                                disabled={busy !== null}
                                                onClick={() => {
                                                    setEditing(extra.settlementId);
                                                    setEditDate(extra.operationalDate);
                                                    setEditShift(extra.shiftLabel);
                                                    setError(null);
                                                }}
                                            >
                                                Trocar dia/turno
                                            </button>
                                            <button
                                                type="button"
                                                className="panel-link-btn danger"
                                                disabled={busy !== null}
                                                onClick={() => void remove(extra)}
                                            >
                                                Tirar
                                            </button>
                                        </>
                                    )}
                                </li>
                            ))}
                        </ul>
                    </div>
                ) : null}

                {error ? <p className="panel-self-service-error">{error}</p> : null}
            </div>
        </section>
    );
}
