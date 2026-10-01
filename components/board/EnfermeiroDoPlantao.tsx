"use client";

/**
 * Enfermeiros(as) do plantão (vários por turno), no topo da Mesa (BoardHero).
 * Chefia/admin abre o seletor, digita (filtra na hora, sem acento, por nome
 * ou matrícula) e acrescenta com Enter ou clique; cada um tem seu "remover".
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

interface EnfermeiroPublico {
    id: string;
    nome: string;
    profissionalId: string | null;
}

interface RespostaGet {
    enfermeiros: EnfermeiroPublico[];
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
    const [enfermeiros, setEnfermeiros] = useState<EnfermeiroPublico[]>([]);
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
                body: opcao ? JSON.stringify(opcao.tipo === "escala" ? { profissionalId: opcao.candidato.id } : { nome: opcao.nome }) : undefined,
            });
            if (!resposta.ok) throw new Error(await lerErro(resposta, "Não foi possível registrar o enfermeiro(a)."));
            const corpo = await resposta.json() as { enfermeiros: EnfermeiroPublico[] };
            setEnfermeiros(corpo.enfermeiros);
            toast.success(remover ? `${remover.nome} removido(a) do plantão.` : "Enfermeiro(a) acrescentado(a) ao plantão.");
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

    const nomes = enfermeiros.map((item) => item.nome).join(", ");
    const rotulo = enfermeiros.length > 0
        ? <><span className="enf-plantao__rotulo">{enfermeiros.length > 1 ? "Enfermeiros(as) do plantão:" : "Enfermeiro(a) do plantão:"}</span> <span className="enf-plantao__nomes">{enfermeiros.map((item) => <strong key={item.id}>{item.nome}</strong>)}</span></>
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
                        <span>{enfermeiros.length > 0 ? "Escolha para acrescentar mais um" : "Ninguém registrado neste turno"}</span>
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
                            {enfermeiros.map((item) => (
                                <li key={item.id}>
                                    <span>{item.nome}</span>
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
