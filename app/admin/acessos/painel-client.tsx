"use client";

/* Painel do monitor de acessos: "Olhe primeiro" (a conta que mais pede atenção,
   com de onde cada aparelho usa), lugares do período e o ranking com o calor
   de cada conta. O ranking troca de critério sem recarregar; as linhas
   deslizam para a posição nova — o movimento diz "a ordem mudou". */
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useMemo, useState } from "react";
import type { ContaNoPainel, Painel } from "@/modules/acessos/painel";
import { EixoDoCalor, FaixaDeCalor, LegendaDoCalor, RaiasPorAparelho } from "@/app/admin/acessos/calor";
import { NOME_DO_NIVEL, papeisDaConta } from "@/app/admin/acessos/rotulos";

type Criterio = {
    id: string;
    nome: string;
    dica: string;
    valor: (c: ContaNoPainel) => number;
    medida: (c: ContaNoPainel) => string;
};

function horasEMinutos(minutos: number) {
    if (minutos <= 0) return "—";
    if (minutos < 60) return `${minutos} min`;
    const resto = minutos % 60;
    return `${Math.floor(minutos / 60)}h${resto ? String(resto).padStart(2, "0") : ""}`;
}

const plural = (n: number, um: string, varios: string) => `${n} ${n === 1 ? um : varios}`;

const CRITERIOS: Criterio[] = [
    { id: "risco", nome: "Risco", dica: "indício de senha compartilhada primeiro", valor: (c) => c.risco, medida: (c) => `risco ${c.risco}` },
    {
        id: "agora",
        nome: "Aberta agora",
        dica: "em mais redes neste momento",
        valor: (c) => c.metricas.agoraRedes * 100 + c.metricas.agoraSessoes,
        medida: (c) => (c.metricas.agoraSessoes ? `agora em ${plural(c.metricas.agoraRedes, "rede", "redes")}` : "fechada"),
    },
    {
        id: "simultaneo",
        nome: "Tempo simultâneo",
        dica: "mais tempo aberta em dois lugares",
        valor: (c) => c.metricas.minutosSimultaneos,
        medida: (c) => horasEMinutos(c.metricas.minutosSimultaneos),
    },
    {
        id: "lugares",
        nome: "Mais lugares",
        dica: "redes e cidades diferentes",
        valor: (c) => c.metricas.lugares * 100 + c.metricas.cidades,
        medida: (c) => plural(c.metricas.lugares, "rede", "redes"),
    },
    {
        id: "aparelhos",
        nome: "Mais aparelhos",
        dica: "navegadores e aparelhos diferentes",
        valor: (c) => c.metricas.aparelhos,
        medida: (c) => plural(c.metricas.aparelhos, "aparelho", "aparelhos"),
    },
    {
        id: "senha",
        nome: "Senha em mais lugares",
        dica: "senha digitada de redes diferentes",
        valor: (c) => c.metricas.redesDeSenha * 100 + c.metricas.senhas,
        medida: (c) => (c.metricas.senhas ? `senha de ${plural(c.metricas.redesDeSenha, "rede", "redes")}` : "—"),
    },
    {
        id: "recente",
        nome: "Uso mais recente",
        dica: "quem usou por último",
        valor: (c) => c.metricas.ultimaAtividadeMs ?? 0,
        medida: (c) => c.metricas.ultimaAtividade ?? "sem uso",
    },
];

const CHAVE_CRITERIO = "acessos:criterio";
const LINHAS_INICIAIS = 15;

function faixaDeRisco(risco: number) {
    return risco >= 70 ? "forte" : risco >= 40 ? "alto" : risco >= 20 ? "atencao" : "calmo";
}

function Lugares({ conta, max = 3 }: { conta: ContaNoPainel; max?: number }) {
    const visiveis = conta.lugares.slice(0, max);
    const resto = conta.lugares.length - visiveis.length;
    if (visiveis.length === 0) return <span className="ac-onde vazio">sem uso no período</span>;
    return (
        <span className="ac-onde">
            {visiveis.map((lugar) => (
                <span
                    key={lugar.rede}
                    className={`ac-lugar${lugar.coletiva ? " coletiva" : ""}${lugar.servidor || lugar.estrangeiro ? " alerta" : ""}`}
                    title={`${lugar.rede}${lugar.provedor ? ` · ${lugar.provedor}` : ""}${lugar.coletiva ? " · rede coletiva" : ""}`}
                >
                    {lugar.local ?? lugar.rede}
                    {lugar.provedor && lugar.local ? <small>{lugar.provedor}</small> : null}
                </span>
            ))}
            {resto > 0 ? <span className="ac-lugar mais">+{resto}</span> : null}
        </span>
    );
}

