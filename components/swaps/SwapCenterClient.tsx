"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Monogram } from "@/components/ui/Monogram";

interface SwapShift {
    id: string;
    domain: string;
    operationalDate: string;
    shiftLabel: string;
}

interface SwapEntry {
    id: string;
    swapType: "transfer" | "mutual" | "function_change" | "base_change";
    status: "offered" | "accepted" | "approved" | "rejected" | "cancelled";
    fromDoctorName: string;
    toDoctorName: string;
    notes: string | null;
    shift: SwapShift | null;
    counterpartShift: SwapShift | null;
}

interface MyShift {
    id: string;
    domain: string;
    operationalDate: string;
    shiftLabel: string;
}

interface DoctorOption {
    id: string;
    name: string;
}

const SWAP_TYPE_LABELS: Record<SwapEntry["swapType"], string> = {
    transfer: "repasse",
    mutual: "troca mútua",
    function_change: "troca de função",
    base_change: "troca de base",
};

const MONTHS_SHORT = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

function formatDateBr(date: string) {
    const [y, m, d] = date.split("-");
    return `${d}/${m}/${y}`;
}

/** Trilho proposta → aceite → chefia; rejeitada/cancelada mata o passo corrente. */
function TicketSteps({ status }: { status: SwapEntry["status"] }) {
    const dead = status === "rejected" || status === "cancelled";
    const reach = status === "approved" ? 3 : status === "accepted" ? 2 : 1;
    const steps = [
        { lbl: "proposta", done: reach >= 1 },
        { lbl: "aceite", done: reach >= 2 },
        { lbl: "chefia", done: reach >= 3 },
    ];
    return (
        <div className="tk-steps" aria-label={`status: ${status}`}>
            {steps.map((step, index) => (
                <span key={step.lbl} style={{ display: "contents" }}>
                    {index > 0 ? <span className={`bar${steps[index].done ? " done" : ""}`} /> : null}
                    <span className={`step${step.done ? " done" : ""}${dead && index === reach - 1 ? " dead" : ""}`}>
                        <span className="dot" />
                        <span className="lbl">{step.lbl}</span>
                    </span>
                </span>
            ))}
        </div>
    );
}

