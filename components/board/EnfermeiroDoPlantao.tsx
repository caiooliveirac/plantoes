"use client";

/**
 * Enfermeiros(as) do plantão (ERS), no topo da Mesa (BoardHero). Cada um numa
 * posição: ADM (4091), DISP (4092) ou Fluxo (3005). Chefia/admin abre o
 * seletor, escolhe a posição, digita (filtra na hora, sem acento, por nome
 * ou matrícula) e registra com Enter ou clique — quem estava na posição sai;
 * cada um tem seu "remover". O DISP basal é o médico(a) DISP do 4092: vale
 * enquanto nenhum enfermeiro(a) for declarado no DISP.
 * Demais: só leitura.
 * Escala fora do ar: aceita o nome digitado. Regras e API em
 * app/api/mesa/enfermeiro-plantao/route.ts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { HeartPulse } from "lucide-react";
import { toast } from "sonner";
import { fetchMesa } from "@/lib/board/fetch-mesa";
import { filtrarCandidatos, type CandidatoEnfermeiro } from "@/components/board/enfermeiro-busca";
import { POSICOES_ENFERMEIRO, ROTULO_POSICAO, type PosicaoEnfermeiro } from "@/modules/operational/posicao-enfermeiro";

interface EnfermeiroPublico {
    id: string;
    nome: string;
    profissionalId: string | null;
    posicao: PosicaoEnfermeiro | null;
}

/** Na ordem ADM, DISP, Fluxo; sem posição (registro antigo) no fim. */
const ordemPosicao = (item: EnfermeiroPublico) => (item.posicao ? POSICOES_ENFERMEIRO.indexOf(item.posicao) : POSICOES_ENFERMEIRO.length);
const rotuloCurto = (item: EnfermeiroPublico) => (item.posicao ? ROTULO_POSICAO[item.posicao] : "sem posição");

interface RespostaGet {
    enfermeiros: EnfermeiroPublico[];
    escalaDisponivel?: boolean;
    candidatos?: CandidatoEnfermeiro[];
}

interface Props {
    podeEditar: boolean;
    /** Muda a cada refresh do quadro (SSE): relê quem está registrado. */
    atualizadoEm: string;
    /** Médico(a) DISP na Mesa agora (medicoDisp): ocupa o DISP sem enfermeiro(a) declarado. */
    medicoDisp?: string | null;
}

type Opcao = { tipo: "escala"; candidato: CandidatoEnfermeiro } | { tipo: "digitado"; nome: string };

async function lerErro(resposta: Response, padrao: string) {
    const corpo = await resposta.json().catch(() => ({})) as { error?: string };
    return corpo.error || padrao;
}

