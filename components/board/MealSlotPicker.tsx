"use client";

import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { toast } from "sonner";
import { useRouter } from "next/navigation";

export type MealKind = "lunch" | "rest" | "dinner" | "work";

const DAY_SLOTS = ["11:30", "12:30", "13:30", "14:30", "15:30", "16:30", "18:00"] as const;
const NIGHT_DINNER_SLOTS = ["20:30", "21:00", "21:30", "22:00", "22:30"] as const;
const NIGHT_WORK_SLOTS = ["23:00", "03:00"] as const;

interface MealSlotPickerProps {
    ramal: string;
    kind: MealKind;
    currentSlot: string | null;
    doctorName: string;
    children: React.ReactNode;
}

function slotsFor(kind: MealKind): readonly string[] {
    if (kind === "dinner") return NIGHT_DINNER_SLOTS;
    if (kind === "work") return NIGHT_WORK_SLOTS;
    return DAY_SLOTS;
}

function payloadKeyFor(kind: MealKind): "lunchSlot" | "restSlot" | "dinnerSlot" | "nightWorkSlot" {
    if (kind === "lunch") return "lunchSlot";
    if (kind === "rest") return "restSlot";
    if (kind === "dinner") return "dinnerSlot";
    return "nightWorkSlot";
}

function kindLabel(kind: MealKind) {
    if (kind === "lunch") return "Almoço";
    if (kind === "rest") return "Descanso";
    if (kind === "dinner") return "Jantar";
    return "Trabalho noturno";
}

export function MealSlotPicker({ ramal, kind, currentSlot, doctorName, children }: MealSlotPickerProps) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const slots = slotsFor(kind);
    const payloadKey = payloadKeyFor(kind);
    const label = kindLabel(kind);

    const apply = async (slot: string | null) => {
        if (slot === currentSlot) {
            setOpen(false);
            return;
        }
        setSubmitting(true);
        try {
            const response = await fetch(`/api/board/meal-breaks/regulation/${encodeURIComponent(ramal)}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ [payloadKey]: slot }),
            });
            if (!response.ok) {
                const body = await response.json().catch(() => ({})) as { error?: string };
                throw new Error(body.error || `Falha ao atualizar ${label.toLowerCase()}.`);
            }
            toast.success(slot ? `${doctorName}: ${label.toLowerCase()} ${slot}.` : `${doctorName}: ${label.toLowerCase()} removido.`);
            setOpen(false);
            router.refresh();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : `Falha ao atualizar ${label.toLowerCase()}.`);
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Popover.Root open={open} onOpenChange={setOpen}>
            <Popover.Trigger asChild>
                <button
                    type="button"
                    className="meal-slot-trigger"
                    onClick={(event) => event.stopPropagation()}
                    aria-label={`Editar ${label.toLowerCase()} de ${doctorName}`}
                >
                    {children}
                </button>
            </Popover.Trigger>
            <Popover.Portal>
                <Popover.Content
                    sideOffset={6}
                    collisionPadding={16}
                    className="historico-list-popover meal-slot__panel"
                    onClick={(event) => event.stopPropagation()}
                >
                    <header>
                        <strong>{label}</strong>
                        <span>{doctorName} · {ramal}</span>
                    </header>
                    <div className="meal-slot__grid">
                        <button
                            type="button"
                            className={`meal-slot__chip ${currentSlot === null ? "active" : ""}`.trim()}
                            onClick={() => apply(null)}
                            disabled={submitting}
                        >
                            Sem horário
                        </button>
                        {slots.map((slot) => (
                            <button
                                key={slot}
                                type="button"
                                className={`meal-slot__chip ${currentSlot === slot ? "active" : ""}`.trim()}
                                onClick={() => apply(slot)}
                                disabled={submitting}
                            >
                                {slot}
                            </button>
                        ))}
                    </div>
                    <Popover.Arrow className="historico-list-popover__arrow" />
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    );
}
