/* ==========================================================================
   Análise de uso de uma conta — o coração do monitor de acessos
   (docs/monitor-acessos.md). Puro: recebe sessões, janelas de presença e
   eventos já lidos do banco e devolve achados em português, cada um com a
   evidência que o sustenta.

   A pergunta central é "a mesma conta estava aberta em dois lugares ao mesmo
   tempo?". A unidade de tempo é a janela de 5 minutos (auth_session_activity);
   a de lugar é a rede (modules/acessos/rede.ts). Uma janela é SIMULTÂNEA quando
   nela aparecem duas sessões diferentes em redes diferentes. Janelas simultâneas
   seguidas viram um EPISÓDIO, classificado em forte / moderado / fraco.

   O que torna um episódio forte é USO nos dois lados ao mesmo tempo — toque,
   clique ou tecla registrados pelo quadro (cabeçalho x-mesa-uso) ou páginas e
   ações abertas — e não só a aba aberta: aba esquecida no computador de casa
   continua consultando o quadro sozinha. Os limites estão em LIMITES e cada um
   tem o porquê no doc.
   ========================================================================== */
import type { GeoAcesso } from "@/lib/acessos/contexto";
import { descreverAparelho, type Aparelho, type TipoAparelho } from "@/modules/acessos/aparelho";
import { chaveDeRede, descreverLocal, distanciaKm, familiaDoIp, temPosicaoDeCidade, type Provedor } from "@/modules/acessos/rede";
import { duracao, intervalo, lista, plural, quando } from "@/modules/acessos/texto";
import { ehOperadorDaCentral } from "@/modules/auth/contracts";

export const JANELA_MS = 5 * 60_000;
/** Sessão com pedido nos últimos 5 minutos = aberta agora. */
export const ABERTA_AGORA_MS = 5 * 60_000;
/** Rede vista em 3+ contas no período = uso coletivo (Central, hospital, base). */
export const CONTAS_REDE_COLETIVA = 3;

export const LIMITES = {
    /** Duas janelas simultâneas separadas por até uma janela vazia continuam o mesmo episódio. */
    folgaEntreJanelasMs: 2 * JANELA_MS,
    /** Cidades a partir desta distância não são "a mesma casa". */
    distanciaRelevanteKm: 50,
    /** Abaixo disto, uma rede IPv4 e outra IPv6 podem ser a mesma casa. */
    distanciaMesmaCasaKm: 30,
    /** Dois computadores (ou dois celulares) em uso em redes diferentes: janelas para forte. */
    janelasUsoMesmoTipo: 2,
    /** Celular + computador em uso: uma pessoa alterna entre os dois; exige mais para forte. */
    janelasUsoCelularComputador: 4,
    janelasVisiveisModerado: 2,
    duracaoModeradoMs: 30 * 60_000,
    velocidadeImpossivelKmH: 800,
    distanciaDeslocamentoKm: 300,
    aparelhosAtencao: 5,
    redesDeSenhaEm24h: 3,
    falhasDeSenhaAtencao: 5,
    /** Mesma sessão em duas redes da mesma família ao mesmo tempo, em N janelas: cookie copiado? */
    janelasMesmaSessaoDuasRedes: 3,
    /** Presença na Mesa (docs/presenca-mesa.md): a vez trocando de aparelho N vezes em 30 min = ping-pong. */
    trocasDeAparelhoPingPong: 4,
    janelaPingPongMs: 30 * 60_000,
    /** Mesa negada a um aparelho com gente mexendo nos dois lados há no máximo isto. */
    humanoSimultaneoSeg: 120,
} as const;

export type Nivel = "forte" | "atencao" | "normal";
export type NivelAchado = "forte" | "atencao" | "info";
export type ForcaEpisodio = "forte" | "moderado" | "fraco";

export interface ContaMonitorada {
    userId: string;
    email: string;
    nome: string | null;
    papeis: string[];
    ativa: boolean;
    /** users.session_version agora — sessão com versão menor já morreu. */
    versaoSessao: number;
}

export interface SessaoMonitorada {
    id: string;
    origem: string;
    versao: number;
    criadaEm: Date;
    ipCriacao: string | null;
    userAgent: string | null;
    geoCriacao: GeoAcesso;
    vistaEm: Date | null;
    ultimoIp: string | null;
    encerradaEm: Date | null;
    motivoEncerramento: string | null;
}

export interface JanelaDeAtividade {
    sessaoId: string;
    ip: string;
    inicio: Date;
    primeira: Date;
    ultima: Date;
    pedidos: number;
    visiveis: number;
    emUso: number;
}

export interface EventoDeSessao {
    em: Date;
    tipo: string;
    sessaoId: string | null;
    metodo: string | null;
    caminho: string | null;
    ip: string | null;
    userAgent: string | null;
    geo: GeoAcesso;
    detalhes: Record<string, unknown>;
}

/** O que se sabe de uma rede no período (todas as contas): lugar, provedor, quantas contas a usam. */
export interface InfoDeRede {
    geo: GeoAcesso;
    provedor: Provedor | null;
    contas: number;
    /** Plantonistas diferentes vistos nela DURANTE o próprio plantão. 2+ = rede do plantão (Central, base). */
    plantonistas?: number;
}

/** Um turno do dono da conta (ocupação na regulação ou na intervenção). */
export interface Plantao {
    inicio: Date;
    fim: Date;
    /** "Regulação 1363", "Intervenção BR60". */
    rotulo: string;
}

export interface EntradaAnalise {
    conta: ContaMonitorada;
    sessoes: SessaoMonitorada[];
    janelas: JanelaDeAtividade[];
    eventos: EventoDeSessao[];
    /** Por chave de rede (chaveDeRede). */
    redes: Map<string, InfoDeRede>;
    agora: Date;
    /** Turnos do médico da conta no período. `undefined` = conta sem médico vinculado (sem escala para comparar). */
    plantoes?: Plantao[];
}

export interface LadoDoEpisodio {
    sessaoId: string;
    rede: string;
    aparelho: Aparelho;
    pedidos: number;
    visiveis: number;
    emUso: number;
    interacoes: number;
    primeira: Date;
    ultima: Date;
}

export interface EpisodioSimultaneo {
    inicio: Date;
    fim: Date;
    duracaoMs: number;
    lados: LadoDoEpisodio[];
    redes: string[];
    janelas: number;
    janelasComUsoNosDois: number;
    janelasVisiveisNosDois: number;
    distanciaKm: number | null;
    forca: ForcaEpisodio;
    motivos: string[];
    ressalvas: string[];
    /** O dono estava de plantão durante o episódio? E todos os aparelhos na rede do plantão? */
    plantao: { rotulo: string; todosNaRedeDoPlantao: boolean; aparelhosFora: string[] } | null;
}

export interface DeslocamentoImprovavel {
    deRede: string;
    paraRede: string;
    deLocal: string;
    paraLocal: string;
    saiuEm: Date;
    chegouEm: Date;
    distanciaKm: number;
    velocidadeKmH: number;
}

export interface Achado {
    nivel: NivelAchado;
    titulo: string;
    texto: string;
    evidencias: string[];
}

export interface ResumoAparelho {
    descricao: string;
    tipo: TipoAparelho;
    userAgent: string | null;
    sessoes: number;
    redes: number;
    primeiraVez: Date;
    ultimaVez: Date | null;
    /** Só usado na rede do plantão, durante turnos do dono (PC da Central): não conta em "muitos aparelhos". */
    doPlantao: boolean;
}

