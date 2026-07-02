"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Monogram } from "@/components/ui/Monogram";
import type { ScheduleBoard, ScheduleDoctorEntry, ScheduleShiftLabel, ScheduleTargetEntry } from "@/services/schedule.service";

const WEEKDAYS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

/** Funções da regulação. COI fica DENTRO da regulação, só muda a cor; CP tem destaque próprio. */
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
    const [picker, setPicker] = useState<ScheduleTargetEntry | null>(null);
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
            setPicker(null);
            void refresh(date);
        }
    }, [date, board.operationalDate, refresh]);

    const regulationTargets = board.targets.filter((target) => target.domain === "regulation");
    const usaTargets = board.targets.filter((target) => target.domain === "intervention");

    const filledCount = (targets: ScheduleTargetEntry[]) => targets.filter((target) => target.scheduled[lens]).length;

    // CP é destaque separado; deriva da escalação da regulação com função CP.
    const cpAssignment = useMemo(() => {
        for (const target of regulationTargets) {
            const scheduled = target.scheduled[lens];
            if (scheduled && (scheduled.roleLabel ?? "").toUpperCase() === "CP") {
                return { target, scheduled };
            }
        }
        return null;
    }, [regulationTargets, lens]);

    const coiCount = useMemo(
        () => regulationTargets.filter((target) => (target.scheduled[lens]?.roleLabel ?? "").toUpperCase() === "COI").length,
        [regulationTargets, lens],
    );

    async function assign(target: ScheduleTargetEntry, doctor: ScheduleDoctorEntry, roleLabel: string | null) {
        if (!canEdit || busy) return;
        setBusy(true);
        setFeedback(null);
        try {
            const response = await fetch("/api/schedule", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    domain: target.domain,
                    targetId: target.targetId,
                    doctorId: doctor.id,
                    operationalDate: date,
                    shiftLabel: lens,
                    roleLabel: target.domain === "regulation" ? roleLabel : null,
                }),
            });
            const payload = await response.json();
            if (!response.ok) {
                setFeedback({ kind: "err", text: payload.error ?? "Não foi possível escalar." });
                return;
            }
            setPicker(null);
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
                            ? `Turno ${lens === "SD" ? "diurno" : "noturno"} de ${WEEKDAYS[board.weekday]}: toque num slot vago e escolha o médico — fixos do dia aparecem primeiro. COI fica na regulação, com cor própria.`
                            : `Escala prevista de ${WEEKDAYS[board.weekday]}, ${formatDateBr(date)}.`}
                    </p>
                </div>
                <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                    <div className="et-lens" role="tablist" aria-label="Turno">
                        <button
                            type="button" role="tab" aria-selected={lens === "SD"}
                            className={`sd${lens === "SD" ? " on" : ""}`}
                            onClick={() => { setLens("SD"); setPicker(null); }}
                        >
                            <span className="glyph">☀</span> SD 07–19
                        </button>
                        <button
                            type="button" role="tab" aria-selected={lens === "SN"}
                            className={`sn${lens === "SN" ? " on" : ""}`}
                            onClick={() => { setLens("SN"); setPicker(null); }}
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

            {/* CP: destaque separado do restante da regulação */}
            <section className={`et-cpbar${cpAssignment ? "" : " open"}`}>
                <span className="et-role cp">CP</span>
                {cpAssignment ? (
                    <>
                        <Monogram name={cpAssignment.scheduled!.doctorName} size={30} />
                        <strong>{cpAssignment.scheduled!.doctorName}</strong>
                        <span className="sub">{cpAssignment.target.label} · chefe do plantão {lens}</span>
                        {canEdit ? (
                            <button
                                type="button" className="unassign" aria-label="Retirar CP"
                                onClick={() => unassign(cpAssignment.scheduled!.shiftId)}
                            >
                                ×
                            </button>
                        ) : null}
                    </>
                ) : (
                    <span className="sub warn">sem chefe de plantão no {lens} — escale alguém com função CP num ramal</span>
                )}
                <span className="et-badge fixed" style={{ marginLeft: "auto" }}>COI no turno: {coiCount}/2</span>
            </section>

            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                <section className="et-panel">
                    <div className="et-panel-head">
                        <h2>Regulação <span className="et-badge reg">ramais</span> <span className="et-badge" style={{ background: "var(--ice-soft)", color: "var(--ice)" }}>COI em azul-gelo</span></h2>
                        <SectionMeter filled={filledCount(regulationTargets)} total={regulationTargets.length} />
                    </div>
                    <div className="et-tilegrid">
                        {regulationTargets.map((target) => (
                            <SlotTile
                                key={`${target.domain}-${target.targetId}-${lens}`}
                                target={target}
                                lens={lens}
                                canEdit={canEdit}
                                onOpen={() => setPicker(target)}
                                onUnassign={unassign}
                            />
                        ))}
                    </div>
                </section>

                <section className="et-panel">
                    <div className="et-panel-head">
                        <h2>Frota USA <span className="et-badge int">{usaTargets.length} bases</span></h2>
                        <SectionMeter filled={filledCount(usaTargets)} total={usaTargets.length} />
                    </div>
                    <div className="et-tilegrid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(148px, 1fr))" }}>
                        {usaTargets.map((target) => (
                            <SlotTile
                                key={`${target.domain}-${target.targetId}-${lens}`}
                                target={target}
                                lens={lens}
                                canEdit={canEdit}
                                bay
                                onOpen={() => setPicker(target)}
                                onUnassign={unassign}
                            />
                        ))}
                    </div>
                </section>
            </div>

            <AnimatePresence>
                {canEdit && picker ? (
                    <PickerDialog
                        key={`${picker.domain}-${picker.targetId}`}
                        target={picker}
                        lens={lens}
                        weekday={board.weekday}
                        doctors={board.doctors}
                        busy={busy}
                        onPick={(doctor, role) => assign(picker, doctor, role)}
                        onClose={() => setPicker(null)}
                    />
                ) : null}
            </AnimatePresence>
        </main>
    );
}

