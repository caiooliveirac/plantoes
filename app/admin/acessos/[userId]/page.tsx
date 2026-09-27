import Link from "next/link";
import { notFound } from "next/navigation";
import "@/app/admin/acessos/acessos.css";
import { ABAS_ADMIN, KairosTopo } from "@/components/kairos-topo";
import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { descreverRede, type EpisodioSimultaneo, type InfoDeRede } from "@/modules/acessos/analise";
import { montarLinhaDoTempo, rotuloDaSessao, type LinhaDoTempo } from "@/modules/acessos/linha-do-tempo";
import { escalaDoPeriodo, faixasPorAparelho, raiaDoPlantao, riscoDaConta } from "@/modules/acessos/painel";
import { LegendaDoCalor, RaiasPorAparelho } from "@/app/admin/acessos/calor";
import { duracao, horaComSegundos, intervalo, plural, quando } from "@/modules/acessos/texto";
import { carregarMonitor, lerPeriodo, PERIODOS, type ChavePeriodo } from "@/services/acessos-relatorio.service";
import { AcoesDaConta, AtualizacaoAutomatica, EncerrarSessao, ImprimirRelatorio } from "@/app/admin/acessos/acessos-client";
import {
    NOME_DA_FORCA,
    NOME_DA_ORIGEM,
    NOME_DA_SITUACAO,
    NOME_DO_ACHADO,
    NOME_DO_NIVEL,
    classeDoLado,
    papeisDaConta,
} from "@/app/admin/acessos/rotulos";

export const dynamic = "force-dynamic";

const ID_VALIDO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MARGEM_DO_EPISODIO_MS = 5 * 60_000;

function Indisponivel({ titulo, texto }: { titulo: string; texto: string }) {
    return (
        <div className="pagina-kairos">
            <KairosTopo titulo="Monitor de acessos" abas={ABAS_ADMIN} />
            <main className="ac-shell">
                <div className="ac-conteudo">
                    <section className="ac-card">
                        <h1>{titulo}</h1>
                        <p className="ac-sub">{texto}</p>
                        <p className="ac-sub"><Link href="/admin/acessos">Voltar ao monitor</Link></p>
                    </section>
                </div>
            </main>
        </div>
    );
}