function Detalhe({ conta, periodo }: { conta: ContaNoPainel; periodo: string }) {
    return (
        <div className="ac-detalhe">
            <p className="ac-detalhe-resumo">{conta.resumo}</p>
            {conta.achados.length > 0 ? (
                <ul className="ac-achados-chips">
                    {conta.achados.map((achado) => (
                        <li key={achado.titulo} className={`ac-nivel ${achado.nivel}`}>{achado.titulo}</li>
                    ))}
                </ul>
            ) : null}
            {conta.maiorEpisodio ? (
                <div className={`ac-episodio-mini ${conta.maiorEpisodio.forca}`}>
                    <strong>Maior uso ao mesmo tempo: {conta.maiorEpisodio.quando} ({conta.maiorEpisodio.duracao})</strong>
                    <ul>
                        {conta.maiorEpisodio.lados.map((lado, indice) => <li key={`${lado}-${indice}`}>{lado}</li>)}
                    </ul>
                </div>
            ) : null}
            <div className="ac-detalhe-grade">
                <div>
                    <h4>De onde</h4>
                    <Lugares conta={conta} max={12} />
                </div>
                <div>
                    <h4>Aparelhos</h4>
                    <ul className="ac-lista-simples">
                        {conta.aparelhos.length ? conta.aparelhos.map((aparelho) => <li key={aparelho}>{aparelho}</li>) : <li>nenhum registrado</li>}
                    </ul>
                </div>
            </div>
            <Link className="ac-btn primario" href={`/admin/acessos/${conta.userId}?periodo=${periodo}`}>
                Abrir relatório completo
            </Link>
        </div>
    );
}