export function EnfermeiroDoPlantao({ podeEditar, atualizadoEm, medicoDisp = null }: Props) {
    const [enfermeiros, setEnfermeiros] = useState<EnfermeiroPublico[]>([]);
    const [carregado, setCarregado] = useState(false);
    const [aberto, setAberto] = useState(false);
    const [termo, setTermo] = useState("");
    const [candidatos, setCandidatos] = useState<CandidatoEnfermeiro[] | null>(null);
    const [escalaDisponivel, setEscalaDisponivel] = useState(true);
    const [destaque, setDestaque] = useState(0);
    const [posicao, setPosicao] = useState<PosicaoEnfermeiro>("ADM");
    const [enviando, setEnviando] = useState(false);
    const listaRef = useRef<HTMLUListElement>(null);
    const enfermeirosRef = useRef(enfermeiros);
    enfermeirosRef.current = enfermeiros;
    const medicoDispRef = useRef(medicoDisp);
    medicoDispRef.current = medicoDisp;
    const enviandoRef = useRef(false);

    const recarregar = useCallback(async (comCandidatos: boolean) => {
        try {
            const resposta = await fetch(`/api/mesa/enfermeiro-plantao${comCandidatos ? "?candidatos=1" : ""}`, { cache: "no-store" });
            if (!resposta.ok) return;
            const corpo = await resposta.json() as RespostaGet;
            // Um registro em andamento manda; a leitura chega depois.
            if (!enviandoRef.current) setEnfermeiros(corpo.enfermeiros ?? []);
            if (comCandidatos) {
                setCandidatos(corpo.candidatos ?? []);
                setEscalaDisponivel(corpo.escalaDisponivel !== false);
            }
        } catch {
            // rede caiu: fica o que estava
        } finally {
            setCarregado(true);
        }
    }, []);

    useEffect(() => {
        void recarregar(false);
    }, [atualizadoEm, recarregar]);

    useEffect(() => {
        if (!aberto) return;
        setTermo("");
        setDestaque(0);
        // abre na primeira posição vaga
        setPosicao(POSICOES_ENFERMEIRO.find((p) => !enfermeirosRef.current.some((item) => item.posicao === p) && !(p === "DISP" && medicoDispRef.current)) ?? "ADM");
        void recarregar(true);
    }, [aberto, recarregar]);

    const opcoes = useMemo<Opcao[]>(() => {
        const achados = filtrarCandidatos(candidatos ?? [], termo).map((candidato) => ({ tipo: "escala" as const, candidato }));
        const digitado = termo.replace(/\s+/g, " ").trim();
        // Nome à mão: sempre disponível quando nada da escala bate (ou a escala não respondeu).
        if (digitado.length >= 3 && achados.length === 0) return [{ tipo: "digitado", nome: digitado }];
        return achados;
    }, [candidatos, termo]);

    useEffect(() => {
        setDestaque((atual) => Math.min(atual, Math.max(opcoes.length - 1, 0)));
    }, [opcoes.length]);

    useEffect(() => {
        listaRef.current?.querySelector<HTMLElement>(`[data-indice="${destaque}"]`)?.scrollIntoView({ block: "nearest" });
    }, [destaque]);

    const enviar = async (metodo: "POST" | "DELETE", opcao?: Opcao, remover?: EnfermeiroPublico) => {
        if (enviandoRef.current) return;
        const anterior = enfermeiros;
        enviandoRef.current = true;
        setEnviando(true);
        if (remover) setEnfermeiros((lista) => lista.filter((item) => item.id !== remover.id));
        setAberto(false);
        try {
            const resposta = await fetchMesa(`/api/mesa/enfermeiro-plantao${remover ? `?id=${encodeURIComponent(remover.id)}` : ""}`, {
                method: metodo,
                headers: { "Content-Type": "application/json" },
                body: opcao ? JSON.stringify(opcao.tipo === "escala" ? { posicao, profissionalId: opcao.candidato.id } : { posicao, nome: opcao.nome }) : undefined,
            });
            if (!resposta.ok) throw new Error(await lerErro(resposta, "Não foi possível registrar o enfermeiro(a)."));
            const corpo = await resposta.json() as { enfermeiros: EnfermeiroPublico[] };
            setEnfermeiros(corpo.enfermeiros);
            toast.success(remover ? `${remover.nome} removido(a) do plantão.` : `Enfermeiro(a) registrado(a) em ${ROTULO_POSICAO[posicao]}.`);
        } catch (erro) {
            setEnfermeiros(anterior);
            toast.error(erro instanceof Error ? erro.message : "Não foi possível registrar o enfermeiro(a).");
        } finally {
            enviandoRef.current = false;
            setEnviando(false);
        }
    };

    const aoTeclar = (evento: React.KeyboardEvent<HTMLInputElement>) => {
        if (evento.key === "ArrowDown") {
            evento.preventDefault();
            setDestaque((atual) => Math.min(atual + 1, opcoes.length - 1));
        } else if (evento.key === "ArrowUp") {
            evento.preventDefault();
            setDestaque((atual) => Math.max(atual - 1, 0));
        } else if (evento.key === "Enter") {
            evento.preventDefault();
            const opcao = opcoes[destaque];
            if (opcao) void enviar("POST", opcao);
        }
    };

    const ordenados = [...enfermeiros].sort((a, b) => ordemPosicao(a) - ordemPosicao(b));
    // DISP sem enfermeiro(a) declarado: fica o médico(a) DISP da Mesa
    const dispMedico = medicoDisp && !enfermeiros.some((item) => item.posicao === "DISP") ? medicoDisp : null;
    const linhas = [
        ...ordenados.map((item) => ({ chave: item.id, ordem: ordemPosicao(item), posicao: rotuloCurto(item), nome: item.nome })),
        ...(dispMedico ? [{ chave: "disp-medico", ordem: POSICOES_ENFERMEIRO.indexOf("DISP"), posicao: ROTULO_POSICAO.DISP, nome: `${dispMedico} (médico)` }] : []),
    ].sort((a, b) => a.ordem - b.ordem);
    const nomes = linhas.map((item) => `${item.posicao}: ${item.nome}`).join(", ");
    const rotulo = enfermeiros.length > 0
        ? <><span className="enf-plantao__rotulo">{enfermeiros.length > 1 ? "Enfermeiros(as) do plantão:" : "Enfermeiro(a) do plantão:"}</span> <span className="enf-plantao__nomes">{linhas.map((item) => <strong key={item.chave}><small className="enf-plantao__posicao">{item.posicao}</small> {item.nome}</strong>)}</span></>
        : podeEditar
            ? <strong>Informar enfermeiro(a)</strong>
            : <span className="enf-plantao__rotulo">Enfermeiro(a) do plantão: não informado</span>;

    if (!carregado && enfermeiros.length === 0) return null;

    if (!podeEditar) {
        return (
            <span className={`enf-plantao ${enfermeiros.length > 0 ? "" : "is-vazio"}`.trim()} aria-live="polite">
                <HeartPulse size={13} strokeWidth={2.2} aria-hidden />
                {rotulo}
            </span>
        );
    }

    const idLista = "enf-plantao-lista";
    return (
        <Popover.Root open={aberto} onOpenChange={setAberto}>
            <Popover.Trigger asChild>
                <button
                    type="button"
                    className={`enf-plantao is-editavel ${enfermeiros.length > 0 ? "" : "is-vazio"} ${enviando ? "is-enviando" : ""}`.trim()}
                    aria-label={enfermeiros.length > 0 ? `Enfermeiro(a) do plantão: ${nomes}. Editar` : "Informar enfermeiro(a) do plantão"}
                >
                    <HeartPulse size={13} strokeWidth={2.2} aria-hidden />
                    {rotulo}
                </button>
            </Popover.Trigger>
            <Popover.Portal>
                <Popover.Content sideOffset={6} collisionPadding={16} align="start" className="historico-list-popover enf-plantao__painel">
                    <header>
                        <strong>Enfermeiro(a) do plantão</strong>
                        <span>Escolha a posição e depois o nome. Quem estava na posição sai.</span>
                    </header>
                    <div className="enf-plantao__posicoes" role="radiogroup" aria-label="Posição">
                        {POSICOES_ENFERMEIRO.map((p) => {
                            const atual = enfermeiros.find((item) => item.posicao === p);
                            return (
                                <button
                                    key={p}
                                    type="button"
                                    role="radio"
                                    aria-checked={posicao === p}
                                    className={posicao === p ? "is-ativa" : ""}
                                    onClick={() => setPosicao(p)}
                                >
                                    <span>{ROTULO_POSICAO[p]}</span>
                                    <small>{atual ? atual.nome : p === "DISP" && medicoDisp ? `${medicoDisp} (médico)` : "vaga"}</small>
                                </button>
                            );
                        })}
                    </div>
                    <label className="historico-list-popover__field">
                        <span>Buscar por nome ou matrícula</span>
                        <input
                            autoFocus
                            type="text"
                            role="combobox"
                            aria-expanded="true"
                            aria-controls={idLista}
                            aria-activedescendant={opcoes[destaque] ? `${idLista}-${destaque}` : undefined}
                            autoComplete="off"
                            spellCheck={false}
                            value={termo}
                            placeholder={escalaDisponivel ? "Digite para filtrar" : "Digite o nome completo"}
                            onChange={(evento) => {
                                setTermo(evento.target.value);
                                setDestaque(0);
                            }}
                            onKeyDown={aoTeclar}
                        />
                    </label>
                    {!escalaDisponivel && (
                        <p className="enf-plantao__aviso">A escala não respondeu: digite o nome. Sem a escala, o acesso ao quadro não é liberado.</p>
                    )}
                    <ul className="enf-plantao__lista" id={idLista} role="listbox" ref={listaRef}>
                        {candidatos === null && escalaDisponivel && <li className="enf-plantao__vazio">Carregando a escala…</li>}
                        {candidatos !== null && opcoes.length === 0 && (
                            <li className="enf-plantao__vazio">{termo.trim().length < 3 ? "Digite ao menos 3 letras." : "Ninguém encontrado."}</li>
                        )}
                        {opcoes.map((opcao, indice) => {
                            const chave = opcao.tipo === "escala" ? opcao.candidato.id : `digitado:${opcao.nome}`;
                            const atual = opcao.tipo === "escala" && enfermeiros.some((item) => item.profissionalId === opcao.candidato.id);
                            return (
                                <li
                                    key={chave}
                                    id={`${idLista}-${indice}`}
                                    data-indice={indice}
                                    role="option"
                                    aria-selected={indice === destaque}
                                    className={`enf-plantao__opcao ${indice === destaque ? "is-destaque" : ""} ${atual ? "is-atual" : ""}`.trim()}
                                    onMouseEnter={() => setDestaque(indice)}
                                    onMouseDown={(evento) => evento.preventDefault()}
                                    onClick={() => void enviar("POST", opcao)}
                                >
                                    {opcao.tipo === "escala" ? (
                                        <>
                                            <span>{opcao.candidato.nome}</span>
                                            {opcao.candidato.matricula ? <small>{opcao.candidato.matricula}</small> : null}
                                        </>
                                    ) : (
                                        <>
                                            <span>Registrar “{opcao.nome}”</span>
                                            <small>digitado</small>
                                        </>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                    {enfermeiros.length > 0 && (
                        <ul className="enf-plantao__atuais" aria-label="Registrados neste turno">
                            {ordenados.map((item) => (
                                <li key={item.id}>
                                    <span><small className="enf-plantao__posicao">{rotuloCurto(item)}</small> {item.nome}</span>
                                    <button type="button" onClick={() => void enviar("DELETE", undefined, item)} disabled={enviando} aria-label={`Remover ${item.nome} do plantão`}>
                                        Remover
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                    <Popover.Arrow className="historico-list-popover__arrow" />
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    );
}
