"use client";

/**
 * Bloco de saldo contratual do fechamento (docs/saldo-contrato/SPEC.md §7.1).
 *
 * Recalcula AO VIVO com o mesmo módulo puro do servidor
 * (lib/contracts/balance-metrics.ts). Nada de round-trip por tecla, e nada de
 * uma segunda implementação da conta no front — é assim que os dois números
 * divergem e ninguém descobre.
 *
 * Estouro é AVISO, nunca bloqueio: o médico pode pegar o plantão extra. O que o
 * sistema faz é mostrar o custo da decisão na hora em que ela é tomada, e exigir
 * ciência explícita antes de assinar.
 */
import { useEffect, useMemo, useState } from "react";
import {
    computeCycleMetrics,
    type CycleMetrics,
    type CycleMetricsInput,
} from "@/lib/contracts/balance-metrics";
import type { ContractBalanceSummary } from "@/modules/reporting/payable-shifts";

const RISK_LABEL: Record<CycleMetrics["riskLevel"], { text: string; icon: string }> = {
    // Cor nunca sozinha: sempre cor + ícone + texto (SPEC §7.2).
    safe: { text: "no ritmo", icon: "●" },
    watch: { text: "atenção", icon: "◐" },
    warning: { text: "acaba antes do fim", icon: "▲" },
    critical: { text: "acaba muito antes do fim", icon: "▲▲" },
    depleted: { text: "saldo esgotado", icon: "■" },
};

function formatBrl(cents: number | null): string {
    if (cents === null) return "—";
    return (cents / 100).toLocaleString("pt-BR", {
        style: "currency",
        currency: "BRL",
        minimumFractionDigits: 2,
    });
}

function formatDate(iso: string | null): string {
    if (!iso) return "—";
    return new Date(iso).toLocaleDateString("pt-BR", { timeZone: "UTC" });
}

function toInput(summary: ContractBalanceSummary, asOf: Date): CycleMetricsInput {
    return {
        ...summary.metricsInput,
        observedSince: new Date(summary.metricsInput.observedSince),
        cycleStart: new Date(summary.metricsInput.cycleStart),
        cycleEnd: new Date(summary.metricsInput.cycleEnd),
        asOf,
    };
}

export interface ContractBalanceCardProps {
    contracts: ContractBalanceSummary[];
    /** Consumo do fechamento aberto, ainda não confirmado. */
    draft: { amountCents: number; weekdayShifts: number; weekendShifts: number };
    canManage: boolean;
    monthLabel: string;
    /** Já assinado: o consumo do mês já está no razão, não é mais projeção. */
    alreadyAttested: boolean;
    /** Avisa o pai quando falta marcar a ciência do estouro. */
    onOverrunBlockChange?: (blocked: boolean) => void;
    onOpeningBalanceSaved?: () => void;
    /**
     * Painel do médico: mesma informação, nada clicável. Some o campo de saldo
     * de abertura, o checkbox de ciência e o aviso de estouro — que são atos do
     * admin. O médico vê o número e a projeção, e é só o que ele precisa ver.
     */
    readOnly?: boolean;
}