function SlotTile({ target, lens, canEdit, bay = false, onOpen, onUnassign }: {
    target: ScheduleTargetEntry;
    lens: ScheduleShiftLabel;
    canEdit: boolean;
    bay?: boolean;
    onOpen: () => void;
    onUnassign: (shiftId: string) => void;
}) {
    const scheduled = target.scheduled[lens];
    const openable = canEdit && !scheduled;
    const tileRole = roleClass(scheduled?.roleLabel);

    return (
        <div
            className={`et-tile${bay ? " et-bay" : ""}${scheduled ? ` filled role-${tileRole}` : " vacant"}${openable ? " armable" : ""}`}
            onClick={openable ? onOpen : undefined}
            role={openable ? "button" : undefined}
            tabIndex={openable ? 0 : undefined}
            onKeyDown={openable ? (event) => { if (event.key === "Enter" || event.key === " ") onOpen(); } : undefined}
        >
            <span className="code">
                {bay ? target.code : target.label}
                {scheduled?.roleLabel ? <span className={`et-role ${tileRole}`}>{scheduled.roleLabel}</span> : null}
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
                <span className="vacant-hint">{canEdit ? "+ escalar" : "vago"}</span>
            )}
        </div>
    );
}

function PickerDialog({ target, lens, weekday, doctors, busy, onPick, onClose }: {
    target: ScheduleTargetEntry;
    lens: ScheduleShiftLabel;
    weekday: number;
    doctors: ScheduleDoctorEntry[];
    busy: boolean;
    onPick: (doctor: ScheduleDoctorEntry, role: string | null) => void;
    onClose: () => void;
}) {
    const [search, setSearch] = useState("");
    const [role, setRole] = useState<string>("RMT");

    const eligible = useMemo(() => doctors.filter((doctor) =>
        target.domain === "regulation" ? doctor.eligibleRegulation : doctor.eligibleIntervention), [doctors, target.domain]);

    const filtered = useMemo(() => {
        const query = search.trim().toLowerCase();
        if (!query) return eligible;
        return eligible.filter((doctor) =>
            doctor.fullName.toLowerCase().includes(query)
            || (doctor.displayName ?? "").toLowerCase().includes(query));
    }, [eligible, search]);

    return (
        <motion.div
            className="et-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
        >
            <motion.div
                className="et-dialog"
                initial={{ opacity: 0, y: 20, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 20 }}
                onClick={(event) => event.stopPropagation()}
                role="dialog"
                aria-label={`Escalar ${target.label} no ${lens}`}
            >
                <div className="et-panel-head">
                    <h2>Escalar · {target.label} · {lens}</h2>
                    <button type="button" className="et-btn" onClick={onClose}>Fechar</button>
                </div>
                <div style={{ display: "flex", gap: 10, padding: "12px 16px 0", alignItems: "center" }}>
                    <input
                        className="et-search"
                        placeholder="Buscar médico…"
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        autoFocus
                    />
                    {target.domain === "regulation" ? (
                        <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--muted-strong)" }}>
                            função
                            <select value={role} onChange={(event) => setRole(event.target.value)}>
                                {ROLE_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
                            </select>
                        </label>
                    ) : null}
                </div>
                <div className="et-doctors-list" style={{ maxHeight: "48vh" }}>
                    {filtered.map((doctor) => {
                        const name = doctor.displayName ?? doctor.fullName;
                        return (
                            <button
                                key={doctor.id}
                                type="button"
                                className="et-doctor-card"
                                style={{ textAlign: "left", font: "inherit", color: "inherit", width: "100%" }}
                                disabled={busy}
                                onClick={() => onPick(doctor, target.domain === "regulation" ? role : null)}
                            >
                                <Monogram name={name} size={30} ringed={doctor.fixedForWeekday} />
                                <div style={{ minWidth: 0, flex: 1 }}>
                                    <div className="et-doc-name">{name}</div>
                                    <div className="et-doc-meta">
                                        {doctor.fixedForWeekday ? <span className="et-badge fixed">fixo de {WEEKDAYS[weekday]} {doctor.fixedShiftLabels.join("·")}</span> : null}
                                        {doctor.admittedAt ? <span>desde {formatDateBr(doctor.admittedAt)}</span> : null}
                                    </div>
                                </div>
                            </button>
                        );
                    })}
                    {filtered.length === 0 ? <div className="et-empty-state">Nenhum médico apto encontrado.</div> : null}
                </div>
            </motion.div>
        </motion.div>
    );
}
