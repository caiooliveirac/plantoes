"use client";

/**
 * Bloco de saldo contratual do fechamento (docs/saldo-contrato/SPEC.md §7.1).
 *
 * Recalcula AO VIVO com o mesmo módulo puro do servidor
 * (lib/contracts/balance-metrics.ts). Nada de round-trip por tecla, e nada de
 * uma segunda implementação da conta no front — é assim que os dois números
 * divergem e ninguém descobre.
 *
 * O saldo mostrado é o REAL: plantão dado já desconta, assinado ou não. A
 * assinatura só decide se o mês em edição ainda precisa ser subtraído como
 * projeção (para não descontar duas vezes) — ela nunca muda o valor.
 *
 * Fronteira do ciclo é regra dura: se o mês do fechamento está fora do ciclo do
 * contrato (renovou em 01/08 → agosto é do ciclo novo), o fechamento NÃO é
 * subtraído deste saldo. Era o bug da renovação: plantões de agosto entravam no
 * contrato anterior.
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
import { isMonthWithinCycle } from "@/lib/contracts/statement";
import type { ContractBalanceSummary } from "@/modules/reporting/payable-shifts";

const RISK_LABEL: Record<CycleMetrics["riskLevel"], { text: string; icon: string }> = {
    // Cor nunca sozinha: sempre cor + ícone + texto (SPEC §7.2).
    safe: { text: "no ritmo", icon: "●" },
    watch: { text: "atenção", icon: "◐" },
    warning: { text: "acaba antes do fim", icon: "▲" },
    critical: { text: "acaba muito antes do fim", icon: "▲▲" },
    depleted: { text: "saldo esgotado", icon: "■" },
};

const MONTH_NAMES = [
    "janeiro", "fevereiro", "março", "abril", "maio", "junho",
    "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

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

/** "2026-07-01" -> "01/07" — as datas do extrato dispensam o ano na célula. */
function formatDayMonth(iso: string): string {
    return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

function formatMonthName(monthKey: string): string {
    const month = Number(monthKey.slice(5, 7));
    return `${MONTH_NAMES[month - 1]}/${monthKey.slice(0, 4)}`;
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
    /** Mês em edição (AAAA-MM) — decide se o fechamento pertence ao ciclo do contrato. */
    monthKey?: string;
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
    monthKey,
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
    const [renewalDraft, setRenewalDraft] = useState<string | null>(null);
    const [renewalBusy, setRenewalBusy] = useState(false);
    const [renewalError, setRenewalError] = useState<string | null>(null);
    // Âncora de saldo: "no início de <data> o saldo era R$ X". Corrige o saldo
    // dali em diante SEM redefinir o contrato — teto e ciclo (e o alerta de
    // renovação no aniversário) ficam como estão. Para trocar teto/mês do
    // padrão, o botão é outro: "Corrigir valor/mês" no card de termos.
    const [anchorOpen, setAnchorOpen] = useState(false);
    const [anchorDate, setAnchorDate] = useState("");
    const [anchorValue, setAnchorValue] = useState("");
    const [anchorReason, setAnchorReason] = useState("");
    const [anchorBusy, setAnchorBusy] = useState(false);
    const [anchorError, setAnchorError] = useState<string | null>(null);

    const selected = contracts.find((item) => item.contractId === selectedId) ?? contracts[0];

    // Fronteira do ciclo: o fechamento do mês só desconta deste contrato se o
    // mês pertence ao ciclo dele. Sem monthKey (chamador antigo), assume dentro.
    const monthInCycle = !selected || !monthKey
        || isMonthWithinCycle(monthKey, selected.cycleStart.slice(0, 10), selected.cycleEnd.slice(0, 10));

    const { before, after } = useMemo(() => {
        if (!selected) return { before: null, after: null };
        const asOf = new Date();
        const input = toInput(selected, asOf);
        const beforeMetrics = computeCycleMetrics(input);
        // Já atestado, o consumo do mês está no razão: somar de novo contaria
        // duas vezes. Mês fora do ciclo não pertence a este contrato. Nos dois
        // casos "depois" é o próprio estado atual.
        if (alreadyAttested || !monthInCycle) return { before: beforeMetrics, after: beforeMetrics };
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
    }, [selected, draft, alreadyAttested, monthInCycle]);

    // Ciclo vencido = renovação pendente: o contrato novo ainda não existe no
    // sistema e a coordenação precisa confirmar o saldo do novo ciclo.
    const todayIso = new Date().toISOString().slice(0, 10);
    const cycleEnded = selected ? selected.cycleEnd.slice(0, 10) <= todayIso : false;

    // Contrato ainda sem saldo informado não estoura coisa nenhuma: o saldo é
    // zero porque ninguém digitou, não porque acabou. Sem esta guarda o botão de
    // atestar travaria e o checkbox de ciência nem aparece nesse estado — o
    // admin ficaria sem saída.
    const overruns = after !== null
        && after.balanceCents < 0
        && !alreadyAttested
        && !readOnly
        && monthInCycle
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

    async function confirmRenewal() {
        const value = Number((renewalValue ?? "").replace(",", "."));
        if (!Number.isFinite(value)) {
            setRenewalError("Informe o saldo do novo ciclo em reais.");
            return;
        }
        setRenewalBusy(true);
        setRenewalError(null);
        try {
            const response = await fetch(`/api/admin/contracts/${selected.contractId}/renew`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ openingBalanceBrl: value }),
            });
            const body = await response.json().catch(() => null) as { error?: string } | null;
            if (!response.ok) throw new Error(body?.error ?? "Não foi possível renovar o contrato.");
            onOpeningBalanceSaved?.();
        } catch (error) {
            setRenewalError(error instanceof Error ? error.message : "Falha ao renovar o contrato.");
        } finally {
            setRenewalBusy(false);
        }
    }

    async function submitBalanceAnchor() {
        const value = Number(anchorValue.replace(",", "."));
        if (!Number.isFinite(value)) {
            setAnchorError("Informe o saldo em reais que valia na data.");
            return;
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(anchorDate)) {
            setAnchorError("Informe a data da âncora.");
            return;
        }
        if (anchorReason.trim().length < 5) {
            setAnchorError("Descreva o motivo da correção — fica no histórico do contrato.");
            return;
        }
        setAnchorBusy(true);
        setAnchorError(null);
        try {
            const response = await fetch(`/api/admin/contracts/${selected.contractId}/adjustments`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    mode: "anchor",
                    targetBalanceBrl: value,
                    anchorDate,
                    description: anchorReason.trim(),
                }),
            });
            const body = await response.json().catch(() => null) as { error?: string } | null;
            if (!response.ok) throw new Error(body?.error ?? "Não foi possível corrigir o saldo.");
            setAnchorOpen(false);
            setAnchorValue("");
            setAnchorReason("");
            onOpeningBalanceSaved?.();
        } catch (error) {
            setAnchorError(error instanceof Error ? error.message : "Falha ao corrigir o saldo.");
        } finally {
            setAnchorBusy(false);
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
    // Sugestão do novo ciclo: a única coisa que o passado permite inferir é o
    // teto do ciclo anterior (a renovação costuma repor o valor anual cheio).
    const suggestedRenewalBrl = selected.ceilingCents !== null
        ? (selected.ceilingCents / 100).toFixed(2)
        : null;
    const renewalValue = renewalDraft ?? suggestedRenewalBrl;
    const cycleEndLabel = formatDate(selected.cycleEnd);

    return (
        <article className={`contract-balance-card risk-${after.riskLevel}`}>
            <header>
                <span>Saldo de contrato</span>
                <small>
                    ciclo {formatDate(selected.cycleStart)} – {cycleEndLabel}
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
                    <dt>
                        {!monthInCycle
                            ? `${monthLabel} (ciclo novo)`
                            : alreadyAttested
                                ? `${monthLabel} (já descontado)`
                                : `Este fechamento (${monthLabel})`}
                    </dt>
                    <dd className="negative">
                        {!monthInCycle || alreadyAttested ? "—" : `−${formatBrl(draft.amountCents)}`}
                    </dd>
                </div>
                <div className="highlight">
                    <dt>Saldo depois</dt>
                    <dd className={after.balanceCents < 0 ? "negative" : ""}>{formatBrl(after.balanceCents)}</dd>
                </div>
            </dl>

            {!monthInCycle ? (
                <p className="contract-balance-cycle-boundary">
                    O ciclo deste contrato vai até <strong>{cycleEndLabel}</strong>: os plantões de{" "}
                    {monthLabel} pertencem ao ciclo renovado e <strong>não descontam deste saldo</strong>.
                </p>
            ) : null}

            {selected.statement.length > 0 ? (
                <div className="contract-balance-statement">
                    <p className="contract-balance-statement-title">Saldo mês a mês</p>
                    <table>
                        <thead>
                            <tr>
                                <th>Mês</th>
                                <th>Saldo no início</th>
                                <th>Gasto do mês</th>
                                <th>Saldo no fim</th>
                            </tr>
                        </thead>
                        <tbody>
                            {selected.statement.map((row) => (
                                <tr key={row.monthKey}>
                                    <td>{formatMonthName(row.monthKey)}</td>
                                    <td>
                                        {formatBrl(row.startBalanceCents)}
                                        <small>em {formatDayMonth(row.startDate)}</small>
                                    </td>
                                    <td className={row.consumptionCents > 0 ? "negative" : ""}>
                                        {row.consumptionCents > 0 ? `−${formatBrl(row.consumptionCents)}` : "—"}
                                        {row.adjustmentsCents !== 0 ? (
                                            <small>
                                                ajuste {row.adjustmentsCents > 0 ? "+" : "−"}
                                                {formatBrl(Math.abs(row.adjustmentsCents))}
                                            </small>
                                        ) : null}
                                    </td>
                                    <td className={row.endBalanceCents < 0 ? "negative" : ""}>
                                        {formatBrl(row.endBalanceCents)}
                                        <small>{row.endIsToday ? `hoje (${formatDayMonth(row.endDate)})` : `em ${formatDayMonth(row.endDate)}`}</small>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            ) : null}

            {canManage && !readOnly ? (
                <div className="contract-balance-anchor">
                    <button
                        type="button"
                        className="payment-button subtle"
                        onClick={() => {
                            setAnchorOpen((open) => !open);
                            setAnchorError(null);
                            // Default: início do mês em edição — o caso típico é
                            // "o saldo no início de maio era X".
                            if (!anchorDate) setAnchorDate(monthKey ? `${monthKey}-01` : new Date().toISOString().slice(0, 10));
                        }}
                    >
                        {anchorOpen ? "Cancelar correção de saldo" : "Corrigir saldo em uma data"}
                    </button>
                    {anchorOpen ? (
                        <div className="contract-balance-anchor-form">
                            <p className="contract-balance-anchor-note">
                                Informe o saldo que valia no <strong>início do dia</strong> escolhido.
                                O sistema lança o ajuste que faz a conta bater e os meses seguintes
                                passam a descontar desse valor. Teto, ciclo e alerta de renovação
                                não mudam — para isso use &quot;Corrigir valor/mês&quot;.
                            </p>
                            <div className="contract-balance-opening">
                                <input
                                    type="date"
                                    value={anchorDate}
                                    onChange={(event) => setAnchorDate(event.target.value)}
                                    disabled={anchorBusy}
                                    aria-label="Data da âncora"
                                />
                                <input
                                    type="number"
                                    step="0.01"
                                    value={anchorValue}
                                    onChange={(event) => setAnchorValue(event.target.value)}
                                    placeholder="saldo na data, ex.: 120000.00"
                                    disabled={anchorBusy}
                                    aria-label="Saldo em reais no início da data"
                                />
                            </div>
                            <div className="contract-balance-opening">
                                <input
                                    type="text"
                                    value={anchorReason}
                                    onChange={(event) => setAnchorReason(event.target.value)}
                                    placeholder="motivo (ex.: saldo conferido na planilha de maio)"
                                    disabled={anchorBusy}
                                />
                                <button
                                    type="button"
                                    className="payment-button"
                                    onClick={() => void submitBalanceAnchor()}
                                    disabled={anchorBusy || anchorValue.trim() === "" || anchorReason.trim() === ""}
                                >
                                    {anchorBusy ? "Corrigindo..." : "Corrigir saldo"}
                                </button>
                            </div>
                            {anchorError ? <p className="chief-payable-extra-feedback danger">{anchorError}</p> : null}
                        </div>
                    ) : null}
                </div>
            ) : null}

            {cycleEnded ? (
                <div className="contract-balance-renewal">
                    <p>
                        <strong>Ciclo encerrado em {cycleEndLabel}.</strong>{" "}
                        {readOnly || !canManage
                            ? "A coordenação ainda precisa informar o saldo do novo ciclo — os valores acima param nessa data."
                            : suggestedRenewalBrl !== null
                                ? `Pelo histórico, a renovação costuma repor o teto do ciclo anterior (${formatBrl(selected.ceilingCents)}). Confirme ou corrija o saldo do novo ciclo:`
                                : "Não dá para calcular o saldo do novo ciclo pelo histórico — informe o valor definido pela coordenação:"}
                    </p>
                    {canManage && !readOnly ? (
                        <>
                            <div className="contract-balance-opening">
                                <input
                                    type="number"
                                    step="0.01"
                                    value={renewalValue ?? ""}
                                    onChange={(event) => setRenewalDraft(event.target.value)}
                                    placeholder="saldo do novo ciclo, ex.: 165732.00"
                                    disabled={renewalBusy}
                                />
                                <button
                                    type="button"
                                    className="payment-button"
                                    onClick={() => void confirmRenewal()}
                                    disabled={renewalBusy || (renewalValue ?? "").trim() === ""}
                                >
                                    {renewalBusy ? "Renovando..." : `Confirmar renovação em ${cycleEndLabel}`}
                                </button>
                            </div>
                            {renewalError ? <p className="chief-payable-extra-feedback danger">{renewalError}</p> : null}
                        </>
                    ) : null}
                </div>
            ) : null}

            <p className="contract-balance-projection">
                <span className={`contract-balance-risk risk-${after.riskLevel}`}>
                    <span aria-hidden="true">{risk.icon}</span> {risk.text}
                </span>
                {after.hasReliableBurnRate ? (
                    after.projectedDepletionDate ? (
                        <>
                            {" "}No ritmo atual o saldo acaba em <strong>{formatDate(after.projectedDepletionDate.toISOString())}</strong>
                            {" "}(ciclo até {cycleEndLabel}).
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
