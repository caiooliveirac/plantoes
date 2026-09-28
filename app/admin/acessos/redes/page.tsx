import Link from "next/link";
import "@/app/admin/acessos/acessos.css";
import { ABAS_ADMIN, KairosTopo } from "@/components/kairos-topo";
import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { NOME_DO_VEREDITO, PLANTONISTAS_POSSIVEL_CENTRAL, type RedeAnalisada, type Veredito } from "@/modules/acessos/redes";
import { carregarRedes, type ContaResumida } from "@/services/acessos-redes.service";
import { lerPeriodo, PERIODOS, type ChavePeriodo } from "@/services/acessos-relatorio.service";
import { RotuloDaRede } from "@/app/admin/acessos/redes/rotulo-client";

export const dynamic = "force-dynamic";

/* Redes do monitor de acessos (docs/monitor-acessos.md, "Redes"): onde as
   contas são usadas fora do plantão, quem provavelmente emprestou a senha, e
   quais faixas o portão trata como Central. */

const CLASSE_DO_VEREDITO: Record<Veredito, string> = {
    vazou: "forte",
    suspeita: "atencao",
    aparelho_estranho: "atencao",
    uso_proprio: "normal",
    trabalho: "aberta",
};

function horas(minutos: number) {
    if (minutos <= 0) return "—";
    if (minutos < 60) return `${minutos} min`;
    const h = Math.floor(minutos / 60);
    const m = minutos % 60;
    return `${h}h${m ? String(m).padStart(2, "0") : ""}`;
}

function nomeDaRede(rede: RedeAnalisada) {
    return rede.rotulo?.label ?? rede.dominios[0] ?? rede.provedores[0] ?? rede.faixa;
}

function HorasFora({ horasFora }: { horasFora: number[] }) {
    const maximo = Math.max(1, ...horasFora);
    if (horasFora.every((n) => n === 0)) return null;
    return (
        <div className="ac-rede-horas" aria-label="Uso fora do plantão por hora do dia">
            {horasFora.map((n, h) => (
                <span key={h} title={`${String(h).padStart(2, "0")}h: ${n * 5} min fora do plantão`}>
                    <i style={{ height: `${Math.round((n / maximo) * 100)}%` }} />
                    {h % 6 === 0 ? <b>{h}h</b> : null}
                </span>
            ))}
        </div>
    );
}

