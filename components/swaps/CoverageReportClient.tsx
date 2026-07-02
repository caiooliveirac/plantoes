"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { CoverageReportRow } from "@/services/shift-swaps.service";

function shiftDate(date: string, days: number) {
    const [y, m, d] = date.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function formatDateBr(date: string) {
    const [y, m, d] = date.split("-");
    return `${d}/${m}/${y}`;
}

export function CoverageReportClient({ initialDate, initialRows }: { initialDate: string; initialRows: CoverageReportRow[] }) {
    const [date, setDate] = useState(initialDate);
    const [rows, setRows] = useState<CoverageReportRow[]>(initialRows);

    const refresh = useCallback(async (targetDate: string) => {
        const response = await fetch(`/api/swaps/report?date=${targetDate}`);
        if (response.ok) {
            const payload = await response.json();
            setRows(payload.rows ?? []);
        }
    }, []);

    useEffect(() => {
        if (date !== initialDate) {
            void refresh(date);
        }
    }, [date, initialDate, refresh]);

    const covered = rows.filter((row) => row.coveredBySwap).length;

    return (
        <main className="et-shell">
            <header className="et-hero">
                <div>
                    <h1>Cobertura do dia</h1>
                    <p>
                        Quem estava por quem: escala prevista resolvida com as trocas aprovadas, casada com os
                        check-ins reais do robô. O local pode divergir do previsto — a atribuição segue a pessoa,
                        não o lugar.
                    </p>
                </div>
                <div className="et-datenav">
                    <button type="button" onClick={() => setDate(shiftDate(date, -1))} aria-label="Dia anterior">‹</button>
                    <strong>{formatDateBr(date)}</strong>
                    <button type="button" onClick={() => setDate(shiftDate(date, 1))} aria-label="Próximo dia">›</button>
                </div>
            </header>

            <section className="et-panel">
                <div className="et-panel-head">
                    <h2>{rows.length} plantões previstos</h2>
                    <span className="et-badge fixed">{covered} com cobertura por troca</span>
                </div>
                <AnimatePresence initial={false}>
                    {rows.map((row) => (
                        <motion.div
                            key={row.shiftId}
                            layout
                            className="et-report-row"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                        >
                            <div className="et-target-label">
                                {row.targetLabel}
                                <small>{row.shiftLabel} · {row.domain === "regulation" ? "regulação" : "intervenção"}</small>
                            </div>
                            <div className="et-coverage-chain">
                                <span className="et-chip">{row.effectiveDoctorName}</span>
                                {row.coveredBySwap ? (
                                    <>
                                        <span className="por">por</span>
                                        <span className="et-chip">{row.originalDoctorName}</span>
                                    </>
                                ) : null}
                                {row.effectiveTargetLabel !== row.targetLabel ? (
                                    <span className="divergent">→ cumpre em {row.effectiveTargetLabel}</span>
                                ) : null}
                                {row.presence === "presente" && row.presenceTargetMatches === false ? (
                                    <span className="divergent">(check-in em local diferente)</span>
                                ) : null}
                            </div>
                            <div className={`et-presence ${row.presence}`}>
                                <span className="dot" />
                                {row.presence === "presente"
                                    ? `check-in ${row.checkinAt ? new Date(row.checkinAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }) : ""}`
                                    : "sem check-in"}
                            </div>
                        </motion.div>
                    ))}
                </AnimatePresence>
                {rows.length === 0 ? (
                    <div className="et-empty-state">Nenhum plantão previsto para {formatDateBr(date)}. Monte a escala em /escala.</div>
                ) : null}
            </section>
        </main>
    );
}
