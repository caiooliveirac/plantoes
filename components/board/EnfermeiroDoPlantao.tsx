"use client";

/**
 * Enfermeiro(a) do plantão, no topo da Mesa (BoardHero). Chefia/admin abre o
 * seletor, digita (filtra na hora, sem acento, por nome ou matrícula) e
 * registra com Enter ou clique — otimista, com toast. Demais: só leitura.
 * Escala fora do ar: aceita o nome digitado. Regras e API em
 * app/api/mesa/enfermeiro-plantao/route.ts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { HeartPulse } from "lucide-react";
import { toast } from "sonner";
import { fetchMesa } from "@/lib/board/fetch-mesa";
import { filtrarCandidatos, type CandidatoEnfermeiro } from "@/components/board/enfermeiro-busca";

interface EnfermeiroPublico {
    nome: string;
    profissionalId: string | null;
}

interface RespostaGet {
    enfermeiro: EnfermeiroPublico | null;
    escalaDisponivel?: boolean;
    candidatos?: CandidatoEnfermeiro[];
}

interface Props {
    podeEditar: boolean;
    /** Muda a cada refresh do quadro (SSE): relê quem está registrado. */
    atualizadoEm: string;
}

type Opcao = { tipo: "escala"; candidato: CandidatoEnfermeiro } | { tipo: "digitado"; nome: string };

async function lerErro(resposta: Response, padrao: string) {
    const corpo = await resposta.json().catch(() => ({})) as { error?: string };
    return corpo.error || padrao;
}

export function EnfermeiroDoPlantao({ podeEditar, atualizadoEm }: Props) {
    const [enfermeiro, setEnfermeiro] = useState<EnfermeiroPublico | null>(null);
    const [carregado, setCarregado] = useState(false);
    const [aberto, setAberto] = useState(false);
    const [termo, setTermo] = useState("");
    const [candidatos, setCandidatos] = useState<CandidatoEnfermeiro[] | null>(null);
    const [escalaDisponivel, setEscalaDisponivel] = useState(true);
    const [destaque, setDestaque] = useState(0);
    const [enviando, setEnviando] = useState(false);
    const listaRef = useRef<HTMLUListElement>(null);
    const enviandoRef = useRef(false);

    const recarregar = useCallback(async (comCandidatos: boolean) => {
        try {
            const resposta = await fetch(`/api/mesa/enfermeiro-plantao${comCandidatos ? "?candidatos=1" : ""}`, { cache: "no-store" });
            if (!resposta.ok) return;
            const corpo = await resposta.json() as RespostaGet;
            // Um registro em andamento manda; a leitura chega depois.
            if (!enviandoRef.current) setEnfermeiro(corpo.enfermeiro);
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

    const enviar = async (metodo: "POST" | "DELETE", opcao?: Opcao) => {
        if (enviandoRef.current) return;
        const anterior = enfermeiro;
        const otimista = opcao
            ? { nome: opcao.tipo === "escala" ? opcao.candidato.nome : opcao.nome, profissionalId: opcao.tipo === "escala" ? opcao.candidato.id : null }
            : null;
        enviandoRef.current = true;
        setEnviando(true);
        setEnfermeiro(otimista);
        setAberto(false);
        try {
            const resposta = await fetchMesa("/api/mesa/enfermeiro-plantao", {
                method: metodo,
                headers: { "Content-Type": "application/json" },
                body: opcao ? JSON.stringify(opcao.tipo === "escala" ? { profissionalId: opcao.candidato.id } : { nome: opcao.nome }) : undefined,
            });
            if (!resposta.ok) throw new Error(await lerErro(resposta, "Não foi possível registrar o enfermeiro(a)."));
            const corpo = await resposta.json() as { enfermeiro: EnfermeiroPublico | null };
            setEnfermeiro(corpo.enfermeiro);
            toast.success(corpo.enfermeiro ? `Enfermeiro(a) do plantão: ${corpo.enfermeiro.nome}.` : "Enfermeiro(a) do plantão removido(a).");
        } catch (erro) {
            setEnfermeiro(anterior);
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

    const rotulo = enfermeiro
        ? <><span className="enf-plantao__rotulo">Enfermeiro(a) do plantão:</span> <strong>{enfermeiro.nome}</strong></>
        : podeEditar
            ? <strong>Informar enfermeiro(a)</strong>
            : <span className="enf-plantao__rotulo">Enfermeiro(a) do plantão: não informado</span>;

    if (!carregado && !enfermeiro) return null;

    if (!podeEditar) {
        return (
            <span className={`enf-plantao ${enfermeiro ? "" : "is-vazio"}`.trim()} aria-live="polite">
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
                    className={`enf-plantao is-editavel ${enfermeiro ? "" : "is-vazio"} ${enviando ? "is-enviando" : ""}`.trim()}
                    aria-label={enfermeiro ? `Enfermeiro(a) do plantão: ${enfermeiro.nome}. Trocar` : "Informar enfermeiro(a) do plantão"}
                >
                    <HeartPulse size={13} strokeWidth={2.2} aria-hidden />
                    {rotulo}
                </button>
            </Popover.Trigger>
            <Popover.Portal>
                <Popover.Content sideOffset={6} collisionPadding={16} align="start" className="historico-list-popover enf-plantao__painel">
                    <header>
                        <strong>Enfermeiro(a) do plantão</strong>
                        <span>{enfermeiro ? `Agora: ${enfermeiro.nome}` : "Ninguém registrado neste turno"}</span>
                    </header>
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
                            const atual = opcao.tipo === "escala" && enfermeiro?.profissionalId === opcao.candidato.id;
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
                    {enfermeiro && (
                        <div className="historico-list-popover__actions">
                            <button type="button" className="historico-list-popover__cancel" onClick={() => void enviar("DELETE")} disabled={enviando}>
                                Remover do turno
                            </button>
                        </div>
                    )}
                    <Popover.Arrow className="historico-list-popover__arrow" />
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    );
}
