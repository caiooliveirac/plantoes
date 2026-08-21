"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";

interface ChiefArrivalRequest {
    requestId: string;
    occupancyId: string;
    requestedAt: string;
    postCode: string | null;
    doctorName: string | null;
    currentStartedAt: string | null;
    requestedStartedAt: string | null;
    note: string | null;
    channel: string | null;
    actorEmail: string | null;
}

function formatHourMinute(iso: string | null) {
    if (!iso) return "--:--";
    const date = new Date(iso);
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * Pedidos de correção da chegada da chefia esperando o admin.
 *
 * Só aparece para admin e só quando existe pedido aberto — chefe barrado no
 * quadro deixa aqui o horário que diz ser o certo, e o admin aplica ou descarta
 * num clique. Sem pedido aberto, o componente não desenha nada.
 */
export function ChiefArrivalRequestsRail() {
    const router = useRouter();
    const [, startTransition] = useTransition();
    const [requests, setRequests] = useState<ChiefArrivalRequest[]>([]);
    const [busyId, setBusyId] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const response = await fetch("/api/board/chief-arrival-requests");
            if (!response.ok) return;
            const payload = await response.json() as { requests?: ChiefArrivalRequest[] };
            setRequests(payload.requests ?? []);
        } catch {
            // Rail informativo: falha de rede não interrompe o quadro.
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const decide = async (requestId: string, decision: "apply" | "dismiss") => {
        setBusyId(requestId);
        try {
            const response = await fetch("/api/board/chief-arrival-requests", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ requestId, decision }),
            });
            const payload = await response.json().catch(() => ({})) as { error?: string; requests?: ChiefArrivalRequest[] };
            if (!response.ok) {
                throw new Error(payload.error || "Falha ao decidir o pedido.");
            }
            setRequests(payload.requests ?? []);
            toast.success(decision === "apply" ? "Chegada corrigida." : "Pedido descartado.");
            startTransition(() => router.refresh());
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Falha ao decidir o pedido.");
        } finally {
            setBusyId(null);
        }
    };

    if (requests.length === 0) {
        return null;
    }

    return (
        <section className="board-audit-rail chief-arrival-rail">
            <div className="board-audit-rail__header" role="presentation">
                <span className="board-audit-rail__title">Chegada da chefia — pedidos de correção</span>
                <span className="board-audit-rail__count">{requests.length}</span>
            </div>
            <div className="board-audit-rail__section">
                Só admin altera chegada em ramal de chefe · {requests.length} pedido(s) aberto(s)
            </div>
            <ul className="chief-arrival-rail__list">
                {requests.map((request) => (
                    <li key={request.requestId} className="chief-arrival-rail__item">
                        <div className="chief-arrival-rail__info">
                            <strong>{request.doctorName ?? "Ocupante"} · {request.postCode ?? "2031"}</strong>
                            <span>
                                {formatHourMinute(request.currentStartedAt)} → {formatHourMinute(request.requestedStartedAt)}
                                {request.channel === "telegram" ? " (pelo Telegram)" : ""}
                            </span>
                            {request.note && <em>{request.note}</em>}
                            {request.actorEmail && <small>pedido por {request.actorEmail}</small>}
                        </div>
                        <div className="chief-arrival-rail__actions">
                            <button
                                type="button"
                                className="board-modal-button confirm"
                                disabled={busyId === request.requestId || !request.requestedStartedAt}
                                onClick={() => void decide(request.requestId, "apply")}
                            >
                                Aplicar
                            </button>
                            <button
                                type="button"
                                className="board-modal-button reject"
                                disabled={busyId === request.requestId}
                                onClick={() => void decide(request.requestId, "dismiss")}
                            >
                                Descartar
                            </button>
                        </div>
                    </li>
                ))}
            </ul>
        </section>
    );
}
