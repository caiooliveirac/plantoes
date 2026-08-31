"use client";

import { useState } from "react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import type { MealBreakBoardEvaluation, MealBreakSession } from "@/modules/telegram/meal-breaks";

interface MealBreakSessionBarProps {
    session: MealBreakSession;
    evaluation: MealBreakBoardEvaluation | null;
    generatedAt: string;
}

/** Pill discreto abaixo das tabelas: emoji + estado + botões pequenos.
    Os textos longos de deriva/fechamento viram title/toast. */
export function MealBreakSessionBar({ session, evaluation, generatedAt }: MealBreakSessionBarProps) {
    const router = useRouter();
    const [confirmRestart, setConfirmRestart] = useState(false);
    const [busy, setBusy] = useState<"restart" | "reconcile" | null>(null);
    const mealLabel = session.mode === "night" ? "jantar" : "almoço";
    const stale = evaluation?.kind === "stale";
    const drifted = evaluation?.kind === "rewind"
        || evaluation?.kind === "structural"
        || evaluation?.kind === "sync";

    const run = async (path: "restart" | "reconcile") => {
        setBusy(path);
        try {
            const response = await fetch(`/api/board/meal-breaks/${path}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ referenceAt: generatedAt }),
            });
            const body = await response.json().catch(() => ({})) as { error?: string; evaluation?: MealBreakBoardEvaluation };
            if (!response.ok) {
                throw new Error(body.error || `Falha ao ${path === "restart" ? "reiniciar" : "atualizar"} a divisão.`);
            }
            if (path === "restart") {
                toast.success(`Divisão do ${mealLabel} reiniciada. O grupo recebeu o novo pedido.`);
            } else if (body.evaluation?.kind === "stale") {
                toast.message(body.evaluation.staleHint ?? `A divisão do ${mealLabel} já fechou. Use Reiniciar se precisar refazer.`);
            } else if (body.evaluation?.kind === "none") {
                toast.success(`A divisão do ${mealLabel} já estava alinhada com o quadro.`);
            } else {
                toast.success(`Divisão do ${mealLabel} atualizada. O grupo foi avisado se alguém precisa escolher de novo.`);
            }
            setConfirmRestart(false);
            router.refresh();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Falha na divisão.");
        } finally {
            setBusy(null);
        }
    };

    const statusEmoji = stale ? "⏸️" : drifted ? "⚠️" : "🍽️";
    const statusTitle = stale
        ? (evaluation?.staleHint ?? `A divisão do ${mealLabel} já fechou.`)
        : drifted
            ? "O quadro mudou depois que a divisão começou. Atualizar recalcula vagas e só devolve a escolha a quem ficou sem as opções de agora. Reiniciar descarta tudo."
            : undefined;

    return (
        <div className="meal-break-mini" title={statusTitle}>
            <span aria-hidden="true">{statusEmoji}</span>
            <span>
                {session.mode === "night" ? "Jantar" : "Almoço"}
                {session.stage === "completed" ? " · divisão fechada" : " em curso"}
                {` · ${session.roster.length}`}
            </span>
            {drifted && (
                <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void run("reconcile")}
                >
                    {busy === "reconcile" ? "Atualizando..." : "Atualizar"}
                </button>
            )}
            {confirmRestart ? (
                <>
                    <button
                        type="button"
                        className="danger"
                        disabled={busy !== null}
                        onClick={() => void run("restart")}
                    >
                        {busy === "restart" ? "Reiniciando..." : "Confirmar reinício"}
                    </button>
                    <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => setConfirmRestart(false)}
                    >
                        Cancelar
                    </button>
                </>
            ) : (
                <button
                    type="button"
                    className="danger"
                    disabled={busy !== null}
                    onClick={() => setConfirmRestart(true)}
                >
                    Reiniciar
                </button>
            )}
        </div>
    );
}