export interface ResumoLugar {
    rede: string;
    local: string | null;
    provedor: string | null;
    servidor: boolean;
    coletiva: boolean;
    /** Na rede do plantão (faixa onde os plantonistas trabalham, ver redeDoPlantao). */
    plantao: boolean;
    plantonistas: number;
    contas: number;
    sessoes: number;
    pedidos: number;
    primeiraVez: Date;
    ultimaVez: Date;
}

export interface ResumoSessao {
    id: string;
    origem: string;
    aparelho: string;
    criadaEm: Date;
    redeDeEntrada: string | null;
    localDeEntrada: string | null;
    ultimaVez: Date | null;
    redes: number;
    pedidos: number;
    situacao: "aberta" | "inativa" | "encerrada";
    motivoEncerramento: string | null;
}

export interface EntradaComSenha {
    em: Date;
    via: "portal" | "login";
    ok: boolean;
    rede: string | null;
    local: string | null;
}

export interface AnaliseDaConta {
    conta: ContaMonitorada;
    nivel: Nivel;
    pontuacao: number;
    resumo: string;
    achados: Achado[];
    episodios: EpisodioSimultaneo[];
    deslocamentos: DeslocamentoImprovavel[];
    aparelhos: ResumoAparelho[];
    lugares: ResumoLugar[];
    sessoes: ResumoSessao[];
    entradasComSenha: EntradaComSenha[];
    abertaAgora: { sessoes: number; redes: number };
    ultimaAtividade: Date | null;
    /** Escala do dono no período (null = conta sem médico vinculado). */
    plantao: {
        turnos: number;
        agora: Plantao | null;
        /** Minutos de uso na rede do plantão fora de qualquer turno do dono. */
        minutosNaRedeForaDoTurno: number;
    } | null;
}

const INTERACOES = new Set(["pagina", "acao"]);
const SEM_REDE: InfoDeRede = { geo: {}, provedor: null, contas: 1 };

function infoDe(redes: Map<string, InfoDeRede>, chave: string) {
    return redes.get(chave) ?? SEM_REDE;
}

export function redeColetiva(info: InfoDeRede) {
    return info.contas >= CONTAS_REDE_COLETIVA;
}

/** Rede do plantão: faixa (/24) onde 3+ plantonistas diferentes usaram a Mesa num
    computador durante o próprio turno — a Central, que sai por vários IPs.
    Celular não conta para formar a rede: faixa de operadora 4G junta estranhos. */
export const PLANTONISTAS_REDE_DO_PLANTAO = 3;
export function redeDoPlantao(info: InfoDeRede) {
    return (info.plantonistas ?? 0) >= PLANTONISTAS_REDE_DO_PLANTAO;
}

/** Folga em volta do turno: chega antes, sai depois, a Mesa fica aberta um pouco. */
export const FOLGA_DO_PLANTAO_MS = 30 * 60_000;

export function plantaoEm(plantoes: Plantao[] | undefined, momento: Date, folgaMs = FOLGA_DO_PLANTAO_MS) {
    if (!plantoes) return null;
    const t = momento.getTime();
    return plantoes.find((p) => t >= p.inicio.getTime() - folgaMs && t <= p.fim.getTime() + folgaMs) ?? null;
}

/** "rede 187.12.34.56 (Salvador-BA · Oi)" + aviso de rede do plantão ou coletiva. */
export function descreverRede(chave: string, info: InfoDeRede = SEM_REDE) {
    const partes = [descreverLocal(info.geo), info.provedor?.nome].filter(Boolean);
    const detalhe = partes.length ? ` (${partes.join(" · ")})` : "";
    const coletiva = redeDoPlantao(info)
        ? `, rede do plantão (faixa onde ${info.plantonistas} plantonistas trabalharam)`
        : redeColetiva(info) ? `, usada por ${info.contas} contas (rede coletiva)` : "";
    return `rede ${chave}${detalhe}${coletiva}`;
}

function inicioDaJanela(data: Date) {
    return Math.floor(data.getTime() / JANELA_MS) * JANELA_MS;
}

interface Presenca {
    sessaoId: string;
    rede: string;
    pedidos: number;
    visiveis: number;
    emUso: number;
    interacoes: number;
    primeira: Date;
    ultima: Date;
}

const emUso = (p: Presenca) => p.emUso > 0 || p.interacoes > 0;
const visivel = (p: Presenca) => p.visiveis > 0 || p.interacoes > 0;

/** Presenças por janela: (sessão × rede) somadas, com as interações (páginas/ações) da janela. */
function presencasPorJanela(janelas: JanelaDeAtividade[], eventos: EventoDeSessao[]) {
    const porJanela = new Map<number, Map<string, Presenca>>();
    const pegar = (inicio: number, sessaoId: string, rede: string, primeira: Date, ultima: Date) => {
        let mapa = porJanela.get(inicio);
        if (!mapa) {
            mapa = new Map();
            porJanela.set(inicio, mapa);
        }
        const chave = `${sessaoId}|${rede}`;
        let presenca = mapa.get(chave);
        if (!presenca) {
            presenca = { sessaoId, rede, pedidos: 0, visiveis: 0, emUso: 0, interacoes: 0, primeira, ultima };
            mapa.set(chave, presenca);
        }
        if (primeira < presenca.primeira) presenca.primeira = primeira;
        if (ultima > presenca.ultima) presenca.ultima = ultima;
        return presenca;
    };
    for (const janela of janelas) {
        const presenca = pegar(inicioDaJanela(janela.inicio), janela.sessaoId, chaveDeRede(janela.ip), janela.primeira, janela.ultima);
        presenca.pedidos += janela.pedidos;
        presenca.visiveis += janela.visiveis;
        presenca.emUso += janela.emUso;
    }
    for (const evento of eventos) {
        if (!evento.sessaoId || !evento.ip || !INTERACOES.has(evento.tipo)) continue;
        pegar(inicioDaJanela(evento.em), evento.sessaoId, chaveDeRede(evento.ip), evento.em, evento.em).interacoes += 1;
    }
    return porJanela;
}

/** Pares (a, b) de sessões diferentes em redes diferentes dentro de uma janela. */
function paresCruzados(presencas: Presenca[]) {
    const pares: Array<[Presenca, Presenca]> = [];
    for (let i = 0; i < presencas.length; i += 1) {
        for (let j = i + 1; j < presencas.length; j += 1) {
            const a = presencas[i];
            const b = presencas[j];
            if (a.sessaoId !== b.sessaoId && a.rede !== b.rede) pares.push([a, b]);
        }
    }
    return pares;
}

/** Momento em que a 2ª rede apareceu e em que a penúltima saiu: o trecho em que havia duas ao mesmo tempo. */
function trechoSobreposto(presencas: Presenca[]) {
    const porRede = new Map<string, { primeira: number; ultima: number }>();
    for (const p of presencas) {
        const atual = porRede.get(p.rede);
        porRede.set(p.rede, {
            primeira: Math.min(atual?.primeira ?? Infinity, p.primeira.getTime()),
            ultima: Math.max(atual?.ultima ?? -Infinity, p.ultima.getTime()),
        });
    }
    const primeiras = [...porRede.values()].map((r) => r.primeira).sort((x, y) => x - y);
    const ultimas = [...porRede.values()].map((r) => r.ultima).sort((x, y) => y - x);
    return { inicio: primeiras[1] ?? primeiras[0], fim: ultimas[1] ?? ultimas[0] };
}

