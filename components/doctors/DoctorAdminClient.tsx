"use client";

import { useCallback, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { DoctorAdminEntry } from "@/services/doctor-admin.service";

const WEEKDAYS_SHORT = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

interface BaseOption {
    id: number;
    code: string;
    label: string;
}

function formatDateBr(date: string) {
    const [y, m, d] = date.split("-");
    return `${d}/${m}/${y}`;
}

export function DoctorAdminClient({ initialDoctors, bases }: { initialDoctors: DoctorAdminEntry[]; bases: BaseOption[] }) {
    const [doctors, setDoctors] = useState(initialDoctors);
    const [search, setSearch] = useState("");
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
    const [busy, setBusy] = useState(false);

    const selected = doctors.find((doctor) => doctor.id === selectedId) ?? null;
    const baseLabels = useMemo(() => new Map(bases.map((base) => [base.id, base.label])), [bases]);

    const filtered = useMemo(() => {
        const query = search.trim().toLowerCase();
        if (!query) return doctors;
        return doctors.filter((doctor) =>
            doctor.fullName.toLowerCase().includes(query)
            || (doctor.displayName ?? "").toLowerCase().includes(query));
    }, [doctors, search]);

    const refresh = useCallback(async () => {
        const response = await fetch("/api/admin/doctors");
        if (response.ok) {
            const payload = await response.json();
            setDoctors(payload.doctors ?? []);
        }
    }, []);

    async function call(url: string, method: string, body?: unknown) {
        setBusy(true);
        setFeedback(null);
        try {
            const response = await fetch(url, {
                method,
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

    return (
        <main className="et-shell et-gestao">
            <header className="et-hero">
                <div>
                    <h1>Gestão de médicos</h1>
                    <p>
                        Cadastre o corpo clínico e ajuste os parâmetros que norteiam a escala: dias preferidos
                        (ranqueados), bases preferidas em ordem e os turnos fixos de cada médico — pode haver
                        mais de um turno fixo por pessoa.
                    </p>
                </div>
                <button type="button" className="et-btn primary" onClick={() => { setCreating(true); setSelectedId(null); }}>
                    + Novo médico
                </button>
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

            <div className="et-layout" style={{ gridTemplateColumns: "360px minmax(0, 1fr)" }}>
                <section className="et-panel et-doctors">
                    <div className="et-panel-head">
                        <h2>{doctors.length} médicos</h2>
                    </div>
                    <div style={{ padding: "10px 10px 0" }}>
                        <input
                            className="et-search"
                            placeholder="Buscar médico…"
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                        />
                    </div>
                    <div className="et-doctors-list">
                        {filtered.map((doctor) => (
                            <div
                                key={doctor.id}
                                className={`et-doctor-card${selectedId === doctor.id ? " selected" : ""}`}
                                onClick={() => { setSelectedId(doctor.id); setCreating(false); }}
                            >
                                <div>
                                    <div className="et-doc-name" style={{ opacity: doctor.isActive ? 1 : 0.45 }}>
                                        {doctor.displayName ?? doctor.fullName}
                                    </div>
                                    <div className="et-doc-meta">
                                        {doctor.admittedAt ? <span>desde {formatDateBr(doctor.admittedAt)}</span> : <span>sem admissão</span>}
                                        {doctor.fixedShifts.length > 0 ? <span>· {doctor.fixedShifts.length} turno(s) fixo(s)</span> : null}
                                    </div>
                                </div>
                                <div className="et-doc-meta">
                                    {!doctor.isActive ? <span className="et-badge" style={{ background: "var(--red-soft)", color: "var(--red)" }}>inativo</span> : null}
                                    {doctor.account && !doctor.account.isActive ? <span className="et-badge fixed">conta pendente</span> : null}
                                </div>
                            </div>
                        ))}
                        {filtered.length === 0 ? <div className="et-empty-state">Nenhum médico encontrado.</div> : null}
                    </div>
                </section>

                {creating ? (
                    <CreateDoctorPanel
                        busy={busy}
                        onCreate={async (payload) => {
                            const ok = await call("/api/admin/doctors", "POST", payload);
                            if (ok) {
                                setCreating(false);
                                setFeedback({ kind: "ok", text: `${payload.fullName} cadastrado(a).` });
                            }
                        }}
                    />
                ) : selected ? (
                    <DoctorEditorPanel
                        key={selected.id}
                        doctor={selected}
                        bases={bases}
                        baseLabels={baseLabels}
                        busy={busy}
                        onPatch={(payload) => call(`/api/admin/doctors/${selected.id}`, "PATCH", payload)}
                        onSavePreferences={async (payload) => {
                            const ok = await call(`/api/admin/doctors/${selected.id}`, "PUT", payload);
                            if (ok) setFeedback({ kind: "ok", text: "Preferências salvas." });
                        }}
                        onActivateAccount={async () => {
                            if (!selected.account) return;
                            const ok = await call(`/api/admin/doctors/accounts/${selected.account.userId}/activate`, "POST");
                            if (ok) setFeedback({ kind: "ok", text: `Conta de ${selected.fullName} ativada.` });
                        }}
                    />
                ) : (
                    <section className="et-panel">
                        <div className="et-empty-state">Selecione um médico à esquerda ou cadastre um novo.</div>
                    </section>
                )}
            </div>
        </main>
    );
}

function CreateDoctorPanel({ busy, onCreate }: {
    busy: boolean;
    onCreate: (payload: { fullName: string; displayName: string | null; admittedAt: string | null; eligibleRegulation: boolean; eligibleIntervention: boolean }) => void;
}) {
    const [form, setForm] = useState({ fullName: "", displayName: "", admittedAt: "", eligibleRegulation: true, eligibleIntervention: true });

    return (
        <section className="et-panel">
            <div className="et-panel-head"><h2>Novo médico</h2></div>
            <div className="et-form" style={{ padding: 20 }}>
                <label>
                    Nome completo
                    <input value={form.fullName} onChange={(event) => setForm({ ...form, fullName: event.target.value })} />
                </label>
                <label>
                    Nome de exibição (opcional)
                    <input value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} />
                </label>
                <label>
                    Data de admissão (antiguidade)
                    <input type="date" value={form.admittedAt} onChange={(event) => setForm({ ...form, admittedAt: event.target.value })} />
                </label>
                <div className="et-actions">
                    <button
                        type="button"
                        className={`et-btn${form.eligibleRegulation ? " primary" : ""}`}
                        onClick={() => setForm({ ...form, eligibleRegulation: !form.eligibleRegulation })}
                    >
                        {form.eligibleRegulation ? "✓" : "✗"} Regulação
                    </button>
                    <button
                        type="button"
                        className={`et-btn${form.eligibleIntervention ? " confirm" : ""}`}
                        onClick={() => setForm({ ...form, eligibleIntervention: !form.eligibleIntervention })}
                    >
                        {form.eligibleIntervention ? "✓" : "✗"} Intervenção
                    </button>
                </div>
                <button
                    type="button"
                    className="et-btn primary"
                    disabled={busy || form.fullName.trim().length < 5}
                    onClick={() => onCreate({
                        fullName: form.fullName.trim(),
                        displayName: form.displayName.trim() || null,
                        admittedAt: form.admittedAt || null,
                        eligibleRegulation: form.eligibleRegulation,
                        eligibleIntervention: form.eligibleIntervention,
                    })}
                >
                    Cadastrar
                </button>
            </div>
        </section>
    );
}

function DoctorEditorPanel({ doctor, bases, baseLabels, busy, onPatch, onSavePreferences, onActivateAccount }: {
    doctor: DoctorAdminEntry;
    bases: BaseOption[];
    baseLabels: Map<number, string>;
    busy: boolean;
    onPatch: (payload: Record<string, unknown>) => Promise<boolean>;
    onSavePreferences: (payload: { preferredWeekdays: number[]; basePreferences: number[]; fixedShifts: { weekday: number; shiftLabel: "SD" | "SN" }[] }) => void;
    onActivateAccount: () => void;
}) {
    const [profile, setProfile] = useState({
        displayName: doctor.displayName ?? "",
        admittedAt: doctor.admittedAt ?? "",
        eligibleRegulation: doctor.eligibleRegulation,
        eligibleIntervention: doctor.eligibleIntervention,
        isActive: doctor.isActive,
    });
    const [preferredWeekdays, setPreferredWeekdays] = useState<number[]>(doctor.preferredWeekdays);
    const [basePreferences, setBasePreferences] = useState<number[]>(doctor.basePreferences);
    const [fixedShifts, setFixedShifts] = useState(doctor.fixedShifts.map((entry) => ({ ...entry, shiftLabel: entry.shiftLabel as "SD" | "SN" })));
    const [baseToAdd, setBaseToAdd] = useState("");

    function toggleWeekday(weekday: number) {
        setPreferredWeekdays((current) => current.includes(weekday)
            ? current.filter((entry) => entry !== weekday)
            : [...current, weekday]);
    }

    function toggleFixedShift(weekday: number, shiftLabel: "SD" | "SN") {
        setFixedShifts((current) => {
            const exists = current.some((entry) => entry.weekday === weekday && entry.shiftLabel === shiftLabel);
            return exists
                ? current.filter((entry) => !(entry.weekday === weekday && entry.shiftLabel === shiftLabel))
                : [...current, { weekday, shiftLabel }];
        });
    }

    function moveBase(index: number, delta: number) {
        setBasePreferences((current) => {
            const next = [...current];
            const target = index + delta;
            if (target < 0 || target >= next.length) return current;
            [next[index], next[target]] = [next[target], next[index]];
            return next;
        });
    }

    return (
        <section className="et-panel">
            <div className="et-panel-head">
                <h2>{doctor.fullName}</h2>
                {doctor.account ? (
                    doctor.account.isActive
                        ? <span className="et-badge int">conta ativa · {doctor.account.email}</span>
                        : (
                            <button type="button" className="et-btn confirm" disabled={busy} onClick={onActivateAccount}>
                                Ativar conta ({doctor.account.email})
                            </button>
                        )
                ) : <span className="et-badge" style={{ background: "var(--ice-soft)", color: "var(--muted-strong)" }}>sem conta web</span>}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 20, padding: 20 }}>
                <div className="et-form">
                    <h3 className="et-section-title">Perfil</h3>
                    <label>
                        Nome de exibição
                        <input value={profile.displayName} onChange={(event) => setProfile({ ...profile, displayName: event.target.value })} />
                    </label>
                    <label>
                        Data de admissão (antiguidade)
                        <input type="date" value={profile.admittedAt} onChange={(event) => setProfile({ ...profile, admittedAt: event.target.value })} />
                    </label>
                    <div className="et-actions">
                        <button type="button" className={`et-btn${profile.eligibleRegulation ? " primary" : ""}`} onClick={() => setProfile({ ...profile, eligibleRegulation: !profile.eligibleRegulation })}>
                            {profile.eligibleRegulation ? "✓" : "✗"} Regulação
                        </button>
                        <button type="button" className={`et-btn${profile.eligibleIntervention ? " confirm" : ""}`} onClick={() => setProfile({ ...profile, eligibleIntervention: !profile.eligibleIntervention })}>
                            {profile.eligibleIntervention ? "✓" : "✗"} Intervenção
                        </button>
                        <button type="button" className={`et-btn${profile.isActive ? "" : " danger"}`} onClick={() => setProfile({ ...profile, isActive: !profile.isActive })}>
                            {profile.isActive ? "Ativo" : "Inativo"}
                        </button>
                    </div>
                    <button
                        type="button"
                        className="et-btn primary"
                        disabled={busy}
                        onClick={() => onPatch({
                            displayName: profile.displayName.trim() || null,
                            admittedAt: profile.admittedAt || null,
                            eligibleRegulation: profile.eligibleRegulation,
                            eligibleIntervention: profile.eligibleIntervention,
                            isActive: profile.isActive,
                        })}
                    >
                        Salvar perfil
                    </button>
                </div>

                <div className="et-form">
                    <h3 className="et-section-title">Dias preferidos (clique na ordem de preferência)</h3>
                    <div className="et-weekday-row">
                        {WEEKDAYS_SHORT.map((label, weekday) => {
                            const rank = preferredWeekdays.indexOf(weekday);
                            return (
                                <button
                                    key={weekday}
                                    type="button"
                                    className={`et-weekday-chip${rank >= 0 ? " on" : ""}`}
                                    onClick={() => toggleWeekday(weekday)}
                                >
                                    {label}
                                    {rank >= 0 ? <span className="et-rank">{rank + 1}º</span> : null}
                                </button>
                            );
                        })}
                    </div>

                    <h3 className="et-section-title">Turnos fixos (pode marcar vários)</h3>
                    <div className="et-fixed-grid">
                        <span />
                        {WEEKDAYS_SHORT.map((label) => <span key={label} className="et-fixed-head">{label}</span>)}
                        {(["SD", "SN"] as const).map((shiftLabel) => (
                            <FixedShiftRow
                                key={shiftLabel}
                                shiftLabel={shiftLabel}
                                fixedShifts={fixedShifts}
                                onToggle={toggleFixedShift}
                            />
                        ))}
                    </div>

                    <h3 className="et-section-title">Bases preferidas (em ordem)</h3>
                    {basePreferences.map((baseId, index) => (
                        <div key={baseId} className="et-chip" style={{ justifyContent: "space-between" }}>
                            <span>{index + 1}º · {baseLabels.get(baseId) ?? baseId}</span>
                            <span className="et-actions">
                                <button type="button" className="et-chip-x" onClick={() => moveBase(index, -1)}>↑</button>
                                <button type="button" className="et-chip-x" onClick={() => moveBase(index, 1)}>↓</button>
                                <button type="button" className="et-chip-x" onClick={() => setBasePreferences(basePreferences.filter((entry) => entry !== baseId))}>×</button>
                            </span>
                        </div>
                    ))}
                    <div className="et-actions">
                        <select value={baseToAdd} onChange={(event) => setBaseToAdd(event.target.value)} style={{ flex: 1 }}>
                            <option value="">+ adicionar base…</option>
                            {bases.filter((base) => !basePreferences.includes(base.id)).map((base) => (
                                <option key={base.id} value={base.id}>{base.label}</option>
                            ))}
                        </select>
                        <button
                            type="button"
                            className="et-btn"
                            disabled={!baseToAdd}
                            onClick={() => {
                                setBasePreferences([...basePreferences, Number(baseToAdd)]);
                                setBaseToAdd("");
                            }}
                        >
                            Adicionar
                        </button>
                    </div>

                    <button
                        type="button"
                        className="et-btn confirm"
                        disabled={busy}
                        onClick={() => onSavePreferences({ preferredWeekdays, basePreferences, fixedShifts })}
                    >
                        Salvar preferências
                    </button>
                </div>
            </div>
        </section>
    );
}

function FixedShiftRow({ shiftLabel, fixedShifts, onToggle }: {
    shiftLabel: "SD" | "SN";
    fixedShifts: { weekday: number; shiftLabel: "SD" | "SN" }[];
    onToggle: (weekday: number, shiftLabel: "SD" | "SN") => void;
}) {
    return (
        <>
            <span className="et-fixed-head">{shiftLabel}</span>
            {WEEKDAYS_SHORT.map((_, weekday) => {
                const on = fixedShifts.some((entry) => entry.weekday === weekday && entry.shiftLabel === shiftLabel);
                return (
                    <button
                        key={weekday}
                        type="button"
                        className={`et-fixed-cell${on ? " on" : ""}`}
                        aria-label={`${shiftLabel} fixo ${WEEKDAYS_SHORT[weekday]}`}
                        onClick={() => onToggle(weekday, shiftLabel)}
                    >
                        {on ? "●" : ""}
                    </button>
                );
            })}
        </>
    );
}
