"use client";

import { useState, type ReactNode } from "react";
import {
    formatDuration,
    formatSignedDuration,
    type DoctorBankHoursView,
    type DoctorShiftFilter,
    type DoctorShiftView,
} from "@/modules/reporting/doctor-bank-hours-view";
import "./banco-de-horas-medico.css";

function tom(minutes: number) {
    return minutes > 0 ? "pos" : minutes < 0 ? "neg" : "zero";
}

/** Régua de −24h a +24h com marcos em −12h, 0 e +12h (a régua da troca). */
function Regua({ saldo, estatutario }: { saldo: number; estatutario: boolean }) {
    const limite = 24 * 60;
    const posicao = ((Math.max(-limite, Math.min(limite, saldo)) + limite) / (2 * limite)) * 100;
    const cor = saldo >= 720 ? "pos" : saldo <= -720 ? "neg" : "zero";
    return (
        <div className="bhm-regua" aria-hidden="true">
            <div className="bhm-regua-trilho">
                <span className="bhm-regua-marco" style={{ left: "25%" }} />
                <span className="bhm-regua-marco" style={{ left: "50%" }} />
                <span className="bhm-regua-marco" style={{ left: "75%" }} />
                <span className={`bhm-regua-ponto ${cor}`} style={{ left: `${posicao}%` }} />
            </div>
            <div className="bhm-regua-legenda">
                <span>{estatutario ? "−12h" : "−12h · retira 1 plantão"}</span>
                <span>0</span>
                <span>+12h · 1 plantão extra</span>
            </div>
        </div>
    );
}

function LinhaPlantao({ shift, aberto, destaque, onToggle }: {
    shift: DoctorShiftView;
    aberto: boolean;
    destaque: boolean;
    onToggle: () => void;
}) {
    const selos: ReactNode[] = [];
    if (shift.delayMinutes > 0) selos.push(<span key="a" className="bhm-selo">atraso {formatDuration(shift.delayMinutes)}</span>);
    if (shift.creditedMinutes > 0) {
        selos.push(
            <span key="c" className="bhm-selo verde">
                além do horário {formatDuration(shift.extraMinutes)}{shift.doubled ? " · em dobro" : ""}
            </span>,
        );
    }
    if (shift.handoff) selos.push(<span key="r" className="bhm-selo azul">rendido às {shift.handoff.at}</span>);
    if (shift.validation?.chip) {
        selos.push(
            <span key="v" className={`bhm-selo ${shift.validation.tone === "warn" ? "ambar" : ""}`.trim()}>
                {shift.validation.chip}
            </span>,
        );
    }

    return (
        <>
            <button
                type="button"
                className={`bhm-plantao ${destaque ? "destaque" : ""}`.trim()}
                id={`bhm-${shift.id}`}
                aria-expanded={aberto}
                onClick={onToggle}
            >
                <span className="bhm-plantao-quando">
                    {shift.dayLabel}
                    <small>{shift.weekday} · {shift.shiftLabel}</small>
                </span>
                <span className="bhm-plantao-oque">
                    {shift.place}
                    <span className="bhm-plantao-resumo">{shift.summary}</span>
                    {selos.length > 0 ? <span className="bhm-selos">{selos}</span> : null}
                </span>
                <span className={`bhm-num bhm-plantao-valor ${tom(shift.balanceMinutes)}`}>
                    {formatSignedDuration(shift.balanceMinutes)}
                </span>
            </button>
            {aberto ? (
                <div className="bhm-explica">
                    <p>{shift.story.join(" ")}</p>
                    <dl className="bhm-horarios">
                        {shift.scheduled ? <div><dt>Previsto</dt><dd className="bhm-num">{shift.scheduled}</dd></div> : null}
                        {shift.arrivedAt ? <div><dt>Chegada</dt><dd className="bhm-num">{shift.arrivedAt}</dd></div> : null}
                        {shift.declaredExit ? (
                            <div><dt>{shift.declaredExitLabel}</dt><dd className="bhm-num">{shift.declaredExit}</dd></div>
                        ) : null}
                        {shift.handoff ? (
                            <div><dt>Rendido por {shift.handoff.name}</dt><dd className="bhm-num">{shift.handoff.at}</dd></div>
                        ) : null}
                        {shift.finalExit ? (
                            <div className="final">
                                <dt>{shift.validation?.finalLabel ?? "Saída que valeu"}</dt>
                                <dd className="bhm-num">{shift.finalExit}</dd>
                            </div>
                        ) : null}
                    </dl>
                    {shift.validation ? (
                        <p className={`bhm-validacao ${shift.validation.tone}`}>{shift.validation.sentence}</p>
                    ) : null}
                </div>
            ) : null}
        </>
    );
}

