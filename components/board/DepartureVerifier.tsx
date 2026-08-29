"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { AnimatePresence, motion } from "framer-motion";
import * as Dialog from "@radix-ui/react-dialog";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { EventTimeline } from "@/components/board/EventTimeline";
import { modalBackdrop, modalPanel, tapFeedback } from "@/lib/board/motion";
import type { PendingDepartureConfirmation } from "@/services/board.service";
import { calculateGuardedBankHours } from "@/modules/bank-hours/calculator";
import { resolveDayOffsetLabel } from "@/lib/board/day-offset";
import type { ContestedDepartureContinuation } from "@/modules/operational/contested-departure";
import {
    isValidOverrideNote,
    OVERRIDE_NOTE_MIN_LENGTH,
    triagePendingDeparture,
} from "@/modules/operational/departure-triage";

export interface DepartureVerifierProps {
    target: PendingDepartureConfirmation | null;
    onClose: () => void;
}

function formatLocalHourMinute(ms: number) {
    const date = new Date(ms);
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function toTimeInputValue(iso: string) {
    const date = new Date(iso);
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Recombina "HH:MM" digitado com a data local do horário original. */
function combineWithLocalDate(baseIso: string, timeValue: string): Date | null {
    const match = /^(\d{2}):(\d{2})$/.exec(timeValue);
    if (!match) return null;
    const base = new Date(baseIso);
    const combined = new Date(base);
    combined.setHours(Number(match[1]), Number(match[2]), 0, 0);
    return combined;
}

function formatSignedMinutes(minutes: number) {
    const sign = minutes >= 0 ? "+" : "−";
    const magnitude = Math.abs(minutes);
    const hours = Math.floor(magnitude / 60);
    const rest = magnitude % 60;
    const body = hours > 0 ? `${hours}h${String(rest).padStart(2, "0")}` : `${rest}min`;
    return `${sign}${body}`;
}

function formatMinutesShort(minutes: number) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours === 0) return `${rest}min`;
    return rest === 0 ? `${hours}h` : `${hours}h${String(rest).padStart(2, "0")}`;
}

type DecisionAction =
    | { kind: "confirm" }
    | { kind: "outcome"; outcome: "bank_only" | "half_shift" | "full_shift"; requiresNote: boolean }
    | { kind: "reject_credit" };

interface DecisionButton {
    label: string;
    hint: string;
    className: "confirm" | "edit" | "reject";
    action: DecisionAction;
}

/**
 * O verificador de saídas.
 *
 * A primeira coisa da tela são os dois horários que decidem tudo — CHEGOU e
 * SAIU — porque é isso que o chefe precisa julgar; a régua vem depois, em uma
 * linha. Antes o modal abria com um parágrafo de triagem e enterrava a chegada
 * numa linha cinza de 0,82rem, e um chefe não conseguia responder "que horas
 * ele chegou?" sem reler tudo.
 *
 * Botões, por caso:
 *
 *   - faixa MEIO (6h–10h de janela): pagar inteiro ou pagar MEIO;
 *   - saída <6h: lançar só no banco, ou pagar MEIO/INTEIRO com justificativa
 *     escrita (mínimo de 8 caracteres — espaços contam);
 *   - permanência de 6h+ além da janela: emendou turno (P) — confirma e a folha
 *     assina o plantão; NUNCA se oferece o crédito de banco aqui;
 *   - saída tardia: confirmar o crédito ou recusar (com justificativa);
 *   - rotina: confirmar e pronto.
 *
 * "Ajustar horários" existe em TODOS os casos: quando o registro está errado, a
 * hora certa tem de prevalecer antes de qualquer decisão de pagamento — era
 * justamente nas faixas de pagamento que o botão faltava.
 */
