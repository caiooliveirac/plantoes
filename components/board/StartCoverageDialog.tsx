"use client";

import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { Power, UserPlus } from "lucide-react";
import { modalBackdrop, modalPanel } from "@/lib/board/motion";

export interface StartCoverageDoctor {
    id: string;
    fullName: string;
    displayName: string | null;
}

interface StartCoverageDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    domain: "regulation" | "intervention";
    /** Post id (regulation) or base id (intervention). */
    targetId: number;
    targetCode: string;
    targetLabel: string;
    /** Current board shift (SD/SN). Applied automatically — no override here. */
    shiftLabel: string;
    doctors: StartCoverageDoctor[];
    onSaved?: () => void;
    /** Switch to the deactivate flow for this same target. */
    onDeactivate?: () => void;
}

function doctorOptionLabel(doctor: StartCoverageDoctor): string {
    return doctor.displayName ? `${doctor.displayName} - ${doctor.fullName}` : doctor.fullName;
}

function matchesDoctorQuery(doctor: StartCoverageDoctor, query: string): boolean {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
        return false;
    }
    const haystack = [doctor.fullName, doctor.displayName ?? ""].join(" ").toLowerCase();
    return normalizedQuery
        .split(/\s+/)
        .filter(Boolean)
        .every((token) => haystack.includes(token));
}

function isoNowLocal(): string {
    const date = new Date();
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
}

function localToIso(value: string): string {
    return new Date(value).toISOString();
}

