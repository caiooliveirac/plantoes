"use client";

import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { toast } from "sonner";
import { useRouter } from "next/navigation";

export type TimeEditorDomain = "regulation" | "intervention";
export type TimeEditorField = "arrival" | "departure";

interface InlineTimeEditorProps {
    domain: TimeEditorDomain;
    occupancyId: string;
    field: TimeEditorField;
    currentIso: string | null;
    doctorName: string;
    targetCode: string;
    /** Renders the trigger. Receives the formatted display value (HH:mm) and a flag for "in aberto". */
    children: (display: { value: string; isPending: boolean }) => React.ReactNode;
    onSaved?: () => void;
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

export function InlineTimeEditor({
    domain,
    occupancyId,
    field,
    currentIso,
    doctorName,
    targetCode,
    children,
    onSaved,
}: InlineTimeEditorProps) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [value, setValue] = useState(() => isoToLocalInputValue(currentIso));
    const [reason, setReason] = useState("");
    const [submitting, setSubmitting] = useState(false);

    const label = field === "arrival" ? "Chegada" : "Saída efetiva";
    const display = {
        value: field === "arrival" ? formatHourMinute(currentIso) : (currentIso ? formatHourMinute(currentIso) : "Em aberto"),
        isPending: !currentIso,
    };

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
            const endpoint = domain === "regulation"
                ? `/api/regulation/occupancies/${occupancyId}`
                : `/api/intervention/occupancies/${occupancyId}`;

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

            toast.success(`${label} atualizada: ${doctorName}.`);
            setOpen(false);
            onSaved?.();
            router.refresh();
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
                    className="historico-grid-time inline-time-trigger"
                    aria-label={`Editar ${label.toLowerCase()} de ${doctorName}`}
                    title={`Editar ${label.toLowerCase()}`}
                    onClick={(event) => event.stopPropagation()}
                >
                    {children(display)}
                </button>
            </Popover.Trigger>
            <Popover.Portal>
                <Popover.Content
                    sideOffset={6}
                    collisionPadding={16}
                    className="historico-list-popover"
                    onClick={(event) => event.stopPropagation()}
                >
                    <header>
                        <strong>Corrigir {label.toLowerCase()}</strong>
                        <span>{doctorName} · {targetCode}</span>
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
