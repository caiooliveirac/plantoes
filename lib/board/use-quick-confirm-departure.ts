"use client";

import { useCallback, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { PendingDepartureConfirmation } from "@/services/board.service";

/**
 * Shared quick-confirm handler used by AuditRail card buttons AND the command
 * palette. Keeps optimistic-removal logic in a single place; both surfaces
 * delegate to the same function.
 *
 * The AuditRail manages its own optimistic-hide state for visual continuity;
 * the palette closes immediately so it relies on `router.refresh()` to surface
 * the updated state on the next render.
 */
export function useQuickConfirmDeparture() {
    const router = useRouter();
    const [, startTransition] = useTransition();

    return useCallback(async (pending: PendingDepartureConfirmation): Promise<{ ok: boolean }> => {
        try {
            const response = await fetch(`/api/${pending.domain}/occupancies/${pending.occupancyId}/confirm-departure`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({}),
            });
            if (!response.ok) {
                const body = await response.json().catch(() => ({})) as { error?: string };
                throw new Error(body.error || "Falha ao confirmar saída.");
            }
            const time = new Date(pending.actualEndedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
            toast.success(`Saída de ${pending.displayName ?? pending.doctorName} confirmada às ${time}.`);
            startTransition(() => {
                router.refresh();
            });
            return { ok: true };
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Falha ao confirmar saída.");
            return { ok: false };
        }
    }, [router, startTransition]);
}