export function PainelDeAcessos({ painel, periodo }: { painel: Painel; periodo: string }) {
    const [criterioId, setCriterioId] = useState("risco");
    const [abertas, setAbertas] = useState<Set<string>>(() => new Set());
    const [todas, setTodas] = useState(false);
    const reduzir = useReducedMotion();

    useEffect(() => {
        try {
            const salvo = window.localStorage.getItem(CHAVE_CRITERIO);
            if (salvo && CRITERIOS.some((c) => c.id === salvo)) setCriterioId(salvo);
        } catch {
            // navegador sem armazenamento: fica o critério padrão
        }
    }, []);

    const criterio = CRITERIOS.find((c) => c.id === criterioId) ?? CRITERIOS[0];
    const ordenadas = useMemo(() => [...painel.contas].sort((a, b) => (
        criterio.valor(b) - criterio.valor(a)
        || b.risco - a.risco
        || (b.metricas.ultimaAtividadeMs ?? 0) - (a.metricas.ultimaAtividadeMs ?? 0)
    )), [painel.contas, criterio]);
    const visiveis = todas ? ordenadas : ordenadas.slice(0, LINHAS_INICIAIS);
    const foco = painel.foco ? painel.contas.find((c) => c.userId === painel.foco!.userId) : undefined;
    const maxContasLugar = Math.max(1, ...painel.lugares.map((l) => l.contas));

    function escolher(id: string) {
        setCriterioId(id);
        try {
            window.localStorage.setItem(CHAVE_CRITERIO, id);
        } catch {
            // sem armazenamento: vale só nesta visita
        }
    }

    function alternar(userId: string) {
        setAbertas((atual) => {
            const proximo = new Set(atual);
            if (proximo.has(userId)) proximo.delete(userId);
            else proximo.add(userId);
            return proximo;
        });
    }

    function verNaLista(userId: string) {
        setCriterioId("risco");
        setAbertas((atual) => new Set(atual).add(userId));
        window.setTimeout(() => document.getElementById(`conta-${userId}`)?.scrollIntoView({ behavior: reduzir ? "auto" : "smooth", block: "center" }), 60);
    }

    const deslize = reduzir ? { duration: 0 } : { duration: 0.26, ease: [0.22, 1, 0.36, 1] as const };

    return (
        <>
            <div className="ac-topo-painel">
                <section className={`ac-foco ${foco ? faixaDeRisco(foco.risco) : "calmo"}`} aria-labelledby="ac-foco-titulo">
                    <h2 id="ac-foco-titulo">Olhe primeiro</h2>
                    {foco && painel.foco ? (
                        <>
                            <div className="ac-foco-quem">
                                <span className={`ac-risco ${faixaDeRisco(foco.risco)}`} aria-label={`Risco ${foco.risco} de 100`}>
                                    <b>{foco.risco}</b>
                                </span>
                                <div>
                                    <p className="ac-foco-nome">{foco.nome}</p>
                                    <p className="ac-foco-meta">
                                        {foco.email} · {papeisDaConta(foco.papeis)}
                                        {foco.metricas.agoraSessoes > 0 ? (
                                            <span className={`ac-agora${foco.metricas.agoraRedes >= 2 ? " varias" : ""}`}>
                                                <span className={`ac-pulso${foco.metricas.agoraRedes >= 2 ? " varias" : ""}`} aria-hidden="true" />
                                                aberta agora em {plural(foco.metricas.agoraRedes, "rede", "redes")}
                                            </span>
                                        ) : null}
                                    </p>
                                </div>
                            </div>
                            <p className="ac-foco-resumo">{foco.resumo}</p>
                            <h3 className="ac-foco-sub">Quem está onde</h3>
                            <RaiasPorAparelho faixas={painel.foco.faixas} escala={painel.escala} />
                            <div className="ac-acoes">
                                <Link className="ac-btn primario" href={`/admin/acessos/${foco.userId}?periodo=${periodo}`}>Abrir relatório</Link>
                                <button type="button" className="ac-btn" onClick={() => verNaLista(foco.userId)}>Ver no ranking</button>
                            </div>
                        </>
                    ) : (
                        <div className="ac-foco-calmo">
                            <p className="ac-foco-nome">Nada pedindo atenção agora.</p>
                            <p className="ac-foco-resumo">Nenhuma conta com sinal de senha compartilhada no período. O ranking abaixo segue atualizando a cada minuto.</p>
                        </div>
                    )}
                </section>

                <section className="ac-card ac-lugares" aria-labelledby="ac-lugares-titulo">
                    <h2 id="ac-lugares-titulo">De onde estão acessando</h2>
                    {painel.lugares.length === 0 ? (
                        <p className="ac-vazio">Ninguém usou o sistema no período.</p>
                    ) : (
                        <ol className="ac-lugares-lista">
                            {painel.lugares.map((lugar) => (
                                <li key={lugar.chave} className={lugar.contasComSinal ? "com-sinal" : undefined}>
                                    <div className="ac-lugares-linha">
                                        <span className="ac-lugares-nome" title={lugar.chave}>{lugar.rotulo}</span>
                                        <span className="ac-lugares-num">{plural(lugar.contas, "conta", "contas")}</span>
                                    </div>
                                    <span className="ac-barra" aria-hidden="true">
                                        <span style={{ width: `${Math.max(6, (lugar.contas / maxContasLugar) * 100)}%` }} />
                                        {lugar.contasComSinal ? <span className="sinal" style={{ width: `${(lugar.contasComSinal / maxContasLugar) * 100}%` }} /> : null}
                                    </span>
                                    <span className="ac-lugares-tags">
                                        {lugar.detalhe ? <span>{lugar.detalhe}</span> : null}
                                        {lugar.coletiva ? <span>rede coletiva</span> : null}
                                        {lugar.servidor ? <span className="alerta">servidor/VPN</span> : null}
                                        {lugar.estrangeiro ? <span className="alerta">fora do Brasil</span> : null}
                                        {lugar.contasComSinal ? <span className="sinal">{plural(lugar.contasComSinal, "conta com sinal", "contas com sinal")}</span> : null}
                                    </span>
                                </li>
                            ))}
                        </ol>
                    )}
                    {!painel.temCidade ? (
                        <p className="ac-nota">
                            Só país e rede por enquanto. Com &quot;Add visitor location headers&quot; ligado no Cloudflare, aparecem as cidades.
                        </p>
                    ) : null}
                </section>
            </div>

            <section className="ac-card ac-ranking" aria-labelledby="ac-ranking-titulo">
                <div className="ac-ranking-topo">
                    <h2 id="ac-ranking-titulo">Ranking</h2>
                    <LegendaDoCalor />
                </div>
                <div className="ac-criterios" role="group" aria-label="Ordenar o ranking por">
                    {CRITERIOS.map((c) => (
                        <button
                            key={c.id}
                            type="button"
                            aria-pressed={c.id === criterio.id}
                            className={c.id === criterio.id ? "on" : undefined}
                            onClick={() => escolher(c.id)}
                            title={c.dica}
                        >
                            {c.nome}
                        </button>
                    ))}
                </div>
                <p className="ac-criterio-dica">Ordenado por {criterio.nome.toLowerCase()}: {criterio.dica}.</p>

                {ordenadas.length === 0 ? (
                    <p className="ac-vazio">Ninguém usou o sistema no período.</p>
                ) : (
                    <>
                        <div className="ac-linha ac-linha-cabecalho" aria-hidden="true">
                            <span />
                            <span />
                            <span>Conta</span>
                            <span>De onde</span>
                            <EixoDoCalor escala={painel.escala} />
                            <span />
                        </div>
                        <ol className="ac-linhas">
                            {visiveis.map((conta, indice) => {
                                const aberta = abertas.has(conta.userId);
                                return (
                                    <motion.li
                                        key={conta.userId}
                                        id={`conta-${conta.userId}`}
                                        layout="position"
                                        transition={{ layout: deslize }}
                                        className={`ac-item ${faixaDeRisco(conta.risco)}${aberta ? " aberta" : ""}`}
                                    >
                                        <button
                                            type="button"
                                            className="ac-linha"
                                            aria-expanded={aberta}
                                            aria-controls={`detalhe-${conta.userId}`}
                                            onClick={() => alternar(conta.userId)}
                                        >
                                            <span className="ac-pos">{indice + 1}</span>
                                            <span className={`ac-risco ${faixaDeRisco(conta.risco)}`} aria-label={`Risco ${conta.risco}`}><b>{conta.risco}</b></span>
                                            <span className="ac-quem">
                                                <strong>
                                                    {conta.nome}
                                                    {conta.metricas.agoraSessoes > 0 ? (
                                                        <span
                                                            className={`ac-pulso${conta.metricas.agoraRedes >= 2 ? " varias" : ""}`}
                                                            title={conta.metricas.agoraRedes >= 2 ? `aberta agora em ${conta.metricas.agoraRedes} redes` : "aberta agora"}
                                                        />
                                                    ) : null}
                                                </strong>
                                                <small>
                                                    {NOME_DO_NIVEL[conta.nivel]} · {papeisDaConta(conta.papeis)}{conta.ativa ? "" : " · SUSPENSA"} · {criterio.medida(conta)}
                                                </small>
                                            </span>
                                            <Lugares conta={conta} />
                                            <FaixaDeCalor faixa={conta.faixa} escala={painel.escala} rotulo={conta.nome} />
                                            <span className="ac-seta" aria-hidden="true" />
                                        </button>
                                        <AnimatePresence initial={false}>
                                            {aberta ? (
                                                <motion.div
                                                    id={`detalhe-${conta.userId}`}
                                                    key="detalhe"
                                                    initial={reduzir ? false : { height: 0, opacity: 0 }}
                                                    animate={{ height: "auto", opacity: 1 }}
                                                    exit={reduzir ? { opacity: 0 } : { height: 0, opacity: 0 }}
                                                    transition={{ duration: reduzir ? 0 : 0.22, ease: [0.22, 1, 0.36, 1] }}
                                                    style={{ overflow: "hidden" }}
                                                >
                                                    <Detalhe conta={conta} periodo={periodo} />
                                                </motion.div>
                                            ) : null}
                                        </AnimatePresence>
                                    </motion.li>
                                );
                            })}
                        </ol>
                        {ordenadas.length > LINHAS_INICIAIS ? (
                            <button type="button" className="ac-btn ac-mais" onClick={() => setTodas((v) => !v)}>
                                {todas ? "Mostrar só as primeiras" : `Mostrar todas as ${ordenadas.length} contas`}
                            </button>
                        ) : null}
                    </>
                )}
            </section>
        </>
    );
}
