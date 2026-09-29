import { calculateGuardedBankHours } from "@/modules/bank-hours/calculator";
import { resolveOperationalShiftWindow } from "@/modules/operational/board-rules";
import type { DepartureOrigin } from "@/modules/operational/departure-origin";
import { triagePendingDeparture, type DepartureTriageInput, type DepartureTriageResult } from "@/modules/operational/departure-triage";

/**
 * Quanto da fila "Saídas a confirmar" precisa de gente.
 *
 * Medido em 30 dias (ago–set/2026, 1097 saídas): o chefe mudou algo em 4,8% e
 * confirmava 87% em rajadas de segundos — a fila pedia leitura que ninguém fazia.
 * Três classes, decididas com a coordenação em 29/09/2026:
 *
 *   - "auto"   (64%, humano mexeu em 3,4%): rotina que o próprio médico avisou
 *     ou que a chegada de outro no mesmo alvo explica. O sistema confirma
 *     sozinho na virada seguinte; o chefe pode desfazer.
 *   - "glance" (32%, 6,9%): rotina fechada pela janela, crédito tardio acima de
 *     1h, saída faltando ≤2h. A sugestão vem pronta e é um toque; parada 24h, o
 *     sistema aplica a sugestão.
 *   - "decide" (4,6%, 45%): dinheiro ou contradição — anomalia, P emendado,
 *     saída antes de 6h ou na faixa de meio, ocorrência sem número, padrão, e o
 *     que o sistema fechou sem origem conhecida. Nunca automático: parada 24h,
 *     escala para os admins.
 *
 * Puro: recebe fatos, devolve classe, sugestão e prazo. Quem age é o ciclo do
 * worker; a tela só mostra.
 */

export type DepartureAutonomy = "auto" | "glance" | "decide";

export interface DepartureSuggestion {
    /** Desfecho gravado junto com a confirmação (só na saída faltando ≤2h). */
    outcome: "full_shift" | null;
    /** O que o toque faz, em poucas palavras. */
    label: string;
    /** O que muda em pagamento/banco, em poucas palavras. */
    effect: string;
}

export interface DepartureAutonomyResult {
    autonomy: DepartureAutonomy;
    triage: DepartureTriageResult;
    /** Pronta para um toque; null quando a decisão é humana. */
    suggestion: DepartureSuggestion | null;
    /**
     * Quando o sistema age sozinho: "auto" confirma, "glance" aplica a
     * sugestão, "decide" escala para os admins.
     */
    dueAt: Date;
}

export interface DepartureAutonomyInput extends DepartureTriageInput {
    origin: DepartureOrigin;
    actualEndedAt: string;
    startedAt: string;
    /** Quando a saída foi registrada (entrou na fila). */
    recordedAt: string;
    /** Janela do banco de horas (07:00/19:00, não 07:15/19:15). */
    bankScheduledStartAt: string | null;
    bankScheduledEndAt: string | null;
}

/** Tempo mínimo de fila antes da confirmação automática da rotina. */
export const AUTO_CONFIRM_MIN_QUEUE_MINUTES = 60;
/** Prazo para o chefe olhar antes de o sistema aplicar a sugestão / escalar. */
export const GLANCE_DEADLINE_HOURS = 24;

const DECIDE_KINDS = new Set<DepartureTriageResult["kind"]>([
    "short_anomaly",
    "extended_stay",
    "early_bank_only",
    "early_half",
    "occurrence_missing",
    "pattern",
]);

function hourMinute(iso: string) {
    const parts = new Intl.DateTimeFormat("pt-BR", {
        timeZone: "America/Sao_Paulo",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    }).formatToParts(new Date(iso));
    const hour = parts.find((part) => part.type === "hour")?.value ?? "00";
    const minute = parts.find((part) => part.type === "minute")?.value ?? "00";
    return `${hour}:${minute}`;
}

function formatSignedMinutes(minutes: number) {
    const sign = minutes >= 0 ? "+" : "−";
    const magnitude = Math.abs(minutes);
    const hours = Math.floor(magnitude / 60);
    const rest = magnitude % 60;
    return `${sign}${hours > 0 ? `${hours}h${String(rest).padStart(2, "0")}` : `${rest} min`}`;
}

function describeBankEffect(input: DepartureAutonomyInput) {
    if (!input.bankScheduledStartAt || !input.bankScheduledEndAt) {
        return "sem efeito em pagamento";
    }
    try {
        const calc = calculateGuardedBankHours({
            scheduledStartAt: input.bankScheduledStartAt,
            scheduledEndAt: input.bankScheduledEndAt,
            actualStartAt: input.startedAt,
            actualEndAt: input.actualEndedAt,
        });
        return calc.balanceMinutes === 0
            ? "sem efeito em pagamento e banco"
            : `banco ${formatSignedMinutes(calc.balanceMinutes)}`;
    } catch {
        return "sem efeito em pagamento";
    }
}

export function resolveDepartureAutonomy(input: DepartureAutonomyInput): DepartureAutonomyResult {
    const triage = triagePendingDeparture(input);
    const queuedAtMs = Math.max(new Date(input.actualEndedAt).getTime(), new Date(input.recordedAt).getTime());
    const deadline = new Date(queuedAtMs + GLANCE_DEADLINE_HOURS * 3_600_000);

    if (DECIDE_KINDS.has(triage.kind) || input.origin === "system") {
        return { autonomy: "decide", triage, suggestion: null, dueAt: deadline };
    }

    const hora = hourMinute(input.actualEndedAt);

    if (triage.kind === "early_full") {
        return {
            autonomy: "glance",
            triage,
            suggestion: {
                outcome: "full_shift",
                label: "Pagar plantão inteiro",
                effect: `saiu ${formatSignedMinutes(triage.classification?.remainingMinutes ?? 0).slice(1)} antes do fim`,
            },
            dueAt: deadline,
        };
    }

    if (triage.kind === "late_credit") {
        return {
            autonomy: "glance",
            triage,
            suggestion: { outcome: null, label: `Creditar saída ${hora}`, effect: describeBankEffect(input) },
            dueAt: deadline,
        };
    }

    // Rotina. Janela vencida pergunta "continuou?" — o chefe contestou 6,7%
    // delas; aviso do médico ou chegada de quem assumiu, 3,4%.
    if (input.origin === "window") {
        return {
            autonomy: "glance",
            triage,
            suggestion: { outcome: null, label: `Saiu no fim da janela, ${hora}`, effect: describeBankEffect(input) },
            dueAt: deadline,
        };
    }

    // Pelo menos 1h na fila e depois a virada seguinte: quem sai 06:58 não é
    // confirmado às 07:00 sem ninguém ter tido chance de ver.
    const earliest = new Date(queuedAtMs + AUTO_CONFIRM_MIN_QUEUE_MINUTES * 60_000);
    return {
        autonomy: "auto",
        triage,
        suggestion: { outcome: null, label: `Confirmar saída ${hora}`, effect: describeBankEffect(input) },
        dueAt: resolveOperationalShiftWindow(earliest).nextBoundaryAt,
    };
}
