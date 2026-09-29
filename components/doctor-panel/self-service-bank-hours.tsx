"use client";

import { useEffect, useState } from "react";
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
    /**
     * Dia+turno ("AAAA-MM-DD|SD") em que ele já tem plantão pagável no mês —
     * trabalhado, extra ou chefia. O extra não pode cair em cima (a API também barra).
     */
    takenSlots: string[];
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
    takenSlots,
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

    async function submit(action: "bonus" | "penalty") {
        const operationalDate = action === "bonus" ? bonusDate : penaltyPick.split("|")[0];
        const shiftLabel = action === "bonus" ? bonusShift : penaltyPick.split("|")[1];
        if (!operationalDate) return;
        if (!confirmaEmDoisToques(action)) return;

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
        if (!confirmaEmDoisToques(`rm:${extra.settlementId}`)) return;
        await call("DELETE", { settlementId: extra.settlementId }, extra.settlementId);
    }

    const ocupado = (data: string, turno: "SD" | "SN", ignorar?: SelfDeclaredExtra) =>
        takenSlots.includes(`${data}|${turno}`)
        && !(ignorar && ignorar.operationalDate === data && ignorar.shiftLabel === turno);
    // Ao trocar o dia, o turno pula para um livre; sem turno livre, nada a registrar.
    const turnoLivre = (data: string, preferido: "SD" | "SN", ignorar?: SelfDeclaredExtra): "SD" | "SN" | null => {
        if (!data) return preferido;
        if (!ocupado(data, preferido, ignorar)) return preferido;
        const outro = preferido === "SD" ? "SN" : "SD";
        return ocupado(data, outro, ignorar) ? null : outro;
    };
    const bonusDiaCheio = Boolean(bonusDate) && turnoLivre(bonusDate, bonusShift) === null;
    const editando = declaredExtras.find((extra) => extra.settlementId === editing);
    const editDiaCheio = Boolean(editDate) && turnoLivre(editDate, editShift, editando) === null;

    const turnoSelect = ({ id, data, valor, aoMudar, ignorar }: {
        id: string;
        data: string;
        valor: "SD" | "SN";
        aoMudar: (turno: "SD" | "SN") => void;
        ignorar?: SelfDeclaredExtra;
    }) => (
        <select id={id} value={valor} onChange={(event) => aoMudar(event.target.value === "SN" ? "SN" : "SD")}>
            <option value="SD" disabled={Boolean(data) && ocupado(data, "SD", ignorar)}>
                Diurno (SD){data && ocupado(data, "SD", ignorar) ? " · você já tem plantão" : ""}
            </option>
            <option value="SN" disabled={Boolean(data) && ocupado(data, "SN", ignorar)}>
                Noturno (SN){data && ocupado(data, "SN", ignorar) ? " · você já tem plantão" : ""}
            </option>
        </select>
    );

    const titulo = canBonus
        ? "Trocar 12h por 1 plantão extra"
        : canPenalty
            ? "Retirar 1 plantão da folha"
            : "Plantões extra que você declarou";

    return (
        <section className="bhm-cartao" id="troca" aria-labelledby="bhm-t-troca">
            <h2 id="bhm-t-troca">{titulo}</h2>
            {canBonus ? (
                <>
                    <p className="bhm-nota">
                        Escolha um dia e turno em que você não tem plantão. O extra entra na folha valendo um plantão e o saldo cai 12h.
                    </p>
                    <div className="bhm-troca-linha">
                        <label className="bhm-campo" htmlFor="bhm-dia-extra">
                            Dia livre
                            <input
                                id="bhm-dia-extra"
                                type="date"
                                value={bonusDate}
                                min={minDate}
                                max={maxDate}
                                onChange={(event) => {
                                    const dia = event.target.value;
                                    setBonusDate(dia);
                                    setBonusShift((atual) => turnoLivre(dia, atual) ?? atual);
                                }}
                            />
                        </label>
                        <label className="bhm-campo" htmlFor="bhm-turno-extra">
                            Turno
                            {turnoSelect({ id: "bhm-turno-extra", data: bonusDate, valor: bonusShift, aoMudar: setBonusShift })}
                        </label>
                    </div>
                    {bonusDiaCheio ? (
                        <p className="bhm-erro">Você já tem plantão nos dois turnos desse dia. Escolha outro dia.</p>
                    ) : null}
                    <button
                        type="button"
                        className="bhm-botao"
                        disabled={!bonusDate || bonusDiaCheio || busy !== null}
                        onClick={() => void submit("bonus")}
                    >
                        {busy === "bonus"
                            ? "Registrando…"
                            : confirming === "bonus" && bonusDate
                                ? `Confirmar ${formatDia(bonusDate)} (${bonusShift})? O saldo cai 12h`
                                : "Registrar plantão extra"}
                    </button>
                </>
            ) : null}

            {canPenalty && shiftOptions.length === 0 ? (
                // Elegível à retirada, mas nenhum plantão pagável no mês para retirar.
                <p className="bhm-nota">
                    A retirada tira um plantão da folha deste mês, e você ainda não tem plantão pagável em{" "}
                    {monthKey.split("-").reverse().join("/")}. Assim que um plantão seu entrar na folha, a opção aparece aqui.
                </p>
            ) : null}

            {canPenalty && shiftOptions.length > 0 ? (
                <>
                    <p className="bhm-nota">O plantão escolhido sai da folha deste mês e o saldo volta 12h.</p>
                    <label className="bhm-campo" htmlFor="bhm-retirada">
                        Plantão a retirar da folha
                        <select id="bhm-retirada" value={penaltyPick} onChange={(event) => setPenaltyPick(event.target.value)}>
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
                        className="bhm-botao alerta"
                        disabled={!penaltyPick || busy !== null}
                        onClick={() => void submit("penalty")}
                    >
                        {busy === "penalty"
                            ? "Retirando…"
                            : confirming === "penalty" && penaltyPick
                                ? `Confirmar retirada de ${formatDia(penaltyPick.split("|")[0])}? O saldo volta 12h`
                                : "Retirar este plantão"}
                    </button>
                </>
            ) : null}

            {declaredExtras.length > 0 ? (
                <div className="bhm-declarados">
                    {canBonus || canPenalty ? <p className="bhm-nota">Plantões extra que você declarou neste mês</p> : null}
                    <ul>
                        {declaredExtras.map((extra) => (
                            <li key={extra.settlementId}>
                                {editing === extra.settlementId ? (
                                    <div className="bhm-declarado-edicao">
                                        <div className="bhm-troca-linha">
                                            <label className="bhm-campo" htmlFor={`bhm-dia-${extra.settlementId}`}>
                                                Novo dia
                                                <input
                                                    id={`bhm-dia-${extra.settlementId}`}
                                                    type="date"
                                                    value={editDate}
                                                    min={minDate}
                                                    max={maxDate}
                                                    onChange={(event) => {
                                                        const dia = event.target.value;
                                                        setEditDate(dia);
                                                        setEditShift((atual) => turnoLivre(dia, atual, extra) ?? atual);
                                                    }}
                                                />
                                            </label>
                                            <label className="bhm-campo" htmlFor={`bhm-turno-${extra.settlementId}`}>
                                                Novo turno
                                                {turnoSelect({ id: `bhm-turno-${extra.settlementId}`, data: editDate, valor: editShift, aoMudar: setEditShift, ignorar: extra })}
                                            </label>
                                        </div>
                                        {editDiaCheio ? (
                                            <p className="bhm-erro">Você já tem plantão nos dois turnos desse dia. Escolha outro dia.</p>
                                        ) : null}
                                        <div className="bhm-acoes">
                                            <button
                                                type="button"
                                                className="bhm-botao"
                                                disabled={!editDate || editDiaCheio || busy !== null}
                                                onClick={() => void saveEdit(extra.settlementId)}
                                            >
                                                {busy === extra.settlementId ? "Salvando…" : "Salvar"}
                                            </button>
                                            <button type="button" className="bhm-link" onClick={() => setEditing(null)}>
                                                Cancelar
                                            </button>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="bhm-declarado">
                                        <span className="bhm-num">{formatDia(extra.operationalDate)} · {extra.shiftLabel}</span>
                                        <button
                                            type="button"
                                            className="bhm-link"
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
                                            className="bhm-link perigo"
                                            disabled={busy !== null}
                                            onClick={() => void remove(extra)}
                                        >
                                            {confirming === `rm:${extra.settlementId}` ? "Confirmar remoção?" : "Tirar"}
                                        </button>
                                    </div>
                                )}
                            </li>
                        ))}
                    </ul>
                </div>
            ) : null}

            {error ? <p className="bhm-erro">{error}</p> : null}
        </section>
    );
}