function combinacaoDeUmaPessoa(tipos: Set<TipoAparelho>) {
    // Celular/tablet + computador: a mesma pessoa pode ter os dois abertos (celular no 4G, PC no Wi-Fi).
    const moveis = tipos.has("celular") || tipos.has("tablet");
    return moveis && tipos.has("computador") && tipos.size === 2;
}

interface JanelaSimultanea {
    inicio: number;
    presencas: Presenca[];
    usoNosDois: boolean;
    visivelNosDois: boolean;
    tiposEmUso: Set<TipoAparelho>;
    trecho: { inicio: number; fim: number };
}

function classificarEpisodio(
    janelas: JanelaSimultanea[],
    aparelhoDe: (sessaoId: string) => Aparelho,
    redes: Map<string, InfoDeRede>,
): EpisodioSimultaneo {
    const lados = new Map<string, LadoDoEpisodio>();
    for (const janela of janelas) {
        for (const p of janela.presencas) {
            const chave = `${p.sessaoId}|${p.rede}`;
            const lado = lados.get(chave);
            if (!lado) {
                lados.set(chave, {
                    sessaoId: p.sessaoId,
                    rede: p.rede,
                    aparelho: aparelhoDe(p.sessaoId),
                    pedidos: p.pedidos,
                    visiveis: p.visiveis,
                    emUso: p.emUso,
                    interacoes: p.interacoes,
                    primeira: p.primeira,
                    ultima: p.ultima,
                });
                continue;
            }
            lado.pedidos += p.pedidos;
            lado.visiveis += p.visiveis;
            lado.emUso += p.emUso;
            lado.interacoes += p.interacoes;
            if (p.primeira < lado.primeira) lado.primeira = p.primeira;
            if (p.ultima > lado.ultima) lado.ultima = p.ultima;
        }
    }
    const listaDeLados = [...lados.values()].sort((a, b) => a.primeira.getTime() - b.primeira.getTime());
    const nomesDeRede = [...new Set(listaDeLados.map((l) => l.rede))];
    const inicio = new Date(janelas[0].trecho.inicio);
    const fim = new Date(Math.max(janelas[janelas.length - 1].trecho.fim, janelas[0].trecho.inicio));
    const duracaoMs = fim.getTime() - inicio.getTime();
    const janelasComUsoNosDois = janelas.filter((j) => j.usoNosDois).length;
    const janelasVisiveisNosDois = janelas.filter((j) => j.visivelNosDois).length;

    let distancia: number | null = null;
    for (let i = 0; i < nomesDeRede.length; i += 1) {
        for (let j = i + 1; j < nomesDeRede.length; j += 1) {
            const a = infoDe(redes, nomesDeRede[i]).geo;
            const b = infoDe(redes, nomesDeRede[j]).geo;
            if (temPosicaoDeCidade(a) && temPosicaoDeCidade(b)) {
                distancia = Math.max(distancia ?? 0, distanciaKm(a, b));
            }
        }
    }

    const tiposEmUso = new Set<TipoAparelho>();
    for (const janela of janelas) for (const tipo of janela.tiposEmUso) tiposEmUso.add(tipo);
    const umaPessoaPlausivel = combinacaoDeUmaPessoa(tiposEmUso);
    const todasColetivas = nomesDeRede.every((rede) => redeColetiva(infoDe(redes, rede)));
    const soIpv4xIpv6 = nomesDeRede.length === 2 && familiaDoIp(nomesDeRede[0]) !== familiaDoIp(nomesDeRede[1]);
    const longe = distancia !== null && distancia >= LIMITES.distanciaRelevanteKm;

    const motivos: string[] = [];
    const ressalvas: string[] = [];
    let forca: ForcaEpisodio = "fraco";

    if (nomesDeRede.length >= 3 && !todasColetivas) {
        forca = "forte";
        motivos.push(`${nomesDeRede.length} redes diferentes ao mesmo tempo.`);
    }
    const janelasParaForte = umaPessoaPlausivel ? LIMITES.janelasUsoCelularComputador : LIMITES.janelasUsoMesmoTipo;
    if (janelasComUsoNosDois >= janelasParaForte) {
        forca = "forte";
        motivos.push(
            umaPessoaPlausivel
                ? `Uso ativo (toque, clique, tecla ou página aberta) nos dois lugares em ${janelasComUsoNosDois} janelas de 5 minutos — mais do que alternar entre celular e computador.`
                : tiposEmUso.has("computador") && !tiposEmUso.has("celular") && !tiposEmUso.has("tablet")
                    ? `Dois computadores em redes diferentes sendo usados ao mesmo tempo, em ${janelasComUsoNosDois} janelas de 5 minutos — uma pessoa não opera dois computadores em dois lugares.`
                    : `Uso ativo nos dois aparelhos ao mesmo tempo em ${janelasComUsoNosDois} janelas de 5 minutos.`,
        );
    }
    if (longe && janelasVisiveisNosDois >= LIMITES.janelasVisiveisModerado) {
        forca = "forte";
        motivos.push(`Cidades a ${Math.round(distancia!)} km uma da outra, com a tela aberta nos dois lugares.`);
    }
    if (forca === "fraco") {
        if (janelasComUsoNosDois >= 1) {
            forca = "moderado";
            motivos.push(`Uso ativo nos dois lugares em ${plural(janelasComUsoNosDois, "janela", "janelas")} de 5 minutos.`);
        } else if (janelasVisiveisNosDois >= LIMITES.janelasVisiveisModerado) {
            forca = "moderado";
            motivos.push(`Tela à vista nos dois lugares em ${janelasVisiveisNosDois} janelas de 5 minutos.`);
        } else if (duracaoMs >= LIMITES.duracaoModeradoMs) {
            forca = "moderado";
            motivos.push(`Aberta nos dois lugares por ${duracao(duracaoMs)}.`);
        } else if (longe) {
            forca = "moderado";
            motivos.push(`Cidades a ${Math.round(distancia!)} km uma da outra.`);
        }
    }
    if (motivos.length === 0) {
        motivos.push(`Sobreposição de ${duracao(duracaoMs)} sem sinal de uso nos dois lados.`);
    }

    const rebaixar = (motivo: string) => {
        ressalvas.push(motivo);
        forca = forca === "forte" ? "moderado" : "fraco";
    };
    if (todasColetivas && forca !== "fraco") {
        rebaixar("As redes são de uso coletivo (várias contas passam por elas): pode ser o mesmo prédio com duas saídas de internet.");
    } else if (soIpv4xIpv6 && !longe && (distancia === null || distancia < LIMITES.distanciaMesmaCasaKm) && forca !== "fraco") {
        rebaixar("Uma rede é IPv4 e a outra IPv6: podem ser dois aparelhos da mesma casa, cada um num tipo de conexão.");
    }
    if (umaPessoaPlausivel && forca !== "forte") {
        ressalvas.push("Celular e computador ao mesmo tempo podem ser a mesma pessoa (celular no 4G, computador no Wi-Fi).");
    }
    if (janelasComUsoNosDois === 0) {
        ressalvas.push("Sem uso ativo nos dois lados ao mesmo tempo: pode ser uma aba esquecida aberta em um deles.");
    }
    if (distancia !== null) {
        ressalvas.push("Localização por IP é aproximada; operadora de celular pode aparecer em outra cidade.");
    }

    return {
        inicio,
        fim,
        duracaoMs,
        lados: listaDeLados,
        redes: nomesDeRede,
        janelas: janelas.length,
        janelasComUsoNosDois,
        janelasVisiveisNosDois,
        distanciaKm: distancia,
        forca,
        motivos,
        ressalvas,
        plantao: null,
    };
}