export function StartCoverageDialog({
    open,
    onOpenChange,
    domain,
    targetId,
    targetCode,
    targetLabel,
    shiftLabel,
    doctors,
    onSaved,
    onDeactivate,
}: StartCoverageDialogProps) {
    const router = useRouter();
    const [query, setQuery] = useState("");
    const [doctorId, setDoctorId] = useState("");
    const [startedAt, setStartedAt] = useState(isoNowLocal());
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
        if (open) {
            setQuery("");
            setDoctorId("");
            setStartedAt(isoNowLocal());
        }
    }, [open]);

    const selectedDoctor = doctors.find((doctor) => doctor.id === doctorId) ?? null;
    const selectionLocked = Boolean(selectedDoctor && query.trim() === doctorOptionLabel(selectedDoctor));
    const filteredDoctors = useMemo(
        () => doctors.filter((doctor) => matchesDoctorQuery(doctor, query)).slice(0, 8),
        [doctors, query],
    );

    const subject = domain === "regulation" ? "ramal" : "USA";

    const submit = async () => {
        if (!doctorId) {
            toast.error("Selecione um médico para abrir a cobertura.");
            return;
        }
        if (!startedAt) {
            toast.error("Informe a hora de chegada.");
            return;
        }
        setSubmitting(true);
        try {
            const startedAtIso = localToIso(startedAt);
            const endpoint = domain === "regulation"
                ? "/api/regulation/occupancies"
                : "/api/intervention/occupancies";
            const payload = domain === "regulation"
                ? {
                    doctorId,
                    postId: targetId,
                    startedAt: startedAtIso,
                    boardStartedAt: startedAtIso,
                    scheduledStartAt: null,
                    scheduledEndAt: null,
                    shiftLabel,
                    roleLabel: null,
                    ramalLabel: targetCode,
                    source: "admin_correction" as const,
                    notes: null,
                }
                : {
                    doctorId,
                    baseId: targetId,
                    startedAt: startedAtIso,
                    boardStartedAt: startedAtIso,
                    scheduledStartAt: null,
                    scheduledEndAt: null,
                    shiftLabel,
                    roleLabel: null,
                    source: "admin_correction" as const,
                    notes: null,
                };
            const response = await fetch(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            const body = await response.json().catch(() => null) as { error?: string } | null;
            if (!response.ok) {
                throw new Error(body?.error || "Falha ao abrir a cobertura.");
            }
            const doctorName = selectedDoctor ? (selectedDoctor.displayName ?? selectedDoctor.fullName) : "Plantonista";
            toast.success(`Cobertura aberta: ${doctorName} em ${targetCode} às ${startedAt.slice(11, 16)}.`);
            onOpenChange(false);
            onSaved?.();
            router.refresh();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Falha ao abrir a cobertura.");
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Dialog.Root open={open} onOpenChange={onOpenChange}>
            <AnimatePresence>
                {open && (
                    <Dialog.Portal forceMount>
                        <Dialog.Overlay asChild>
                            <motion.div
                                className="board-modal-backdrop"
                                variants={modalBackdrop}
                                initial="initial"
                                animate="animate"
                                exit="exit"
                            />
                        </Dialog.Overlay>
                        <Dialog.Content asChild>
                            <motion.div
                                className="board-modal-panel"
                                variants={modalPanel}
                                initial="initial"
                                animate="animate"
                                exit="exit"
                            >
                                <header className="board-modal-header">
                                    <div className="board-modal-icon info">
                                        <UserPlus size={18} strokeWidth={2.2} />
                                    </div>
                                    <div>
                                        <Dialog.Title asChild>
                                            <h2>Lançar médico · {targetCode}</h2>
                                        </Dialog.Title>
                                        <Dialog.Description asChild>
                                            <p>{targetLabel} · turno {shiftLabel}</p>
                                        </Dialog.Description>
                                    </div>
                                </header>

                                <div className="board-modal-fields">
                                    <label className="board-modal-field chief-doctor-picker">
                                        <span>Médico</span>
                                        <input
                                            type="text"
                                            value={query}
                                            onChange={(event) => {
                                                setQuery(event.target.value);
                                                setDoctorId("");
                                            }}
                                            placeholder="Digite parte do nome e selecione o médico"
                                            autoComplete="off"
                                        />

                                        {selectedDoctor && selectionLocked && (
                                            <div className="chief-doctor-selection">
                                                <strong>{doctorOptionLabel(selectedDoctor)}</strong>
                                                <button
                                                    type="button"
                                                    className="chief-selection-clear"
                                                    onClick={() => { setQuery(""); setDoctorId(""); }}
                                                >
                                                    Trocar médico
                                                </button>
                                            </div>
                                        )}

                                        {!selectedDoctor && filteredDoctors.length > 0 && (
                                            <div className="chief-doctor-suggestions" role="listbox" aria-label="Sugestões de médicos">
                                                {filteredDoctors.map((doctor) => (
                                                    <button
                                                        key={doctor.id}
                                                        type="button"
                                                        className="chief-doctor-option"
                                                        onClick={() => {
                                                            setDoctorId(doctor.id);
                                                            setQuery(doctorOptionLabel(doctor));
                                                        }}
                                                    >
                                                        <strong>{doctor.displayName ?? doctor.fullName}</strong>
                                                        {doctor.displayName && <span>{doctor.fullName}</span>}
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </label>

                                    <label className="board-modal-field">
                                        <span>Hora de chegada</span>
                                        <input
                                            type="datetime-local"
                                            value={startedAt}
                                            onChange={(event) => setStartedAt(event.target.value)}
                                            step={60}
                                        />
                                    </label>
                                </div>

                                <footer className="board-modal-actions spread">
                                    {onDeactivate ? (
                                        <button
                                            type="button"
                                            className="board-modal-deactivate"
                                            onClick={onDeactivate}
                                            disabled={submitting}
                                            title={`Desativar ${subject} ${targetCode}`}
                                        >
                                            <Power size={13} strokeWidth={2.2} />
                                            <span>Desativar {subject}</span>
                                        </button>
                                    ) : <span />}
                                    <div className="board-modal-actions-group">
                                        <Dialog.Close asChild>
                                            <button type="button" className="board-modal-cancel" disabled={submitting}>
                                                Cancelar
                                            </button>
                                        </Dialog.Close>
                                        <button
                                            type="button"
                                            className="board-modal-confirm"
                                            onClick={submit}
                                            disabled={submitting || !doctorId}
                                        >
                                            {submitting ? "Lançando…" : "Lançar"}
                                        </button>
                                    </div>
                                </footer>
                            </motion.div>
                        </Dialog.Content>
                    </Dialog.Portal>
                )}
            </AnimatePresence>
        </Dialog.Root>
    );
}
