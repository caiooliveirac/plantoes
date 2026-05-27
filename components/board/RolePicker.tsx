"use client";

import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { STANDARD_OPERATIONAL_ROLE_CODES } from "@/modules/operational/roles";

interface RolePickerProps {
    domain: "regulation" | "intervention";
    occupancyId: string;
    currentRole: string | null;
    doctorName: string;
    targetCode: string;
    children: React.ReactNode;
}

export function RolePicker({ domain, occupancyId, currentRole, doctorName, targetCode, children }: RolePickerProps) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [submitting, setSubmitting] = useState(false);

    const apply = async (next: string | null) => {
        if (next === currentRole) {
            setOpen(false);
            return;
        }
        setSubmitting(true);
        try {
            const endpoint = domain === "regulation"
                ? `/api/regulation/occupancies/${occupancyId}`
                : `/api/intervention/occupancies/${occupancyId}`;
            const response = await fetch(endpoint, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ roleLabel: next }),
            });
            if (!response.ok) {
                const body = await response.json().catch(() => ({})) as { error?: string };
                throw new Error(body.error || "Falha ao atualizar função.");
            }
            toast.success(next ? `${doctorName}: função ${next}.` : `${doctorName}: função removida.`);
            setOpen(false);
            router.refresh();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Falha ao atualizar função.");
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Popover.Root open={open} onOpenChange={setOpen}>
            <Popover.Trigger asChild>
                <button
                    type="button"
                    className="row-action role-trigger"
                    onClick={(event) => event.stopPropagation()}
                    aria-label={`Mudar função de ${doctorName}`}
                >
                    {children}
                </button>
            </Popover.Trigger>
            <Popover.Portal>
                <Popover.Content
                    sideOffset={6}
                    collisionPadding={16}
                    className="historico-list-popover role-picker__panel"
                    onClick={(event) => event.stopPropagation()}
                >
                    <header>
                        <strong>Função operacional</strong>
                        <span>{doctorName} · {targetCode}</span>
                    </header>
                    <div className="role-picker__grid">
                        <button
                            type="button"
                            className={`role-picker__chip ${currentRole === null ? "active" : ""}`.trim()}
                            onClick={() => apply(null)}
                            disabled={submitting}
                        >
                            Nenhuma
                        </button>
                        {STANDARD_OPERATIONAL_ROLE_CODES.map((role) => (
                            <button
                                key={role}
                                type="button"
                                className={`role-picker__chip ${currentRole === role ? "active" : ""}`.trim()}
                                onClick={() => apply(role)}
                                disabled={submitting}
                            >
                                {role}
                            </button>
                        ))}
                    </div>
                    <Popover.Arrow className="historico-list-popover__arrow" />
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    );
}
