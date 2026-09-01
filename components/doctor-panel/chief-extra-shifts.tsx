"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export interface ChiefExtraShift {
    id: string;
    operationalDate: string;
    shiftLabel: "SD" | "SN";
    /** Inteiro paga 1 plantão; meio paga 0,5 (metade do valor). */
    coverage: "full" | "half";
}

type Coverage = ChiefExtraShift["coverage"];

function coverageLabel(coverage: Coverage) {
    return coverage === "half" ? "meio plantão" : "plantão inteiro";
}

interface Props {
    medicoId: string;
    monthKey: string;
    token: string | null;
    shifts: ChiefExtraShift[];
}

function formatDia(operationalDate: string) {
    return operationalDate.split("-").reverse().slice(0, 2).join("/");
}

/**
 * Plantão extra de CHEFIA na área do médico.
 *
 * Vive em bloco próprio, roxo, longe do verde/vermelho do banco de horas: as
 * duas coisas se pareciam demais e chefes acabaram gastando saldo de banco de
 * horas para registrar turno de chefia. Aqui nada de saldo é movido — a cor, o
 * título e o aviso existem para isso ficar impossível de confundir.
 */
export function ChiefExtraShifts({ medicoId, monthKey, token, shifts }: Props) {
    const router = useRouter();
    const [date, setDate] = useState("");
    const [shift, setShift] = useState<"SD" | "SN">("SD");
    const [coverage, setCoverage] = useState<Coverage>("full");
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [editing, setEditing] = useState<string | null>(null);
    const [editDate, setEditDate] = useState("");
    const [editShift, setEditShift] = useState<"SD" | "SN">("SD");
    const [editCoverage, setEditCoverage] = useState<Coverage>("full");
    // Confirmação em dois toques no próprio botão (Kairós): o primeiro toque
    // arma ("Confirmar?"), o segundo executa. Substitui o window.confirm
    // nativo, que destoava da interface. Desarma sozinho em 4s.
    const [confirming, setConfirming] = useState<string | null>(null);
    useEffect(() => {
        if (!confirming) return;
        const timer = setTimeout(() => setConfirming(null), 4000);
        return () => clearTimeout(timer);
    }, [confirming]);
    function confirmaEmDoisToques(key: string): boolean {
        if (confirming === key) {
            setConfirming(null);
            return true;
        }
        setConfirming(key);
        return false;
    }

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
            const response = await fetch("/api/medico/plantao-chefia", {
                method,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ medicoId, monthKey, ...payload, ...(token ? { t: token } : {}) }),
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

    async function create() {
        if (!date) return;
        if (!confirmaEmDoisToques("create")) return;
        const ok = await call("POST", { operationalDate: date, shiftLabel: shift, coverage }, "create");
        if (ok) {
            setDate("");
            setCoverage("full");
        }
    }

    async function saveEdit(id: string) {
        if (!editDate) return;
        const ok = await call("PATCH", {
            extraShiftId: id,
            operationalDate: editDate,
            shiftLabel: editShift,
            coverage: editCoverage,
        }, id);
        if (ok) setEditing(null);
    }

    async function remove(item: ChiefExtraShift) {
        if (!confirmaEmDoisToques(`rm:${item.id}`)) return;
        await call("DELETE", { extraShiftId: item.id }, item.id);
    }

    return (
        <section className="panel-section panel-chief-extra">
            <div className="panel-chief-extra-head">
                <span className="panel-chief-extra-badge">CHEFIA</span>
                <h2>Plantão de chefia</h2>
            </div>
            <p className="panel-chief-extra-warning">
                Isto <strong>não é banco de horas</strong>. Nenhuma hora do seu saldo é
                usada, gasta ou descontada aqui — o turno de chefia entra na folha como
                plantão extra e pronto. Meio plantão entra valendo <strong>metade</strong> do
                valor de um plantão. Para trocar saldo de banco de horas por plantão,
                use o bloco verde do banco de horas, mais abaixo.
            </p>

            <div className="panel-self-service-row">
                <label className="panel-field">
                    <span className="panel-field-label">Dia do plantão de chefia</span>
                    <input
                        type="date"
                        value={date}
                        min={minDate}
                        max={maxDate}
                        onChange={(event) => setDate(event.target.value)}
                    />
                </label>
                <label className="panel-field">
                    <span className="panel-field-label">Turno</span>
                    <select
                        value={shift}
                        onChange={(event) => setShift(event.target.value === "SN" ? "SN" : "SD")}
                    >
                        <option value="SD">Diurno (SD)</option>
                        <option value="SN">Noturno (SN)</option>
                    </select>
                </label>
                <label className="panel-field">
                    <span className="panel-field-label">Inteiro ou meio?</span>
                    <select
                        value={coverage}
                        onChange={(event) => setCoverage(event.target.value === "half" ? "half" : "full")}
                    >
                        <option value="full">Inteiro</option>
                        <option value="half">Meio plantão (vale metade)</option>
                    </select>
                </label>
                <button
                    type="button"
                    className="panel-action-btn chief"
                    disabled={!date || busy !== null}
                    onClick={() => void create()}
                >
                    {busy === "create"
                        ? "Registrando…"
                        : confirming === "create" && date
                            ? `Confirmar ${formatDia(date)} ${shift} (${coverageLabel(coverage)})?`
                            : "Registrar plantão de chefia"}
                </button>
            </div>

            {shifts.length > 0 ? (
                <div className="panel-declared-extras chief">
                    <p className="panel-declared-extras-head">
                        Plantões de chefia que você registrou neste mês
                    </p>
                    <ul>
                        {shifts.map((item) => (
                            <li key={item.id}>
                                {editing === item.id ? (
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
                                        <label className="panel-field">
                                            <span className="panel-field-label">Inteiro ou meio?</span>
                                            <select
                                                value={editCoverage}
                                                onChange={(event) => setEditCoverage(event.target.value === "half" ? "half" : "full")}
                                            >
                                                <option value="full">Inteiro</option>
                                                <option value="half">Meio plantão (vale metade)</option>
                                            </select>
                                        </label>
                                        <button
                                            type="button"
                                            className="panel-action-btn chief"
                                            disabled={!editDate || busy !== null}
                                            onClick={() => void saveEdit(item.id)}
                                        >
                                            {busy === item.id ? "Salvando…" : "Salvar"}
                                        </button>
                                        <button
                                            type="button"
                                            className="panel-link-btn chief"
                                            onClick={() => setEditing(null)}
                                        >
                                            Cancelar
                                        </button>
                                    </div>
                                ) : (
                                    <>
                                        <span className="panel-declared-extra-when">
                                            {formatDia(item.operationalDate)} · {item.shiftLabel}
                                            {item.coverage === "half" ? " · meio plantão" : ""}
                                        </span>
                                        <button
                                            type="button"
                                            className="panel-link-btn chief"
                                            disabled={busy !== null}
                                            onClick={() => {
                                                setEditing(item.id);
                                                setEditDate(item.operationalDate);
                                                setEditShift(item.shiftLabel);
                                                setEditCoverage(item.coverage);
                                                setError(null);
                                            }}
                                        >
                                            Editar
                                        </button>
                                        <button
                                            type="button"
                                            className="panel-link-btn danger"
                                            disabled={busy !== null}
                                            onClick={() => void remove(item)}
                                        >
                                            {confirming === `rm:${item.id}` ? "Confirmar remoção?" : "Tirar"}
                                        </button>
                                    </>
                                )}
                            </li>
                        ))}
                    </ul>
                </div>
            ) : null}

            {error ? <p className="panel-self-service-error">{error}</p> : null}
        </section>
    );
}
