"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Clock3, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { fetchMesa } from "@/lib/board/fetch-mesa";
import { bahiaClockHHMM } from "@/lib/time";
import { MOTIVOS_ATRASO, MotivoChips, motivoValido } from "@/components/board/MotivoChips";
import "@/app/mesa-kit.css";

interface AcoesDeAtrasoProps {
    domain: "regulation" | "intervention";
    occupancyId: string;
    doctorName: string;
    /** Atraso previsto (min) que o quadro já calculou; 0/null = nada a fazer. */
    arrivalDelayMinutes: number | null;
    arrivalDelayWaived: boolean;
    /** Início da janela prevista (ISO) — vira a hora do botão "Chegou no horário". */
    scheduledStartAt: string | null;
}

/**
 * Dois botões ao lado das ações da linha quando há atraso:
 *  - "Chegou no horário (07:00)": correção de hora (PATCH), mexe em refeição/saída;
 *  - "Desconsiderar atraso": abono (banco e pagamento como pontual), hora intacta.
 * Já abonado: botão pequeno para reverter. docs/plano-mesa-chefe-plantonista.md.
 */
export function AcoesDeAtraso({ domain, occupancyId, doctorName, arrivalDelayMinutes, arrivalDelayWaived, scheduledStartAt }: AcoesDeAtrasoProps) {
    const router = useRouter();
    const [folha, setFolha] = useState<"abonar" | null>(null);
    const [motivo, setMotivo] = useState("");
    const [enviando, setEnviando] = useState(false);
    const base = domain === "regulation" ? `/api/regulation/occupancies/${occupancyId}` : `/api/intervention/occupancies/${occupancyId}`;
    const horaPrevista = scheduledStartAt ? bahiaClockHHMM(scheduledStartAt) : null;

    async function chamar(url: string, method: string, body: unknown, sucesso: string) {
        setEnviando(true);
        try {
            const response = await fetchMesa(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
            if (!response.ok) {
                const corpo = await response.json().catch(() => ({})) as { error?: string };
                throw new Error(corpo.error || "Não foi possível salvar.");
            }
            toast.success(sucesso);
            setFolha(null);
            setMotivo("");
            router.refresh();
        } catch (erro) {
            toast.error(erro instanceof Error ? erro.message : "Não foi possível salvar.");
        } finally {
            setEnviando(false);
        }
    }

    if (arrivalDelayWaived) {
        return (
            <button
                type="button"
                className="row-action ghost"
                disabled={enviando}
                title="Voltar a contar o atraso no banco e no pagamento"
                onClick={(evento) => {
                    evento.stopPropagation();
                    void chamar(`${base}/arrival-delay-waiver`, "POST", { waived: false }, `Atraso de ${doctorName} volta a contar.`);
                }}
            >
                <Undo2 size={13} strokeWidth={2.2} />
                <span>Voltar a contar atraso</span>
            </button>
        );
    }

    if (!arrivalDelayMinutes || arrivalDelayMinutes <= 0) return null;

    return (
        <>
            {horaPrevista && scheduledStartAt ? (
                <button
                    type="button"
                    className="row-action info"
                    disabled={enviando}
                    title={`Corrige a chegada para ${horaPrevista}: passa a valer para refeição e saída também`}
                    onClick={(evento) => {
                        evento.stopPropagation();
                        void chamar(
                            base,
                            "PATCH",
                            { startedAt: scheduledStartAt, boardStartedAt: scheduledStartAt, notes: `Chegou no horário (${horaPrevista}), registro atrasado` },
                            `Chegada de ${doctorName} corrigida para ${horaPrevista}.`,
                        );
                    }}
                >
                    <Clock3 size={13} strokeWidth={2.2} />
                    <span>Chegou às {horaPrevista}</span>
                </button>
            ) : null}
            <button
                type="button"
                className="row-action"
                disabled={enviando}
                title="Banco e pagamento como pontual; a hora de chegada, a refeição e a saída não mudam"
                onClick={(evento) => { evento.stopPropagation(); setFolha("abonar"); }}
            >
                <CheckCircle2 size={13} strokeWidth={2.2} />
                <span>Desconsiderar atraso</span>
            </button>

            {folha === "abonar" ? (
                <div className="mk-veu" role="presentation" onClick={() => setFolha(null)}>
                    <div className="mk-folha" role="dialog" aria-modal="true" aria-labelledby="mk-abono-titulo" onClick={(evento) => evento.stopPropagation()}>
                        <h2 id="mk-abono-titulo" className="mk-folha-titulo">Desconsiderar atraso de {doctorName}</h2>
                        <p className="mk-folha-texto">
                            Banco de horas e pagamento passam a tratar como pontual (hoje: +{arrivalDelayMinutes} min).
                            A hora de chegada, a fila de refeição e a prioridade de saída continuam as mesmas.
                        </p>
                        <MotivoChips opcoes={MOTIVOS_ATRASO} valor={motivo} onChange={setMotivo} />
                        <div className="mk-folha-acoes" style={{ marginTop: 14 }}>
                            <button
                                type="button"
                                className="mk-botao primario"
                                disabled={enviando || !motivoValido(motivo)}
                                onClick={() => void chamar(`${base}/arrival-delay-waiver`, "POST", { waived: true, note: motivo.trim() }, `Atraso de ${doctorName} desconsiderado.`)}
                            >
                                Confirmar
                            </button>
                            <button type="button" className="mk-botao" disabled={enviando} onClick={() => setFolha(null)}>Cancelar</button>
                        </div>
                    </div>
                </div>
            ) : null}
        </>
    );
}
