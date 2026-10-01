"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { SeletorDePosto, type PostoAzulejo } from "@/components/board/SeletorDePosto";
import { bahiaClockHHMM } from "@/lib/time";
import "@/app/mesa-kit.css";

/* Contratos das rotas em app/api/medico/* (chegada, saida, estado, continuar, remanejar). */
type Dominio = "regulation" | "intervention";
interface Previa {
    atrasoMin: number;
    excedenteMin: number;
    multiplicador: 1 | 2;
    creditoMin: number;
    saldoMin: number;
    janelaInicio: string | null;
    janelaFim: string | null;
    agora: string;
}
interface EmTurno {
    domain: Dominio;
    occupancyId: string;
    targetId: string;
    code: string;
    startedAt: string;
    saidaDeclaradaAt?: string | null;
    pedidoContinuar?: { status: "pendente" | "aceito" | "recusado" } | null;
}
export interface EstadoDoPainel {
    medico: { id: string; nome: string };
    emTurno: EmTurno | null;
    previa?: Previa | null;
}
interface ErroPostoOcupado {
    error: "posto_ocupado";
    ocupante: { nome: string; desde: string | null };
    efeito: "deslocar" | "dupla";
}

export type PassoDoPainel = Passo;
type Passo =
    | { tipo: "nenhum" }
    | { tipo: "escolher"; acao: "chegada" | "remanejar" }
    | { tipo: "confirmar"; acao: "chegada" | "remanejar"; alvo: PostoAzulejo }
    | { tipo: "ocupado-1"; acao: "chegada" | "remanejar"; alvo: PostoAzulejo; erro: ErroPostoOcupado }
    | { tipo: "ocupado-2"; acao: "chegada" | "remanejar"; alvo: PostoAzulejo; erro: ErroPostoOcupado }
    | { tipo: "sair" }
    | { tipo: "continuar" };

function minutos(n: number) {
    const abs = Math.abs(n);
    const h = Math.floor(abs / 60);
    const m = abs % 60;
    return h > 0 ? `${h}h${String(m).padStart(2, "0")}` : `${m} min`;
}

function textoPrevia(p: Previa): string[] {
    const linhas: string[] = [];
    if (p.atrasoMin > 0) linhas.push(`Você entrou ${minutos(p.atrasoMin)} atrasado: sai devendo ${minutos(p.atrasoMin)} no banco.`);
    else linhas.push("Chegada pontual.");
    if (p.excedenteMin > 0) {
        linhas.push(p.multiplicador === 2
            ? `Já passou ${minutos(p.excedenteMin)} do fim da janela: conta em dobro (${minutos(p.creditoMin)}).`
            : `Já passou ${minutos(p.excedenteMin)} do fim da janela: conta simples, porque houve atraso.`);
    }
    linhas.push(`Saldo deste plantão se sair agora: ${p.saldoMin >= 0 ? "+" : "−"}${minutos(p.saldoMin)}.`);
    return linhas;
}

/**
 * Tela do médico plantonista (papel doctor + doctorId): declarar chegada
 * tocando no posto, e, em turno, sair (com a prévia do banco), pedir para
 * continuar no turno seguinte e remanejar-se. Hora sempre do servidor.
 * docs/plano-mesa-chefe-plantonista.md §5.
 */