export function detectarEpisodios(
    janelas: JanelaDeAtividade[],
    eventos: EventoDeSessao[],
    aparelhoDe: (sessaoId: string) => Aparelho,
    redes: Map<string, InfoDeRede>,
): { episodios: EpisodioSimultaneo[]; janelasMesmaSessaoDuasRedes: number } {
    const porJanela = presencasPorJanela(janelas, eventos);
    const simultaneas: JanelaSimultanea[] = [];
    let janelasMesmaSessaoDuasRedes = 0;
    for (const [inicio, mapa] of [...porJanela.entries()].sort((a, b) => a[0] - b[0])) {
        const presencas = [...mapa.values()];
        // Mesma sessão em duas redes da mesma família (dois IPv4, por exemplo) na mesma janela.
        const redesPorSessao = new Map<string, Set<string>>();
        for (const p of presencas) {
            const conjunto = redesPorSessao.get(p.sessaoId) ?? new Set<string>();
            conjunto.add(p.rede);
            redesPorSessao.set(p.sessaoId, conjunto);
        }
        for (const conjunto of redesPorSessao.values()) {
            const familias = [...conjunto].map(familiaDoIp);
            if (familias.filter((f) => f === 4).length >= 2 || familias.filter((f) => f === 6).length >= 2) {
                janelasMesmaSessaoDuasRedes += 1;
                break;
            }
        }

        const pares = paresCruzados(presencas);
        if (pares.length === 0) continue;
        const participantes = new Set<Presenca>(pares.flat());
        const tiposEmUso = new Set<TipoAparelho>();
        let usoNosDois = false;
        let visivelNosDois = false;
        for (const [a, b] of pares) {
            if (emUso(a) && emUso(b)) {
                usoNosDois = true;
                tiposEmUso.add(aparelhoDe(a.sessaoId).tipo);
                tiposEmUso.add(aparelhoDe(b.sessaoId).tipo);
            }
            if (visivel(a) && visivel(b)) visivelNosDois = true;
        }
        const envolvidas = [...participantes];
        simultaneas.push({ inicio, presencas: envolvidas, usoNosDois, visivelNosDois, tiposEmUso, trecho: trechoSobreposto(envolvidas) });
    }

    const episodios: EpisodioSimultaneo[] = [];
    let grupo: JanelaSimultanea[] = [];
    for (const janela of simultaneas) {
        const anterior = grupo[grupo.length - 1];
        if (anterior && janela.inicio - anterior.inicio > LIMITES.folgaEntreJanelasMs) {
            episodios.push(classificarEpisodio(grupo, aparelhoDe, redes));
            grupo = [];
        }
        grupo.push(janela);
    }
    if (grupo.length > 0) episodios.push(classificarEpisodio(grupo, aparelhoDe, redes));
    return { episodios, janelasMesmaSessaoDuasRedes };
}

/* Plantão: quem está de plantão usa a Mesa o turno inteiro, às vezes em dois
   PCs da Central — é trabalho, não senha emprestada. O turno do dono muda o
   peso do episódio:
   - de plantão e todos os aparelhos na rede do plantão → fraco (uso de trabalho);
   - de plantão na rede do plantão e a conta em uso num COMPUTADOR fora dela →
     forte (alguém usando o login enquanto o dono trabalha);
   - de plantão e o aparelho de fora é celular → desce um nível (pode ser o dele, no 4G).
   Fora do turno, todos os aparelhos na rede do plantão = o mesmo lugar (a Central
   sai por vários IPs): chefia/coordenação trabalha lá → fraco; os demais descem
   um nível e o achado "Na rede do plantão fora do turno do dono" fala por eles. */
export function aplicarPlantao(
    episodio: EpisodioSimultaneo,
    plantoes: Plantao[] | undefined,
    redes: Map<string, InfoDeRede>,
    gestao = false,
): EpisodioSimultaneo {
    const naRede = episodio.lados.filter((lado) => redeDoPlantao(infoDe(redes, lado.rede)));
    const fora = episodio.lados.filter((lado) => !redeDoPlantao(infoDe(redes, lado.rede)));
    const meio = new Date((episodio.inicio.getTime() + episodio.fim.getTime()) / 2);
    const plantao = plantaoEm(plantoes, meio) ?? plantaoEm(plantoes, episodio.inicio) ?? plantaoEm(plantoes, episodio.fim);
    if (!plantao) {
        if (fora.length > 0) return episodio;
        if (gestao) {
            return {
                ...episodio,
                forca: "fraco",
                motivos: ["Chefia/coordenação/operador da Central com todos os aparelhos na rede do plantão — a Central sai por vários IPs; é o mesmo lugar."],
                ressalvas: [],
            };
        }
        return {
            ...episodio,
            forca: episodio.forca === "forte" ? "moderado" : "fraco",
            ressalvas: [
                ...episodio.ressalvas,
                "Todos os aparelhos estavam na rede do plantão (a Central sai por vários IPs), mas fora do turno do dono.",
            ],
        };
    }
    const contexto = { rotulo: plantao.rotulo, todosNaRedeDoPlantao: fora.length === 0, aparelhosFora: fora.map((lado) => lado.aparelho.descricao) };
    if (fora.length === 0) {
        return {
            ...episodio,
            forca: "fraco",
            plantao: contexto,
            motivos: [`De plantão (${plantao.rotulo}), com todos os aparelhos na rede do plantão — a mesma dos outros plantonistas. Uso de trabalho.`],
            ressalvas: [],
        };
    }
    if (naRede.length === 0) {
        return {
            ...episodio,
            plantao: contexto,
            ressalvas: [...episodio.ressalvas, `O dono estava de plantão (${plantao.rotulo}), mas nenhum aparelho estava numa rede de plantão conhecida.`],
        };
    }
    const descricaoFora = fora.map((lado) => `${lado.aparelho.descricao} na ${descreverRede(lado.rede, infoDe(redes, lado.rede))}`);
    const motivos = [
        `O dono estava de plantão (${plantao.rotulo}) na rede do plantão e, ao mesmo tempo, a conta estava aberta fora dela: ${lista(descricaoFora)}.`,
        ...episodio.motivos,
    ];
    const computadorFora = fora.some((lado) => (lado.emUso > 0 || lado.interacoes > 0) && lado.aparelho.tipo === "computador");
    if (computadorFora) {
        return {
            ...episodio,
            forca: "forte",
            plantao: contexto,
            motivos: [...motivos, "Um computador fora da rede do plantão estava em uso enquanto o dono trabalhava — não é o celular dele."],
            ressalvas: episodio.ressalvas.filter((r) => !/mesma pessoa/.test(r)),
        };
    }
    const soCelular = fora.every((lado) => lado.aparelho.tipo === "celular" || lado.aparelho.tipo === "tablet");
    if (!soCelular) return { ...episodio, plantao: contexto, motivos };
    return {
        ...episodio,
        forca: episodio.forca === "forte" ? "moderado" : "fraco",
        plantao: contexto,
        motivos,
        ressalvas: [...episodio.ressalvas, "O aparelho fora da rede do plantão é um celular: pode ser o do próprio plantonista, no 4G."],
    };
}

