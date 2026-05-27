"use client";

import { useMemo, useState, useTransition } from "react";
import * as Popover from "@radix-ui/react-popover";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { fadeRise, staggerChild, staggerList } from "@/lib/board/motion";
import type {
    PendingDepartureConfirmation,
    PreviousOperationalBucket,
    PreviousOperationalEntry,
} from "@/services/board.service";

const BUCKET_META: Record<PreviousOperationalBucket, { label: string; tone: "ice" | "gold" | "green" | "amber"; description: string }> = {
    P_INVERTIDO: {
        label: "Plantão invertido",
        tone: "amber",
        description: "Assumiu no SN e entregou no SD.",
    },
    P: {
        label: "Plantão P",
        tone: "gold",
        description: "Responsáveis que atravessaram SD e SN.",
    },
    SD: {
        label: "Diurno (SD)",
        tone: "ice",
        description: "Responsáveis pelo turno diurno.",
    },
    SN: {
        label: "Noturno (SN)",
        tone: "green",
        description: "Responsáveis pelo turno noturno.",
    },
};

function formatHourMinute(value: string | null | undefined) {
    if (!value) return "—";
    return new Date(value).toLocaleTimeString("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "America/Sao_Paulo",
    });
}

function formatSignedMinutes(minutes: number | null): string {
    if (minutes === null) return "Sem banco";
    if (minutes === 0) return "0min";
    const sign = minutes > 0 ? "+" : "−";
    const abs = Math.abs(minutes);
    const hours = Math.floor(abs / 60);
    const mins = abs % 60;
    if (hours > 0 && mins > 0) return `${sign}${hours}h${String(mins).padStart(2, "0")}`;
    if (hours > 0) return `${sign}${hours}h`;
    return `${sign}${mins}min`;
}

function balanceTone(value: number | null): "neutral" | "positive" | "negative" {
    if (value === null || value === 0) return "neutral";
    return value > 0 ? "positive" : "negative";
}

function entryArrival(entry: PreviousOperationalEntry) {
    return entry.boardStartedAt ?? entry.startedAt;
}

function entryEffectiveEnd(entry: PreviousOperationalEntry) {
    return entry.actualEndedAt ?? entry.endedAt;
}

/** Convert ISO to <input type="datetime-local"> value preserving Sao_Paulo wall-clock. */
function isoToLocalInputValue(iso: string | null): string {
    if (!iso) return "";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
}

function localInputValueToIso(value: string): string {
    return new Date(value).toISOString();
}

interface TimeEditorProps {
    entry: PreviousOperationalEntry;
    field: "arrival" | "departure";
    currentIso: string | null;
    onSaved: () => void;
}

