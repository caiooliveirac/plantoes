"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { fetchMesa } from "@/lib/board/fetch-mesa";
import { MotivoChips, motivoValido } from "@/components/board/MotivoChips";
import "@/app/mesa-kit.css";

const MOTIVOS_BONUS = ["Ficou além do turno em ocorrência", "Cobriu colega sem registro", "Acerto combinado com a chefia", "Correção de cálculo"];
const PASSOS = [-30, -15, 15, 30, 60] as const;

function formatarSaldo(min: number) {
    const sinal = min < 0 ? "−" : "+";
    const abs = Math.abs(min);
    const h = Math.floor(abs / 60);
    const m = abs % 60;
    return `${sinal}${h}:${String(m).padStart(2, "0")}`;
}

/**
 * "Banco deste plantão": saldo calculado + botões ±15/±30/+60 que gravam um
 * override = automático + delta pela rota existente de override (sem teto por
 * decisão do Caio, 01/10/2026). Só plantão fechado e com uma ocupação.
 */
export function AjustesDoBanco({ domain, occupancyId, doctorName, saldoMinutos, ruleCode }: {
    domain: "regulation" | "intervention";
    occupancyId: string;
    doctorName: string;
    saldoMinutos: number | null;
    ruleCode: string | null;
}) {
    const router = useRouter();
    const [aberto, setAberto] = useState(false);
    const [delta, setDelta] = useState(0);
    const [motivo, setMotivo] = useState("");
    const [enviando, setEnviando] = useState(false);

    if (saldoMinutos === null || occupancyId.includes("+")) return null;
    const manual = ruleCode === "MANUAL_OVERRIDE" || (ruleCode ?? "").toUpperCase().includes("MANUAL");
    const novoSaldo = saldoMinutos + delta;

    async function gravar() {
        setEnviando(true);
        try {
            const response = await fetchMesa("/api/admin/bank-hours/overrides", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    domain,
                    occupancyId,
                    balanceMinutes: novoSaldo,
                    notes: `${delta > 0 ? "Bônus" : "Desconto"} de ${Math.abs(delta)} min: ${motivo.trim()}`,
                }),
            });
            if (!response.ok) {
                const corpo = await response.json().catch(() => ({})) as { error?: string };
                throw new Error(corpo.error || "Não foi possível ajustar o banco.");
            }
            toast.success(`Banco de ${doctorName}: ${formatarSaldo(novoSaldo)}.`);
            setAberto(false);
            setDelta(0);
            setMotivo("");
            router.refresh();
        } catch (erro) {
            toast.error(erro instanceof Error ? erro.message : "Não foi possível ajustar o banco.");
        } finally {
            setEnviando(false);
        }
    }

    return (
        <>
            <button
                type="button"
                className="row-action ghost"
                title={manual ? "Saldo já ajustado manualmente; ajustar de novo" : "Dar bônus ou desconto de minutos no banco deste plantão"}
                onClick={(evento) => { evento.stopPropagation(); setAberto(true); }}
            >
                <span>{manual ? "Banco (manual)" : "Ajustar banco"}</span>
            </button>
            {aberto ? (
                <div className="mk-veu" role="presentation" onClick={() => setAberto(false)}>
                    <div className="mk-folha" role="dialog" aria-modal="true" aria-labelledby="mk-banco-titulo" onClick={(evento) => evento.stopPropagation()}>
                        <h2 id="mk-banco-titulo" className="mk-folha-titulo">Banco deste plantão · {doctorName}</h2>
                        <p className="mk-folha-texto">
                            Saldo calculado <strong>{formatarSaldo(saldoMinutos)}</strong>
                            {delta !== 0 ? <> → novo saldo <strong>{formatarSaldo(novoSaldo)}</strong></> : null}
                        </p>
                        <div className="mk-passo" role="group" aria-label="Bônus ou desconto em minutos">
                            {PASSOS.map((passo) => (
                                <button
                                    key={passo}
                                    type="button"
                                    className={`mk-chip ${delta === passo ? "on" : ""}`.trim()}
                                    aria-pressed={delta === passo}
                                    onClick={() => setDelta(passo)}
                                >
                                    {passo > 0 ? `+${passo}` : passo} min
                                </button>
                            ))}
                        </div>
                        <MotivoChips opcoes={MOTIVOS_BONUS} valor={motivo} onChange={setMotivo} />
                        <div className="mk-folha-acoes" style={{ marginTop: 14 }}>
                            <button type="button" className="mk-botao primario" disabled={enviando || delta === 0 || !motivoValido(motivo)} onClick={() => void gravar()}>
                                Gravar {delta !== 0 ? formatarSaldo(novoSaldo) : ""}
                            </button>
                            <button type="button" className="mk-botao" disabled={enviando} onClick={() => setAberto(false)}>Cancelar</button>
                        </div>
                    </div>
                </div>
            ) : null}
        </>
    );
}