/** Pontos consecutivos em cidades distantes com tempo curto demais entre eles. */
export function detectarDeslocamentos(janelas: JanelaDeAtividade[], redes: Map<string, InfoDeRede>): DeslocamentoImprovavel[] {
    const pontos = janelas
        .map((j) => ({ rede: chaveDeRede(j.ip), primeira: j.primeira, ultima: j.ultima }))
        .filter((p) => temPosicaoDeCidade(infoDe(redes, p.rede).geo))
        .sort((a, b) => a.primeira.getTime() - b.primeira.getTime());
    const porPar = new Map<string, DeslocamentoImprovavel>();
    for (let i = 1; i < pontos.length; i += 1) {
        const de = pontos[i - 1];
        const para = pontos[i];
        if (de.rede === para.rede) continue;
        const geoDe = infoDe(redes, de.rede).geo;
        const geoPara = infoDe(redes, para.rede).geo;
        if (!temPosicaoDeCidade(geoDe) || !temPosicaoDeCidade(geoPara)) continue;
        const km = distanciaKm(geoDe, geoPara);
        if (km < LIMITES.distanciaDeslocamentoKm) continue;
        const horas = Math.max(para.primeira.getTime() - de.ultima.getTime(), 60_000) / 3_600_000;
        const velocidade = km / horas;
        if (velocidade < LIMITES.velocidadeImpossivelKmH) continue;
        const chave = [de.rede, para.rede].sort().join("|");
        const atual = porPar.get(chave);
        if (!atual || velocidade > atual.velocidadeKmH) {
            porPar.set(chave, {
                deRede: de.rede,
                paraRede: para.rede,
                deLocal: descreverLocal(geoDe) ?? de.rede,
                paraLocal: descreverLocal(geoPara) ?? para.rede,
                saiuEm: de.ultima,
                chegouEm: para.primeira,
                distanciaKm: Math.round(km),
                velocidadeKmH: Math.round(velocidade),
            });
        }
    }
    return [...porPar.values()].sort((a, b) => b.velocidadeKmH - a.velocidadeKmH).slice(0, 5);
}

function descreverLado(lado: LadoDoEpisodio, redes: Map<string, InfoDeRede>) {
    const uso = lado.emUso > 0 || lado.interacoes > 0
        ? "em uso"
        : lado.visiveis > 0
            ? "tela à vista, sem toque"
            : "só aberta (sem sinal de tela à vista)";
    return `${lado.aparelho.descricao} na ${descreverRede(lado.rede, infoDe(redes, lado.rede))} — ${uso}`;
}

export function descreverEpisodio(episodio: EpisodioSimultaneo, redes: Map<string, InfoDeRede>) {
    const lados = episodio.lados.map((lado) => descreverLado(lado, redes));
    return `${intervalo(episodio.inicio, episodio.fim)} (${duracao(episodio.duracaoMs)}): ${lista(lados)}.`;
}

function entradasComSenha(eventos: EventoDeSessao[], redes: Map<string, InfoDeRede>): EntradaComSenha[] {
    const tipos: Record<string, { via: "portal" | "login"; ok: boolean }> = {
        senha_portal_ok: { via: "portal", ok: true },
        senha_portal_falhou: { via: "portal", ok: false },
        senha_login_ok: { via: "login", ok: true },
        senha_login_falhou: { via: "login", ok: false },
    };
    return eventos
        .filter((e) => tipos[e.tipo])
        .map((e) => {
            const rede = e.ip ? chaveDeRede(e.ip) : null;
            const geo = Object.keys(e.geo).length > 0 ? e.geo : rede ? infoDe(redes, rede).geo : {};
            return { em: e.em, ...tipos[e.tipo], rede, local: descreverLocal(geo) };
        })
        .sort((a, b) => a.em.getTime() - b.em.getTime());
}

/** Maior número de redes distintas com senha certa dentro de 24 h corridas. */
function maxRedesDeSenhaEm24h(entradas: EntradaComSenha[]) {
    const certas = entradas.filter((e) => e.ok && e.rede);
    let maior = 0;
    for (let i = 0; i < certas.length; i += 1) {
        const limite = certas[i].em.getTime() + 24 * 3_600_000;
        const redes = new Set<string>();
        for (let j = i; j < certas.length && certas[j].em.getTime() <= limite; j += 1) redes.add(certas[j].rede!);
        maior = Math.max(maior, redes.size);
    }
    return maior;
}

const ORDEM_FORCA: Record<ForcaEpisodio, number> = { forte: 0, moderado: 1, fraco: 2 };