/**
 * Banco de horas do Painel do médico: saldo com a frase do que fazer, a conta
 * que leva ao saldo e os meses com só os plantões que importam. O modelo vem
 * pronto do servidor (modules/reporting/doctor-bank-hours-view.ts); aqui só
 * desenha e guarda o que está aberto. `troca` é o bloco de autoatendimento.
 */
export function BancoDeHorasMedico({ view, troca }: { view: DoctorBankHoursView; troca: ReactNode }) {
    const [filtro, setFiltro] = useState<DoctorShiftFilter | null>(null);
    const [mesesAbertos, setMesesAbertos] = useState<Set<string>>(
        () => new Set(view.defaultOpenMonthKey ? [view.defaultOpenMonthKey] : []),
    );
    const [plantoesAbertos, setPlantoesAbertos] = useState<Set<string>>(() => new Set());
    const [diasAbertos, setDiasAbertos] = useState<Set<string>>(() => new Set());

    const alternar = (setter: typeof setMesesAbertos, chave: string) =>
        setter((atual) => {
            const proximo = new Set(atual);
            if (proximo.has(chave)) proximo.delete(chave);
            else proximo.add(chave);
            return proximo;
        });

    function escolherFiltro(proximo: DoctorShiftFilter) {
        setFiltro((atual) => (atual === proximo ? null : proximo));
        window.setTimeout(() => document.getElementById("bhm-meses")?.scrollIntoView({ block: "start" }), 50);
    }

    const passaNoFiltro = (shift: DoctorShiftView) =>
        filtro === "atraso" ? shift.delayMinutes > 0 : filtro === "alem" ? shift.creditedMinutes > 0 : true;

    return (
        <div className="bhm">
            <section className="bhm-cartao" aria-labelledby="bhm-t-saldo">
                <div>
                    <p className="bhm-saldo-rotulo" id="bhm-t-saldo">Seu saldo no banco de horas</p>
                    <p className={`bhm-num bhm-saldo-valor ${tom(view.saldoMinutes)}`}>{formatSignedDuration(view.saldoMinutes)}</p>
                    <p className="bhm-nota">Somado desde o início, não só deste mês.</p>
                </div>
                <Regua saldo={view.saldoMinutes} estatutario={view.isStatutory} />
                <div className={`bhm-frase ${view.headline.tone}`}>
                    <p><strong>{view.headline.title}</strong></p>
                    <p className="bhm-frase-sub">{view.headline.detail}</p>
                    {view.headline.showAction && view.headline.actionLabel ? (
                        <a className="bhm-botao" href="#troca">{view.headline.actionLabel}</a>
                    ) : null}
                </div>
            </section>

            <section className="bhm-cartao" aria-labelledby="bhm-t-conta">
                <h2 id="bhm-t-conta">Como chegamos a {formatSignedDuration(view.saldoMinutes)}</h2>
                <ul className="bhm-conta">
                    {view.composition.map((term) => (
                        <li key={term.key}>
                            {term.filter ? (
                                <button
                                    type="button"
                                    className="bhm-conta-linha"
                                    aria-pressed={filtro === term.filter}
                                    onClick={() => escolherFiltro(term.filter!)}
                                >
                                    <span className="rot">{term.label}</span>
                                    <span className="det">{term.detail}</span>
                                    <span className={`bhm-num val ${tom(term.minutes)}`}>{formatSignedDuration(term.minutes)}</span>
                                </button>
                            ) : (
                                <div className="bhm-conta-linha">
                                    <span className="rot">{term.label}</span>
                                    <span className="det">{term.detail}</span>
                                    <span className={`bhm-num val ${tom(term.minutes)}`}>{formatSignedDuration(term.minutes)}</span>
                                </div>
                            )}
                        </li>
                    ))}
                    <li className="total">
                        <div className="bhm-conta-linha">
                            <span className="rot">Saldo</span>
                            <span className={`bhm-num val ${tom(view.saldoMinutes)}`}>{formatSignedDuration(view.saldoMinutes)}</span>
                        </div>
                    </li>
                </ul>
                <p className="bhm-nota">
                    Chegada até 15 min depois do previsto não conta como atraso. Tempo além do horário conta em dobro
                    quando a chegada foi no horário e simples quando houve atraso.
                    {view.hiddenOldCreditMinutes > 0
                        ? ` Seu crédito de ${formatSignedDuration(view.hiddenOldCreditMinutes)} até abr/2025 fica fora desta conta: ele não vira plantão extra.`
                        : ""}
                </p>
            </section>

            {troca}

            <section className="bhm-cartao" id="bhm-meses" aria-labelledby="bhm-t-meses">
                <h2 id="bhm-t-meses">Mês a mês</h2>
                {filtro ? (
                    <div className="bhm-filtro">
                        <span>Mostrando só {filtro === "atraso" ? "os atrasos" : "o tempo além do horário"}</span>
                        <button type="button" onClick={() => setFiltro(null)}>ver tudo</button>
                    </div>
                ) : null}
                <p className="bhm-nota">
                    Aparecem os plantões que mexeram no saldo, os que tiveram rendição e os de saída a validar.
                    Toque num plantão para ver a explicação.
                </p>
                {view.months.length === 0 ? (
                    <p className="bhm-nota">Nenhum plantão apurado pelo sistema ainda.</p>
                ) : null}
                <div className="bhm-meses">
                    {view.months.map((month) => {
                        const aberto = Boolean(filtro) || mesesAbertos.has(month.monthKey);
                        const plantoes = month.shifts.filter(passaNoFiltro);
                        if (filtro && plantoes.length === 0) return null;
                        const resumo = [
                            `${month.shiftCount} ${month.shiftCount === 1 ? "plantão" : "plantões"}`,
                            month.delayCount ? `${month.delayCount} com atraso` : null,
                            month.extraCount ? `${month.extraCount} além do horário` : null,
                            month.settlements.length ? `${month.settlements.length} ${month.settlements.length === 1 ? "acerto" : "acertos"}` : null,
                        ].filter(Boolean).join(" · ");
                        return (
                            <div className="bhm-mes" key={month.monthKey}>
                                <button
                                    type="button"
                                    className="bhm-mes-cab"
                                    aria-expanded={aberto}
                                    onClick={() => alternar(setMesesAbertos, month.monthKey)}
                                >
                                    <span className="nome">{month.label}</span>
                                    <span className="resumo">{resumo}</span>
                                    <span className="valores">
                                        <span className={tom(month.movedMinutes)}>
                                            <span className="bhm-num">{formatSignedDuration(month.movedMinutes)}</span> no mês
                                        </span>
                                        <span className="acum">
                                            saldo ao fim: <span className="bhm-num">{formatSignedDuration(month.closingMinutes)}</span>
                                        </span>
                                    </span>
                                </button>
                                {aberto ? (
                                    <div className="bhm-mes-corpo">
                                        {plantoes.map((shift) => (
                                            <LinhaPlantao
                                                key={shift.id}
                                                shift={shift}
                                                aberto={plantoesAbertos.has(shift.id)}
                                                destaque={Boolean(filtro)}
                                                onToggle={() => alternar(setPlantoesAbertos, shift.id)}
                                            />
                                        ))}
                                        {!filtro && month.payrollMinutes > 0 ? (
                                            <div className="bhm-acerto">
                                                <span className="bhm-plantao-quando">folha</span>
                                                <span className="bhm-acerto-oque">
                                                    Atraso descontado na folha de ponto
                                                    <small>o que passou do zero não fica no banco</small>
                                                </span>
                                                <span className="bhm-num pos">{formatSignedDuration(month.payrollMinutes)}</span>
                                            </div>
                                        ) : null}
                                        {!filtro ? month.settlements.map((settlement) => (
                                            <div className={`bhm-acerto ${settlement.reversed ? "estornado" : ""}`.trim()} key={settlement.id}>
                                                <span className="bhm-plantao-quando">{settlement.dayLabel}</span>
                                                <span className="bhm-acerto-oque">
                                                    {settlement.text}
                                                    <small>{settlement.reversed ? "estornado depois" : settlement.detail}</small>
                                                </span>
                                                <span className={`bhm-num ${tom(settlement.deltaMinutes)}`}>{formatSignedDuration(settlement.deltaMinutes)}</span>
                                            </div>
                                        )) : null}
                                        {!filtro && month.quietDays.length > 0 ? (
                                            <div className="bhm-sem-mudanca">
                                                <span>
                                                    {month.quietDays.length === 1
                                                        ? "1 plantão sem atraso e sem tempo além do horário: não mexeu no saldo."
                                                        : `${month.quietDays.length} plantões sem atraso e sem tempo além do horário: não mexeram no saldo.`}
                                                </span>
                                                {diasAbertos.has(month.monthKey) ? (
                                                    <span className="bhm-dias">
                                                        {month.quietDays.map((dia, i) => <span key={`${dia}-${i}`} className="bhm-selo bhm-num">{dia}</span>)}
                                                    </span>
                                                ) : (
                                                    <button type="button" onClick={() => alternar(setDiasAbertos, month.monthKey)}>ver os dias</button>
                                                )}
                                            </div>
                                        ) : null}
                                    </div>
                                ) : null}
                            </div>
                        );
                    })}
                </div>
            </section>
        </div>
    );
}
