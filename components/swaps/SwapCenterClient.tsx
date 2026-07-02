"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Monogram } from "@/components/ui/Monogram";
import type { OfferView, SwapBoardDay } from "@/services/shift-offers.service";

const WEEKDAYS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

interface MyShift {
    id: string;
    domain: string;
    operationalDate: string;
    shiftLabel: string;
    targetLabel: string;
}

interface PendingSwap {
    id: string;
    status: string;
    fromDoctorName: string;
    toDoctorName: string;
    shift: { operationalDate: string; shiftLabel: string } | null;
}

function formatDateBr(date: string) {
    const [y, m, d] = date.split("-");
    return `${d}/${m}/${y}`;
}

export function SwapCenterClient({ isChief, myDoctorId, myShifts, initialBoard, today }: {
    isChief: boolean;
    myDoctorId: string | null;
    myShifts: MyShift[];
    initialBoard: SwapBoardDay[];
    today: string;
}) {
    const [board, setBoard] = useState<SwapBoardDay[]>(initialBoard);
    const [pending, setPending] = useState<PendingSwap[]>([]);
    const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
    const [busy, setBusy] = useState(false);
    const [offerForm, setOfferForm] = useState({ shiftId: "", bonusBrl: 0, note: "", open: false });
    const [counterFor, setCounterFor] = useState<{ offerId: string; shiftId: string } | null>(null);

    const refresh = useCallback(async () => {
        const [offersResponse, swapsResponse] = await Promise.all([
            fetch("/api/offers"),
            isChief ? fetch("/api/swaps") : Promise.resolve(null),
        ]);
        if (offersResponse.ok) {
            const payload = await offersResponse.json();
            setBoard(payload.board ?? []);
        }
        if (swapsResponse?.ok) {
            const payload = await swapsResponse.json();
            setPending((payload.swaps ?? []).filter((swap: PendingSwap) => swap.status === "accepted"));
        }
    }, [isChief]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    async function call(url: string, body?: unknown) {
        setBusy(true);
        setFeedback(null);
        try {
            const response = await fetch(url, {
                method: "POST",
                headers: body ? { "content-type": "application/json" } : undefined,
                body: body ? JSON.stringify(body) : undefined,
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
                setFeedback({ kind: "err", text: payload.error ?? "Operação falhou." });
                return false;
            }
            await refresh();
            return true;
        } finally {
            setBusy(false);
        }
    }

    async function submitOffer() {
        if (!offerForm.shiftId) {
            setFeedback({ kind: "err", text: "Escolha qual dos seus plantões vai para o mural." });
            return;
        }
        const ok = await call("/api/offers", {
            shiftId: offerForm.shiftId,
            bonusBrl: offerForm.bonusBrl,
            note: offerForm.note || null,
        });
        if (ok) {
            setOfferForm({ shiftId: "", bonusBrl: 0, note: "", open: false });
            setFeedback({ kind: "ok", text: "Plantão no mural. Todo o corpo clínico já pode ver e pegar." });
        }
    }

    const bonusPreview = "$".repeat(Math.min(10, Math.floor(offerForm.bonusBrl / 100)));

    return (
        <main className="et-shell">
            <header className="et-hero">
                <div>
                    <h1>Mural de trocas</h1>
                    <p>
                        As próximas duas semanas, dia a dia, diurno e noturno separados — com todas as ofertas
                        abertas. Cada <strong style={{ color: "var(--accent-confirm)" }}>$</strong> sinaliza R$100 de
                        bônus de quem oferta. Pegue direto, ou contra-oferte um plantão seu: a oferta continua
                        visível e outros colegas podem dar lance até o ofertante escolher.
                    </p>
                </div>
                {myDoctorId ? (
                    <button type="button" className="et-btn primary" onClick={() => setOfferForm({ ...offerForm, open: !offerForm.open })}>
                        {offerForm.open ? "Fechar" : "＋ Ofertar plantão meu"}
                    </button>
                ) : null}
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

            <AnimatePresence>
                {offerForm.open ? (
                    <motion.section
                        className="et-panel"
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        style={{ overflow: "hidden" }}
                    >
                        <div className="et-panel-head"><h2>Nova oferta</h2></div>
                        <div className="et-form" style={{ padding: 16, maxWidth: 640 }}>
                            <label>
                                Qual plantão meu vai pro mural
                                <select value={offerForm.shiftId} onChange={(event) => setOfferForm({ ...offerForm, shiftId: event.target.value })}>
                                    <option value="">— selecione —</option>
                                    {myShifts.map((shift) => (
                                        <option key={shift.id} value={shift.id}>
                                            {formatDateBr(shift.operationalDate)} · {shift.shiftLabel} · {shift.targetLabel}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <label>
                                Bônus (opcional — cada $ = R$100, ninguém vê o valor em texto)
                                <span className="mu-bonus-stepper">
                                    <button type="button" onClick={() => setOfferForm({ ...offerForm, bonusBrl: Math.max(0, offerForm.bonusBrl - 100) })} aria-label="Menos R$100">−</button>
                                    <span className="icons mu-bonus">{bonusPreview || "sem bônus"}</span>
                                    <button type="button" onClick={() => setOfferForm({ ...offerForm, bonusBrl: Math.min(5000, offerForm.bonusBrl + 100) })} aria-label="Mais R$100">＋</button>
                                </span>
                            </label>
                            <label>
                                Recado (opcional)
                                <input value={offerForm.note} onChange={(event) => setOfferForm({ ...offerForm, note: event.target.value })} placeholder="ex.: preciso viajar, dou preferência a troca em julho" />
                            </label>
                            <button type="button" className="et-btn confirm" disabled={busy} onClick={submitOffer}>
                                Publicar no mural
                            </button>
                        </div>
                    </motion.section>
                ) : null}
            </AnimatePresence>

            {isChief && pending.length > 0 ? (
                <section className="et-panel">
                    <div className="et-panel-head"><h2>Acordos aguardando sua aprovação</h2></div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 14 }}>
                        {pending.map((swap) => (
                            <div key={swap.id} className="mu-offer">
                                <div className="mu-offer-top">
                                    <Monogram name={swap.fromDoctorName} size={24} />
                                    <span className="name">{swap.fromDoctorName} ⇢ {swap.toDoctorName}</span>
                                    <span className="target">
                                        {swap.shift ? `${formatDateBr(swap.shift.operationalDate)} · ${swap.shift.shiftLabel}` : ""}
                                    </span>
                                    <span className="mu-actions" style={{ marginLeft: "auto" }}>
                                        <button type="button" className="et-btn primary" disabled={busy} onClick={() => call(`/api/swaps/${swap.id}/transition`, { action: "approve" })}>Aprovar</button>
                                        <button type="button" className="et-btn danger" disabled={busy} onClick={() => call(`/api/swaps/${swap.id}/transition`, { action: "reject" })}>Recusar</button>
                                    </span>
                                </div>
                            </div>
                        ))}
                    </div>
                </section>
            ) : null}

            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {board.map((day) => {
                    const total = day.offers.SD.length + day.offers.SN.length;
                    return (
                        <section key={day.operationalDate} className={`mu-day${day.operationalDate === today ? " today" : ""}`}>
                            <div className="mu-day-head">
                                <span className="dow">{WEEKDAYS[day.weekday]}</span>
                                <span className="dt">{formatDateBr(day.operationalDate)}</span>
                                {day.operationalDate === today ? <span className="et-badge reg">hoje</span> : null}
                                <span className="count">{total === 0 ? "sem ofertas" : `${total} oferta${total > 1 ? "s" : ""}`}</span>
                            </div>
                            <div className="mu-lanes">
                                <OfferLane
                                    label="☀ diurno"
                                    lane="sd"
                                    offers={day.offers.SD}
                                    myDoctorId={myDoctorId}
                                    myShifts={myShifts}
                                    busy={busy}
                                    counterFor={counterFor}
                                    setCounterFor={setCounterFor}
                                    call={call}
                                />
                                <OfferLane
                                    label="☾ noturno"
                                    lane="sn"
                                    offers={day.offers.SN}
                                    myDoctorId={myDoctorId}
                                    myShifts={myShifts}
                                    busy={busy}
                                    counterFor={counterFor}
                                    setCounterFor={setCounterFor}
                                    call={call}
                                />
                            </div>
                        </section>
                    );
                })}
            </div>
        </main>
    );
}

function OfferLane({ label, lane, offers, myDoctorId, myShifts, busy, counterFor, setCounterFor, call }: {
    label: string;
    lane: "sd" | "sn";
    offers: OfferView[];
    myDoctorId: string | null;
    myShifts: MyShift[];
    busy: boolean;
    counterFor: { offerId: string; shiftId: string } | null;
    setCounterFor: (value: { offerId: string; shiftId: string } | null) => void;
    call: (url: string, body?: unknown) => Promise<boolean>;
}) {
    return (
        <div className="mu-lane">
            <span className={`mu-lane-head ${lane}`}>{label}</span>
            {offers.length === 0 ? <span className="none">—</span> : null}
            <AnimatePresence initial={false}>
                {offers.map((offer) => {
                    const mine = offer.offeredByDoctorId === myDoctorId;
                    const myBid = offer.bids.find((bid) => bid.doctorId === myDoctorId && bid.status === "pending");
                    return (
                        <motion.article
                            key={offer.id}
                            layout
                            className={`mu-offer${offer.status === "committed" ? " committed" : ""}`}
                            initial={{ opacity: 0, y: 8 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0 }}
                        >
                            <div className="mu-offer-top">
                                <Monogram name={offer.offeredByDoctorName} size={26} />
                                <span style={{ minWidth: 0 }}>
                                    <span className="name" style={{ display: "block" }}>{offer.offeredByDoctorName}</span>
                                    <span className="target">{offer.targetLabel} · {offer.domain === "regulation" ? "regulação" : "intervenção"}</span>
                                </span>
                                {offer.bonusBrl > 0 ? (
                                    <span className="mu-bonus" title="Bônus sinalizado: cada $ vale R$100">{offer.bonusIcons}</span>
                                ) : null}
                            </div>
                            {offer.note ? <span className="note">{offer.note}</span> : null}
                            {offer.status === "committed" ? (
                                <span className="note" style={{ color: "var(--accent-info)" }}>acordo fechado — aguardando chefia</span>
                            ) : null}

                            {offer.bids.length > 0 ? (
                                <div className="mu-bids">
                                    {offer.bids.map((bid) => (
                                        <div key={bid.id} className={`mu-bid${bid.status === "chosen" ? " chosen" : ""}`}>
                                            <Monogram name={bid.doctorName} size={20} />
                                            <span>{bid.doctorName}</span>
                                            <span className="k">{bid.kind === "take" ? "quer pegar" : `oferece ${bid.counterShiftLabel ?? "troca"}`}</span>
                                            {mine && offer.status === "open" && bid.status === "pending" ? (
                                                <button
                                                    type="button" className="et-btn confirm" style={{ marginLeft: "auto", padding: "4px 10px", fontSize: 11 }}
                                                    disabled={busy}
                                                    onClick={() => call(`/api/offers/${offer.id}/choose`, { bidId: bid.id })}
                                                >
                                                    Fechar com {bid.doctorName.split(" ")[0]}
                                                </button>
                                            ) : null}
                                        </div>
                                    ))}
                                </div>
                            ) : null}

                            {offer.status === "open" && myDoctorId && !mine && !myBid ? (
                                <div className="mu-actions">
                                    <button type="button" className="et-btn confirm" disabled={busy} onClick={() => call(`/api/offers/${offer.id}/bids`, { kind: "take" })}>
                                        Pegar
                                    </button>
                                    {counterFor?.offerId === offer.id ? (
                                        <>
                                            <select
                                                value={counterFor.shiftId}
                                                onChange={(event) => setCounterFor({ offerId: offer.id, shiftId: event.target.value })}
                                                style={{ background: "var(--surface-elevated)", color: "var(--text)", border: "1px solid var(--surface-elevated-border)", borderRadius: 10, padding: "6px 8px", fontSize: 12 }}
                                            >
                                                <option value="">meu plantão…</option>
                                                {myShifts.map((shift) => (
                                                    <option key={shift.id} value={shift.id}>
                                                        {formatDateBr(shift.operationalDate)} · {shift.shiftLabel} · {shift.targetLabel}
                                                    </option>
                                                ))}
                                            </select>
                                            <button
                                                type="button" className="et-btn primary" disabled={busy || !counterFor.shiftId}
                                                onClick={async () => {
                                                    const ok = await call(`/api/offers/${offer.id}/bids`, { kind: "counter", counterShiftId: counterFor.shiftId });
                                                    if (ok) setCounterFor(null);
                                                }}
                                            >
                                                Enviar
                                            </button>
                                            <button type="button" className="et-btn" onClick={() => setCounterFor(null)}>✕</button>
                                        </>
                                    ) : (
                                        <button type="button" className="et-btn" disabled={busy} onClick={() => setCounterFor({ offerId: offer.id, shiftId: "" })}>
                                            Contra-ofertar
                                        </button>
                                    )}
                                </div>
                            ) : null}
                            {myBid ? <span className="note" style={{ color: "var(--accent-confirm)" }}>seu lance está no mural — aguardando o ofertante</span> : null}
                            {mine && offer.status === "open" ? (
                                <div className="mu-actions">
                                    <button type="button" className="et-btn danger" disabled={busy} onClick={() => call(`/api/offers/${offer.id}/withdraw`)}>
                                        Retirar oferta
                                    </button>
                                </div>
                            ) : null}
                        </motion.article>
                    );
                })}
            </AnimatePresence>
        </div>
    );
}
