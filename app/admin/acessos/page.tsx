import Link from "next/link";
import "@/app/admin/acessos/acessos.css";
import { ABAS_ADMIN, KairosTopo } from "@/components/kairos-topo";
import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import type { AnaliseDaConta } from "@/modules/acessos/analise";
import { plural, quando } from "@/modules/acessos/texto";
import { carregarMonitor, lerPeriodo, PERIODOS, type ChavePeriodo } from "@/services/acessos-relatorio.service";
import { AtualizacaoAutomatica } from "@/app/admin/acessos/acessos-client";
import { NOME_DO_NIVEL, papeisDaConta } from "@/app/admin/acessos/rotulos";

export const dynamic = "force-dynamic";

function Indisponivel({ titulo, texto }: { titulo: string; texto: string }) {
    return (
        <div className="pagina-kairos">
            <KairosTopo titulo="Monitor de acessos" abas={ABAS_ADMIN} />
            <main className="ac-shell">
                <div className="ac-conteudo">
                    <section className="ac-card">
                        <h1>{titulo}</h1>
                        <p className="ac-sub">{texto}</p>
                    </section>
                </div>
            </main>
        </div>
    );
}

function LinhaDaConta({ analise, periodo }: { analise: AnaliseDaConta; periodo: ChavePeriodo }) {
    const { conta } = analise;
    const episodios = analise.episodios.filter((e) => e.forca !== "fraco").length;
    return (
        <li className="ac-conta">
            <span className={`ac-nivel ${analise.nivel}`}>{NOME_DO_NIVEL[analise.nivel]}</span>
            <span className="ac-conta-quem">
                <Link href={`/admin/acessos/${conta.userId}?periodo=${periodo}`}>{conta.nome ?? conta.email}</Link>
                <small>{conta.email} · {papeisDaConta(conta.papeis)}{conta.ativa ? "" : " · SUSPENSA"}</small>
            </span>
            <span className="ac-conta-resumo">{analise.resumo}</span>
            <span className="ac-conta-numeros">
                {plural(analise.aparelhos.length, "aparelho", "aparelhos")} · {plural(analise.lugares.length, "rede", "redes")}
                {episodios > 0 ? ` · ${plural(episodios, "ocasião simultânea", "ocasiões simultâneas")}` : ""}
                <br />
                {analise.abertaAgora.sessoes > 0
                    ? `aberta agora (${plural(analise.abertaAgora.redes, "rede", "redes")})`
                    : analise.ultimaAtividade ? `último uso ${quando(analise.ultimaAtividade)}` : "sem uso registrado"}
            </span>
        </li>
    );
}