export function DepartureVerifier({ target, onClose }: DepartureVerifierProps) {
    const router = useRouter();
    const [, startTransition] = useTransition();
    const open = target !== null;

    const verbalizedMs = useMemo(
        () => (target ? new Date(target.actualEndedAt).getTime() : 0),
        [target],
    );
    const scheduledEndMs = useMemo(
        () => (target?.scheduledEndAt ? new Date(target.scheduledEndAt).getTime() : null),
        [target],
    );

    const [submitting, setSubmitting] = useState(false);
    const [view, setView] = useState<"decide" | "adjust" | "contest">("decide");
    // "NÃO SAIU": onde o médico ficou depois da saída que o chefe está desmentindo.
    const [contestContinuation, setContestContinuation] = useState<ContestedDepartureContinuation>("same_target");
    const [contestLabel, setContestLabel] = useState("");
    // Ação escolhida que exige justificativa — o textarea aparece e o envio
    // fica travado até a nota ter 8+ caracteres.
    const [pendingAction, setPendingAction] = useState<DecisionAction | null>(null);
    const [noteText, setNoteText] = useState("");
    const [adjustStart, setAdjustStart] = useState("");
    const [adjustEnd, setAdjustEnd] = useState("");

    useEffect(() => {
        if (target) {
            setView("decide");
            setPendingAction(null);
            setNoteText("");
            setContestContinuation("same_target");
            setContestLabel("");
            setAdjustStart(toTimeInputValue(target.startedAt));
            setAdjustEnd(toTimeInputValue(target.actualEndedAt));
        }
    }, [target]);

    const triage = useMemo(
        () => (target
            ? triagePendingDeparture({
                actualEndedAt: target.actualEndedAt,
                scheduledStartAt: target.scheduledStartAt,
                scheduledEndAt: target.scheduledEndAt,
                startedAt: target.startedAt,
                roleLabel: target.roleLabel,
                delayMinutes: target.delayMinutes,
                reasonCode: target.reasonCode,
                occurrenceNumberMissing: target.occurrenceNumberMissing,
                reasonOccurrenceCount30d: target.reasonOccurrenceCount30d,
            })
            : null),
        [target],
    );

    // Saldo padrão de banco (atraso vs excedente) para a saída verbalizada.
    // ponytail: usa a janela da própria ocupação; cadeias P longas podem divergir
    // do cálculo por grupo de continuidade do servidor — é um preview, o número
    // final é sempre o do banco de horas gravado.
    // Janela do BANCO, não a do quadro: na regulação o previsto termina 07:15/19:15
    // (a rendição), mas o banco conta desde 07:00/19:00. Usar a do quadro mostrava
    // 15 min de excedente a menos do que o sistema credita de fato.
    const bankScheduledStartAt = target?.bankScheduledStartAt ?? target?.scheduledStartAt ?? null;
    const bankScheduledEndAt = target?.bankScheduledEndAt ?? target?.scheduledEndAt ?? null;

    // Atraso da CHEGADA contra a janela do quadro — o número que o chefe procura
    // primeiro e que o modal só mostrava indiretamente, dentro da frase de triagem.
    // "chegou 07:00 → saiu 07:00" em dias diferentes não se lê sem esta marca.
    const dayOffset = useMemo(
        () => (target ? resolveDayOffsetLabel(target.startedAt, target.actualEndedAt) : null),
        [target],
    );

    const arrivalDeltaMinutes = useMemo(() => {
        if (!target?.scheduledStartAt) return null;
        const scheduled = new Date(target.scheduledStartAt).getTime();
        const started = new Date(target.startedAt).getTime();
        if (Number.isNaN(scheduled) || Number.isNaN(started)) return null;
        return Math.round((started - scheduled) / 60000);
    }, [target]);

    const standardBalance = useMemo(() => {
        if (!target || !bankScheduledStartAt || !bankScheduledEndAt) return null;
        try {
            return calculateGuardedBankHours({
                scheduledStartAt: bankScheduledStartAt,
                scheduledEndAt: bankScheduledEndAt,
                actualStartAt: target.startedAt,
                actualEndAt: target.actualEndedAt,
            });
        } catch {
            return null;
        }
    }, [target, bankScheduledStartAt, bankScheduledEndAt]);

    const adjustPreview = useMemo(() => {
        if (view !== "adjust" || !target || !bankScheduledStartAt || !bankScheduledEndAt) return null;
        const start = combineWithLocalDate(target.startedAt, adjustStart);
        let end = combineWithLocalDate(target.actualEndedAt, adjustEnd);
        if (!start || !end) return null;
        // Saída digitada "antes" da chegada no mesmo dia = virada de meia-noite.
        if (end.getTime() < start.getTime()) {
            end = new Date(end.getTime() + 24 * 3600000);
        }
        try {
            return {
                start,
                end,
                calc: calculateGuardedBankHours({
                    scheduledStartAt: bankScheduledStartAt,
                    scheduledEndAt: bankScheduledEndAt,
                    actualStartAt: start,
                    actualEndAt: end,
                }),
            };
        } catch {
            return null;
        }
    }, [view, target, adjustStart, adjustEnd, bankScheduledStartAt, bankScheduledEndAt]);

    const submit = async (body: {
        actualEndedAt?: string;
        startedAt?: string;
        note?: string | null;
        outcome?: "bank_only" | "half_shift" | "full_shift";
        contestDeparture?: { continuation: ContestedDepartureContinuation; continuedAtLabel?: string | null };
    }, successLabel: string) => {
        if (!target) return;
        setSubmitting(true);
        try {
            const response = await fetch(`/api/${target.domain}/occupancies/${target.occupancyId}/confirm-departure`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const payload = await response.json().catch(() => ({})) as
                { error?: string; outOfBoardReason?: string | null };
            if (!response.ok) {
                throw new Error(payload.error || "Falha ao confirmar saída.");
            }
            toast.success(`${target.displayName ?? target.doctorName}: ${successLabel}`);
            // A contestação nunca derruba quem está no quadro — quando sobra
            // conflito, o chefe precisa VER de quem é a chegada a corrigir.
            if (payload.outOfBoardReason) {
                toast.warning(payload.outOfBoardReason, { duration: 12000 });
            }
            onClose();
            startTransition(() => {
                router.refresh();
            });
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Falha ao confirmar saída.");
        } finally {
            setSubmitting(false);
        }
    };

    const runAction = async (action: DecisionAction, note: string | null) => {
        if (!target) return;
        if (action.kind === "confirm") {
            await submit({ note }, `saída confirmada às ${formatLocalHourMinute(verbalizedMs)}.`);
            return;
        }
        if (action.kind === "reject_credit") {
            if (scheduledEndMs === null) {
                toast.error("Esta ocupação não tem fim de janela definido para registrar a recusa.");
                return;
            }
            await submit({
                actualEndedAt: new Date(scheduledEndMs).toISOString(),
                note: note ?? "Crédito de banco recusado pelo chefe — paga até o fim da janela.",
            }, "crédito recusado — saída registrada no fim da janela.");
            return;
        }
        const label = action.outcome === "bank_only"
            ? "lançado só no banco de horas (plantão não assinado)."
            : action.outcome === "half_shift"
                ? "MEIO plantão assinado — excedente de 6h vira banco."
                : "plantão INTEIRO assinado.";
        await submit({ outcome: action.outcome, note }, label);
    };

    const handleDecision = (button: DecisionButton) => {
        const requiresNote = button.action.kind === "reject_credit"
            || (button.action.kind === "outcome" && button.action.requiresNote);
        if (requiresNote) {
            setPendingAction(button.action);
            setNoteText("");
            return;
        }
        void runAction(button.action, null);
    };

    const buttons = useMemo<DecisionButton[]>(() => {
        if (!target || !triage) return [];
        const confirmLabel = `Confirmar saída ${formatLocalHourMinute(verbalizedMs)}`;

        if (triage.kind === "early_half") {
            return [
                {
                    label: "Pagar plantão inteiro",
                    hint: "Atraso e saída antecipada contam no banco de horas como sempre.",
                    className: "confirm",
                    action: { kind: "outcome", outcome: "full_shift", requiresNote: false },
                },
                {
                    label: "Pagar MEIO plantão",
                    hint: `Assina MEIO (0,5x). O que passar de 6h trabalhadas vira crédito`
                        + `${triage.classification && triage.classification.bankCreditMinutes > 0
                            ? ` (${formatMinutesShort(triage.classification.bankCreditMinutes)})`
                            : ""} — sem punição pelo atraso.`,
                    className: "edit",
                    action: { kind: "outcome", outcome: "half_shift", requiresNote: false },
                },
            ];
        }

        if (triage.kind === "short_anomaly") {
            // Anomalia: nada de botão de pagamento. Confirmar aqui seria validar
            // um registro provavelmente errado — o caminho é ajustar os horários
            // (ou tratar no /corrigir), e só confirmar se a saída for real mesmo.
            return [
                {
                    label: confirmLabel,
                    hint: "Só confirme se essa saída de poucos minutos foi real. Se foi conflito de posto ou erro, use o ajuste de horários ou o /corrigir.",
                    className: "reject",
                    action: { kind: "confirm" },
                },
            ];
        }

        if (triage.kind === "early_full") {
            const worked = triage.classification?.workedMinutes ?? 0;
            return [
                {
                    label: "Pagar plantão inteiro",
                    hint: "Assina inteiro; atraso e saída antecipada contam no banco de horas como sempre.",
                    className: "confirm",
                    action: { kind: "outcome", outcome: "full_shift", requiresNote: false },
                },
                {
                    label: "Pagar MEIO plantão",
                    hint: `Assina MEIO (0,5x); o que passar de 6h trabalhadas vira crédito`
                        + `${worked > 360 ? ` (${formatMinutesShort(worked - 360)})` : ""}.`
                        + ` Paga menos que a régua — exige justificativa de ${OVERRIDE_NOTE_MIN_LENGTH}+ caracteres.`,
                    className: "edit",
                    action: { kind: "outcome", outcome: "half_shift", requiresNote: true },
                },
                {
                    label: "Lançar só para o banco de horas",
                    hint: `Não assina; as horas trabalhadas viram crédito${worked > 0 ? ` (${formatMinutesShort(worked)})` : ""}.`
                        + ` Exige justificativa de ${OVERRIDE_NOTE_MIN_LENGTH}+ caracteres.`,
                    className: "reject",
                    action: { kind: "outcome", outcome: "bank_only", requiresNote: true },
                },
            ];
        }

        if (triage.kind === "early_bank_only") {
            const credit = triage.classification?.bankCreditMinutes ?? 0;
            return [
                {
                    label: `Lançar só para o banco de horas (${formatMinutesShort(credit)})`,
                    hint: "Plantão não é assinado; as horas trabalhadas viram crédito.",
                    className: "confirm",
                    action: { kind: "outcome", outcome: "bank_only", requiresNote: false },
                },
                {
                    label: "Pagar MEIO plantão",
                    hint: `Acima da régua (fez menos de 6h) — exige justificativa de ${OVERRIDE_NOTE_MIN_LENGTH}+ caracteres.`,
                    className: "edit",
                    action: { kind: "outcome", outcome: "half_shift", requiresNote: true },
                },
                {
                    label: "Pagar plantão INTEIRO",
                    hint: `Acima da régua — exige justificativa de ${OVERRIDE_NOTE_MIN_LENGTH}+ caracteres.`,
                    className: "reject",
                    action: { kind: "outcome", outcome: "full_shift", requiresNote: true },
                },
            ];
        }

        // Emendou o turno: a folha assina o plantão pelo slot ocupado e o banco
        // fica com o resto (< 6h). Oferecer "confirmar N h de banco" aqui era
        // prometer um número que applyAnomalyGuard já cortava na gravação.
        if (triage.kind === "extended_stay") {
            return [
                {
                    label: confirmLabel,
                    hint: standardBalance
                        ? standardBalance.explanation
                        : "Confirma a saída verbalizada como está.",
                    className: "confirm",
                    action: { kind: "confirm" },
                },
            ];
        }

        if (triage.kind === "late_credit") {
            const balance = standardBalance?.balanceMinutes ?? null;
            return [
                {
                    label: balance !== null && balance > 0
                        ? `Confirmar os ${formatMinutesShort(balance)} de banco de horas`
                        : confirmLabel,
                    hint: standardBalance
                        ? standardBalance.explanation
                        : "Confirma a saída verbalizada como está.",
                    className: "confirm",
                    action: { kind: "confirm" },
                },
                {
                    label: "Recusar crédito para o banco de horas",
                    hint: `Paga até o fim da janela, sem crédito — exige justificativa de ${OVERRIDE_NOTE_MIN_LENGTH}+ caracteres.`,
                    className: "reject",
                    action: { kind: "reject_credit" },
                },
            ];
        }

        return [
            {
                label: confirmLabel,
                hint: triage.headline,
                className: "confirm",
                action: { kind: "confirm" },
            },
        ];
    }, [target, triage, verbalizedMs, standardBalance]);

    const canAdjust = Boolean(target?.scheduledStartAt && target?.scheduledEndAt);
    const noteValid = isValidOverrideNote(noteText);

    return (
        <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
            <AnimatePresence>
                {open && target && triage && (
                    <Dialog.Portal forceMount>
                        <Dialog.Overlay asChild>
                            <motion.div
                                className="departure-verifier-backdrop"
                                variants={modalBackdrop}
                                initial="initial"
                                animate="animate"
                                exit="exit"
                            />
                        </Dialog.Overlay>
                        <Dialog.Content asChild>
                            <div className="departure-verifier-shell">
                                <motion.div
                                    layoutId={`pending-${target.occupancyId}`}
                                    className="departure-verifier-panel"
                                    variants={modalPanel}
                                    initial="initial"
                                    animate="animate"
                                    exit="exit"
                                >
                                    <header className="departure-verifier-header">
                                        <div className="departure-verifier-header__title">
                                            <Dialog.Title asChild>
                                                <strong>{target.displayName ?? target.doctorName}</strong>
                                            </Dialog.Title>
                                            <Dialog.Description asChild>
                                                {/* A hora da saída não se repete aqui: ela é o segundo
                                                    número grande do bloco de fatos, logo abaixo. */}
                                                <span>
                                                    {target.targetCode} · {target.shiftLabel ?? "—"}{target.roleLabel ? ` · ${target.roleLabel}` : ""}
                                                </span>
                                            </Dialog.Description>
                                        </div>
                                        <Dialog.Close asChild>
                                            <button type="button" className="departure-verifier-close" aria-label="Fechar verificador">Fechar (esc)</button>
                                        </Dialog.Close>
                                    </header>

                                    <div className="departure-verifier-body">
                                        <div className="departure-verifier-body__col">
                                            {/* Os dois horários que decidem tudo, antes de qualquer régua. */}
                                            <div className="departure-verifier-facts">
                                                <div className="departure-verifier-fact">
                                                    <span className="departure-verifier-fact__label">Chegou</span>
                                                    <strong className="departure-verifier-fact__value">
                                                        {formatLocalHourMinute(new Date(target.startedAt).getTime())}
                                                    </strong>
                                                    {arrivalDeltaMinutes !== null && (
                                                        <span className="departure-verifier-fact__delta" data-off={arrivalDeltaMinutes > 15}>
                                                            {arrivalDeltaMinutes === 0 ? "no horário" : `${formatSignedMinutes(arrivalDeltaMinutes)} vs previsto`}
                                                        </span>
                                                    )}
                                                    {target.arrivalCorrectedInTelegram && (
                                                        <span className="departure-verifier-fact__badge" title="Esta chegada já foi corrigida no Telegram (/corrigir). É a hora que vale.">
                                                            corrigida no /corrigir
                                                        </span>
                                                    )}
                                                </div>
                                                <span className="departure-verifier-facts__arrow" aria-hidden="true">→</span>
                                                <div className="departure-verifier-fact">
                                                    <span className="departure-verifier-fact__label">Saiu</span>
                                                    <strong className="departure-verifier-fact__value">
                                                        {formatLocalHourMinute(verbalizedMs)}
                                                        {dayOffset && <i className="departure-verifier-fact__day">{dayOffset}</i>}
                                                    </strong>
                                                    {typeof target.delayMinutes === "number" && (
                                                        <span className="departure-verifier-fact__delta" data-off={Math.abs(target.delayMinutes) > 15}>
                                                            {target.delayMinutes === 0 ? "no horário" : `${formatSignedMinutes(target.delayMinutes)} vs previsto`}
                                                        </span>
                                                    )}
                                                </div>
                                                {target.scheduledStartAt && target.scheduledEndAt && (
                                                    <span className="departure-verifier-facts__window">
                                                        previsto {formatLocalHourMinute(new Date(target.scheduledStartAt).getTime())}
                                                        {" — "}{formatLocalHourMinute(new Date(target.scheduledEndAt).getTime())}
                                                    </span>
                                                )}
                                            </div>
                                            <p className="departure-verifier-headline">{triage.headline}</p>

                                            {view === "decide" && (
                                                <div className="departure-verifier-decisions">
                                                    {buttons.map((button) => (
                                                        <div key={button.label} className="departure-verifier-decision">
                                                            <motion.button
                                                                type="button"
                                                                className={`departure-verifier-action ${button.className}`}
                                                                onClick={() => handleDecision(button)}
                                                                whileTap={tapFeedback}
                                                                disabled={submitting || pendingAction !== null}
                                                            >
                                                                {button.label}
                                                            </motion.button>
                                                            <span className="departure-verifier-decision__hint">{button.hint}</span>
                                                        </div>
                                                    ))}
                                                    <div className="departure-verifier-decision">
                                                        <motion.button
                                                            type="button"
                                                            className="departure-verifier-action reject"
                                                            onClick={() => setView("contest")}
                                                            whileTap={tapFeedback}
                                                            disabled={submitting || pendingAction !== null}
                                                        >
                                                            {`${target.displayName ?? target.doctorName} NÃO SAIU`}
                                                        </motion.button>
                                                        <span className="departure-verifier-decision__hint">
                                                            A saída registrada não aconteceu (rendição por engano, erro de registro).
                                                            Reabre este mesmo plantão — nenhuma ocupação nova é criada — e cancela
                                                            qualquer desfecho de pagamento já decidido sobre ela.
                                                        </span>
                                                    </div>
                                                    {canAdjust && (
                                                        <div className="departure-verifier-decision">
                                                            <motion.button
                                                                type="button"
                                                                className="departure-verifier-action edit"
                                                                onClick={() => setView("adjust")}
                                                                whileTap={tapFeedback}
                                                                disabled={submitting || pendingAction !== null}
                                                            >
                                                                Corrigir os horários
                                                            </motion.button>
                                                            <span className="departure-verifier-decision__hint">
                                                                A hora registrada está errada. Corrija chegada e/ou saída antes de
                                                                decidir — a régua e o saldo são recalculados na tela.
                                                            </span>
                                                        </div>
                                                    )}
                                                </div>
                                            )}

                                            {view === "contest" && (
                                                <div className="departure-verifier-note">
                                                    <p style={{ fontSize: "0.85rem", fontWeight: 600 }}>
                                                        Onde {target.displayName ?? target.doctorName} ficou depois das {formatLocalHourMinute(verbalizedMs)}?
                                                    </p>
                                                    <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: "0.85rem" }}>
                                                        {([
                                                            ["same_target", `Continuou no ${target.targetCode}`],
                                                            ["other_target", "Foi para outro posto/base"],
                                                            ["unknown", "Não sei dizer"],
                                                        ] as [ContestedDepartureContinuation, string][]).map(([value, label]) => (
                                                            <label key={value} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                                                                <input
                                                                    type="radio"
                                                                    name="departure-verifier-contest"
                                                                    value={value}
                                                                    checked={contestContinuation === value}
                                                                    onChange={() => setContestContinuation(value)}
                                                                />
                                                                {label}
                                                            </label>
                                                        ))}
                                                    </div>
                                                    {contestContinuation === "other_target" && (
                                                        <input
                                                            type="text"
                                                            value={contestLabel}
                                                            onChange={(event) => setContestLabel(event.target.value)}
                                                            placeholder="Qual posto/base (ex.: CB02, 2032)"
                                                            style={{ width: "100%", fontSize: "0.85rem", padding: 8 }}
                                                        />
                                                    )}
                                                    {contestContinuation === "unknown" && (
                                                        <div
                                                            role="alert"
                                                            style={{
                                                                border: "3px solid #b91c1c",
                                                                background: "#b91c1c",
                                                                color: "#fff",
                                                                borderRadius: 10,
                                                                padding: "18px 16px",
                                                                textAlign: "center",
                                                                display: "flex",
                                                                flexDirection: "column",
                                                                gap: 8,
                                                            }}
                                                        >
                                                            <strong style={{ fontSize: "1.6rem", letterSpacing: "0.04em", lineHeight: 1.1 }}>
                                                                LIGUE PARA {(target.displayName ?? target.doctorName).toUpperCase()}
                                                            </strong>
                                                            <span style={{ fontSize: "0.9rem", fontWeight: 600 }}>
                                                                Chefe logado não pode não saber onde está o plantonista dele.
                                                            </span>
                                                            <span style={{ fontSize: "0.82rem", opacity: 0.9 }}>
                                                                Descubra e escolha uma das duas primeiras opções. Este aviso não sai daqui.
                                                            </span>
                                                        </div>
                                                    )}
                                                    <textarea
                                                        value={noteText}
                                                        onChange={(event) => setNoteText(event.target.value)}
                                                        rows={2}
                                                        placeholder="O que aconteceu (opcional) — vai para a auditoria."
                                                        style={{ width: "100%", resize: "vertical", fontSize: "0.85rem", padding: 8 }}
                                                    />
                                                    <span className="departure-verifier-decision__hint">
                                                        O quadro não muda de dono aqui: se outro médico assumiu este alvo, ele
                                                        continua onde está e a tela diz de quem é a chegada a corrigir. Mudança de
                                                        posto/base se faz pelo remanejamento, que move este mesmo plantão.
                                                    </span>
                                                    <div style={{ display: "flex", gap: 8 }}>
                                                        <motion.button
                                                            type="button"
                                                            className="departure-verifier-action reject"
                                                            whileTap={tapFeedback}
                                                            disabled={submitting
                                                                || contestContinuation === "unknown"
                                                                || (contestContinuation === "other_target" && contestLabel.trim().length === 0)}
                                                            onClick={() => {
                                                                void submit({
                                                                    contestDeparture: {
                                                                        continuation: contestContinuation,
                                                                        continuedAtLabel: contestContinuation === "other_target"
                                                                            ? contestLabel.trim()
                                                                            : null,
                                                                    },
                                                                    note: noteText.trim().length > 0 ? noteText.trim() : null,
                                                                }, "saída desmentida — plantão reaberto, sem ocupação nova.");
                                                            }}
                                                        >
                                                            Registrar que não saiu
                                                        </motion.button>
                                                        <motion.button
                                                            type="button"
                                                            className="departure-verifier-action edit"
                                                            whileTap={tapFeedback}
                                                            disabled={submitting}
                                                            onClick={() => { setView("decide"); setNoteText(""); }}
                                                        >
                                                            Voltar
                                                        </motion.button>
                                                    </div>
                                                </div>
                                            )}

                                            {view === "decide" && pendingAction !== null && (
                                                <div className="departure-verifier-note">
                                                    <label htmlFor="departure-verifier-note-input" style={{ fontSize: "0.82rem", fontWeight: 600 }}>
                                                        Justificativa (mínimo {OVERRIDE_NOTE_MIN_LENGTH} caracteres)
                                                    </label>
                                                    <textarea
                                                        id="departure-verifier-note-input"
                                                        value={noteText}
                                                        onChange={(event) => setNoteText(event.target.value)}
                                                        rows={3}
                                                        autoFocus
                                                        placeholder="Explique a decisão — vai para a folha do médico e para a auditoria."
                                                        style={{ width: "100%", resize: "vertical", fontSize: "0.85rem", padding: 8 }}
                                                    />
                                                    <div style={{ display: "flex", gap: 8 }}>
                                                        <motion.button
                                                            type="button"
                                                            className="departure-verifier-action confirm"
                                                            onClick={() => { void runAction(pendingAction, noteText.trim()); }}
                                                            whileTap={tapFeedback}
                                                            disabled={submitting || !noteValid}
                                                        >
                                                            Confirmar decisão
                                                        </motion.button>
                                                        <motion.button
                                                            type="button"
                                                            className="departure-verifier-action edit"
                                                            onClick={() => { setPendingAction(null); setNoteText(""); }}
                                                            whileTap={tapFeedback}
                                                            disabled={submitting}
                                                        >
                                                            Voltar
                                                        </motion.button>
                                                    </div>
                                                </div>
                                            )}

                                            {view === "adjust" && (
                                                <div className="departure-verifier-adjust">
                                                    <div style={{ display: "flex", gap: 16 }}>
                                                        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.82rem", fontWeight: 600 }}>
                                                            Chegou às
                                                            <input
                                                                type="time"
                                                                value={adjustStart}
                                                                onChange={(event) => setAdjustStart(event.target.value)}
                                                                style={{ fontSize: "1.05rem", padding: "6px 8px" }}
                                                            />
                                                        </label>
                                                        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.82rem", fontWeight: 600 }}>
                                                            Saiu às
                                                            <input
                                                                type="time"
                                                                value={adjustEnd}
                                                                onChange={(event) => setAdjustEnd(event.target.value)}
                                                                style={{ fontSize: "1.05rem", padding: "6px 8px" }}
                                                            />
                                                        </label>
                                                    </div>
                                                    <div className="departure-verifier-adjust__balance">
                                                        {adjustPreview ? (
                                                            <>
                                                                <strong style={{ fontSize: "1.6rem" }}>
                                                                    {formatSignedMinutes(adjustPreview.calc.balanceMinutes)}
                                                                </strong>
                                                                <span style={{ fontSize: "0.8rem", color: "var(--muted-strong)" }}>
                                                                    {adjustPreview.calc.explanation}
                                                                </span>
                                                            </>
                                                        ) : (
                                                            <span style={{ fontSize: "0.85rem" }}>Horários inválidos.</span>
                                                        )}
                                                    </div>
                                                    <div style={{ display: "flex", gap: 8 }}>
                                                        <motion.button
                                                            type="button"
                                                            className="departure-verifier-action confirm"
                                                            onClick={() => {
                                                                if (!adjustPreview) return;
                                                                void submit({
                                                                    startedAt: adjustPreview.start.toISOString(),
                                                                    actualEndedAt: adjustPreview.end.toISOString(),
                                                                    note: "Horários ajustados pelo chefe na confirmação da saída.",
                                                                }, `horários ajustados (${formatLocalHourMinute(adjustPreview.start.getTime())}–${formatLocalHourMinute(adjustPreview.end.getTime())}), saldo ${formatSignedMinutes(adjustPreview.calc.balanceMinutes)}.`);
                                                            }}
                                                            whileTap={tapFeedback}
                                                            disabled={submitting || !adjustPreview}
                                                        >
                                                            Confirmar ajuste
                                                        </motion.button>
                                                        <motion.button
                                                            type="button"
                                                            className="departure-verifier-action edit"
                                                            onClick={() => setView("decide")}
                                                            whileTap={tapFeedback}
                                                            disabled={submitting}
                                                        >
                                                            Voltar
                                                        </motion.button>
                                                    </div>
                                                </div>
                                            )}
                                        </div>

                                        <div className="departure-verifier-body__col">
                                            <span className="departure-verifier-body__label">Eventos correlacionados</span>
                                            <EventTimeline pending={target} />
                                        </div>
                                    </div>
                                </motion.div>
                            </div>
                        </Dialog.Content>
                    </Dialog.Portal>
                )}
            </AnimatePresence>
        </Dialog.Root>
    );
}