export function analisarConta(entrada: EntradaAnalise): AnaliseDaConta {
    const { conta, sessoes, janelas, eventos, redes, agora } = entrada;
    const sessaoPorId = new Map(sessoes.map((s) => [s.id, s]));
    const aparelhoCache = new Map<string, Aparelho>();
    const aparelhoDe = (sessaoId: string) => {
        let aparelho = aparelhoCache.get(sessaoId);
        if (!aparelho) {
            aparelho = descreverAparelho(sessaoPorId.get(sessaoId)?.userAgent);
            aparelhoCache.set(sessaoId, aparelho);
        }
        return aparelho;
    };

    const detectados = detectarEpisodios(janelas, eventos, aparelhoDe, redes);
    // Chefia, coordenação e operadores da Central (rádio, TARM) passam na Central fora de qualquer escala.
    const papeisDeGestao = conta.papeis.some((papel) => papel === "chief" || papel === "admin") || ehOperadorDaCentral(conta.papeis);
    const episodios = detectados.episodios.map((episodio) => aplicarPlantao(episodio, entrada.plantoes, redes, papeisDeGestao));
    const { janelasMesmaSessaoDuasRedes } = detectados;
    const deslocamentos = detectarDeslocamentos(janelas, redes);
    const senhas = entradasComSenha(eventos, redes);

    // Lugares (redes) e sessões.
    const lugares = new Map<string, ResumoLugar & { sessoesSet: Set<string> }>();
    const porSessao = new Map<string, { redes: Set<string>; pedidos: number; ultima: Date | null }>();
    let ultimaAtividade: Date | null = null;
    const abertasAgora = new Set<string>();
    const redesAgora = new Set<string>();
    for (const janela of janelas) {
        const rede = chaveDeRede(janela.ip);
        const info = infoDe(redes, rede);
        const lugar = lugares.get(rede);
        if (!lugar) {
            lugares.set(rede, {
                rede,
                local: descreverLocal(info.geo),
                provedor: info.provedor?.nome ?? null,
                servidor: Boolean(info.provedor?.servidor),
                coletiva: redeColetiva(info),
                plantao: redeDoPlantao(info),
                plantonistas: info.plantonistas ?? 0,
                contas: info.contas,
                sessoes: 0,
                pedidos: janela.pedidos,
                primeiraVez: janela.primeira,
                ultimaVez: janela.ultima,
                sessoesSet: new Set([janela.sessaoId]),
            });
        } else {
            lugar.pedidos += janela.pedidos;
            lugar.sessoesSet.add(janela.sessaoId);
            if (janela.primeira < lugar.primeiraVez) lugar.primeiraVez = janela.primeira;
            if (janela.ultima > lugar.ultimaVez) lugar.ultimaVez = janela.ultima;
        }
        const s = porSessao.get(janela.sessaoId) ?? { redes: new Set<string>(), pedidos: 0, ultima: null };
        s.redes.add(rede);
        s.pedidos += janela.pedidos;
        if (!s.ultima || janela.ultima > s.ultima) s.ultima = janela.ultima;
        porSessao.set(janela.sessaoId, s);
        if (!ultimaAtividade || janela.ultima > ultimaAtividade) ultimaAtividade = janela.ultima;
        if (agora.getTime() - janela.ultima.getTime() <= ABERTA_AGORA_MS) {
            abertasAgora.add(janela.sessaoId);
            redesAgora.add(rede);
        }
    }
    for (const evento of eventos) {
        if (evento.sessaoId && INTERACOES.has(evento.tipo) && (!ultimaAtividade || evento.em > ultimaAtividade)) {
            ultimaAtividade = evento.em;
        }
    }

    const resumoSessoes: ResumoSessao[] = sessoes
        .map((sessao) => {
            const uso = porSessao.get(sessao.id);
            const ultimaVez = uso?.ultima ?? sessao.vistaEm;
            const morta = sessao.encerradaEm !== null || sessao.versao < conta.versaoSessao;
            const situacao: ResumoSessao["situacao"] = morta
                ? "encerrada"
                : ultimaVez && agora.getTime() - ultimaVez.getTime() <= ABERTA_AGORA_MS
                    ? "aberta"
                    : "inativa";
            const redeDeEntrada = sessao.ipCriacao ? chaveDeRede(sessao.ipCriacao) : null;
            const geoEntrada = Object.keys(sessao.geoCriacao).length > 0
                ? sessao.geoCriacao
                : redeDeEntrada ? infoDe(redes, redeDeEntrada).geo : {};
            return {
                id: sessao.id,
                origem: sessao.origem,
                aparelho: aparelhoDe(sessao.id).descricao,
                criadaEm: sessao.criadaEm,
                redeDeEntrada,
                localDeEntrada: descreverLocal(geoEntrada),
                ultimaVez,
                redes: uso?.redes.size ?? 0,
                pedidos: uso?.pedidos ?? 0,
                situacao,
                motivoEncerramento: sessao.encerradaEm
                    ? sessao.motivoEncerramento
                    : sessao.versao < conta.versaoSessao ? "senha trocada ou sessões encerradas" : null,
            };
        })
        .sort((a, b) => (b.ultimaVez?.getTime() ?? b.criadaEm.getTime()) - (a.ultimaVez?.getTime() ?? a.criadaEm.getTime()));

    // Sessão "do plantão": toda a presença dela foi na rede do plantão, dentro de um turno do dono.
    const foraDoPlantao = new Set<string>();
    for (const janela of janelas) {
        if (!redeDoPlantao(infoDe(redes, chaveDeRede(janela.ip))) || !plantaoEm(entrada.plantoes, janela.primeira)) foraDoPlantao.add(janela.sessaoId);
    }
    const sessaoDoPlantao = (sessaoId: string) => Boolean(entrada.plantoes?.length) && porSessao.has(sessaoId) && !foraDoPlantao.has(sessaoId);

    // Aparelhos = user-agents distintos (PCs iguais da Central viram um só).
    const aparelhos = new Map<string, ResumoAparelho & { redesSet: Set<string> }>();
    for (const sessao of sessoes) {
        const chave = sessao.userAgent ?? "(sem user-agent)";
        const uso = porSessao.get(sessao.id);
        const atual = aparelhos.get(chave);
        const ultimaVez = uso?.ultima ?? sessao.vistaEm;
        if (!atual) {
            aparelhos.set(chave, {
                descricao: aparelhoDe(sessao.id).descricao,
                tipo: aparelhoDe(sessao.id).tipo,
                userAgent: sessao.userAgent,
                sessoes: 1,
                redes: 0,
                primeiraVez: sessao.criadaEm,
                ultimaVez,
                doPlantao: sessaoDoPlantao(sessao.id),
                redesSet: new Set(uso?.redes ?? []),
            });
            continue;
        }
        atual.sessoes += 1;
        atual.doPlantao &&= sessaoDoPlantao(sessao.id);
        for (const rede of uso?.redes ?? []) atual.redesSet.add(rede);
        if (sessao.criadaEm < atual.primeiraVez) atual.primeiraVez = sessao.criadaEm;
        if (ultimaVez && (!atual.ultimaVez || ultimaVez > atual.ultimaVez)) atual.ultimaVez = ultimaVez;
    }
    const resumoAparelhos: ResumoAparelho[] = [...aparelhos.values()]
        .map(({ redesSet, ...a }) => ({ ...a, redes: redesSet.size }))
        .sort((a, b) => (b.ultimaVez?.getTime() ?? 0) - (a.ultimaVez?.getTime() ?? 0));
    const resumoLugares: ResumoLugar[] = [...lugares.values()]
        .map(({ sessoesSet, ...l }) => ({ ...l, sessoes: sessoesSet.size }))
        .sort((a, b) => b.ultimaVez.getTime() - a.ultimaVez.getTime());

    // ── Achados ────────────────────────────────────────────────────────────
    const achados: Achado[] = [];
    const ordenados = [...episodios].sort((a, b) => ORDEM_FORCA[a.forca] - ORDEM_FORCA[b.forca] || b.duracaoMs - a.duracaoMs);
    const fortes = ordenados.filter((e) => e.forca === "forte");
    const moderados = ordenados.filter((e) => e.forca === "moderado");
    const fracos = ordenados.filter((e) => e.forca === "fraco");
    const evidenciaDe = (episodio: EpisodioSimultaneo) => {
        const motivo = episodio.motivos.join(" ");
        const ressalva = episodio.ressalvas.length ? ` Ressalva: ${episodio.ressalvas.join(" ")}` : "";
        return `${descreverEpisodio(episodio, redes)} ${motivo}${ressalva}`;
    };
    if (fortes.length > 0) {
        achados.push({
            nivel: "forte",
            titulo: "Aberta ao mesmo tempo em lugares diferentes, com uso nos dois",
            texto: `${plural(fortes.length, "ocasião", "ocasiões")} em que a conta estava sendo usada em dois ou mais lugares ao mesmo tempo, `
                + "com sinais de que havia gente mexendo nos dois aparelhos. Uma pessoa sozinha não explica isso: é o padrão de senha compartilhada.",
            evidencias: fortes.slice(0, 6).map(evidenciaDe),
        });
    }
    if (moderados.length > 0) {
        achados.push({
            nivel: "atencao",
            titulo: "Aberta ao mesmo tempo em redes diferentes",
            texto: `${plural(moderados.length, "ocasião", "ocasiões")} com a conta aberta em duas redes ao mesmo tempo, sem prova de uso ativo nos dois lados. `
                + "Pode ser compartilhamento ou uma pessoa com celular e computador — a repetição é o que pesa.",
            evidencias: moderados.slice(0, 6).map(evidenciaDe),
        });
    }
    const fracosDoPlantao = fracos.filter((e) => e.plantao?.todosNaRedeDoPlantao);
    const fracosComuns = fracos.filter((e) => !e.plantao?.todosNaRedeDoPlantao);
    if (fracosDoPlantao.length > 0) {
        achados.push({
            nivel: "info",
            titulo: "Mais de um aparelho durante o plantão, todos na rede do plantão",
            texto: `${plural(fracosDoPlantao.length, "vez", "vezes")} a conta esteve aberta em mais de um aparelho enquanto o dono estava de plantão, `
                + "todos na rede onde os plantonistas trabalham — uso de trabalho (dois PCs da Central, por exemplo).",
            evidencias: fracosDoPlantao.slice(0, 4).map((e) => `${e.plantao?.rotulo}: ${descreverEpisodio(e, redes)}`),
        });
    }
    if (fracosComuns.length > 0) {
        achados.push({
            nivel: "info",
            titulo: "Sobreposições curtas",
            texto: `${plural(fracosComuns.length, "sobreposição curta", "sobreposições curtas")} entre aparelhos em redes diferentes, sem uso nos dois lados — `
                + "típico de trocar do computador para o celular com a aba ainda aberta.",
            evidencias: fracosComuns.slice(0, 4).map((e) => descreverEpisodio(e, redes)),
        });
    }
    if (deslocamentos.length > 0) {
        achados.push({
            nivel: "atencao",
            titulo: "Deslocamento impossível entre cidades",
            texto: "Acessos seguidos em cidades distantes com tempo curto demais para uma viagem. A localização por IP é aproximada, "
                + "por isso isto reforça outros sinais mas não prova sozinho.",
            evidencias: deslocamentos.map((d) => `${quando(d.saiuEm)} em ${d.deLocal} → ${quando(d.chegouEm)} em ${d.paraLocal}: `
                + `${d.distanciaKm} km, seria preciso viajar a ${d.velocidadeKmH} km/h.`),
        });
    }
    const redesDeSenha = maxRedesDeSenhaEm24h(senhas);
    if (redesDeSenha >= LIMITES.redesDeSenhaEm24h) {
        achados.push({
            nivel: "atencao",
            titulo: "Senha digitada em muitos lugares",
            texto: `A senha certa foi digitada a partir de ${redesDeSenha} redes diferentes dentro de 24 horas. Quem usa a própria senha costuma entrar de 1 ou 2 lugares.`,
            evidencias: senhas.filter((s) => s.ok).slice(-8).map((s) => `${quando(s.em)} — ${s.via === "portal" ? "portal mnrs.com.br" : "login do Plantões"}, `
                + `rede ${s.rede ?? "não informada"}${s.local ? ` (${s.local})` : ""}.`),
        });
    }
    const falhas = senhas.filter((s) => !s.ok);
    if (falhas.length >= LIMITES.falhasDeSenhaAtencao) {
        achados.push({
            nivel: "atencao",
            titulo: "Tentativas de senha errada",
            texto: `${plural(falhas.length, "tentativa", "tentativas")} com senha errada nesta conta no período.`,
            evidencias: falhas.slice(-6).map((s) => `${quando(s.em)} — ${s.via === "portal" ? "portal" : "login do Plantões"}, rede ${s.rede ?? "não informada"}.`),
        });
    }
    const aparelhosDeGente = resumoAparelhos.filter((a) => a.tipo !== "programa");
    // PCs usados só na rede do plantão durante o turno (a Central) não pesam: regulador troca de PC.
    const aparelhosPessoais = aparelhosDeGente.filter((a) => !a.doPlantao);
    if (aparelhosPessoais.length >= LIMITES.aparelhosAtencao) {
        achados.push({
            nivel: "atencao",
            titulo: "Muitos aparelhos",
            texto: `${plural(aparelhosPessoais.length, "aparelho diferente", "aparelhos diferentes")} usaram esta conta no período, fora os PCs da rede do plantão. `
                + "Uma pessoa costuma ter 2 ou 3 (celular, computador de casa, computador do trabalho).",
            evidencias: aparelhosPessoais.slice(0, 8).map((a) => `${a.descricao} — ${plural(a.sessoes, "entrada", "entradas")}, última vez ${a.ultimaVez ? quando(a.ultimaVez) : "sem uso registrado"}.`),
        });
    }

    // Na rede do plantão fora do turno do dono: um colega usando o login dele na Central?
    // Só para quem é só médico (chefia e coordenação passam na Central fora de plantão).
    let minutosNaRedeForaDoTurno = 0;
    if (entrada.plantoes && !papeisDeGestao) {
        const trechos: Array<{ inicio: Date; fim: Date; sessaoId: string; rede: string }> = [];
        const foraDoTurno = janelas
            .filter((j) => j.emUso > 0 && redeDoPlantao(infoDe(redes, chaveDeRede(j.ip))) && !plantaoEm(entrada.plantoes, j.primeira, 60 * 60_000))
            .sort((a, b) => a.primeira.getTime() - b.primeira.getTime());
        for (const janela of foraDoTurno) {
            const ultimo = trechos[trechos.length - 1];
            if (ultimo && janela.primeira.getTime() - ultimo.fim.getTime() <= LIMITES.folgaEntreJanelasMs) {
                if (janela.ultima > ultimo.fim) ultimo.fim = janela.ultima;
            } else {
                trechos.push({ inicio: janela.primeira, fim: janela.ultima, sessaoId: janela.sessaoId, rede: chaveDeRede(janela.ip) });
            }
        }
        minutosNaRedeForaDoTurno = Math.round(trechos.reduce((total, t) => total + Math.max(60_000, t.fim.getTime() - t.inicio.getTime()), 0) / 60_000);
        if (minutosNaRedeForaDoTurno >= 30) {
            achados.push({
                nivel: "atencao",
                titulo: "Na rede do plantão fora do turno do dono",
                texto: `A conta foi usada na rede onde os plantonistas trabalham por ${duracao(minutosNaRedeForaDoTurno * 60_000)} em horários em que o dono não estava de plantão. `
                    + "Pode ser o dono na Central fora do turno, um turno que não foi registrado no bot, a sessão dele esquecida aberta num PC da Central "
                    + "— ou um colega usando o login dele.",
                evidencias: trechos.slice(-5).map((t) => `${intervalo(t.inicio, t.fim)} — ${aparelhoDe(t.sessaoId).descricao} na ${descreverRede(t.rede, infoDe(redes, t.rede))}.`),
            });
        }
    }
    const programas = resumoAparelhos.filter((a) => a.tipo === "programa");
    if (programas.length > 0) {
        achados.push({
            nivel: "atencao",
            titulo: "Sessão usada fora de um navegador",
            texto: "Pedidos com a sessão desta conta vieram de um programa (não de um navegador). Pode ser alguém copiando o cookie para um robô.",
            evidencias: programas.map((a) => `${a.descricao} (${a.userAgent ?? "sem user-agent"}).`),
        });
    }
    const estrangeiros = resumoLugares.filter((l) => {
        const pais = infoDe(redes, l.rede).geo.pais;
        return pais && pais !== "BR";
    });
    if (estrangeiros.length > 0) {
        achados.push({
            nivel: "atencao",
            titulo: "Acesso de fora do Brasil",
            texto: "Houve acesso por rede localizada fora do Brasil. Pode ser viagem, VPN ou o Retransmissão Privada do iCloud.",
            evidencias: estrangeiros.map((l) => `${descreverRede(l.rede, infoDe(redes, l.rede))}: ${quando(l.primeiraVez)} a ${quando(l.ultimaVez)}.`),
        });
    }
    const servidores = resumoLugares.filter((l) => l.servidor);
    if (servidores.length > 0) {
        achados.push({
            nivel: "atencao",
            titulo: "Acesso por servidor, nuvem ou VPN",
            texto: "Houve acesso vindo de rede de datacenter ou VPN — costuma ser usado para esconder de onde se está.",
            evidencias: servidores.map((l) => `${descreverRede(l.rede, infoDe(redes, l.rede))}: ${quando(l.primeiraVez)} a ${quando(l.ultimaVez)}.`),
        });
    }
    if (janelasMesmaSessaoDuasRedes >= LIMITES.janelasMesmaSessaoDuasRedes) {
        achados.push({
            nivel: "atencao",
            titulo: "A mesma sessão em duas redes ao mesmo tempo",
            texto: `Em ${janelasMesmaSessaoDuasRedes} janelas de 5 minutos o MESMO login (mesmo cookie) apareceu em duas redes ao mesmo tempo. `
                + "Celular trocando Wi-Fi/4G explica alguns casos; muitos casos seguidos sugerem cookie copiado para outro aparelho.",
            evidencias: [],
        });
    }
    // Portão de turno (modules/acessos/portao.ts): registrado no máximo 1× a cada 10 min por sistema.
    const barrados = eventos.filter((e) => e.tipo === "barrado_fora_do_plantao");
    if (barrados.length > 0) {
        achados.push({
            nivel: "atencao",
            titulo: "Tentou abrir a Mesa ou a Tabela fora do plantão",
            texto: `${barrados.length} ${barrados.length === 1 ? "tentativa barrada" : "tentativas barradas"} fora do turno e fora da Central (registro de 10 em 10 minutos).`,
            evidencias: barrados.slice(-10).map((e) => `${quando(e.em)} — ${e.detalhes.sistema === "tabela" ? "Tabela" : "Mesa operacional"}.`),
        });
    }
    achados.push(...achadosDaPresenca(eventos));
    const acoesDoAdmin = eventos.filter((e) => e.tipo.startsWith("admin_") || e.tipo.startsWith("auto_"));
    if (acoesDoAdmin.length > 0) {
        achados.push({
            nivel: "info",
            titulo: "Ações da coordenação nesta conta",
            texto: "Registro do que já foi feito por aqui (inclusive as automáticas).",
            evidencias: acoesDoAdmin.map((e) => `${quando(e.em)} — ${e.tipo.startsWith("auto_") ? "automático: " : ""}${String(e.detalhes.descricao ?? e.tipo)}${e.detalhes.motivo ? `: ${String(e.detalhes.motivo)}` : ""}.`),
        });
    }

    const nivel: Nivel = achados.some((a) => a.nivel === "forte")
        ? "forte"
        : achados.some((a) => a.nivel === "atencao") ? "atencao" : "normal";
    const recencia = ultimaAtividade ? Math.max(0, 7 - (agora.getTime() - ultimaAtividade.getTime()) / 86_400_000) : 0;
    const pontuacao = fortes.length * 100 + moderados.length * 10
        + achados.filter((a) => a.nivel === "atencao").length * 5 + recencia;

    const redesDePessoas = resumoLugares.length;
    let resumo: string;
    if (nivel === "forte") {
        const maior = fortes[0];
        resumo = `Forte indício de senha compartilhada: ${plural(fortes.length, "vez", "vezes")} a conta foi usada em lugares diferentes ao mesmo tempo, `
            + `com gente mexendo nos dois aparelhos. A maior durou ${duracao(maior.duracaoMs)} (${intervalo(maior.inicio, maior.fim)}).`;
    } else if (nivel === "atencao") {
        resumo = `Pontos de atenção: ${lista(achados.filter((a) => a.nivel === "atencao").map((a) => a.titulo.toLowerCase()))}.`;
    } else {
        resumo = `Uso compatível com uma pessoa: ${plural(aparelhosDeGente.length, "aparelho", "aparelhos")} e ${plural(redesDePessoas, "rede", "redes")} no período, `
            + "sem uso em lugares diferentes ao mesmo tempo."
            + (fracosDoPlantao.length ? " Mais de um aparelho só durante o plantão, na rede do plantão." : "");
    }
    const turnos = entrada.plantoes ?? null;

    return {
        conta,
        nivel,
        pontuacao,
        resumo,
        achados,
        episodios: ordenados,
        deslocamentos,
        aparelhos: resumoAparelhos,
        lugares: resumoLugares,
        sessoes: resumoSessoes,
        entradasComSenha: senhas,
        abertaAgora: { sessoes: abertasAgora.size, redes: redesAgora.size },
        ultimaAtividade,
        plantao: turnos
            ? { turnos: turnos.length, agora: plantaoEm(turnos, agora, 0), minutosNaRedeForaDoTurno }
            : null,
    };
}

