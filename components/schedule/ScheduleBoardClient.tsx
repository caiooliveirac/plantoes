"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Monogram } from "@/components/ui/Monogram";
import type { RegulationAssignment, ScheduleBoard, ScheduleDoctorEntry, ScheduleShiftLabel, ScheduleTargetEntry } from "@/services/schedule.service";

const WEEKDAYS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

/** Funções livres da regulação (CP e COI têm slots próprios, com limite). */
const OPEN_ROLE_OPTIONS = ["RMT", "MRV", "PIAM", "PSIQ"] as const;

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

type PickerRequest =
    | { kind: "regulation"; lockedRole: "CP" | "COI" | null }
    | { kind: "intervention"; target: ScheduleTargetEntry };

export function ScheduleBoardClient({ initialBoard, canEdit }: { initialBoard: ScheduleBoard; canEdit: boolean }) {
    const [board, setBoard] = useState<ScheduleBoard>(initialBoard);
    const [date, setDate] = useState(initialBoard.operationalDate);
    const [lens, setLens] = useState<ScheduleShiftLabel>("SD");
    const [picker, setPicker] = useState<PickerRequest | null>(null);
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

    const regulation = board.regulation[lens];
    const usaTargets = board.targets;

    const cp = useMemo(() => regulation.find((entry) => (entry.roleLabel ?? "").toUpperCase() === "CP") ?? null, [regulation]);
    const cois = useMemo(() => regulation.filter((entry) => (entry.roleLabel ?? "").toUpperCase() === "COI"), [regulation]);
    const openRegulation = useMemo(
        () => regulation.filter((entry) => !["CP", "COI"].includes((entry.roleLabel ?? "").toUpperCase())),
        [regulation],
    );
    const usaFilled = usaTargets.filter((target) => target.scheduled[lens]).length;
    const scheduledDoctorIds = useMemo(() => {
        const ids = new Set<string>(regulation.map((entry) => entry.doctorId));
        for (const target of usaTargets) {
            const scheduled = target.scheduled[lens];
            if (scheduled) ids.add(scheduled.doctorId);
        }
        return ids;
    }, [regulation, usaTargets, lens]);

    async function assign(request: PickerRequest, doctor: ScheduleDoctorEntry, role: string | null) {
        if (!canEdit || busy) return;
        setBusy(true);
        setFeedback(null);
        try {
            const response = await fetch("/api/schedule", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    domain: request.kind,
                    targetId: request.kind === "intervention" ? request.target.targetId : null,
                    doctorId: doctor.id,
                    operationalDate: date,
                    shiftLabel: lens,
                    roleLabel: request.kind === "regulation" ? role : null,
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
                            ? `Turno ${lens === "SD" ? "diurno" : "noturno"} de ${WEEKDAYS[board.weekday]}: regulação por função (1 CP, 2 COI, demais na regulação — sem ramal); intervenção por ambulância.`
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

            {/* CP: faixa própria, separada */}
            <section className={`et-cpbar${cp ? "" : " open"}`}>
                <span className="et-role cp">CP</span>
                {cp ? (
                    <>
                        <Monogram name={cp.doctorName} size={30} />
                        <strong>{cp.doctorName}</strong>
                        <span className="sub">chefe do plantão {lens}</span>
                        {canEdit ? (
                            <button type="button" className="unassign" aria-label="Retirar CP" onClick={() => unassign(cp.shiftId)}>×</button>
                        ) : null}
                    </>
                ) : canEdit ? (
                    <button type="button" className="et-btn" onClick={() => setPicker({ kind: "regulation", lockedRole: "CP" })}>
                        Escalar chefe de plantão
                    </button>
                ) : (
                    <span className="sub warn">sem chefe de plantão no {lens}</span>
                )}
            </section>

            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                <section className="et-panel">
                    <div className="et-panel-head">
                        <h2>Regulação <span className="et-badge ice">COI em azul-gelo</span></h2>
                        <SectionMeter filled={regulation.length} total={Math.max(regulation.length, 13)} />
                    </div>
                    <div className="et-tilegrid">
                        {/* 2 slots de COI, sempre visíveis */}
                        {[0, 1].map((seat) => {
                            const entry = cois[seat] ?? null;
                            return (
                                <RegulationTile
                                    key={`coi-${seat}`}
                                    entry={entry}
                                    fallbackRole="COI"
                                    seatLabel={`COI · assento ${seat + 1}`}
                                    canEdit={canEdit}
                                    onOpen={() => setPicker({ kind: "regulation", lockedRole: "COI" })}
                                    onUnassign={unassign}
                                />
                            );
                        })}
                        {/* demais médicos da regulação, sem ramal */}
                        {openRegulation.map((entry) => (
                            <RegulationTile
                                key={entry.shiftId}
                                entry={entry}
                                fallbackRole="RMT"
                                seatLabel="Regulação"
                                canEdit={canEdit}
                                onOpen={() => setPicker({ kind: "regulation", lockedRole: null })}
                                onUnassign={unassign}
                            />
                        ))}
                        {canEdit ? (
                            <button
                                type="button"
                                className="et-tile vacant armable"
                                style={{ font: "inherit", color: "inherit", alignItems: "center", justifyContent: "center" }}
                                onClick={() => setPicker({ kind: "regulation", lockedRole: null })}
                            >
                                <span className="vacant-hint">＋ escalar na regulação</span>
                            </button>
                        ) : null}
                    </div>
                </section>

                <section className="et-panel">
                    <div className="et-panel-head">
                        <h2>Frota USA <span className="et-badge int">{usaTargets.length} bases</span></h2>
                        <SectionMeter filled={usaFilled} total={usaTargets.length} />
                    </div>
                    <div className="et-tilegrid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(148px, 1fr))" }}>
                        {usaTargets.map((target) => {
                            const scheduled = target.scheduled[lens];
                            const openable = canEdit && !scheduled;
                            return (
                                <div
                                    key={`${target.targetId}-${lens}`}
                                    className={`et-tile et-bay${scheduled ? " filled" : " vacant"}${openable ? " armable" : ""}`}
                                    onClick={openable ? () => setPicker({ kind: "intervention", target }) : undefined}
                                    role={openable ? "button" : undefined}
                                    tabIndex={openable ? 0 : undefined}
                                    onKeyDown={openable ? (event) => { if (event.key === "Enter" || event.key === " ") setPicker({ kind: "intervention", target }); } : undefined}
                                >
                                    <span className="code">{target.code}</span>
                                    {scheduled ? (
                                        <span className="et-occupant">
                                            <Monogram name={scheduled.doctorName} size={26} />
                                            <span className="name">{scheduled.doctorName}</span>
                                            {canEdit ? (
                                                <button
                                                    type="button" className="unassign" aria-label={`Retirar ${scheduled.doctorName}`}
                                                    onClick={(event) => { event.stopPropagation(); unassign(scheduled.shiftId); }}
                                                >
                                                    ×
                                                </button>
                                            ) : null}
                                        </span>
                                    ) : (
                                        <span className="vacant-hint">{canEdit ? "+ escalar" : "baia vaga"}</span>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </section>
            </div>

            <AnimatePresence>
                {canEdit && picker ? (
                    <PickerDialog
                        key={picker.kind === "intervention" ? `int-${picker.target.targetId}` : `reg-${picker.lockedRole ?? "open"}`}
                        request={picker}
                        lens={lens}
                        weekday={board.weekday}
                        doctors={board.doctors}
                        scheduledDoctorIds={scheduledDoctorIds}
                        busy={busy}
                        onPick={(doctor, role) => assign(picker, doctor, role)}
                        onClose={() => setPicker(null)}
                    />
                ) : null}
            </AnimatePresence>
        </main>
    );
}

function RegulationTile({ entry, fallbackRole, seatLabel, canEdit, onOpen, onUnassign }: {
    entry: RegulationAssignment | null;
    fallbackRole: string;
    seatLabel: string;
    canEdit: boolean;
    onOpen: () => void;
    onUnassign: (shiftId: string) => void;
}) {
    const role = entry?.roleLabel ?? fallbackRole;
    const openable = canEdit && !entry;

    return (
        <div
            className={`et-tile${entry ? ` filled role-${roleClass(role)}` : " vacant"}${openable ? " armable" : ""}`}
            onClick={openable ? onOpen : undefined}
            role={openable ? "button" : undefined}
            tabIndex={openable ? 0 : undefined}
            onKeyDown={openable ? (event) => { if (event.key === "Enter" || event.key === " ") onOpen(); } : undefined}
        >
            <span className="code">
                {seatLabel}
                <span className={`et-role ${roleClass(role)}`}>{role}</span>
            </span>
            {entry ? (
                <span className="et-occupant">
                    <Monogram name={entry.doctorName} size={26} />
                    <span className="name">{entry.doctorName}</span>
                    {canEdit ? (
                        <button
                            type="button" className="unassign" aria-label={`Retirar ${entry.doctorName}`}
                            onClick={(event) => { event.stopPropagation(); onUnassign(entry.shiftId); }}
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

function PickerDialog({ request, lens, weekday, doctors, scheduledDoctorIds, busy, onPick, onClose }: {
    request: PickerRequest;
    lens: ScheduleShiftLabel;
    weekday: number;
    doctors: ScheduleDoctorEntry[];
    scheduledDoctorIds: Set<string>;
    busy: boolean;
    onPick: (doctor: ScheduleDoctorEntry, role: string | null) => void;
    onClose: () => void;
}) {
    const [search, setSearch] = useState("");
    const [role, setRole] = useState<string>(request.kind === "regulation" ? (request.lockedRole ?? "RMT") : "");

    const title = request.kind === "intervention"
        ? `${request.target.label} · ${lens}`
        : `${request.lockedRole ?? "Regulação"} · ${lens}`;

    const eligible = useMemo(() => doctors.filter((doctor) => {
        if (scheduledDoctorIds.has(doctor.id)) return false;
        return request.kind === "regulation" ? doctor.eligibleRegulation : doctor.eligibleIntervention;
    }), [doctors, request.kind, scheduledDoctorIds]);

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
                aria-label={`Escalar · ${title}`}
            >
                <div className="et-panel-head">
                    <h2>Escalar · {title}</h2>
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
                    {request.kind === "regulation" && !request.lockedRole ? (
                        <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--muted-strong)" }}>
                            função
                            <select value={role} onChange={(event) => setRole(event.target.value)}>
                                {OPEN_ROLE_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
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
                                onClick={() => onPick(doctor, request.kind === "regulation" ? (request.lockedRole ?? role) : null)}
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
                    {filtered.length === 0 ? <div className="et-empty-state">Nenhum médico apto disponível (já escalados neste turno não aparecem).</div> : null}
                </div>
            </motion.div>
        </motion.div>
    );
}
