"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Monogram } from "@/components/ui/Monogram";
import type { ScheduleBoard, ScheduleDoctorEntry, ScheduleShiftLabel, ScheduleTargetEntry } from "@/services/schedule.service";

const WEEKDAYS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

/** Funções da regulação com cor semântica própria (dados reais do serviço). */
const ROLE_OPTIONS = ["RMT", "COI", "CP", "MRV", "PIAM", "PSIQ"] as const;

function roleClass(role: string | null | undefined) {
    const normalized = (role ?? "").toUpperCase();
    if (["CP", "COI", "RMT", "MRV", "PIAM", "PSIQ"].includes(normalized)) {
        return normalized.toLowerCase();
    }
    return "other";
}

function shiftDate(date: string, days: number) {
    const [y, m, d] = date.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function formatDateBr(date: string) {
    const [y, m, d] = date.split("-");
    return `${d}/${m}/${y}`;
}

function SectionMeter({ filled, total }: { filled: number; total: number }) {
    const radius = 9;
    const circumference = 2 * Math.PI * radius;
    const ratio = total > 0 ? filled / total : 0;
    return (
        <span className="et-meter" title={`${filled} de ${total} preenchidos`}>
            <svg width="24" height="24" viewBox="0 0 24 24" role="img" aria-label={`${filled} de ${total}`}>
                <circle cx="12" cy="12" r={radius} fill="none" stroke="var(--line)" strokeWidth="2.5" />
                <circle
                    cx="12" cy="12" r={radius} fill="none"
                    stroke={ratio >= 1 ? "var(--accent-confirm)" : "var(--accent-info)"}
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeDasharray={circumference}
                    strokeDashoffset={circumference * (1 - ratio)}
                    transform="rotate(-90 12 12)"
                    style={{ transition: "stroke-dashoffset var(--dur-slow) var(--ease-emph)" }}
                />
            </svg>
            <span className="num">{filled}/{total}</span>
        </span>
    );
}

export function ScheduleBoardClient({ initialBoard, canEdit }: { initialBoard: ScheduleBoard; canEdit: boolean }) {
    const [board, setBoard] = useState<ScheduleBoard>(initialBoard);
    const [date, setDate] = useState(initialBoard.operationalDate);
    const [lens, setLens] = useState<ScheduleShiftLabel>("SD");
    const [armedDoctor, setArmedDoctor] = useState<ScheduleDoctorEntry | null>(null);
    const [armedRole, setArmedRole] = useState<string>("RMT");
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

    const fixedDoctors = useMemo(
        () => board.doctors.filter((doctor) => doctor.fixedShiftLabels.includes(lens) || (doctor.fixedForWeekday && doctor.fixedShiftLabels.length === 0)),
        [board.doctors, lens],
    );
    const otherDoctors = useMemo(
        () => board.doctors.filter((doctor) => !fixedDoctors.includes(doctor)),
        [board.doctors, fixedDoctors],
    );
    const visibleDoctors = showAllDoctors ? [...fixedDoctors, ...otherDoctors] : fixedDoctors;

    const regulationTargets = board.targets.filter((target) => target.domain === "regulation");
    const usaTargets = board.targets.filter((target) => target.domain === "intervention");

    const filledCount = (targets: ScheduleTargetEntry[]) => targets.filter((target) => target.scheduled[lens]).length;

    // Trilho de comando: o invariante do serviço (1 CP + 2 COI, sempre) vira
    // slots dedicados no topo, derivados das escalações da regulação por função.
    const commandSeats = useMemo(() => {
        const assignments = regulationTargets
            .map((target) => ({ target, scheduled: target.scheduled[lens] }))
            .filter((entry) => entry.scheduled);
        const cp = assignments.filter((entry) => (entry.scheduled!.roleLabel ?? "").toUpperCase() === "CP");
        const coi = assignments.filter((entry) => (entry.scheduled!.roleLabel ?? "").toUpperCase() === "COI");
        return {
            cp: [cp[0] ?? null],
            coi: [coi[0] ?? null, coi[1] ?? null],
            extraCoi: coi.slice(2),
        };
    }, [regulationTargets, lens]);

    function armForRole(role: string) {
        setArmedRole(role);
        setFeedback({
            kind: "ok",
            text: armedDoctor
                ? `Função ${role} armada para ${armedDoctor.displayName ?? armedDoctor.fullName} — toque num ramal.`
                : `Função ${role} armada — selecione um médico na bancada e toque num ramal.`,
        });
    }

    async function assign(target: ScheduleTargetEntry) {
        if (!canEdit || busy) return;
        if (!armedDoctor) {
            setFeedback({ kind: "err", text: "Selecione um médico na bancada para armar a escalação." });
            return;
        }
        if (target.domain === "regulation" && !armedDoctor.eligibleRegulation) {
            setFeedback({ kind: "err", text: `${armedDoctor.displayName ?? armedDoctor.fullName} não está apto(a) a REGULAÇÃO.` });
            return;
        }
        if (target.domain === "intervention" && !armedDoctor.eligibleIntervention) {
            setFeedback({ kind: "err", text: `${armedDoctor.displayName ?? armedDoctor.fullName} não está apto(a) a INTERVENÇÃO.` });
            return;
        }

        setBusy(true);
        setFeedback(null);
        try {
            const response = await fetch("/api/schedule", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    domain: target.domain,
                    targetId: target.targetId,
                    doctorId: armedDoctor.id,
                    operationalDate: date,
                    shiftLabel: lens,
                    roleLabel: target.domain === "regulation" ? armedRole : null,
                }),
            });
            const payload = await response.json();
            if (!response.ok) {
                setFeedback({ kind: "err", text: payload.error ?? "Não foi possível escalar." });
                return;
            }
            await refresh(date);
        } finally {
            setBusy(false);
        }
    }

    async function unassign(shiftId: string) {
        if (!canEdit || busy) return;
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

    return (
        <main className={`et-shell${lens === "SN" ? " night" : ""}`}>
            <header className="et-hero">
                <div>
                    <h1>{canEdit ? "Mesa de escala" : "Escala do dia"}</h1>
                    <p>
                        {canEdit
                            ? `Componha o turno ${lens === "SD" ? "diurno" : "noturno"} de ${WEEKDAYS[board.weekday]}: arme um médico na bancada, escolha a função e toque no slot. Fixos de ${lens} aparecem primeiro.`
                            : `Escala prevista de ${WEEKDAYS[board.weekday]}, ${formatDateBr(date)}. Trocas aprovadas aparecem no relatório de cobertura.`}
                    </p>
                </div>
                <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                    <div className="et-lens" role="tablist" aria-label="Turno">
                        <button
                            type="button" role="tab" aria-selected={lens === "SD"}
                            className={`sd${lens === "SD" ? " on" : ""}`}
                            onClick={() => setLens("SD")}
                        >
                            <span className="glyph">☀</span> SD 07–19
                        </button>
                        <button
                            type="button" role="tab" aria-selected={lens === "SN"}
                            className={`sn${lens === "SN" ? " on" : ""}`}
                            onClick={() => setLens("SN")}
                        >
                            <span className="glyph">☾</span> SN 19–07
                        </button>
                    </div>
                    <div className="et-datenav">
                        <button type="button" onClick={() => setDate(shiftDate(date, -1))} aria-label="Dia anterior">‹</button>
                        <div>
                            <strong>{formatDateBr(date)}</strong>{" "}
                            <span className="et-weekday">{WEEKDAYS[board.weekday]}</span>
                        </div>
                        <button type="button" onClick={() => setDate(shiftDate(date, 1))} aria-label="Próximo dia">›</button>
                    </div>
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

            <div className={`et-layout${canEdit ? "" : " solo"}`}>
                <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                    <section className="et-panel">
                        <div className="et-panel-head">
                            <h2>Comando do plantão</h2>
                            <SectionMeter
                                filled={(commandSeats.cp[0] ? 1 : 0) + commandSeats.coi.filter(Boolean).length}
                                total={3}
                            />
                        </div>
                        <div className="et-cmdgrid">
                            <CommandSeat
                                role="CP"
                                seatLabel="chefe de plantão"
                                entry={commandSeats.cp[0]}
                                canEdit={canEdit}
                                onArm={() => armForRole("CP")}
                                onUnassign={unassign}
                            />
                            {commandSeats.coi.map((entry, index) => (
                                <CommandSeat
                                    key={`coi-${index}`}
                                    role="COI"
                                    seatLabel={`assento ${index + 1} de 2`}
                                    entry={entry}
                                    canEdit={canEdit}
                                    onArm={() => armForRole("COI")}
                                    onUnassign={unassign}
                                />
                            ))}
                            {commandSeats.extraCoi.map((entry) => (
                                <CommandSeat
                                    key={entry!.scheduled!.shiftId}
                                    role="COI"
                                    seatLabel="excedente"
                                    entry={entry}
                                    canEdit={canEdit}
                                    onArm={() => armForRole("COI")}
                                    onUnassign={unassign}
                                />
                            ))}
                        </div>
                    </section>

                    <section className="et-panel">
                        <div className="et-panel-head">
                            <h2>Regulação <span className="et-badge reg">ramais</span></h2>
                            <SectionMeter filled={filledCount(regulationTargets)} total={regulationTargets.length} />
                        </div>
                        <div className="et-tilegrid">
                            <AnimatePresence initial={false} mode="popLayout">
                                {regulationTargets.map((target) => (
                                    <SlotTile
                                        key={`${target.domain}-${target.targetId}-${lens}`}
                                        target={target}
                                        lens={lens}
                                        canEdit={canEdit}
                                        armed={Boolean(armedDoctor)}
                                        onAssign={() => assign(target)}
                                        onUnassign={unassign}
                                    />
                                ))}
                            </AnimatePresence>
                        </div>
                    </section>

                    <section className="et-panel">
                        <div className="et-panel-head">
                            <h2>Frota USA <span className="et-badge int">{usaTargets.length} bases</span></h2>
                            <SectionMeter filled={filledCount(usaTargets)} total={usaTargets.length} />
                        </div>
                        <div className="et-tilegrid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(148px, 1fr))" }}>
                            <AnimatePresence initial={false} mode="popLayout">
                                {usaTargets.map((target) => (
                                    <SlotTile
                                        key={`${target.domain}-${target.targetId}-${lens}`}
                                        target={target}
                                        lens={lens}
                                        canEdit={canEdit}
                                        armed={Boolean(armedDoctor)}
                                        bay
                                        onAssign={() => assign(target)}
                                        onUnassign={unassign}
                                    />
                                ))}
                            </AnimatePresence>
                        </div>
                    </section>

                    <AnimatePresence>
                        {canEdit && armedDoctor ? (
                            <motion.div
                                className="et-armed"
                                initial={{ opacity: 0, y: 24 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: 24 }}
                            >
                                <Monogram name={armedDoctor.displayName ?? armedDoctor.fullName} size={32} />
                                <strong>{armedDoctor.displayName ?? armedDoctor.fullName}</strong>
                                <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--muted-strong)" }}>
                                    função
                                    <select value={armedRole} onChange={(event) => setArmedRole(event.target.value)}>
                                        {ROLE_OPTIONS.map((role) => <option key={role} value={role}>{role}</option>)}
                                    </select>
                                </label>
                                <span className="hint">toque num slot para escalar no {lens}</span>
                                <button type="button" className="et-btn" style={{ marginLeft: "auto" }} onClick={() => setArmedDoctor(null)}>
                                    Desarmar
                                </button>
                            </motion.div>
                        ) : null}
                    </AnimatePresence>
                </div>

                {canEdit ? (
                    <aside className="et-panel et-doctors">
                        <div className="et-panel-head">
                            <h2>Bancada</h2>
                            <span className="et-badge fixed">{fixedDoctors.length} fixos de {WEEKDAYS[board.weekday]}</span>
                        </div>
                        <div className="et-doctors-list">
                            <AnimatePresence initial={false}>
                                {visibleDoctors.map((doctor) => {
                                    const name = doctor.displayName ?? doctor.fullName;
                                    return (
                                        <motion.button
                                            key={doctor.id}
                                            layout
                                            type="button"
                                            initial={{ opacity: 0, y: 6 }}
                                            animate={{ opacity: 1, y: 0 }}
                                            exit={{ opacity: 0 }}
                                            className={`et-doctor-card${armedDoctor?.id === doctor.id ? " selected" : ""}`}
                                            style={{ textAlign: "left", font: "inherit", color: "inherit" }}
                                            onClick={() => setArmedDoctor(armedDoctor?.id === doctor.id ? null : doctor)}
                                        >
                                            <Monogram name={name} size={30} ringed={doctor.fixedForWeekday} />
                                            <div style={{ minWidth: 0, flex: 1 }}>
                                                <div className="et-doc-name">{name}</div>
                                                <div className="et-doc-meta">
                                                    {doctor.fixedForWeekday ? <span className="et-badge fixed">fixo {doctor.fixedShiftLabels.join("·") || "dia"}</span> : null}
                                                    {doctor.admittedAt ? <span>desde {formatDateBr(doctor.admittedAt)}</span> : null}
                                                </div>
                                            </div>
                                            <div className="et-doc-meta">
                                                {doctor.eligibleRegulation ? <span className="et-badge reg">R</span> : null}
                                                {doctor.eligibleIntervention ? <span className="et-badge int">I</span> : null}
                                            </div>
                                        </motion.button>
                                    );
                                })}
                            </AnimatePresence>
                            {visibleDoctors.length === 0 ? (
                                <div className="et-empty-state">Nenhum fixo de {WEEKDAYS[board.weekday]} no {lens}. Expanda a bancada.</div>
                            ) : null}
                        </div>
                        <button type="button" className="et-expander" onClick={() => setShowAllDoctors(!showAllDoctors)}>
                            {showAllDoctors ? "▲ Só os fixos do dia" : `▼ Corpo clínico completo (${otherDoctors.length})`}
                        </button>
                    </aside>
                ) : null}
            </div>
        </main>
    );
}

