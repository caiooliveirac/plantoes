"use client";

import {
    handoffKindLabel,
    type HandoffCounts,
    type HandoffKind,
    type HandoffPhase,
    type HandoffScheduleWarning,
    type HandoffTransfer,
    type OccurrenceHandoffPlan,
} from "@/modules/operational/occurrence-handoff";

function plusMinutes(hhmm: string, minutes: number) {
    const [h, m] = hhmm.split(":").map(Number);
    const t = h * 60 + m + minutes;
    return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

function participantName(plan: OccurrenceHandoffPlan, ramal: string) {
    const all = [...plan.givers, ...plan.returning, ...plan.pools.aguardando, ...plan.pools.regulado, ...(plan.recip ? [plan.recip] : [])];
    return all.find((p) => p.ramal === ramal)?.name ?? ramal;
}

function KindTag({ kind, count }: { kind: HandoffKind; count?: number }) {
    return (
        <span className={`ops-handoff-tag ${kind}`}>
            {count !== undefined ? <strong>{count}</strong> : null}
            {handoffKindLabel(kind, count)}
        </span>
    );
}

function TransferLine({ plan, transfer, direction }: { plan: OccurrenceHandoffPlan; transfer: HandoffTransfer; direction: "to" | "from" }) {
    const other = direction === "to" ? transfer.to : transfer.from;
    const isRecip = plan.recip?.ramal === other;
    return (
        // display: contents — as três partes caem nas colunas do grid do pai
        <span className="ops-handoff-transfer">
            <KindTag kind={transfer.kind} count={transfer.count} />
            <span className="ops-handoff-arrow" aria-hidden="true">{direction === "to" ? "→" : "←"}</span>
            <span className="ops-handoff-person">
                {participantName(plan, other)}
                {isRecip ? <span className="ops-inline-flag recip">RECIP</span> : null}
            </span>
        </span>
    );
}

/** Faixa acima do quadro: quem sai, para quem passa cada ocorrência, quem falta informar. */
export function OccurrenceHandoffBanner({ plan, phase, scheduleWarnings = [], canManage = false, error = null }: {
    plan: OccurrenceHandoffPlan;
    phase: HandoffPhase;
    /** Falha ao gravar a contagem (rede, janela fechada). */
    error?: string | null;
    /** Só para quem pode corrigir horário (chefia logada). */
    scheduleWarnings?: HandoffScheduleWarning[];
    canManage?: boolean;
}) {
    const pending = plan.pendingGivers.map((ramal) => participantName(plan, ramal));
    const byGiver = plan.givers
        .map((giver) => ({ giver, transfers: plan.transfers.filter((t) => t.from === giver.ramal) }))
        .filter((row) => row.transfers.length > 0);

    return (
        <section className={`ops-handoff phase-${phase}`} aria-live="polite" aria-label={`Passagem de ocorrências da saída das ${plan.slot}`}>
            <header className="ops-handoff-head">
                <div className="ops-handoff-title">
                    <span className="ops-handoff-eyebrow">Passagem de ocorrências</span>
                    <h3>Saída das {plan.slot}</h3>
                </div>
                <div className="ops-handoff-meta">
                    {plan.recip ? (
                        <span>RECIP <strong>{plan.recip.name}</strong> · {plan.recipLoad}/15</span>
                    ) : (
                        <span>Sem RECIP · <KindTag kind="regulado" /> para quem sai 12:30 · <KindTag kind="aguardando" /> para quem sai 13:30</span>
                    )}
                    <span>Total a passar <strong>{plan.total}</strong></span>
                    {phase === "divisao" ? <span>Correções até <strong>{plusMinutes(plan.slot, 10)}</strong></span> : null}
                    {phase === "encerrada" ? <span><strong>Divisão fechada</strong></span> : null}
                </div>
            </header>

            <p className="ops-handoff-who">
                <span>Saem: <strong>{plan.givers.map((g) => g.name).join(", ") || "ninguém"}</strong></span>
                <span>Voltam: <strong>{plan.returning.map((p) => p.name).join(", ") || "ninguém"}</strong></span>
            </p>

            {canManage ? (
                <div className="ops-handoff-check">
                    <strong>Confira os horários antes da divisão.</strong>{" "}
                    {scheduleWarnings.length > 0 ? (
                        <>
                            {scheduleWarnings.map((w, i) => (
                                <span key={w.ramal}>
                                    {i > 0 ? " · " : ""}
                                    <b>{w.name}</b> ({w.ramal}) {w.problem === "presumido" ? "com almoço presumido às 12:30 (confirme com ele)" : "sem horário de almoço"}
                                </span>
                            ))}
                            .{" "}
                        </>
                    ) : null}
                    Alguém trocou de horário? Clique no horário na linha do médico: a divisão refaz na hora.
                </div>
            ) : null}

            {error ? <div className="ops-handoff-alert" role="alert">{error}</div> : null}

            {phase !== "aviso" && pending.length > 0 ? (
                <div className="ops-handoff-alert" role="alert">
                    <strong>Falta contagem:</strong> {pending.join(", ")}. Chamem para preencher na linha do ramal.
                </div>
            ) : null}

            {phase === "aviso" ? (
                <p className="ops-handoff-hint">A contagem abre 10 min antes da saída, na linha de cada médico que sai.</p>
            ) : byGiver.length > 0 ? (
                <ul className="ops-handoff-list">
                    {byGiver.map(({ giver, transfers }) => (
                        <li key={giver.ramal}>
                            <span className="ops-handoff-giver">
                                <strong>{giver.name}</strong>
                                <em>{giver.ramal}</em>
                            </span>
                            <span className="ops-handoff-transfers">
                                {transfers.map((t) => <TransferLine key={`${t.to}-${t.kind}`} plan={plan} transfer={t} direction="to" />)}
                            </span>
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="ops-handoff-hint">A divisão aparece aqui conforme a contagem chega.</p>
            )}

            {plan.unassigned > 0 ? <p className="ops-handoff-hint">{plan.unassigned} sem destino: ninguém disponível para receber. Chefia decide.</p> : null}
        </section>
    );
}

/** Expansão sob a linha do ramal: contagem de quem sai, ou o que recebe quem fica/volta. */
export function OccurrenceHandoffRowDetail(props: {
    ramal: string;
    role: string | null;
    plan: OccurrenceHandoffPlan;
    phase: HandoffPhase;
    counts: HandoffCounts | undefined;
    onCountsChange: (ramal: string, counts: HandoffCounts) => void;
}) {
    const { ramal, role, plan, phase, counts } = props;
    const editable = phase === "contagem" || phase === "divisao";
    const isGiver = plan.givers.some((g) => g.ramal === ramal);
    const incoming = plan.transfers.filter((t) => t.to === ramal);
    const outgoing = plan.transfers.filter((t) => t.from === ramal);
    const isReturning = plan.returning.some((p) => p.ramal === ramal);
    if (!isGiver && incoming.length === 0 && !isReturning) return null;

    const setCount = (kind: HandoffKind, raw: string) => {
        const value = Math.max(0, Math.min(99, Math.floor(Number(raw) || 0)));
        props.onCountsChange(ramal, { aguardando: counts?.aguardando ?? 0, regulado: counts?.regulado ?? 0, [kind]: value });
    };

    return (
        <div className={`ops-handoff-row ${isGiver ? "giver" : "receiver"} ${isGiver && !counts && phase !== "aviso" ? "pending" : ""}`.trim()}>
            {isGiver ? (
                phase === "aviso" ? (
                    <span className="ops-handoff-hint">Sai às {plan.slot}. A contagem abre 10 min antes.</span>
                ) : (
                    <>
                        <span className="ops-handoff-row-label">
                            {role === "MRV" ? "Suas amarelas" : role === "PSIQ" ? "Suas ocorrências · nunca para o RECIP" : "Suas ocorrências"}
                        </span>
                        <span className="ops-handoff-inputs">
                            {(["aguardando", "regulado"] as const).map((kind) => (
                                <label key={kind} className={`ops-handoff-input ${kind}`}>
                                    <span>{handoffKindLabel(kind)}</span>
                                    <input
                                        type="number"
                                        inputMode="numeric"
                                        min={0}
                                        max={99}
                                        value={counts ? counts[kind] : ""}
                                        placeholder="–"
                                        readOnly={!editable}
                                        onClick={(e) => e.stopPropagation()}
                                        onChange={(e) => editable && setCount(kind, e.target.value)}
                                        aria-label={`${handoffKindLabel(kind)} do ramal ${ramal}`}
                                    />
                                </label>
                            ))}
                        </span>
                        {outgoing.length > 0 ? (
                            <>
                                <span className="ops-handoff-row-label">Passa</span>
                                <span className="ops-handoff-transfers">
                                    {outgoing.map((t) => <TransferLine key={`${t.to}-${t.kind}`} plan={plan} transfer={t} direction="to" />)}
                                </span>
                            </>
                        ) : null}
                    </>
                )
            ) : (
                <>
                    <span className="ops-handoff-row-label">{isReturning ? `Volta ${plan.slot} · recebe` : "Recebe"}</span>
                    {incoming.length > 0 ? (
                        <span className="ops-handoff-transfers">
                            {incoming.map((t) => <TransferLine key={`${t.from}-${t.kind}`} plan={plan} transfer={t} direction="from" />)}
                        </span>
                    ) : <span className="ops-handoff-hint">nada por enquanto</span>}
                </>
            )}
        </div>
    );
}