function Rede({ rede, contas }: { rede: RedeAnalisada; contas: Map<string, ContaResumida> }) {
    const quaseCentral = !rede.central && rede.plantonistas >= PLANTONISTAS_POSSIVEL_CENTRAL;
    return (
        <section className={`ac-card ac-rede${rede.coletivaFora ? " suspeita" : ""}`} id={rede.faixa}>
            <div className="ac-topo">
                <div>
                    <h2>
                        {nomeDaRede(rede)}{" "}
                        {rede.central ? <span className="ac-nivel aberta">Central · {rede.central === "medida" ? `${rede.plantonistas} plantonistas no PC` : "rótulo do admin"}</span> : null}
                        {rede.coletivaFora ? <span className="ac-nivel forte">coletiva fora do plantão</span> : null}
                        {rede.rotulo && rede.rotulo.kind !== "central" ? <span className={`ac-nivel ${rede.rotulo.kind === "suspeita" ? "atencao" : "normal"}`}>{rede.rotulo.kind}</span> : null}
                        {quaseCentral ? <span className="ac-nivel atencao">{rede.plantonistas} plantonista(s) no PC — Central?</span> : null}
                    </h2>
                    <p className="ac-sub">
                        <span className="ac-mono">{rede.faixa}</span> · {rede.ips.length} {rede.ips.length === 1 ? "IP" : "IPs"}
                        {rede.dominios.length ? <> · {rede.dominios.join(", ")}</> : null}
                        {rede.provedores.length ? <> · {rede.provedores.join(", ")}</> : null}
                        {rede.lugares.length ? <> · {rede.lugares.join(", ")}</> : null}
                    </p>
                    {rede.rotulo?.note ? <p className="ac-sub">{rede.rotulo.note}</p> : null}
                </div>
                <RotuloDaRede faixa={rede.faixa} rotulo={rede.rotulo} />
            </div>
            <p className="ac-resumo-geral">
                <b>{rede.contas.length}</b> {rede.contas.length === 1 ? "conta" : "contas"} ·{" "}
                <b className={rede.contasFora >= 2 && !rede.central ? "forte" : undefined}>{rede.contasFora}</b> fora do plantão ·{" "}
                <b>{horas(rede.minutosFora)}</b> de uso fora do plantão ·{" "}
                <b className={rede.barrados ? "forte" : undefined}>{rede.barrados}</b> barrados ·{" "}
                <b className={rede.vazamentos ? "forte" : undefined}>{rede.vazamentos}</b> vazamento(s) provável(is)
            </p>
            <HorasFora horasFora={rede.horasFora} />
            <div className="ac-tabela-wrap">
                <table className="ac-tabela">
                    <thead>
                        <tr>
                            <th>Conta</th>
                            <th>Veredito</th>
                            <th>Fora do plantão</th>
                            <th>Barrado</th>
                            <th>Junto c/ Central</th>
                            <th>Aparelhos</th>
                            <th>Por quê</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rede.contas.map((c) => {
                            const conta = contas.get(c.userId);
                            return (
                                <tr key={c.userId}>
                                    <td>
                                        <Link href={`/admin/acessos/${c.userId}?periodo=7d`}>{conta?.email ?? c.userId.slice(0, 8)}</Link>
                                        <div className="ac-sub">{conta ? [...conta.papeis].sort().join(", ") || "sem papel" : ""}{conta && !conta.temMedico ? " · sem médico vinculado" : ""}</div>
                                    </td>
                                    <td><span className={`ac-nivel ${CLASSE_DO_VEREDITO[c.veredito]}`}>{NOME_DO_VEREDITO[c.veredito]}</span></td>
                                    <td className="num">{horas(c.minutosFora)}{c.minutosEmUsoFora ? ` (${horas(c.minutosEmUsoFora)} mexendo)` : ""}</td>
                                    <td className="num">{c.barrados || "—"}</td>
                                    <td className="num">{c.aoMesmoTempoNaCentral || "—"}</td>
                                    <td>{c.aparelhos.slice(0, 3).join("; ")}{c.aparelhos.length > 3 ? ` +${c.aparelhos.length - 3}` : ""}</td>
                                    <td>{c.porque}</td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </section>
    );
}

export default async function RedesPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
    if (!hasDatabaseUrl()) return null;
    try {
        await requireAuthenticatedSession(["admin"]);
    } catch (error) {
        if (error instanceof AuthError) {
            return (
                <div className="pagina-kairos">
                    <KairosTopo titulo="Redes" abas={ABAS_ADMIN} />
                    <main className="ac-shell"><div className="ac-conteudo"><section className="ac-card"><h1>Acesso restrito</h1></section></div></main>
                </div>
            );
        }
        throw error;
    }
    const params = searchParams ? await searchParams : undefined;
    const periodo = lerPeriodo(params?.periodo);
    const todas = params?.todas === "1";
    const dados = await carregarRedes({ desde: new Date(Date.now() - PERIODOS[periodo].ms) });

    const centrais = dados.redes.filter((r) => r.central);
    const quase = dados.redes.filter((r) => !r.central && r.plantonistas >= PLANTONISTAS_POSSIVEL_CENTRAL);
    const suspeitas = dados.redes.filter((r) => r.coletivaFora || r.vazamentos > 0 || r.rotulo?.kind === "suspeita");
    const demais = dados.redes.filter((r) => !r.central && !suspeitas.includes(r) && (r.minutosFora > 0 || r.barrados > 0));
    const vazamentos = dados.redes.reduce((t, r) => t + r.vazamentos, 0);

    return (
        <div className="pagina-kairos">
            <KairosTopo titulo="Monitor de acessos · Redes" abas={ABAS_ADMIN} />
            <main className="ac-shell">
                <div className="ac-conteudo">
                    <section className="ac-card">
                        <div className="ac-topo">
                            <div>
                                <h1>Redes</h1>
                                <p className="ac-sub">
                                    De onde as contas são usadas fora do plantão. Uma rede com várias contas fora do turno é um lugar onde
                                    logins emprestados são usados; o veredito de cada conta diz quem provavelmente emprestou.{" "}
                                    <Link href={`/admin/acessos?periodo=${periodo}`}>Voltar às contas</Link>
                                </p>
                            </div>
                            <nav className="ac-chips ac-nao-imprimir" aria-label="Período">
                                {(Object.keys(PERIODOS) as ChavePeriodo[]).map((chave) => (
                                    <Link key={chave} href={`/admin/acessos/redes?periodo=${chave}`} className={chave === periodo ? "on" : ""}>
                                        {PERIODOS[chave].rotulo}
                                    </Link>
                                ))}
                            </nav>
                        </div>
                        <p className="ac-resumo-geral">
                            <b className={suspeitas.length ? "forte" : undefined}>{suspeitas.length}</b> redes suspeitas ·{" "}
                            <b className={vazamentos ? "forte" : undefined}>{vazamentos}</b> vazamentos prováveis ·{" "}
                            <b>{centrais.length}</b> {centrais.length === 1 ? "faixa tratada" : "faixas tratadas"} como Central
                            {quase.length ? <> · <b className="forte">{quase.length}</b> com plantonista no PC mas <em>não</em> reconhecida(s) como Central</> : null}
                        </p>
                    </section>

                    <section className="ac-card">
                        <h2>Central — o que o portão reconhece</h2>
                        <p className="ac-sub">
                            Computador numa destas faixas abre Mesa e Tabela mesmo sem chegada registrada. Reconhecida por medida (3+
                            plantonistas usaram a Mesa num PC dentro do turno, últimos 14 dias no portão) ou por rótulo do admin — que
                            garante a faixa mesmo se a medida cair. Faixas com 2+ plantonistas no PC que não são reconhecidas aparecem
                            abaixo: se forem da Central, rotule como <b>Central</b>. (Com 1 só, costuma ser o notebook de um médico.)
                        </p>
                        <div className="ac-tabela-wrap">
                            <table className="ac-tabela">
                                <thead><tr><th>Rede</th><th>Faixa</th><th>Situação</th><th>Plantonistas no PC</th><th>Barrados</th></tr></thead>
                                <tbody>
                                    {[...centrais, ...quase].map((r) => (
                                        <tr key={r.faixa}>
                                            <td><a href={`#${r.faixa}`}>{nomeDaRede(r)}</a></td>
                                            <td className="ac-mono">{r.faixa}</td>
                                            <td>{r.central === "medida" ? "Central (medida)" : r.central === "rotulo" ? "Central (rótulo)" : "NÃO reconhecida"}</td>
                                            <td className="num">{r.plantonistas}</td>
                                            <td className="num">{r.barrados || "—"}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </section>

                    {suspeitas.length === 0 ? (
                        <section className="ac-card"><p className="ac-sub">Nenhuma rede suspeita no período.</p></section>
                    ) : suspeitas.map((r) => <Rede key={r.faixa} rede={r} contas={dados.contas} />)}

                    {quase.filter((r) => !suspeitas.includes(r)).map((r) => <Rede key={r.faixa} rede={r} contas={dados.contas} />)}

                    {todas ? (
                        demais.filter((r) => !quase.includes(r)).map((r) => <Rede key={r.faixa} rede={r} contas={dados.contas} />)
                    ) : demais.length ? (
                        <section className="ac-card">
                            <p className="ac-sub">
                                {demais.length} outras redes com uso fora do plantão de uma conta só (casa, 4G).{" "}
                                <Link href={`/admin/acessos/redes?periodo=${periodo}&todas=1`}>Mostrar todas</Link>
                            </p>
                        </section>
                    ) : null}
                </div>
            </main>
        </div>
    );
}