export default async function MonitorDeAcessosPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
    if (!hasDatabaseUrl()) {
        return <Indisponivel titulo="Banco indisponível" texto="Sem DATABASE_URL não há registro de acessos para mostrar." />;
    }
    try {
        await requireAuthenticatedSession(["admin"]);
    } catch (error) {
        if (error instanceof AuthError) {
            return (
                <Indisponivel
                    titulo={error.status === 403 ? "Acesso restrito" : "Autenticação necessária"}
                    texto="O monitor de acessos é exclusivo da administração."
                />
            );
        }
        throw error;
    }

    const params = searchParams ? await searchParams : undefined;
    const periodo = lerPeriodo(params?.periodo);
    let dados;
    try {
        dados = await carregarMonitor({ desde: new Date(Date.now() - PERIODOS[periodo].ms) });
    } catch (error) {
        console.error("[acessos] monitor indisponível", error);
        return (
            <Indisponivel
                titulo="Registro de acessos indisponível"
                texto="As tabelas do monitor ainda não existem neste banco (migration 0046_monitor_acessos) ou o banco falhou. Nada foi perdido: aplique a migration e recarregue."
            />
        );
    }

    const { analises } = dados;
    const fortes = analises.filter((a) => a.nivel === "forte");
    const atencao = analises.filter((a) => a.nivel === "atencao");
    const normais = analises.filter((a) => a.nivel === "normal");
    const agoraEmVariosLugares = analises.filter((a) => a.abertaAgora.redes >= 2);
    const sessoesAbertas = analises.reduce((total, a) => total + a.abertaAgora.sessoes, 0);
    const temCidade = [...dados.redes.values()].some((rede) => rede.geo.cidade);

    return (
        <div className="pagina-kairos">
            <KairosTopo titulo="Monitor de acessos" abas={ABAS_ADMIN} />
            <main className="ac-shell">
                <div className="ac-conteudo">
                    <section className="ac-card">
                        <div className="ac-topo">
                            <div>
                                <h1>Monitor de acessos</h1>
                                <p className="ac-sub">
                                    Quem entrou, de onde, em qual aparelho e o que fez — e, principalmente, quando a mesma conta esteve
                                    aberta em lugares diferentes ao mesmo tempo. Nada aqui bloqueia ninguém sozinho: as ações ficam
                                    no relatório de cada conta.
                                </p>
                            </div>
                            <nav className="ac-chips ac-nao-imprimir" aria-label="Período">
                                {(Object.keys(PERIODOS) as ChavePeriodo[]).map((chave) => (
                                    <Link key={chave} href={`/admin/acessos?periodo=${chave}`} className={chave === periodo ? "on" : ""}>
                                        {PERIODOS[chave].rotulo}
                                    </Link>
                                ))}
                            </nav>
                        </div>
                        <AtualizacaoAutomatica geradoEm={dados.geradoEm.toISOString()} />
                    </section>

                    <section className="ac-kpis" aria-label="Resumo do período">
                        <div className={`ac-kpi ${fortes.length ? "forte" : ""}`.trim()}>
                            <span className="ac-kpi-valor">{fortes.length}</span>
                            <span className="ac-kpi-rotulo">contas com indício forte</span>
                        </div>
                        <div className={`ac-kpi ${atencao.length ? "atencao" : ""}`.trim()}>
                            <span className="ac-kpi-valor">{atencao.length}</span>
                            <span className="ac-kpi-rotulo">contas com pontos de atenção</span>
                        </div>
                        <div className={`ac-kpi ${agoraEmVariosLugares.length ? "forte" : ""}`.trim()}>
                            <span className="ac-kpi-valor">{agoraEmVariosLugares.length}</span>
                            <span className="ac-kpi-rotulo">abertas agora em 2+ redes</span>
                        </div>
                        <div className="ac-kpi">
                            <span className="ac-kpi-valor">{sessoesAbertas}</span>
                            <span className="ac-kpi-rotulo">sessões abertas agora</span>
                        </div>
                        <div className="ac-kpi">
                            <span className="ac-kpi-valor">{analises.length}</span>
                            <span className="ac-kpi-rotulo">contas com uso no período</span>
                        </div>
                    </section>

                    {agoraEmVariosLugares.length > 0 ? (
                        <section className="ac-card ac-agora">
                            <h2>Agora: abertas em mais de uma rede</h2>
                            <p className="ac-sub" style={{ marginTop: 0, marginBottom: 10 }}>
                                Nos últimos 5 minutos estas contas fizeram pedidos de redes diferentes. Abra o relatório para ver se há
                                uso nos dois lados ou só uma aba esquecida.
                            </p>
                            <ul className="ac-lista">
                                {agoraEmVariosLugares.map((analise) => <LinhaDaConta key={analise.conta.userId} analise={analise} periodo={periodo} />)}
                            </ul>
                        </section>
                    ) : null}

                    <section className="ac-card">
                        <h2>Contas com sinais ({PERIODOS[periodo].rotulo})</h2>
                        {fortes.length + atencao.length === 0 ? (
                            <p className="ac-vazio">Nenhuma conta com sinal de uso compartilhado no período.</p>
                        ) : (
                            <ul className="ac-lista">
                                {[...fortes, ...atencao].map((analise) => <LinhaDaConta key={analise.conta.userId} analise={analise} periodo={periodo} />)}
                            </ul>
                        )}
                    </section>

                    <section className="ac-card">
                        <details>
                            <summary className="ac-como-ler" style={{ cursor: "pointer" }}>
                                <strong>Contas sem sinal ({normais.length})</strong>
                            </summary>
                            <ul className="ac-lista" style={{ marginTop: 12 }}>
                                {normais.map((analise) => <LinhaDaConta key={analise.conta.userId} analise={analise} periodo={periodo} />)}
                            </ul>
                        </details>
                    </section>

                    {!temCidade ? (
                        <div className="ac-aviso">
                            Localização só por país. Para ver cidade e região de cada rede, ligue no Cloudflare (zona mnrs.com.br):
                            Regras → Transformações gerenciadas → <strong>Add visitor location headers</strong>. Não precisa mexer no código.
                        </div>
                    ) : null}

                    <section className="ac-card ac-como-ler">
                        <details>
                            <summary>Como ler este monitor</summary>
                            <ul>
                                <li><strong>Forte</strong>: a conta estava sendo usada em dois ou mais lugares ao mesmo tempo, com toque, clique ou tecla nos dois aparelhos — ou em 3 redes de uma vez. Uma pessoa sozinha não explica.</li>
                                <li><strong>Atenção</strong>: aberta em duas redes ao mesmo tempo sem prova de uso nos dois lados, senha digitada em muitos lugares, muitos aparelhos, acesso de fora do Brasil ou por VPN. Pode ter explicação inocente — a repetição é que pesa.</li>
                                <li><strong>Rede</strong> = lugar de onde a conexão sai para a internet. A Central tem uma rede usada por muitas contas; o 4G e a casa de cada um têm a sua.</li>
                                <li><strong>Celular + computador</strong> ao mesmo tempo pode ser a mesma pessoa. O relatório diz quando é o caso.</li>
                                <li><strong>Localização</strong> vem do IP e é aproximada; operadora de celular às vezes aparece em outra cidade.</li>
                                <li>Registros guardados por 180 dias. Detalhes em docs/monitor-acessos.md.</li>
                            </ul>
                        </details>
                    </section>
                </div>
            </main>
        </div>
    );
}
