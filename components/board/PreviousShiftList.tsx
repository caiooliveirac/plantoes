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

const BUCKET_META: Record<PreviousOperationalBucket, { label: string; tone: "ice" | "gold" | "green" | "amber" }> = {
    P_INVERTIDO: { label: "P inv", tone: "amber" },
    P: { label: "P", tone: "gold" },
    SD: { label: "SD", tone: "ice" },
    SN: { label: "SN", tone: "green" },
};

const REGULATION_PRIORITY = ["2031", "2032", "2033", "2034", "2035", "2151"];

function regulationOrderRank(code: string): [number, number] {
    const trimmed = code.trim();
    const priorityIndex = REGULATION_PRIORITY.indexOf(trimmed);
    if (priorityIndex !== -1) return [0, priorityIndex];
    const numeric = Number.parseInt(trimmed, 10);
    return [1, Number.isFinite(numeric) ? numeric : Number.MAX_SAFE_INTEGER];
}

function interventionOrderRank(code: string): number {
    const match = code.match(/(\d+)/);
    if (!match) return Number.MAX_SAFE_INTEGER;
    return Number.parseInt(match[1], 10);
}

function compareEntries(a: PreviousOperationalEntry, b: PreviousOperationalEntry): number {
    if (a.domain === "regulation") {
        const [ag, an] = regulationOrderRank(a.targetCode);
        const [bg, bn] = regulationOrderRank(b.targetCode);
        if (ag !== bg) return ag - bg;
        if (an !== bn) return an - bn;
    } else {
        const an = interventionOrderRank(a.targetCode);
        const bn = interventionOrderRank(b.targetCode);
        if (an !== bn) return an - bn;
    }
    return a.targetCode.localeCompare(b.targetCode, "pt-BR");
}

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
    if (minutes === null) return "—";
    if (minutes === 0) return "0";
    const sign = minutes > 0 ? "+" : "−";
    const abs = Math.abs(minutes);
    const hours = Math.floor(abs / 60);
    const mins = abs % 60;
    if (hours > 0 && mins > 0) return `${sign}${hours}h${String(mins).padStart(2, "0")}`;
    if (hours > 0) return `${sign}${hours}h`;
    return `${sign}${mins}m`;
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
                    className="historico-grid-time"
                    aria-label={`Editar ${label.toLowerCase()} de ${entry.displayName ?? entry.doctorName}`}
                    title={`Editar ${label.toLowerCase()}`}
                >
                    {displayValue}
                </button>
            </Popover.Trigger>
            <Popover.Portal>
                <Popover.Content
                    sideOffset={6}
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
        const byDomain = new Map<"regulation" | "intervention", PreviousOperationalEntry[]>();
        for (const entry of entries) {
            const list = byDomain.get(entry.domain) ?? [];
            list.push(entry);
            byDomain.set(entry.domain, list);
        }
        const order: Array<{ domain: "regulation" | "intervention"; label: string }> = [
            { domain: "regulation", label: "Regulação" },
            { domain: "intervention", label: "Intervenção" },
        ];
        return order
            .map((section) => ({
                ...section,
                entries: (byDomain.get(section.domain) ?? []).sort(compareEntries),
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
            className="historico-grid"
            variants={staggerList}
            initial="initial"
            animate="animate"
        >
            {grouped.map((section) => (
                <motion.section
                    key={section.domain}
                    className="historico-grid-section"
                    variants={fadeRise}
                >
                    <header className="historico-grid-section__header">
                        <h2>{section.label}</h2>
                        <span>{section.entries.length} ocupações</span>
                    </header>

                    <div className="historico-grid-table" role="table" aria-label={`Ocupações de ${section.label}`}>
                        <div className="historico-grid-row historico-grid-row--head" role="row">
                            <div role="columnheader" className="col-turno">Turno</div>
                            <div role="columnheader" className="col-codigo">{section.domain === "regulation" ? "Ramal" : "Base"}</div>
                            <div role="columnheader" className="col-medico">Médico</div>
                            <div role="columnheader" className="col-hora">Chegada</div>
                            <div role="columnheader" className="col-hora">Saída</div>
                            <div role="columnheader" className="col-saldo">Saldo</div>
                            <div role="columnheader" className="col-extra">Observações</div>
                        </div>

                        {section.entries.map((entry) => {
                            const pending = pendingByOccupancyId.get(entry.occupancyId);
                            const balance = entry.balanceMinutes;
                            const tone = balanceTone(balance);
                            const arrivalIso = entryArrival(entry);
                            const departureIso = entryEffectiveEnd(entry);
                            return (
                                <motion.div
                                    key={`${entry.domain}-${entry.occupancyId}`}
                                    role="row"
                                    className={`historico-grid-row ${pending ? "is-pending" : ""}`.trim()}
                                    variants={staggerChild}
                                >
                                    <div role="cell" className="col-turno">
                                        <span className={`historico-grid-bucket tone-${BUCKET_META[entry.bucket].tone}`}>
                                            {BUCKET_META[entry.bucket].label}
                                        </span>
                                    </div>
                                    <div role="cell" className="col-codigo">
                                        <strong>{entry.targetCode}</strong>
                                    </div>
                                    <div role="cell" className="col-medico">
                                        <span className="historico-grid-medico">{entry.displayName || entry.doctorName}</span>
                                        {entry.roleLabel && <span className="historico-grid-role">{entry.roleLabel}</span>}
                                    </div>
                                    <div role="cell" className="col-hora">
                                        <TimeEditor
                                            entry={entry}
                                            field="arrival"
                                            currentIso={arrivalIso}
                                            onSaved={handleSaved}
                                        />
                                    </div>
                                    <div role="cell" className="col-hora">
                                        <TimeEditor
                                            entry={entry}
                                            field="departure"
                                            currentIso={departureIso}
                                            onSaved={handleSaved}
                                        />
                                    </div>
                                    <div role="cell" className="col-saldo">
                                        <span className={`historico-grid-balance tone-${tone}`}>
                                            {formatSignedMinutes(balance)}
                                        </span>
                                    </div>
                                    <div role="cell" className="col-extra">
                                        {pending && (
                                            <button
                                                type="button"
                                                className="historico-grid-pending"
                                                onClick={() => onPendingClick(entry, pending)}
                                            >
                                                Verbalizada {formatHourMinute(pending.actualEndedAt)} →
                                            </button>
                                        )}
                                        {!pending && entry.ruleCode && (
                                            <span className="historico-grid-rule">{entry.ruleCode}</span>
                                        )}
                                        {!pending && !entry.ruleCode && entry.status === "open" && (
                                            <span className="historico-grid-open">Em aberto</span>
                                        )}
                                    </div>
                                </motion.div>
                            );
                        })}
                    </div>
                </motion.section>
            ))}
        </motion.div>
    );
}