function CommandSeat({ role, seatLabel, entry, canEdit, onArm, onUnassign }: {
    role: "CP" | "COI";
    seatLabel: string;
    entry: { target: ScheduleTargetEntry; scheduled: ScheduleTargetEntry["scheduled"][ScheduleShiftLabel] } | null;
    canEdit: boolean;
    onArm: () => void;
    onUnassign: (shiftId: string) => void;
}) {
    const scheduled = entry?.scheduled ?? null;
    const open = !scheduled;
    const armable = canEdit && open;

    return (
        <motion.div
            layout
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            className={`et-cmd ${role.toLowerCase()}${open ? " open" : ""}${armable ? " armable" : ""}`}
            onClick={armable ? onArm : undefined}
            role={armable ? "button" : undefined}
            tabIndex={armable ? 0 : undefined}
            onKeyDown={armable ? (event) => { if (event.key === "Enter" || event.key === " ") onArm(); } : undefined}
        >
            <span className="slot-title">
                {role}
                <span className="seat">{seatLabel}</span>
            </span>
            {scheduled ? (
                <span className="et-occupant">
                    <Monogram name={scheduled.doctorName} size={30} />
                    <span style={{ minWidth: 0 }}>
                        <span className="name" style={{ display: "block" }}>{scheduled.doctorName}</span>
                        <span style={{ fontSize: 11, color: "var(--muted)" }}>{entry!.target.label}</span>
                    </span>
                    {canEdit ? (
                        <button
                            type="button"
                            className="unassign"
                            aria-label={`Retirar ${scheduled.doctorName} do ${role}`}
                            onClick={(event) => {
                                event.stopPropagation();
                                onUnassign(scheduled.shiftId);
                            }}
                        >
                            ×
                        </button>
                    ) : null}
                </span>
            ) : (
                <span className="vacant-hint">
                    {canEdit ? `sem ${role} no turno — toque para armar a função` : `sem ${role} escalado`}
                </span>
            )}
        </motion.div>
    );
}