/* Presença na Mesa (docs/presenca-mesa.md). Duas pessoas na mesma conta
   aparecem de dois jeitos: disputando a vez com gente mexendo nos dois
   aparelhos (simultâneo), ou revezando — a vez indo e voltando entre aparelhos
   em minutos (ping-pong). Um único revezamento é normal (PC → celular). */
export function achadosDaPresenca(eventos: readonly EventoDeSessao[]): Achado[] {
    const achados: Achado[] = [];
    const negadas = eventos.filter((e) => e.tipo === "mesa_ocupada_negada" || e.tipo === "mesa_ocupada_negada_sombra");
    const segundos = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const simultaneas = negadas.filter((e) => {
        const aqui = segundos(e.detalhes.humanoAqui);
        const la = segundos(e.detalhes.humanoLa);
        return aqui !== null && la !== null && aqui <= LIMITES.humanoSimultaneoSeg && la <= LIMITES.humanoSimultaneoSeg;
    });
    if (simultaneas.length > 0) {
        achados.push({
            nivel: "forte",
            titulo: "Mesa aberta em dois aparelhos com gente mexendo nos dois",
            texto: `${plural(simultaneas.length, "vez", "vezes")} um aparelho tentou abrir a Mesa enquanto outro estava com ela, `
                + `e havia toque, clique ou rolagem nos dois nos ${LIMITES.humanoSimultaneoSeg / 60} minutos anteriores. Uma pessoa não opera duas telas ao mesmo tempo.`,
            evidencias: simultaneas.slice(-10).map((e) => `${quando(e.em)} — mexeram aqui há ${String(e.detalhes.humanoAqui)} s e no outro aparelho há ${String(e.detalhes.humanoLa)} s.`),
        });
    } else if (negadas.length >= 2) {
        achados.push({
            nivel: "atencao",
            titulo: "Mesa disputada entre aparelhos",
            texto: `${negadas.length} tentativas de abrir a Mesa com ela aberta em outro aparelho (registro de 10 em 10 minutos). Pode ser o próprio dono no PC e no celular.`,
            evidencias: negadas.slice(-10).map((e) => `${quando(e.em)}${e.tipo.endsWith("_sombra") ? " (sombra: não bloqueou)" : ""}.`),
        });
    }

    const trocas = eventos.filter((e) => e.tipo === "mesa_troca_de_aparelho").map((e) => e.em.getTime()).sort((a, b) => a - b);
    let maiorSequencia = 0;
    let inicio = 0;
    for (let fim = 0; fim < trocas.length; fim += 1) {
        while (trocas[fim] - trocas[inicio] > LIMITES.janelaPingPongMs) inicio += 1;
        maiorSequencia = Math.max(maiorSequencia, fim - inicio + 1);
    }
    if (maiorSequencia >= LIMITES.trocasDeAparelhoPingPong) {
        achados.push({
            nivel: "atencao",
            titulo: "A Mesa revezando entre aparelhos",
            texto: `A Mesa trocou de aparelho ${maiorSequencia} vezes em ${LIMITES.janelaPingPongMs / 60_000} minutos. `
                + "Revezar a tela entre dois aparelhos a cada poucos minutos é o jeito de dividir a conta sem abrir as duas juntas.",
            evidencias: [],
        });
    }
    return achados;
}