export function PainelDoPlantonista({ nome, azulejos, emTurnoInicial, estadoInicial = null, passoInicial = null }: {
    nome: string;
    azulejos: PostoAzulejo[];
    emTurnoInicial: boolean;
    /** Render estático/teste: estado antes do primeiro fetch. */
    estadoInicial?: EstadoDoPainel | null;
    passoInicial?: Passo | null;
}) {
    const router = useRouter();
    const [estado, setEstado] = useState<EstadoDoPainel | null>(estadoInicial);
    const [passo, setPasso] = useState<Passo>(passoInicial ?? { tipo: "nenhum" });
    const [enviando, setEnviando] = useState(false);
    const [erro, setErro] = useState<string | null>(null);
    const [aviso, setAviso] = useState<string | null>(null);
    const [recolhido, setRecolhido] = useState(emTurnoInicial);

    const carregar = useCallback(async () => {
        try {
            const r = await fetch("/api/medico/estado", { cache: "no-store" });
            if (r.ok) setEstado(await r.json() as EstadoDoPainel);
        } catch {
            // sem estado: mostra só a chegada
        }
    }, []);

    useEffect(() => { void carregar(); }, [carregar]);

    async function chamar(url: string, body: unknown): Promise<{ ok: true; corpo: unknown } | { ok: false; status: number; corpo: Record<string, unknown> }> {
        setEnviando(true);
        setErro(null);
        try {
            const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
            const corpo = await r.json().catch(() => ({})) as Record<string, unknown>;
            if (r.ok) return { ok: true, corpo };
            return { ok: false, status: r.status, corpo };
        } catch {
            return { ok: false, status: 0, corpo: { error: "Sem conexão." } };
        } finally {
            setEnviando(false);
        }
    }

    async function executarPosto(acao: "chegada" | "remanejar", alvo: PostoAzulejo, flags: { cienteOcupado?: boolean; assumirPosto?: boolean } = {}) {
        const url = acao === "chegada" ? "/api/medico/chegada" : "/api/medico/remanejar";
        const r = await chamar(url, { domain: alvo.domain, targetId: alvo.targetId, ...flags });
        if (r.ok) {
            setPasso({ tipo: "nenhum" });
            setAviso(acao === "chegada" ? `Você está na ${alvo.code} desde ${bahiaClockHHMM(new Date().toISOString())}.` : `Você agora está na ${alvo.code}.`);
            await carregar();
            router.refresh();
            return;
        }
        const codigo = String(r.corpo.error ?? "");
        if (codigo === "posto_ocupado") {
            const e = r.corpo as unknown as ErroPostoOcupado;
            setPasso(flags.cienteOcupado ? { tipo: "ocupado-2", acao, alvo, erro: e } : { tipo: "ocupado-1", acao, alvo, erro: e });
            return;
        }
        if (codigo === "ja_em_turno") {
            setErro("Você já está em turno. Atualizando…");
            await carregar();
            router.refresh();
            return;
        }
        const mensagens: Record<string, string> = {
            posto_indisponivel: "Esse posto está desativado ou é eventual: fale com o chefe de plantão.",
            fora_de_turno: "Você não está em turno.",
            sem_medico_vinculado: "Sua conta não está ligada a um cadastro de médico.",
        };
        setErro(mensagens[codigo] ?? (typeof r.corpo.error === "string" ? r.corpo.error : "Não deu certo. Tente de novo."));
        setPasso({ tipo: "nenhum" });
    }

    async function sair() {
        const r = await chamar("/api/medico/saida", {});
        if (r.ok) {
            setPasso({ tipo: "nenhum" });
            setAviso(`Saída registrada às ${bahiaClockHHMM(new Date().toISOString())}. A chefia confirma.`);
            await carregar();
            router.refresh();
        } else {
            setErro(typeof r.corpo.error === "string" ? r.corpo.error : "Não foi possível registrar a saída.");
        }
    }

    async function continuar() {
        const r = await chamar("/api/medico/continuar", {});
        if (r.ok) {
            setPasso({ tipo: "nenhum" });
            setAviso("Pedido enviado: a chefia dá o ciente ou recusa a dobra. Você continua no quadro.");
            await carregar();
        } else {
            const codigo = String(r.corpo.error ?? "");
            setErro(codigo === "pedido_ja_pendente" ? "Seu pedido já está com a chefia." : (typeof r.corpo.error === "string" ? r.corpo.error : "Não foi possível pedir."));
            setPasso({ tipo: "nenhum" });
        }
    }

    const emTurno = estado?.emTurno ?? null;
    const previa = estado?.previa ?? null;
    const azulejosParaEscolha = azulejos.map((a) => (
        emTurno && a.domain === emTurno.domain && a.targetId === emTurno.targetId ? { ...a, status: "origem" as const } : a
    ));

    // ----- fora de turno: chegada -----
    if (!emTurno) {
        return (
            <section className="mk-painel" aria-label="Chegada ao plantão">
                <h1 className="mk-painel-titulo">Olá, {nome}.</h1>
                <p className="mk-painel-texto">Onde você está chegando? Toque no posto para começar agora.</p>
                {aviso ? <p className="mk-painel-aviso">{aviso}</p> : null}
                {erro ? <p className="mk-painel-erro" role="alert">{erro}</p> : null}
                <SeletorDePosto
                    modo="chegada"
                    azulejos={azulejosParaEscolha}
                    mostrarEventuais={false}
                    onEscolher={(alvo) => setPasso({ tipo: "confirmar", acao: "chegada", alvo })}
                />
                {renderFolhas()}
            </section>
        );
    }

    // ----- em turno: painel próprio -----
    return (
        <section className={`mk-painel mk-painel--turno ${recolhido ? "recolhido" : ""}`.trim()} aria-label="Seu plantão">
            <div className="mk-painel-cabeca">
                <div>
                    <strong>{nome} · {emTurno.code}</strong>
                    <span> desde {bahiaClockHHMM(emTurno.startedAt)}</span>
                    {emTurno.saidaDeclaradaAt ? <span> · saída {bahiaClockHHMM(emTurno.saidaDeclaradaAt)} a confirmar</span> : null}
                    {emTurno.pedidoContinuar?.status === "pendente" ? <span> · dobra aguardando ciente</span> : null}
                    {emTurno.pedidoContinuar?.status === "aceito" ? <span> · dobra aceita</span> : null}
                </div>
                <button type="button" className="mk-botao mk-botao--compacto" onClick={() => setRecolhido((v) => !v)} aria-expanded={!recolhido}>
                    {recolhido ? "Minhas ações ▾" : "Recolher ▴"}
                </button>
            </div>
            {!recolhido ? (
                <>
                    {aviso ? <p className="mk-painel-aviso">{aviso}</p> : null}
                    {erro ? <p className="mk-painel-erro" role="alert">{erro}</p> : null}
                    <div className="mk-painel-acoes">
                        <button type="button" className="mk-botao critico" disabled={enviando || Boolean(emTurno.saidaDeclaradaAt)} onClick={() => setPasso({ tipo: "sair" })}>
                            Sair do plantão
                            <small>{previa && previa.atrasoMin > 0 ? `sai devendo ${minutos(previa.atrasoMin)}` : "a chefia confirma a saída"}</small>
                        </button>
                        <button type="button" className="mk-botao primario" disabled={enviando || emTurno.pedidoContinuar?.status === "pendente"} onClick={() => setPasso({ tipo: "continuar" })}>
                            Continuar no próximo turno
                            <small>pede o ciente da chefia para a dobra</small>
                        </button>
                        <button type="button" className="mk-botao" disabled={enviando} onClick={() => setPasso({ tipo: "escolher", acao: "remanejar" })}>
                            Mudar de posto
                            <small>toque no destino</small>
                        </button>
                    </div>
                </>
            ) : null}
            {renderFolhas()}
        </section>
    );

    function renderFolhas() {
        if (passo.tipo === "nenhum") return null;
        const fechar = () => { if (!enviando) setPasso({ tipo: "nenhum" }); };
        return (
            <div className="mk-veu" role="presentation" onClick={fechar}>
                <div className="mk-folha" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
                    {passo.tipo === "escolher" ? (
                        <>
                            <h2 className="mk-folha-titulo">Para onde você vai?</h2>
                            <SeletorDePosto
                                modo="chegada"
                                azulejos={azulejosParaEscolha}
                                dominioInicial={emTurno?.domain}
                                mostrarEventuais={false}
                                onEscolher={(alvo) => setPasso({ tipo: "confirmar", acao: passo.acao, alvo })}
                            />
                            <div className="mk-folha-acoes" style={{ marginTop: 14 }}>
                                <button type="button" className="mk-botao" onClick={fechar}>Cancelar</button>
                            </div>
                        </>
                    ) : null}

                    {passo.tipo === "confirmar" ? (
                        <>
                            <h2 className="mk-folha-titulo">{passo.acao === "chegada" ? `Começar na ${passo.alvo.code} agora` : `Ir para a ${passo.alvo.code} agora`}</h2>
                            <p className="mk-folha-texto">
                                {passo.acao === "chegada"
                                    ? `A hora de chegada é a deste toque (${bahiaClockHHMM(new Date().toISOString())}). Você entra no quadro e ganha a Mesa.`
                                    : "A chegada no novo posto é agora; a hora prevista continua a do posto onde você chegou."}
                            </p>
                            <div className="mk-folha-acoes">
                                <button type="button" className="mk-botao primario" disabled={enviando} onClick={() => void executarPosto(passo.acao, passo.alvo)}>
                                    {enviando ? "Registrando…" : "Confirmar"}
                                </button>
                                <button type="button" className="mk-botao" disabled={enviando} onClick={fechar}>Voltar</button>
                            </div>
                        </>
                    ) : null}

                    {passo.tipo === "ocupado-1" ? (
                        <>
                            <h2 className="mk-folha-titulo">Tem gente na {passo.alvo.code}</h2>
                            <p className="mk-folha-texto">
                                <strong>{passo.erro.ocupante.nome}</strong>
                                {passo.erro.ocupante.desde ? ` está lá desde ${bahiaClockHHMM(passo.erro.ocupante.desde)}` : " está lá"}. É aqui mesmo que você está?
                            </p>
                            <div className="mk-folha-acoes">
                                <button type="button" className="mk-botao atencao" disabled={enviando} onClick={() => setPasso({ ...passo, tipo: "ocupado-2" })}>
                                    Sim, é na {passo.alvo.code} mesmo
                                </button>
                                <button type="button" className="mk-botao" disabled={enviando} onClick={() => setPasso({ tipo: "escolher", acao: passo.acao })}>Escolher outro posto</button>
                            </div>
                        </>
                    ) : null}

                    {passo.tipo === "ocupado-2" ? (
                        <>
                            <h2 className="mk-folha-titulo">{passo.erro.efeito === "deslocar" ? `${passo.erro.ocupante.nome} sai do painel` : "A base fica com dois médicos"}</h2>
                            <p className="mk-folha-texto">
                                {passo.erro.efeito === "deslocar"
                                    ? `Ao confirmar, você assume a ${passo.alvo.code} e ${passo.erro.ocupante.nome} sai do painel como deslocado (segue no plantão até a chefia remanejar ou retirar).`
                                    : `Ao confirmar, você entra na ${passo.alvo.code} como dupla com ${passo.erro.ocupante.nome}; ninguém é retirado.`}
                            </p>
                            <div className="mk-folha-acoes">
                                <button type="button" className="mk-botao critico" disabled={enviando} onClick={() => void executarPosto(passo.acao, passo.alvo, { cienteOcupado: true, assumirPosto: true })}>
                                    {enviando ? "Registrando…" : passo.erro.efeito === "deslocar" ? `Assumir a ${passo.alvo.code}` : `Entrar como dupla`}
                                </button>
                                <button type="button" className="mk-botao" disabled={enviando} onClick={fechar}>Cancelar</button>
                            </div>
                        </>
                    ) : null}

                    {passo.tipo === "sair" ? (
                        <>
                            <h2 className="mk-folha-titulo">Sair do plantão agora</h2>
                            {previa ? (
                                <ul className="mk-folha-lista">
                                    {textoPrevia(previa).map((linha) => <li key={linha}>{linha}</li>)}
                                </ul>
                            ) : <p className="mk-folha-texto">A saída fica a confirmar pela chefia.</p>}
                            <p className="mk-folha-sub">A hora da saída é a deste toque. A chefia confirma e o banco fecha no fechamento do mês.</p>
                            <div className="mk-folha-acoes">
                                <button type="button" className="mk-botao critico" disabled={enviando} onClick={() => void sair()}>
                                    {enviando ? "Registrando…" : "Confirmar saída"}
                                </button>
                                <button type="button" className="mk-botao" disabled={enviando} onClick={fechar}>Ainda não</button>
                            </div>
                        </>
                    ) : null}

                    {passo.tipo === "continuar" ? (
                        <>
                            <h2 className="mk-folha-titulo">Continuar no próximo turno</h2>
                            <p className="mk-folha-texto">
                                Você avisa que vai dobrar. O chefe de plantão (ou o admin) dá o ciente ou recusa; até lá você segue no quadro normalmente.
                            </p>
                            <div className="mk-folha-acoes">
                                <button type="button" className="mk-botao primario" disabled={enviando} onClick={() => void continuar()}>
                                    {enviando ? "Enviando…" : "Avisar que vou continuar"}
                                </button>
                                <button type="button" className="mk-botao" disabled={enviando} onClick={fechar}>Cancelar</button>
                            </div>
                        </>
                    ) : null}
                </div>
            </div>
        );
    }
}