function SlotTile({ target, lens, canEdit, armed, bay = false, onAssign, onUnassign }: {
    target: ScheduleTargetEntry;
    lens: ScheduleShiftLabel;
    canEdit: boolean;
    armed: boolean;
    bay?: boolean;
    onAssign: () => void;
    onUnassign: (shiftId: string) => void;
}) {
    const scheduled = target.scheduled[lens];
    const armable = canEdit && !scheduled;

    return (
        <motion.div
            layout
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            className={`et-tile${bay ? " et-bay" : ""}${scheduled ? "" : " vacant"}${armable ? " armable" : ""}`}
            onClick={armable ? onAssign : undefined}
            role={armable ? "button" : undefined}
            tabIndex={armable ? 0 : undefined}
            onKeyDown={armable ? (event) => { if (event.key === "Enter" || event.key === " ") onAssign(); } : undefined}
        >
            <span className="code">
                {bay ? target.code : target.label}
                {scheduled?.roleLabel ? <span className={`et-role ${roleClass(scheduled.roleLabel)}`}>{scheduled.roleLabel}</span> : null}
            </span>
            {scheduled ? (
                <span className="et-occupant">
                    <Monogram name={scheduled.doctorName} size={26} />
                    <span className="name">{scheduled.doctorName}</span>
                    {canEdit ? (
                        <button
                            type="button"
                            className="unassign"
                            aria-label={`Retirar ${scheduled.doctorName}`}
                            onClick={(event) => {
                                event.stopPropagation();
                                onUnassign(scheduled.shiftId);
                            }}
                        >
                            ×
                        </button>
                    ) : null}
                </span>
            ) : (
                <span className="vacant-hint">{canEdit ? (armed ? "toque para escalar" : "vago") : "vago"}</span>
            )}
        </motion.div>
    );
}