export function SwapCenterClient({
    isChief,
    myDoctorId,
    myShifts,
    doctorOptions,
}: {
    isChief: boolean;
    myDoctorId: string | null;
    myShifts: MyShift[];
    doctorOptions: DoctorOption[];
}) {
    const [swaps, setSwaps] = useState<SwapEntry[]>([]);
    const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
    const [busy, setBusy] = useState(false);
    const [form, setForm] = useState({ shiftId: "", swapType: "transfer", toDoctorId: "", notes: "" });

    const refresh = useCallback(async () => {
        const response = await fetch("/api/swaps");
        if (response.ok) {
            const payload = await response.json();
            setSwaps(payload.swaps ?? []);
        }
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    async function submit() {
        if (busy || !form.shiftId || !form.toDoctorId) {
            setFeedback({ kind: "err", text: "Escolha o plantão e o médico destinatário." });
            return;
        }
        setBusy(true);
        setFeedback(null);
        try {
            const response = await fetch("/api/swaps", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    shiftId: form.shiftId,
                    swapType: form.swapType,
                    toDoctorId: form.toDoctorId,
                    notes: form.notes || null,
                }),
            });
            const payload = await response.json();
            if (!response.ok) {
                setFeedback({ kind: "err", text: payload.error ?? "Não foi possível propor a troca." });
                return;
            }
            setFeedback({ kind: "ok", text: "Troca proposta. Aguarde o aceite do colega e a aprovação da chefia." });
            setForm({ shiftId: "", swapType: "transfer", toDoctorId: "", notes: "" });
            await refresh();
        } finally {
            setBusy(false);
        }
    }

    async function transition(swapId: string, action: "accept" | "approve" | "reject" | "cancel") {
        if (busy) return;
        setBusy(true);
        try {
            const response = await fetch(`/api/swaps/${swapId}/transition`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ action }),
            });
            const payload = await response.json();
            if (!response.ok) {
                setFeedback({ kind: "err", text: payload.error ?? "Transição não permitida." });
            }
            await refresh();
        } finally {
            setBusy(false);
        }
    }

    return (
        <main className="et-shell">
            <header className="et-hero">
                <div>
                    <h1>Trocas de plantão</h1>
                    <p>
                        Cada troca é um bilhete: você propõe, o colega aceita, a chefia carimba. O relatório de
                        cobertura passa a mostrar quem está por quem — check-ins e pagamento seguem como hoje.
                    </p>
                </div>
            </header>

            <AnimatePresence>
                {feedback ? (
                    <motion.div
                        key={feedback.text}
                        className={`et-feedback ${feedback.kind}`}
                        initial={{ opacity: 0, y: -8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0 }}
                    >
                        {feedback.text}
                    </motion.div>
                ) : null}
            </AnimatePresence>

            <div className="et-layout">
                <section className="et-panel">
                    <div className="et-panel-head">
                        <h2>{isChief ? "Todas as trocas" : "Minhas trocas"}</h2>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 16 }}>
                        <AnimatePresence initial={false}>
                            {swaps.map((swap) => {
                                const [, month, day] = (swap.shift?.operationalDate ?? "----00-00").split("-");
                                return (
                                    <motion.article
                                        key={swap.id}
                                        layout
                                        className="tk-card"
                                        initial={{ opacity: 0, y: 10 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        exit={{ opacity: 0 }}
                                    >
                                        <div className="tk-stub">
                                            <span className="day">{day}</span>
                                            <span className="month">{MONTHS_SHORT[Number(month) - 1] ?? "—"}</span>
                                            <span className={`turno ${swap.shift?.shiftLabel === "SN" ? "sn" : "sd"}`}>
                                                {swap.shift?.shiftLabel === "SN" ? "☾ SN" : "☀ SD"}
                                            </span>
                                        </div>
                                        <div className="tk-body">
                                            <div className="tk-flow">
                                                <span className="who">
                                                    <Monogram name={swap.fromDoctorName} size={26} />
                                                    {swap.fromDoctorName}
                                                </span>
                                                <span className="arrow">⇢</span>
                                                <span className="who">
                                                    <Monogram name={swap.toDoctorName} size={26} />
                                                    {swap.toDoctorName}
                                                </span>
                                                <span className="kind">{SWAP_TYPE_LABELS[swap.swapType]}</span>
                                            </div>
                                            <span className="tk-note">
                                                {swap.shift ? `${swap.shift.domain === "regulation" ? "regulação" : "intervenção"} · ${formatDateBr(swap.shift.operationalDate)}` : ""}
                                                {swap.notes ? ` — ${swap.notes}` : ""}
                                            </span>
                                            <div className="et-actions">
                                                {swap.status === "offered" && myDoctorId ? (
                                                    <button type="button" className="et-btn confirm" disabled={busy} onClick={() => transition(swap.id, "accept")}>
                                                        Aceitar
                                                    </button>
                                                ) : null}
                                                {swap.status === "accepted" && isChief ? (
                                                    <button type="button" className="et-btn primary" disabled={busy} onClick={() => transition(swap.id, "approve")}>
                                                        Aprovar
                                                    </button>
                                                ) : null}
                                                {(swap.status === "offered" || swap.status === "accepted") ? (
                                                    <>
                                                        <button type="button" className="et-btn danger" disabled={busy} onClick={() => transition(swap.id, "reject")}>
                                                            Recusar
                                                        </button>
                                                        <button type="button" className="et-btn" disabled={busy} onClick={() => transition(swap.id, "cancel")}>
                                                            Cancelar
                                                        </button>
                                                    </>
                                                ) : null}
                                            </div>
                                        </div>
                                        <div className="tk-side">
                                            <TicketSteps status={swap.status} />
                                            <span className={`et-status ${swap.status}`}>{swap.status === "accepted" ? "aguarda chefia" : swap.status}</span>
                                        </div>
                                    </motion.article>
                                );
                            })}
                        </AnimatePresence>
                        {swaps.length === 0 ? <div className="et-empty-state">Nenhuma troca por aqui ainda.</div> : null}
                    </div>
                </section>

                {myDoctorId ? (
                    <aside className="et-panel">
                        <div className="et-panel-head">
                            <h2>Propor troca</h2>
                        </div>
                        <div className="et-form" style={{ padding: 16 }}>
                            <label>
                                Meu plantão previsto
                                <select value={form.shiftId} onChange={(event) => setForm({ ...form, shiftId: event.target.value })}>
                                    <option value="">— selecione —</option>
                                    {myShifts.map((shift) => (
                                        <option key={shift.id} value={shift.id}>
                                            {formatDateBr(shift.operationalDate)} · {shift.shiftLabel} · {shift.domain === "regulation" ? "regulação" : "intervenção"}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <label>
                                Tipo
                                <select value={form.swapType} onChange={(event) => setForm({ ...form, swapType: event.target.value })}>
                                    <option value="transfer">Repasse (colega assume por mim)</option>
                                    <option value="function_change">Troca de função</option>
                                    <option value="base_change">Troca de base</option>
                                </select>
                            </label>
                            <label>
                                Para
                                <select value={form.toDoctorId} onChange={(event) => setForm({ ...form, toDoctorId: event.target.value })}>
                                    <option value="">— selecione o colega —</option>
                                    {doctorOptions.map((doctor) => (
                                        <option key={doctor.id} value={doctor.id}>{doctor.name}</option>
                                    ))}
                                </select>
                            </label>
                            <label>
                                Observação (opcional)
                                <textarea rows={2} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} />
                            </label>
                            <button type="button" className="et-btn primary" disabled={busy} onClick={submit}>
                                Propor troca
                            </button>
                        </div>
                    </aside>
                ) : null}
            </div>
        </main>
    );
}
