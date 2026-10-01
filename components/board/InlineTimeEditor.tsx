"use client";

import { fetchMesa } from "@/lib/board/fetch-mesa";
import { useMemo, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { EditorDeHorario } from "@/components/board/EditorDeHorario";
import { MOTIVOS_HORARIO, MotivoChips, motivoValido } from "@/components/board/MotivoChips";
import { BAHIA_OFFSET_MINUTES } from "@/lib/time";

export type TimeEditorDomain = "regulation" | "intervention";
export type TimeEditorField = "arrival" | "departure";

interface InlineTimeEditorProps {
    domain: TimeEditorDomain;
    occupancyId: string;
    field: TimeEditorField;
    currentIso: string | null;
    doctorName: string;
    targetCode: string;
    /** Janela prevista do turno (ISO). Sem ela, deduz SD/SN pela hora atual. */
    janela?: { inicio: string | null; fim: string | null } | null;
    /** Renders the trigger. Receives the formatted display value (HH:mm) and a flag for "in aberto". */
    children: (display: { value: string; isPending: boolean }) => React.ReactNode;
    onSaved?: () => void;
}

const HORA_MS = 3_600_000;
const OFFSET_MS = BAHIA_OFFSET_MINUTES * 60_000;

function formatHourMinute(value: string | null | undefined) {
    if (!value) return "—";
    return new Date(value).toLocaleTimeString("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "America/Sao_Paulo",
    });
}

/** Janela SD (07–19) ou SN (19–07) que contém o instante, no fuso operacional. */
function janelaDoTurno(ms: number): { inicio: number; fim: number } {
    const local = ms + OFFSET_MS;
    const dia = Math.floor(local / (24 * HORA_MS)) * 24 * HORA_MS;
    const hora = (local - dia) / HORA_MS;
    if (hora >= 7 && hora < 19) return { inicio: dia + 7 * HORA_MS - OFFSET_MS, fim: dia + 19 * HORA_MS - OFFSET_MS };
    if (hora >= 19) return { inicio: dia + 19 * HORA_MS - OFFSET_MS, fim: dia + 31 * HORA_MS - OFFSET_MS };
    return { inicio: dia - 5 * HORA_MS - OFFSET_MS, fim: dia + 7 * HORA_MS - OFFSET_MS };
}

export function InlineTimeEditor({
    domain,
    occupancyId,
    field,
    currentIso,
    doctorName,
    targetCode,
    janela,
    children,
    onSaved,
}: InlineTimeEditorProps) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [valorMs, setValorMs] = useState<number>(() => (currentIso ? new Date(currentIso).getTime() : Date.now()));
    const [reason, setReason] = useState("");
    const [submitting, setSubmitting] = useState(false);

    const label = field === "arrival" ? "Chegada" : "Saída efetiva";
    const display = {
        value: field === "arrival" ? formatHourMinute(currentIso) : (currentIso ? formatHourMinute(currentIso) : "Em aberto"),
        isPending: !currentIso,
    };

    const limites = useMemo(() => {
        const referencia = currentIso ? new Date(currentIso).getTime() : Date.now();
        const inicioJanela = janela?.inicio ? new Date(janela.inicio).getTime() : null;
        const fimJanela = janela?.fim ? new Date(janela.fim).getTime() : null;
        const deduzida = janelaDoTurno(inicioJanela ?? referencia);
        const inicio = inicioJanela ?? deduzida.inicio;
        const fim = fimJanela ?? deduzida.fim;
        return {
            janelaInicioMs: inicio,
            janelaFimMs: fim,
            // Chegada: de 6h antes da janela até o fim dela. Saída: do início da
            // janela até 12h depois do fim (permanência longa).
            minMs: field === "arrival" ? inicio - 6 * HORA_MS : inicio,
            maxMs: field === "arrival" ? Math.min(fim, Date.now() + 60_000) : Math.min(fim + 12 * HORA_MS, Date.now() + 60_000),
        };
    }, [currentIso, janela, field]);

    const handleOpenChange = (next: boolean) => {
        if (next) {
            setValorMs(currentIso ? new Date(currentIso).getTime() : Math.min(Date.now(), limites.maxMs));
            setReason("");
        }
        setOpen(next);
    };

    const submit = async () => {
        const nextIso = new Date(valorMs).toISOString();
        const changed = !currentIso || new Date(currentIso).toISOString() !== nextIso;
        if (!changed) {
            setOpen(false);
            return;
        }
        if (!motivoValido(reason)) {
            toast.error("Escolha um motivo (ou escreva um com 8+ caracteres).");
            return;
        }
        setSubmitting(true);
        try {
            const endpoint = domain === "regulation"
                ? `/api/regulation/occupancies/${occupancyId}`
                : `/api/intervention/occupancies/${occupancyId}`;

            const payload: Record<string, unknown> = { notes: reason.trim() };
            if (field === "arrival") {
                payload.startedAt = nextIso;
                payload.boardStartedAt = nextIso;
            } else {
                payload.actualEndedAt = nextIso;
            }

            const response = await fetchMesa(endpoint, {
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

    const deltaMin = Math.round((valorMs - limites.janelaInicioMs) / 60_000);
    const consequencia = field === "arrival"
        ? (deltaMin > 15
            ? `Atraso de ${deltaMin} min contra a janela (${formatHourMinute(new Date(limites.janelaInicioMs).toISOString())}). Muda refeição e saída.`
            : `Dentro da tolerância: conta como pontual. Muda refeição e saída.`)
        : null;

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
                    className="historico-list-popover historico-list-popover--largo"
                    onClick={(event) => event.stopPropagation()}
                >
                    <header>
                        <strong>Corrigir {label.toLowerCase()}</strong>
                        <span>{doctorName} · {targetCode}</span>
                    </header>
                    <EditorDeHorario
                        valorMs={valorMs}
                        janelaInicioMs={limites.janelaInicioMs}
                        janelaFimMs={limites.janelaFimMs}
                        minMs={limites.minMs}
                        maxMs={Math.max(limites.maxMs, limites.minMs + 60_000)}
                        tipo={field === "arrival" ? "chegada" : "saida"}
                        verbalizadoMs={currentIso ? new Date(currentIso).getTime() : null}
                        onChange={setValorMs}
                        consequencia={consequencia}
                    />
                    <MotivoChips opcoes={MOTIVOS_HORARIO} valor={reason} onChange={setReason} />
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
