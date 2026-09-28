import Link from "next/link";
import "@/app/admin/acessos/acessos.css";
import { ABAS_ADMIN, KairosTopo } from "@/components/kairos-topo";
import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { montarPainel } from "@/modules/acessos/painel";
import { carregarMonitor, lerPeriodo, PERIODOS, type ChavePeriodo } from "@/services/acessos-relatorio.service";
import { AtualizacaoAutomatica } from "@/app/admin/acessos/acessos-client";
import { PainelDeAcessos } from "@/app/admin/acessos/painel-client";

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

const plural = (n: number, um: string, varios: string) => `${n} ${n === 1 ? um : varios}`;

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

    const painel = montarPainel({ ...dados, ate: dados.geradoEm, plantoes: dados.plantoes });
    const fortes = painel.contas.filter((c) => c.nivel === "forte").length;
    const atencao = painel.contas.filter((c) => c.nivel === "atencao").length;
    const agoraEmVarias = painel.contas.filter((c) => c.metricas.agoraRedes >= 2).length;
    const abertas = painel.contas.reduce((total, c) => total + c.metricas.agoraSessoes, 0);

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
                                    Quem entrou, de onde, em qual aparelho — e quando a mesma conta esteve em uso em lugares diferentes ao
                                    mesmo tempo. Mesa, Tabela e portal. Mesa e Tabela só abrem de plantão (ou na Central); 4+ lugares ao mesmo tempo
                                    troca a senha sozinho; o resto das ações fica no relatório de cada conta.{" "}
                                    <Link href={`/admin/acessos/redes?periodo=${periodo}`}>Ver redes (fora do plantão, Central, vazamentos)</Link>
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
                        <p className="ac-resumo-geral">
                            <b className={fortes ? "forte" : undefined}>{plural(fortes, "conta", "contas")}</b> com indício forte ·{" "}
                            <b>{atencao}</b> com pontos de atenção ·{" "}
                            <b className={agoraEmVarias ? "forte" : undefined}>{agoraEmVarias}</b> abertas agora em 2+ redes ·{" "}
                            <b>{abertas}</b> {abertas === 1 ? "sessão aberta" : "sessões abertas"} agora ·{" "}
                            <b>{painel.contas.length}</b> contas usaram no período
                        </p>
                        <AtualizacaoAutomatica geradoEm={dados.geradoEm.toISOString()} />
                    </section>

                    <PainelDeAcessos painel={painel} periodo={periodo} />

                    <section className="ac-card ac-como-ler">
                        <details>
                            <summary>Como ler este monitor</summary>
                            <ul>
                                <li><strong>Risco</strong> vai de 0 a 100. <strong>70+</strong>: a conta estava sendo usada em dois ou mais lugares ao mesmo tempo, com gente mexendo nos dois aparelhos, ou em 3 redes de uma vez. <strong>20–69</strong>: pontos de atenção — duas redes ao mesmo tempo sem prova de uso dos dois lados, senha digitada em muitos lugares, muitos aparelhos, acesso de fora do Brasil ou por VPN.</li>
                                <li><strong>Calor</strong>: cada quadradinho é um trecho do período (30 min em 24 horas, 3 h em 7 dias, 12 h em 30 dias). Azul é uso; âmbar, duas redes no mesmo trecho; âmbar cheio, uso simultâneo; vermelho, uso simultâneo forte.</li>
                                <li><strong>Quem está onde</strong>: uma raia por aparelho da conta, com a cidade (ou a rede) de onde ele usa. Vermelho na raia = aquele aparelho estava num uso simultâneo forte.</li>
                                <li><strong>Plantão</strong> (verde): quando o dono da conta estava de plantão, pelas ocupações do quadro. <strong>Rede do plantão</strong>: faixa de endereços onde 3 ou mais plantonistas usaram a Mesa num computador durante o próprio turno — a Central, que sai por vários IPs. Uso intenso — e até em dois PCs — dentro do plantão e na rede do plantão é trabalho e não pesa. Pesa: a conta em uso <em>fora</em> da rede do plantão enquanto o dono trabalha (computador fora = forte), e a conta na rede do plantão <em>fora</em> do turno do dono.</li>
                                <li><strong>Rede coletiva</strong> (contorno tracejado): rede usada por 3 ou mais contas — Central, hospital, base.</li>
                                <li><strong>Celular + computador</strong> ao mesmo tempo pode ser a mesma pessoa; o relatório da conta diz quando é o caso.</li>
                                <li><strong>Localização</strong> vem do IP e é aproximada; operadora de celular às vezes aparece em outra cidade.</li>
                                <li>Registros guardados por 180 dias. Critérios completos em docs/monitor-acessos.md.</li>
                            </ul>
                        </details>
                    </section>
                </div>
            </main>
        </div>
    );
}
