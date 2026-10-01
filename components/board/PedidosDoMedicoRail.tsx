"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { fetchMesa } from "@/lib/board/fetch-mesa";
import { bahiaClockHHMM } from "@/lib/time";
import "@/app/mesa-kit.css";

interface PedidoApi {
    id: string;
    kind: "continuar";
    status: string;
    createdAt: string;
    medico: { id: string; nome: string };
    ocupacao: { domain: "regulation" | "intervention"; code: string; shiftLabel?: string | null };
}
interface Pedido {
    id: string;
    kind: "continuar";
    doctorName: string;
    code: string;
    domain: "regulation" | "intervention";
    createdAt: string;
}

/**
 * Faixa para a chefia: pedidos do médico pela web (hoje só "continuar no
 * próximo turno" = dobra). Ciente cria a continuação; recusar só marca.
 * Rotas: GET /api/mesa/pedidos-do-medico, POST .../[id]/decidir.
 */
export function PedidosDoMedicoRail({ pedidosIniciais = [] }: { pedidosIniciais?: Pedido[] } = {}) {
    const router = useRouter();
    const [pedidos, setPedidos] = useState<Pedido[]>(pedidosIniciais);
    const [decidindo, setDecidindo] = useState<string | null>(null);

    const carregar = useCallback(async () => {
        try {
            const r = await fetch("/api/mesa/pedidos-do-medico", { cache: "no-store" });
            if (!r.ok) return;
            const corpo = await r.json() as { pedidos?: PedidoApi[] };
            setPedidos((corpo.pedidos ?? []).map((p) => ({
                id: p.id,
                kind: p.kind,
                doctorName: p.medico?.nome ?? "Médico",
                code: p.ocupacao?.code ?? "—",
                domain: p.ocupacao?.domain ?? "regulation",
                createdAt: p.createdAt,
            })));
        } catch {
            // silencioso: a faixa some
        }
    }, []);

    useEffect(() => {
        void carregar();
        const id = window.setInterval(() => void carregar(), 60_000);
        return () => window.clearInterval(id);
    }, [carregar]);

    async function decidir(pedido: Pedido, decisao: "aceito" | "recusado") {
        setDecidindo(pedido.id);
        try {
            const r = await fetchMesa(`/api/mesa/pedidos-do-medico/${pedido.id}/decidir`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ decisao }),
            });
            if (!r.ok) {
                const corpo = await r.json().catch(() => ({})) as { error?: string };
                throw new Error(corpo.error || "Não foi possível decidir.");
            }
            toast.success(decisao === "aceito" ? `${pedido.doctorName} continua no próximo turno.` : `Dobra de ${pedido.doctorName} recusada.`);
            await carregar();
            router.refresh();
        } catch (erro) {
            toast.error(erro instanceof Error ? erro.message : "Não foi possível decidir.");
        } finally {
            setDecidindo(null);
        }
    }

    if (pedidos.length === 0) return null;

    return (
        <section className="mk-rail" aria-label="Pedidos dos médicos">
            {pedidos.map((pedido) => (
                <div key={pedido.id} className="mk-rail-item">
                    <div className="mk-rail-texto">
                        <strong>{pedido.doctorName}</strong> ({pedido.code}) avisou às {bahiaClockHHMM(pedido.createdAt)} que vai <strong>continuar no próximo turno</strong>.
                    </div>
                    <div className="mk-rail-acoes">
                        <button type="button" className="mk-botao primario" disabled={decidindo === pedido.id} onClick={() => void decidir(pedido, "aceito")}>Ciente, pode dobrar</button>
                        <button type="button" className="mk-botao" disabled={decidindo === pedido.id} onClick={() => void decidir(pedido, "recusado")}>Recusar</button>
                    </div>
                </div>
            ))}
        </section>
    );
}