function TimeEditor({ entry, field, currentIso, onSaved }: TimeEditorProps) {
    const [open, setOpen] = useState(false);
    const [value, setValue] = useState(() => isoToLocalInputValue(currentIso));
    const [reason, setReason] = useState("");
    const [submitting, setSubmitting] = useState(false);

    const label = field === "arrival" ? "Chegada" : "Saída efetiva";
    const displayValue = field === "arrival"
        ? formatHourMinute(currentIso)
        : currentIso ? formatHourMinute(currentIso) : "Em aberto";

    const handleOpenChange = (next: boolean) => {
        if (next) {
            setValue(isoToLocalInputValue(currentIso));
            setReason("");
        }
        setOpen(next);
    };

    const submit = async () => {
        if (!value) {
            toast.error("Informe o novo horário.");
            return;
        }
        const trimmedReason = reason.trim();
        const nextIso = localInputValueToIso(value);
        const changed = !currentIso || new Date(currentIso).toISOString() !== nextIso;
        if (changed && trimmedReason.length < 8) {
            toast.error("Motivo obrigatório (≥ 8 caracteres) para corrigir horário.");
            return;
        }
        setSubmitting(true);
        try {
            const endpoint = entry.domain === "regulation"
                ? `/api/regulation/occupancies/${entry.occupancyId}`
                : `/api/intervention/occupancies/${entry.occupancyId}`;

            const payload: Record<string, unknown> = {
                notes: trimmedReason || undefined,
            };

            if (field === "arrival") {
                payload.startedAt = nextIso;
                payload.boardStartedAt = nextIso;
            } else {
                payload.actualEndedAt = nextIso;
            }

            const response = await fetch(endpoint, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                const body = await response.json().catch(() => ({})) as { error?: string };
                throw new Error(body.error || "Falha ao salvar horário.");
            }

            toast.success(`${label} atualizada: ${entry.displayName ?? entry.doctorName}.`);
            setOpen(false);
            onSaved();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Falha ao salvar horário.");
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Popover.Root open={open} onOpenChange={handleOpenChange}>
            <Popover.Trigger asChild>
                <button
                    type="button"
                    className="historico-list-time"
                    aria-label={`Editar ${label.toLowerCase()} de ${entry.displayName ?? entry.doctorName}`}
                >
                    <span className="historico-list-time__label">{label}</span>
                    <strong>{displayValue}</strong>
                    <span className="historico-list-time__edit">editar</span>
                </button>
            </Popover.Trigger>
            <Popover.Portal>
                <Popover.Content
                    sideOffset={8}
                    collisionPadding={16}
                    className="historico-list-popover"
                >
                    <header>
                        <strong>Corrigir {label.toLowerCase()}</strong>
                        <span>{entry.displayName ?? entry.doctorName} · {entry.targetCode}</span>
                    </header>
                    <label className="historico-list-popover__field">
                        <span>Novo horário</span>
                        <input
                            type="datetime-local"
                            value={value}
                            onChange={(event) => setValue(event.target.value)}
                            step={60}
                        />
                    </label>
                    <label className="historico-list-popover__field">
                        <span>Motivo (obrigatório)</span>
                        <textarea
                            value={reason}
                            onChange={(event) => setReason(event.target.value)}
                            rows={3}
                            placeholder="Ex.: chegada confirmada por rádio às 07:08"
                        />
                    </label>
                    <div className="historico-list-popover__actions">
                        <button
                            type="button"
                            className="historico-list-popover__cancel"
                            onClick={() => setOpen(false)}
                            disabled={submitting}
                        >
                            Cancelar
                        </button>
                        <button
                            type="button"
                            className="historico-list-popover__save"
                            onClick={submit}
                            disabled={submitting}
                        >
                            {submitting ? "Salvando…" : "Salvar"}
                        </button>
                    </div>
                    <Popover.Arrow className="historico-list-popover__arrow" />
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    );
}

export function PreviousShiftList({
    entries,
    pendingByOccupancyId,
    onPendingClick,
}: {
    entries: PreviousOperationalEntry[];
    pendingByOccupancyId: Map<string, PendingDepartureConfirmation>;
    onPendingClick: (entry: PreviousOperationalEntry, pending: PendingDepartureConfirmation) => void;
}) {
    const router = useRouter();
    const [, startTransition] = useTransition();

    const grouped = useMemo(() => {
        const byBucket = new Map<PreviousOperationalBucket, PreviousOperationalEntry[]>();
        for (const entry of entries) {
            const list = byBucket.get(entry.bucket) ?? [];
            list.push(entry);
            byBucket.set(entry.bucket, list);
        }
        const order: PreviousOperationalBucket[] = ["P_INVERTIDO", "P", "SD", "SN"];
        return order
            .map((bucket) => ({
                bucket,
                entries: (byBucket.get(bucket) ?? []).sort(
                    (a, b) => new Date(entryArrival(a)).getTime() - new Date(entryArrival(b)).getTime(),
                ),
            }))
            .filter((section) => section.entries.length > 0);
    }, [entries]);

    if (entries.length === 0) {
        return (
            <div className="historico-list-empty">
                Nenhum registro corresponde aos filtros atuais.
            </div>
        );
    }

    const handleSaved = () => {
        startTransition(() => {
            router.refresh();
        });
    };

    return (
        <motion.div
            className="historico-list"
            variants={staggerList}
            initial="initial"
            animate="animate"
        >
            {grouped.map((section) => (
                <motion.section
                    key={section.bucket}
                    className="historico-list-section"
                    variants={fadeRise}
                >
                    <header className="historico-list-section__header">
                        <span className={`historico-list-section__tone tone-${BUCKET_META[section.bucket].tone}`} />
                        <div>
                            <h2>{BUCKET_META[section.bucket].label}</h2>
                            <p>{BUCKET_META[section.bucket].description}</p>
                        </div>
                        <span className="historico-list-section__count">{section.entries.length} ocupações</span>
                    </header>

                    <motion.div
                        className="historico-list-cards"
                        variants={staggerList}
                        initial="initial"
                        animate="animate"
                    >
                        {section.entries.map((entry) => {
                            const pending = pendingByOccupancyId.get(entry.occupancyId);
                            const balance = entry.balanceMinutes;
                            const tone = balanceTone(balance);
                            const arrivalIso = entryArrival(entry);
                            const departureIso = entryEffectiveEnd(entry);
                            return (
                                <motion.article
                                    key={`${entry.domain}-${entry.occupancyId}`}
                                    className={`historico-list-card ${pending ? "pending" : ""}`.trim()}
                                    variants={staggerChild}
                                >
                                    <header className="historico-list-card__header">
                                        <div className="historico-list-card__title">
                                            <span className={`historico-list-card__domain ${entry.domain}`}>
                                                {entry.domain === "regulation" ? "Regulação" : "Intervenção"}
                                            </span>
                                            <strong>{entry.targetCode}</strong>
                                            <span className="historico-list-card__target">{entry.targetLabel}</span>
                                        </div>
                                        <span className={`historico-list-card__balance tone-${tone}`}>
                                            {formatSignedMinutes(balance)}
                                        </span>
                                    </header>

                                    <div className="historico-list-card__doctor">
                                        <strong>{entry.displayName || entry.doctorName}</strong>
                                        {entry.roleLabel && <span>{entry.roleLabel}</span>}
                                    </div>

                                    <div className="historico-list-card__times">
                                        <TimeEditor
                                            entry={entry}
                                            field="arrival"
                                            currentIso={arrivalIso}
                                            onSaved={handleSaved}
                                        />
                                        <TimeEditor
                                            entry={entry}
                                            field="departure"
                                            currentIso={departureIso}
                                            onSaved={handleSaved}
                                        />
                                    </div>

                                    <footer className="historico-list-card__footer">
                                        <span>
                                            Janela banco: {entry.scheduledStartAt && entry.scheduledEndAt
                                                ? `${formatHourMinute(entry.scheduledStartAt)} — ${formatHourMinute(entry.scheduledEndAt)}`
                                                : "—"}
                                        </span>
                                        <span>{entry.status === "open" ? "Em aberto" : "Encerrado"}</span>
                                        {entry.ruleCode && <span className="historico-list-card__rule">{entry.ruleCode}</span>}
                                    </footer>

                                    {pending && (
                                        <button
                                            type="button"
                                            className="historico-list-card__pending"
                                            onClick={() => onPendingClick(entry, pending)}
                                        >
                                            Saída verbalizada às {formatHourMinute(pending.actualEndedAt)} — abrir verificador →
                                        </button>
                                    )}

                                    {entry.bankHoursExplanation && (
                                        <p className="historico-list-card__explanation">{entry.bankHoursExplanation}</p>
                                    )}
                                </motion.article>
                            );
                        })}
                    </motion.div>
                </motion.section>
            ))}
        </motion.div>
    );
}
