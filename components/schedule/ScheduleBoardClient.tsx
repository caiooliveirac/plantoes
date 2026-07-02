"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { ScheduleBoard, ScheduleDoctorEntry, ScheduleShiftLabel } from "@/services/schedule.service";

const WEEKDAYS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

function shiftDate(date: string, days: number) {
    const [y, m, d] = date.split("-").map(Number);
    const next = new Date(Date.UTC(y, m - 1, d + days));
    return next.toISOString().slice(0, 10);
}

function formatDateBr(date: string) {
    const [y, m, d] = date.split("-");
    return `${d}/${m}/${y}`;
}

export function ScheduleBoardClient({ initialBoard }: { initialBoard: ScheduleBoard }) {
    const [board, setBoard] = useState<ScheduleBoard>(initialBoard);
    const [date, setDate] = useState(initialBoard.operationalDate);
    const [selectedDoctor, setSelectedDoctor] = useState<ScheduleDoctorEntry | null>(null);
    const [showAllDoctors, setShowAllDoctors] = useState(false);
    const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
    const [busy, setBusy] = useState(false);

    const refresh = useCallback(async (targetDate: string) => {
        const response = await fetch(`/api/schedule?date=${targetDate}`);
        if (response.ok) {
            setBoard(await response.json());
        }
    }, []);

    useEffect(() => {
        if (date !== board.operationalDate) {
            void refresh(date);
        }
    }, [date, board.operationalDate, refresh]);

    const fixedDoctors = useMemo(() => board.doctors.filter((doctor) => doctor.fixedForWeekday), [board.doctors]);
    const otherDoctors = useMemo(() => board.doctors.filter((doctor) => !doctor.fixedForWeekday), [board.doctors]);
    const visibleDoctors = showAllDoctors ? [...fixedDoctors, ...otherDoctors] : fixedDoctors;

    async function assign(domain: string, targetId: number, shiftLabel: ScheduleShiftLabel) {
        if (!selectedDoctor || busy) {
            if (!selectedDoctor) {
                setFeedback({ kind: "err", text: "Selecione um médico no painel à direita antes de preencher o turno." });
            }
            return;
        }

        setBusy(true);
        setFeedback(null);
        try {
            const response = await fetch("/api/schedule", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    domain,
                    targetId,
                    doctorId: selectedDoctor.id,
                    operationalDate: date,
                    shiftLabel,
                }),
            });
            const payload = await response.json();
            if (!response.ok) {
                setFeedback({ kind: "err", text: payload.error ?? "Não foi possível escalar." });
                return;
            }
            setFeedback({ kind: "ok", text: `${selectedDoctor.displayName ?? selectedDoctor.fullName} escalado(a) (${shiftLabel}).` });
            await refresh(date);
        } finally {
            setBusy(false);
        }
    }

    async function cancelShift(shiftId: string) {
        if (busy) return;
        setBusy(true);
        try {
            const response = await fetch(`/api/schedule/${shiftId}/cancel`, { method: "POST" });
            if (response.ok) {
                await refresh(date);
            }
        } finally {
            setBusy(false);
        }
    }

    const regulationTargets = board.targets.filter((target) => target.domain === "regulation");
    const interventionTargets = board.targets.filter((target) => target.domain === "intervention");

    return (
        <main className="et-shell">
            <header className="et-hero">
                <div>
                    <h1>Escala de plantões</h1>
                    <p>
                        Monte a escala prevista do dia. Médicos fixos de {WEEKDAYS[board.weekday]} aparecem primeiro
                        no painel — expanda para ver todo o corpo clínico. A escala norteia os donos originais;
                        pagamento continua pelos check-ins do robô.
                    </p>
                </div>
                <div className="et-datenav">
                    <button type="button" onClick={() => setDate(shiftDate(date, -1))} aria-label="Dia anterior">‹</button>
                    <div>
                        <strong>{formatDateBr(date)}</strong>{" "}
                        <span className="et-weekday">{WEEKDAYS[board.weekday]}</span>
                    </div>
                    <button type="button" onClick={() => setDate(shiftDate(date, 1))} aria-label="Próximo dia">›</button>
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
                <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                    {[{ title: "Regulação", domain: "regulation", targets: regulationTargets },
                      { title: "Intervenção", domain: "intervention", targets: interventionTargets }].map((section) => (
                        <section key={section.domain} className="et-panel">
                            <div className="et-panel-head">
                                <h2>{section.title}</h2>
                                <span className={`et-domain-tag ${section.domain}`}>{section.targets.length} alvos</span>
                            </div>
                            <div className="et-grid">
                                <div className="et-colhead">Posto / Base</div>
                                <div className="et-colhead">SD · 07–19</div>
                                <div className="et-colhead">SN · 19–07</div>
                                {section.targets.map((target) => (
                                    <SlotRow
                                        key={`${target.domain}-${target.targetId}`}
                                        target={target}
                                        onAssign={(label) => assign(target.domain, target.targetId, label)}
                                        onCancel={cancelShift}
                                    />
                                ))}
                            </div>
                        </section>
                    ))}
                </div>

                <aside className="et-panel et-doctors">
                    <div className="et-panel-head">
                        <h2>Médicos</h2>
                        <span className="et-badge fixed">{fixedDoctors.length} fixos de {WEEKDAYS[board.weekday]}</span>
                    </div>
                    <div className="et-doctors-list">
                        <AnimatePresence initial={false}>
                            {visibleDoctors.map((doctor) => (
                                <motion.div
                                    key={doctor.id}
                                    layout
                                    initial={{ opacity: 0, y: 6 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0 }}
                                    className={`et-doctor-card${selectedDoctor?.id === doctor.id ? " selected" : ""}`}
                                    onClick={() => setSelectedDoctor(selectedDoctor?.id === doctor.id ? null : doctor)}
                                >
                                    <div>
                                        <div className="et-doc-name">{doctor.displayName ?? doctor.fullName}</div>
                                        <div className="et-doc-meta">
                                            {doctor.admittedAt ? <span>desde {formatDateBr(doctor.admittedAt)}</span> : <span>sem admissão</span>}
                                        </div>
                                    </div>
                                    <div className="et-doc-meta">
                                        {doctor.fixedForWeekday ? <span className="et-badge fixed">fixo</span> : null}
                                        {doctor.eligibleRegulation ? <span className="et-badge reg">REG</span> : null}
                                        {doctor.eligibleIntervention ? <span className="et-badge int">INT</span> : null}
                                    </div>
                                </motion.div>
                            ))}
                        </AnimatePresence>
                        {visibleDoctors.length === 0 ? (
                            <div className="et-empty-state">Nenhum médico fixo de {WEEKDAYS[board.weekday]}. Expanda para ver todos.</div>
                        ) : null}
                    </div>
                    <button type="button" className="et-expander" onClick={() => setShowAllDoctors(!showAllDoctors)}>
                        {showAllDoctors ? "▲ Mostrar só os fixos do dia" : `▼ Expandir corpo clínico (${otherDoctors.length})`}
                    </button>
                </aside>
            </div>
        </main>
    );
}

function SlotRow({
    target,
    onAssign,
    onCancel,
}: {
    target: ScheduleBoard["targets"][number];
    onAssign: (label: ScheduleShiftLabel) => void;
    onCancel: (shiftId: string) => void;
}) {
    return (
        <>
            <div className="et-target-label">
                {target.label}
                <small>{target.code}</small>
            </div>
            {(["SD", "SN"] as const).map((label) => {
                const scheduled = target.scheduled[label];
                return (
                    <div
                        key={label}
                        className={`et-slot${scheduled ? " filled" : ""}`}
                        onClick={scheduled ? undefined : () => onAssign(label)}
                    >
                        {scheduled ? (
                            <motion.span layout className="et-chip" initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}>
                                {scheduled.doctorName}
                                <button
                                    type="button"
                                    className="et-chip-x"
                                    aria-label="Cancelar plantão previsto"
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        onCancel(scheduled.shiftId);
                                    }}
                                >
                                    ×
                                </button>
                            </motion.span>
                        ) : (
                            <span className="et-empty">+ escalar</span>
                        )}
                    </div>
                );
            })}
        </>
    );
}