function TabelaDaLinhaDoTempo({ linhas }: { linhas: LinhaDoTempo[] }) {
    if (linhas.length === 0) return <p className="ac-vazio">Sem registros neste intervalo.</p>;
    return (
        <div className="ac-tabela-wrap">
            <table className="ac-tabela">
                <thead>
                    <tr>
                        <th>Hora</th>
                        <th>Aparelho</th>
                        <th>O que aconteceu</th>
                        <th>Rede</th>
                    </tr>
                </thead>
                <tbody>
                    {linhas.map((linha, indice) => (
                        <tr key={`${linha.em.getTime()}-${indice}`} className={linha.tipo}>
                            <td className="num">{quando(linha.em).slice(0, 10)} {horaComSegundos(linha.em)}</td>
                            <td>
                                {linha.lado ? <span className={classeDoLado(linha.lado)}>{linha.lado}</span> : null} {linha.aparelho ?? "—"}
                            </td>
                            <td>{linha.oque}</td>
                            <td className="ac-mono">{linha.rede ?? "—"}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function CartaoDoEpisodio({ episodio, linhas, rotulos, redes }: {
    episodio: EpisodioSimultaneo;
    linhas: LinhaDoTempo[];
    rotulos: Map<string, string>;
    redes: Map<string, InfoDeRede>;
}) {
    return (
        <article className={`ac-episodio ${episodio.forca}`}>
            <div className="ac-topo">
                <h3>{intervalo(episodio.inicio, episodio.fim)} · {duracao(episodio.duracaoMs)}</h3>
                <span className={`ac-nivel ${episodio.forca}`}>{NOME_DA_FORCA[episodio.forca]}</span>
            </div>
            <ul>
                {episodio.lados.map((lado) => (
                    <li key={`${lado.sessaoId}-${lado.rede}`}>
                        <span className={classeDoLado(rotulos.get(lado.sessaoId) ?? null)}>{rotulos.get(lado.sessaoId) ?? "?"}</span>{" "}
                        {lado.aparelho.descricao} na {descreverRede(lado.rede, redes.get(lado.rede))} —{" "}
                        {plural(lado.pedidos, "consulta", "consultas")}, {lado.emUso > 0 || lado.interacoes > 0
                            ? `em uso (${plural(lado.emUso + lado.interacoes, "sinal", "sinais")} de toque/clique/página)`
                            : lado.visiveis > 0 ? "tela à vista, sem toque" : "aberta sem sinal de tela à vista"}
                    </li>
                ))}
            </ul>
            <ul>
                {episodio.motivos.map((motivo) => <li key={motivo}>{motivo}</li>)}
                {episodio.ressalvas.map((ressalva) => <li key={ressalva} className="ac-ressalva">Ressalva: {ressalva}</li>)}
            </ul>
            <details open={episodio.forca === "forte"}>
                <summary className="ac-sub" style={{ cursor: "pointer" }}>Linha do tempo minuto a minuto ({linhas.length} registros)</summary>
                <div style={{ marginTop: 8 }}>
                    <TabelaDaLinhaDoTempo linhas={linhas} />
                </div>
            </details>
        </article>
    );
}

export default async function RelatorioDaContaPage({
    params,
    searchParams,
}: {
    params: Promise<{ userId: string }>;
    searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
    if (!hasDatabaseUrl()) {
        return <Indisponivel titulo="Banco indisponível" texto="Sem DATABASE_URL não há registro de acessos para mostrar." />;
    }
    let adminId: string;
    try {
        adminId = (await requireAuthenticatedSession(["admin"])).user.id;
    } catch (error) {
        if (error instanceof AuthError) {
            return <Indisponivel titulo={error.status === 403 ? "Acesso restrito" : "Autenticação necessária"} texto="O monitor de acessos é exclusivo da administração." />;
        }
        throw error;
    }

    const { userId } = await params;
    if (!ID_VALIDO.test(userId)) notFound();
    const periodo: ChavePeriodo = lerPeriodo((searchParams ? await searchParams : undefined)?.periodo);

    let dados;
    try {
        dados = await carregarMonitor({ desde: new Date(Date.now() - PERIODOS[periodo].ms), userId });
    } catch (error) {
        console.error("[acessos] relatório indisponível", error);
        return <Indisponivel titulo="Registro de acessos indisponível" texto="As tabelas do monitor ainda não existem neste banco (migration 0046_monitor_acessos) ou o banco falhou." />;
    }
    const analise = dados.analises.find((a) => a.conta.userId === userId);
    if (!analise) notFound();
    const bruto = dados.brutos.get(userId) ?? { sessoes: [], janelas: [], eventos: [] };
    const { conta } = analise;
    const risco = riscoDaConta(analise);
    const faixaDeRisco = risco >= 70 ? "forte" : risco >= 40 ? "alto" : risco >= 20 ? "atencao" : "calmo";
    const escala = escalaDoPeriodo(dados.desde, dados.geradoEm);
    const raias = faixasPorAparelho(bruto.sessoes, bruto.janelas, analise.episodios, dados.redes, escala, 8);
    const raiaPlantao = raiaDoPlantao(dados.plantoes.get(userId), escala);

    // Mesmo rótulo (A, B, C…) para o mesmo aparelho no relatório inteiro.
    const rotulos = new Map<string, string>();
    const episodiosMostrados = analise.episodios.filter((e) => e.forca !== "fraco").slice(0, 10);
    const linhasPorEpisodio = episodiosMostrados.map((episodio) => montarLinhaDoTempo({
        ...bruto,
        redes: dados.redes,
        inicio: new Date(episodio.inicio.getTime() - MARGEM_DO_EPISODIO_MS),
        fim: new Date(episodio.fim.getTime() + MARGEM_DO_EPISODIO_MS),
        rotulos,
        limite: 120,
    }).linhas);
    for (const sessao of analise.sessoes) rotuloDaSessao(rotulos, sessao.id);
    const linhaGeral = montarLinhaDoTempo({
        ...bruto,
        janelas: [],
        redes: dados.redes,
        inicio: dados.desde,
        fim: dados.geradoEm,
        rotulos,
        limite: 200,
    }).linhas.reverse();

    return (
        <div className="pagina-kairos">
            <KairosTopo titulo="Monitor de acessos" abas={ABAS_ADMIN} />
            <main className="ac-shell">
                <div className="ac-conteudo">
                    <Link className="ac-voltar ac-nao-imprimir" href={`/admin/acessos?periodo=${periodo}`}>← Voltar ao monitor</Link>

                    <section className="ac-card">
                        <div className="ac-topo">
                            <div>
                                <h1>{conta.nome ?? conta.email}</h1>
                                <p className="ac-sub" style={{ marginTop: 4 }}>
                                    {conta.email} · {papeisDaConta(conta.papeis)} · conta {conta.ativa ? "ativa" : "SUSPENSA"}
                                </p>
                            </div>
                            <span className="ac-foco-quem">
                                <span className={`ac-nivel ${analise.nivel}`}>{NOME_DO_NIVEL[analise.nivel]}</span>
                                <span className={`ac-risco ${faixaDeRisco}`} aria-label={`Risco ${risco} de 100`}><b>{risco}</b></span>
                            </span>
                        </div>
                        <p className="ac-resumo">{analise.resumo}</p>
                        {analise.plantao ? (
                            <p className="ac-sub">
                                {analise.plantao.agora ? <span className="ac-tag-plantao">de plantão agora · {analise.plantao.agora.rotulo}</span> : "Não está de plantão agora."}
                                {" "}{analise.plantao.turnos} {analise.plantao.turnos === 1 ? "turno" : "turnos"} no período.
                            </p>
                        ) : (
                            <p className="ac-sub">Conta sem médico vinculado: sem escala para comparar com o uso.</p>
                        )}
                        <p className="ac-sub">
                            Relatório de {PERIODOS[periodo].rotulo} ({quando(dados.desde)} a {quando(dados.geradoEm)}, horário da Bahia).{" "}
                            {plural(analise.aparelhos.length, "aparelho", "aparelhos")}, {plural(analise.lugares.length, "rede", "redes")},{" "}
                            {plural(analise.sessoes.length, "entrada", "entradas")}
                            {analise.abertaAgora.sessoes > 0 ? ` — aberta agora em ${plural(analise.abertaAgora.redes, "rede", "redes")}` : ""}.
                        </p>
                        <div className="ac-topo ac-nao-imprimir" style={{ marginTop: 12 }}>
                            <nav className="ac-chips" aria-label="Período">
                                {(Object.keys(PERIODOS) as ChavePeriodo[]).map((chave) => (
                                    <Link key={chave} href={`/admin/acessos/${userId}?periodo=${chave}`} className={chave === periodo ? "on" : ""}>
                                        {PERIODOS[chave].rotulo}
                                    </Link>
                                ))}
                            </nav>
                            <ImprimirRelatorio />
                        </div>
                        <AtualizacaoAutomatica geradoEm={dados.geradoEm.toISOString()} />
                    </section>

                    <section className="ac-card">
                        <div className="ac-ranking-topo">
                            <h2>Quem está onde</h2>
                            <LegendaDoCalor />
                        </div>
                        <p className="ac-sub" style={{ marginTop: 6, marginBottom: 14 }}>
                            Uma raia por aparelho, com a cidade (ou a rede) de onde ele mais usa. Verde no topo: quando o dono estava de plantão.
                            Uso intenso — até em dois PCs — dentro do plantão e na rede do plantão é trabalho; o que chama atenção é a conta em
                            uso fora da rede do plantão enquanto ele trabalha, ou na Central fora do turno dele. Vermelho: uso simultâneo forte.
                        </p>
                        <RaiasPorAparelho faixas={raias} escala={escala} plantao={raiaPlantao} />
                    </section>

                    <section className="ac-card ac-nao-imprimir">
                        <h2>Ações</h2>
                        <p className="ac-sub" style={{ marginTop: 0, marginBottom: 10 }}>
                            Nada é feito sozinho. Cada ação pede um motivo, fica na auditoria e aparece na linha do tempo desta conta.
                        </p>
                        <AcoesDaConta userId={userId} email={conta.email} ativa={conta.ativa} ehVoceMesmo={userId === adminId} />
                    </section>

                    <section className="ac-card">
                        <h2>O que chama atenção</h2>
                        {analise.achados.length === 0 ? (
                            <p className="ac-vazio">Nada fora do comum no período.</p>
                        ) : analise.achados.map((achado) => (
                            <div key={achado.titulo} className={`ac-achado ${achado.nivel}`}>
                                <h3><span className={`ac-nivel ${achado.nivel}`}>{NOME_DO_ACHADO[achado.nivel]}</span> {achado.titulo}</h3>
                                <p>{achado.texto}</p>
                                {achado.evidencias.length > 0 ? (
                                    <ul className="ac-evidencias">
                                        {achado.evidencias.map((evidencia) => <li key={evidencia}>{evidencia}</li>)}
                                    </ul>
                                ) : null}
                            </div>
                        ))}
                    </section>

                    {episodiosMostrados.length > 0 ? (
                        <section className="ac-card">
                            <h2>Uso ao mesmo tempo em redes diferentes ({episodiosMostrados.length})</h2>
                            <p className="ac-sub" style={{ marginTop: 0, marginBottom: 12 }}>
                                Cada bloco é um trecho em que a conta estava aberta em dois ou mais lugares. A linha do tempo intercala o que cada
                                aparelho fez — é a prova para mostrar a quem precisar.
                            </p>
                            {episodiosMostrados.map((episodio, indice) => (
                                <CartaoDoEpisodio
                                    key={episodio.inicio.getTime()}
                                    episodio={episodio}
                                    linhas={linhasPorEpisodio[indice]}
                                    rotulos={rotulos}
                                    redes={dados.redes}
                                />
                            ))}
                        </section>
                    ) : null}

                    <section className="ac-card">
                        <h2>Aparelhos e entradas</h2>
                        {analise.sessoes.length === 0 ? <p className="ac-vazio">Nenhuma entrada no período.</p> : (
                            <div className="ac-tabela-wrap">
                                <table className="ac-tabela">
                                    <thead>
                                        <tr>
                                            <th>Aparelho</th>
                                            <th>Entrou</th>
                                            <th>Como</th>
                                            <th>De onde entrou</th>
                                            <th>Último uso</th>
                                            <th>Redes</th>
                                            <th>Situação</th>
                                            <th className="ac-nao-imprimir"></th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {analise.sessoes.map((sessao) => (
                                            <tr key={sessao.id}>
                                                <td>
                                                    <span className={classeDoLado(rotulos.get(sessao.id) ?? null)}>{rotulos.get(sessao.id) ?? "?"}</span> {sessao.aparelho}
                                                </td>
                                                <td className="num">{quando(sessao.criadaEm)}</td>
                                                <td>{NOME_DA_ORIGEM[sessao.origem] ?? sessao.origem}</td>
                                                <td className="ac-mono">
                                                    {sessao.redeDeEntrada ?? "—"}{sessao.localDeEntrada ? ` (${sessao.localDeEntrada})` : ""}
                                                </td>
                                                <td className="num">{sessao.ultimaVez ? quando(sessao.ultimaVez) : "—"}</td>
                                                <td className="num">{sessao.redes}</td>
                                                <td>
                                                    <span className={`ac-nivel ${sessao.situacao === "aberta" ? "aberta" : "normal"}`}>{NOME_DA_SITUACAO[sessao.situacao]}</span>
                                                    {sessao.motivoEncerramento ? <div className="ac-sub" style={{ margin: "4px 0 0" }}>{sessao.motivoEncerramento}</div> : null}
                                                </td>
                                                <td className="ac-nao-imprimir">{sessao.situacao !== "encerrada" ? <EncerrarSessao sessionId={sessao.id} /> : null}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </section>

                    <section className="ac-card">
                        <h2>Redes (lugares)</h2>
                        {analise.lugares.length === 0 ? <p className="ac-vazio">Sem uso registrado no período.</p> : (
                            <div className="ac-tabela-wrap">
                                <table className="ac-tabela">
                                    <thead>
                                        <tr>
                                            <th>Rede</th>
                                            <th>Local aproximado</th>
                                            <th>Provedor</th>
                                            <th>Contas nesta rede</th>
                                            <th>Primeiro uso</th>
                                            <th>Último uso</th>
                                            <th>Consultas</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {analise.lugares.map((lugar) => (
                                            <tr key={lugar.rede}>
                                                <td className="ac-mono">{lugar.rede}</td>
                                                <td>{lugar.local ?? "—"}</td>
                                                <td>{lugar.provedor ?? "—"}{lugar.servidor ? " (servidor/VPN)" : ""}</td>
                                                <td className="num">{lugar.contas}{lugar.coletiva ? " · rede coletiva" : ""}</td>
                                                <td className="num">{quando(lugar.primeiraVez)}</td>
                                                <td className="num">{quando(lugar.ultimaVez)}</td>
                                                <td className="num">{lugar.pedidos}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </section>

                    <section className="ac-card">
                        <h2>Senha digitada ({analise.entradasComSenha.length})</h2>
                        {analise.entradasComSenha.length === 0 ? <p className="ac-vazio">Ninguém digitou a senha desta conta no período (entradas por sessão já aberta não pedem senha).</p> : (
                            <div className="ac-tabela-wrap">
                                <table className="ac-tabela">
                                    <thead>
                                        <tr>
                                            <th>Quando</th>
                                            <th>Onde</th>
                                            <th>Resultado</th>
                                            <th>Rede</th>
                                            <th>Local aproximado</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {[...analise.entradasComSenha].reverse().map((entrada, indice) => (
                                            <tr key={`${entrada.em.getTime()}-${indice}`}>
                                                <td className="num">{quando(entrada.em)}</td>
                                                <td>{entrada.via === "portal" ? "portal / app Escalas" : "login do Plantões"}</td>
                                                <td>{entrada.ok ? "senha certa" : "senha errada"}</td>
                                                <td className="ac-mono">{entrada.rede ?? "não informada"}</td>
                                                <td>{entrada.local ?? "—"}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </section>

                    <section className="ac-card">
                        <details>
                            <summary className="ac-como-ler" style={{ cursor: "pointer" }}>
                                <strong>Tudo o que esta conta fez no período (últimos {linhaGeral.length} registros)</strong>
                            </summary>
                            <div style={{ marginTop: 12 }}>
                                <TabelaDaLinhaDoTempo linhas={linhaGeral} />
                            </div>
                        </details>
                    </section>

                    <p className="ac-sub">
                        Localização por IP é aproximada. &quot;Em uso&quot; = toque, clique, tecla ou rolagem na Mesa nos 2 minutos anteriores, ou página
                        aberta/ação feita. Critérios completos em docs/monitor-acessos.md.
                    </p>
                </div>
            </main>
        </div>
    );
}