export function ContractBalanceCard({
    contracts,
    draft,
    canManage,
    monthLabel,
    alreadyAttested,
    onOverrunBlockChange,
    onOpeningBalanceSaved,
    readOnly = false,
}: ContractBalanceCardProps) {
    const [selectedId, setSelectedId] = useState(contracts[0]?.contractId ?? "");
    const [overrunAcknowledged, setOverrunAcknowledged] = useState(false);
    const [openingDraft, setOpeningDraft] = useState("");
    const [openingBusy, setOpeningBusy] = useState(false);
    const [openingError, setOpeningError] = useState<string | null>(null);

    const selected = contracts.find((item) => item.contractId === selectedId) ?? contracts[0];

    const { before, after } = useMemo(() => {
        if (!selected) return { before: null, after: null };
        const asOf = new Date();
        const input = toInput(selected, asOf);
        const beforeMetrics = computeCycleMetrics(input);
        // Já atestado, o consumo do mês está no razão: somar de novo contaria
        // duas vezes. Aí "depois" é o próprio estado atual.
        if (alreadyAttested) return { before: beforeMetrics, after: beforeMetrics };
        return {
            before: beforeMetrics,
            after: computeCycleMetrics({
                ...input,
                balanceCents: input.balanceCents - draft.amountCents,
                observedConsumptionCents: input.observedConsumptionCents + draft.amountCents,
                weekdayShifts: input.weekdayShifts + draft.weekdayShifts,
                weekendShifts: input.weekendShifts + draft.weekendShifts,
            }),
        };
    }, [selected, draft, alreadyAttested]);

    // Contrato ainda sem saldo informado não estoura coisa nenhuma: o saldo é
    // zero porque ninguém digitou, não porque acabou. Sem esta guarda o botão de
    // atestar travaria e o checkbox de ciência nem aparece nesse estado — o
    // admin ficaria sem saída.
    const overruns = after !== null
        && after.balanceCents < 0
        && !alreadyAttested
        && !readOnly
        && !(selected?.awaitingOpeningBalance ?? false);
    const blocked = overruns && !overrunAcknowledged;
    // Avisar o pai é efeito, não render: chamar setState de outro componente
    // durante o render derruba o React.
    useEffect(() => {
        onOverrunBlockChange?.(blocked);
    }, [blocked, onOverrunBlockChange]);

    if (!selected || !before || !after) return null;

    async function saveOpeningBalance() {
        setOpeningBusy(true);
        setOpeningError(null);
        try {
            const response = await fetch(`/api/admin/contracts/${selected.contractId}/opening`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ balanceBrl: Number(openingDraft.replace(",", ".")) }),
            });
            const body = await response.json().catch(() => null) as { error?: string } | null;
            if (!response.ok) throw new Error(body?.error ?? "Não foi possível gravar o saldo.");
            onOpeningBalanceSaved?.();
        } catch (error) {
            setOpeningError(error instanceof Error ? error.message : "Falha ao gravar o saldo.");
        } finally {
            setOpeningBusy(false);
        }
    }

    if (selected.awaitingOpeningBalance) {
        return (
            <article className="contract-balance-card awaiting">
                <header>
                    <span>Saldo de contrato</span>
                    <small>contrato {selected.contractNumber}</small>
                </header>
                <p className="contract-balance-awaiting-note">
                    {readOnly
                        ? "O saldo deste contrato ainda não foi informado pela coordenação. Assim que for, o acompanhamento aparece aqui."
                        : "Este contrato ainda não tem saldo informado. A planilha de origem não trouxe um número confiável para ele — informe o saldo atual para o acompanhamento começar."}
                </p>
                {canManage && !readOnly ? (
                    <div className="contract-balance-opening">
                        <input
                            type="number"
                            step="0.01"
                            value={openingDraft}
                            onChange={(event) => setOpeningDraft(event.target.value)}
                            placeholder="ex.: 165732.00"
                            disabled={openingBusy}
                        />
                        <button
                            type="button"
                            className="payment-button"
                            onClick={() => void saveOpeningBalance()}
                            disabled={openingBusy || openingDraft.trim() === ""}
                        >
                            {openingBusy ? "Salvando..." : "Definir saldo"}
                        </button>
                    </div>
                ) : null}
                {openingError ? <p className="chief-payable-extra-feedback danger">{openingError}</p> : null}
            </article>
        );
    }

    const risk = RISK_LABEL[after.riskLevel];
    const consumedPct = after.consumedPct === null ? null : Math.min(after.consumedPct, 1.5);
    const barWidth = consumedPct === null ? 0 : Math.min(consumedPct * 100, 100);
    const paceLeft = Math.min(after.elapsedPct * 100, 100);

    return (
        <article className={`contract-balance-card risk-${after.riskLevel}`}>
            <header>
                <span>Saldo de contrato</span>
                <small>
                    ciclo {formatDate(selected.cycleStart)} – {formatDate(selected.cycleEnd)}
                </small>
            </header>

            {contracts.length > 1 ? (
                <label className="contract-balance-selector">
                    Contrato
                    <select value={selected.contractId} onChange={(event) => setSelectedId(event.target.value)}>
                        {contracts.map((item) => (
                            <option key={item.contractId} value={item.contractId}>
                                {item.contractNumber}
                            </option>
                        ))}
                    </select>
                </label>
            ) : null}

            {consumedPct === null ? (
                <p className="contract-balance-no-ceiling">
                    Teto do contrato não cadastrado — sem ele não dá para mostrar percentual consumido nem
                    comparar com o ritmo esperado. O saldo abaixo continua válido.
                </p>
            ) : (
                <div className="contract-balance-bar" role="img"
                    aria-label={`${(consumedPct * 100).toFixed(1)}% consumido, ritmo esperado hoje ${paceLeft.toFixed(1)}%`}>
                    <div className="contract-balance-bar-fill" style={{ width: `${barWidth}%` }} />
                    {/* Marcador de ritmo: a leitura de um segundo que o chefe quer. */}
                    <div className="contract-balance-bar-pace" style={{ left: `${paceLeft}%` }} />
                </div>
            )}
            {consumedPct !== null ? (
                <p className="contract-balance-bar-legend">
                    <strong>{(consumedPct * 100).toFixed(1)}%</strong> consumido ·
                    ritmo esperado hoje {paceLeft.toFixed(1)}%
                    {after.paceIndex !== null && after.paceIndex > 1
                        ? ` · ${((after.paceIndex - 1) * 100).toFixed(1)}% acima`
                        : after.paceIndex !== null
                            ? ` · ${((1 - after.paceIndex) * 100).toFixed(1)}% abaixo`
                            : ""}
                </p>
            ) : null}

            <dl className="contract-balance-values">
                <div>
                    <dt>Saldo hoje</dt>
                    <dd>{formatBrl(before.balanceCents)}</dd>
                </div>
                <div>
                    <dt>{alreadyAttested ? `${monthLabel} (já atestado)` : `Este fechamento (${monthLabel})`}</dt>
                    <dd className="negative">{alreadyAttested ? "—" : `−${formatBrl(draft.amountCents)}`}</dd>
                </div>
                <div className="highlight">
                    <dt>Saldo depois</dt>
                    <dd className={after.balanceCents < 0 ? "negative" : ""}>{formatBrl(after.balanceCents)}</dd>
                </div>
            </dl>

            <p className="contract-balance-projection">
                <span className={`contract-balance-risk risk-${after.riskLevel}`}>
                    <span aria-hidden="true">{risk.icon}</span> {risk.text}
                </span>
                {after.hasReliableBurnRate ? (
                    after.projectedDepletionDate ? (
                        <>
                            {" "}No ritmo atual o saldo acaba em <strong>{formatDate(after.projectedDepletionDate.toISOString())}</strong>
                            {" "}(ciclo até {formatDate(selected.cycleEnd)}).
                        </>
                    ) : (
                        <> Sem projeção de exaustão no ritmo atual.</>
                    )
                ) : (
                    // Nos primeiros 45 dias o burn rate é ruído: um mês pesado
                    // distorce tudo. Melhor dizer que a amostra é curta.
                    <> Amostra ainda insuficiente para projetar a data de exaustão.</>
                )}
            </p>

            {after.remainingDays > 0 ? (
                <p className="contract-balance-budget">
                    Para chegar ao fim do ciclo: <strong>{formatBrl(after.healthyMonthlyBudgetCents)}/mês</strong>
                    {" "}≈ {after.monthlyWeekdayShifts.toLocaleString("pt-BR")} plantões de semana por mês.
                    {" "}Restam {after.remainingWeekdayShifts.toLocaleString("pt-BR")} plantões de semana no saldo.
                </p>
            ) : null}

            {overruns ? (
                <div className="contract-balance-overrun">
                    <p>
                        <strong>Este fechamento estoura o teto do contrato.</strong> O saldo fica em{" "}
                        {formatBrl(after.balanceCents)}. Isso não impede o pagamento — mas fica registrado.
                    </p>
                    <label>
                        <input
                            type="checkbox"
                            checked={overrunAcknowledged}
                            onChange={(event) => setOverrunAcknowledged(event.target.checked)}
                        />
                        Ciente de que este fechamento estoura o teto do contrato
                    </label>
                </div>
            ) : null}
        </article>
    );
}
