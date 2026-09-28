/* Modelo do painel /admin/acessos: o que a tela desenha, já pronto e
   serializável (datas como texto no horário da Bahia). Puro.

   - risco 0–100 por conta, coerente com o nível da análise: forte ≥ 70,
     atenção 20–69, normal < 20. É a ordem padrão e o que escolhe quem vai
     para "Olhe primeiro".
   - faixa de calor: a linha do tempo do período em colunas (30 min em 24 h,
     3 h em 7 dias, 12 h em 30 dias), um dígito por coluna:
       0 sem uso · 1–3 uso (pouco → muito) · 4 duas redes na mesma coluna
       5 uso simultâneo moderado · 6 uso simultâneo forte
   - por aparelho (as faixas do "quem está onde"): o mesmo, uma linha por
     sessão, com 6 onde aquele aparelho estava num episódio forte. */
import {
    CONTAS_REDE_COLETIVA,
    redeDoPlantao,
    type AnaliseDaConta,
    type EpisodioSimultaneo,
    type InfoDeRede,
    type JanelaDeAtividade,
    type Plantao,
    type SessaoMonitorada,
} from "@/modules/acessos/analise";
import { descreverAparelho } from "@/modules/acessos/aparelho";
import { chaveDeRede, descreverLocal } from "@/modules/acessos/rede";
import { dia, duracao, hora, intervalo, quando } from "@/modules/acessos/texto";

const HORA_MS = 3_600_000;
const DIAS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

export interface EscalaDoCalor {
    desde: number;
    passoMs: number;
    colunas: number;
    /** Marcas do eixo: coluna e texto ("19h", "ter 22", "22/09"). */
    marcas: Array<{ coluna: number; texto: string }>;
}

function naBahia(ms: number) {
    return new Date(ms - 3 * HORA_MS);
}

/** 24 h → 48 × 30 min; 7 dias → 56 × 3 h; 30 dias → 60 × 12 h. Colunas alinhadas ao relógio da Bahia. */
export function escalaDoPeriodo(desde: Date, ate: Date): EscalaDoCalor {
    const duracaoMs = ate.getTime() - desde.getTime();
    const passoMs = duracaoMs <= 26 * HORA_MS ? HORA_MS / 2 : duracaoMs <= 8 * 24 * HORA_MS ? 3 * HORA_MS : 12 * HORA_MS;
    // Início alinhado ao passo no relógio da Bahia (UTC-3), para as marcas caírem em horas redondas.
    const inicio = Math.floor((desde.getTime() - 3 * HORA_MS) / passoMs) * passoMs + 3 * HORA_MS;
    const colunas = Math.max(1, Math.ceil((ate.getTime() - inicio) / passoMs));
    const marcas: EscalaDoCalor["marcas"] = [];
    for (let coluna = 0; coluna < colunas; coluna += 1) {
        const local = naBahia(inicio + coluna * passoMs);
        const h = local.getUTCHours();
        const m = local.getUTCMinutes();
        if (passoMs === HORA_MS / 2 && m === 0 && h % 3 === 0) marcas.push({ coluna, texto: `${h}h` });
        if (passoMs === 3 * HORA_MS && h === 0) marcas.push({ coluna, texto: `${DIAS[local.getUTCDay()]} ${local.getUTCDate()}` });
        if (passoMs === 12 * HORA_MS && h === 0 && (local.getUTCDate() - 1) % 5 === 0) {
            marcas.push({ coluna, texto: dia(new Date(inicio + coluna * passoMs)) });
        }
    }
    return { desde: inicio, passoMs, colunas, marcas };
}

function colunaDe(escala: EscalaDoCalor, ms: number) {
    return Math.floor((ms - escala.desde) / escala.passoMs);
}

/** Nível de uso pela taxa de pedidos por hora (o quadro consulta ~30×/h com a Mesa aberta). */
function nivelDeUso(pedidos: number, passoMs: number) {
    if (pedidos <= 0) return 0;
    const porHora = pedidos / (passoMs / HORA_MS);
    return porHora < 8 ? 1 : porHora < 30 ? 2 : 3;
}

function marcarEpisodios(niveis: number[], escala: EscalaDoCalor, episodios: EpisodioSimultaneo[], filtro?: (e: EpisodioSimultaneo) => boolean) {
    for (const episodio of episodios) {
        if (episodio.forca === "fraco" || (filtro && !filtro(episodio))) continue;
        const valor = episodio.forca === "forte" ? 6 : 5;
        const primeira = Math.max(0, colunaDe(escala, episodio.inicio.getTime()));
        const ultima = Math.min(escala.colunas - 1, colunaDe(escala, episodio.fim.getTime()));
        for (let coluna = primeira; coluna <= ultima; coluna += 1) niveis[coluna] = Math.max(niveis[coluna], valor);
    }
}

export function faixaDeCalor(janelas: JanelaDeAtividade[], episodios: EpisodioSimultaneo[], escala: EscalaDoCalor): string {
    const pedidos = new Array<number>(escala.colunas).fill(0);
    const redes = Array.from({ length: escala.colunas }, () => new Set<string>());
    for (const janela of janelas) {
        const coluna = colunaDe(escala, janela.inicio.getTime());
        if (coluna < 0 || coluna >= escala.colunas) continue;
        pedidos[coluna] += janela.pedidos;
        redes[coluna].add(chaveDeRede(janela.ip));
    }
    const niveis = pedidos.map((n, coluna) => (redes[coluna].size >= 2 ? 4 : nivelDeUso(n, escala.passoMs)));
    marcarEpisodios(niveis, escala, episodios);
    return niveis.join("");
}

/** Uma coluna por trecho do período: "1" se o dono estava de plantão em algum momento dele. */
export function faixaDePlantao(plantoes: Plantao[], escala: EscalaDoCalor): string {
    let faixa = "";
    for (let coluna = 0; coluna < escala.colunas; coluna += 1) {
        const inicio = escala.desde + coluna * escala.passoMs;
        const fim = inicio + escala.passoMs;
        faixa += plantoes.some((p) => p.inicio.getTime() < fim && p.fim.getTime() > inicio) ? "1" : "0";
    }
    return faixa;
}

export interface FaixaDoAparelho {
    sessaoId: string;
    aparelho: string;
    tipo: string;
    /** Onde esse aparelho mais apareceu: cidade/região ou a rede. */
    onde: string;
    provedor: string | null;
    faixa: string;
    /** A rede principal desse aparelho é a rede do plantão (onde os plantonistas trabalham). */
    redeDoPlantao: boolean;
}

/** Uma faixa por sessão (aparelho) com uso no período — o "quem está onde". */
export function faixasPorAparelho(
    sessoes: SessaoMonitorada[],
    janelas: JanelaDeAtividade[],
    episodios: EpisodioSimultaneo[],
    redes: Map<string, InfoDeRede>,
    escala: EscalaDoCalor,
    limite = 6,
): FaixaDoAparelho[] {
    const porSessao = new Map<string, JanelaDeAtividade[]>();
    for (const janela of janelas) {
        const lista = porSessao.get(janela.sessaoId);
        if (lista) lista.push(janela);
        else porSessao.set(janela.sessaoId, [janela]);
    }
    const saida: Array<FaixaDoAparelho & { total: number }> = [];
    for (const [sessaoId, daSessao] of porSessao) {
        const sessao = sessoes.find((s) => s.id === sessaoId);
        const pedidos = new Array<number>(escala.colunas).fill(0);
        const porRede = new Map<string, number>();
        for (const janela of daSessao) {
            const coluna = colunaDe(escala, janela.inicio.getTime());
            if (coluna >= 0 && coluna < escala.colunas) pedidos[coluna] += janela.pedidos;
            const rede = chaveDeRede(janela.ip);
            porRede.set(rede, (porRede.get(rede) ?? 0) + janela.pedidos);
        }
        const niveis = pedidos.map((n) => nivelDeUso(n, escala.passoMs));
        marcarEpisodios(niveis, escala, episodios, (e) => e.lados.some((lado) => lado.sessaoId === sessaoId));
        // Onde: a rede mais usada; cidade quando o Cloudflare deu, senão a própria rede.
        const [redePrincipal] = [...porRede.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null];
        const info = redePrincipal ? redes.get(redePrincipal) : undefined;
        const aparelho = descreverAparelho(sessao?.userAgent);
        saida.push({
            sessaoId,
            aparelho: aparelho.descricao,
            tipo: aparelho.tipo,
            onde: descreverLocal(info?.geo) ?? redePrincipal ?? "rede não informada",
            provedor: info?.provedor?.nome ?? null,
            faixa: niveis.join(""),
            redeDoPlantao: info ? redeDoPlantao(info) : false,
            total: pedidos.reduce((a, b) => a + b, 0),
        });
    }
    return saida
        .sort((a, b) => b.total - a.total)
        .slice(0, limite)
        .map(({ total: _total, ...faixa }) => faixa);
}

/** 0–100, coerente com o nível: forte ≥ 70, atenção 20–69, normal < 20. */
export function riscoDaConta(analise: AnaliseDaConta): number {
    const fortes = analise.episodios.filter((e) => e.forca === "forte").length;
    const moderados = analise.episodios.filter((e) => e.forca === "moderado").length;
    const atencao = analise.achados.filter((a) => a.nivel === "atencao").length;
    if (fortes > 0) return Math.min(100, 70 + (fortes - 1) * 8 + moderados * 2 + (analise.abertaAgora.redes >= 2 ? 6 : 0));
    if (atencao > 0) return Math.min(69, 20 + moderados * 12 + (atencao - 1) * 6 + (analise.abertaAgora.redes >= 2 ? 6 : 0));
    return Math.min(19, analise.aparelhos.length * 2 + analise.lugares.length + (analise.abertaAgora.redes >= 2 ? 5 : 0));
}

export interface LugarDaConta {
    rede: string;
    local: string | null;
    provedor: string | null;
    coletiva: boolean;
    plantao: boolean;
    servidor: boolean;
    estrangeiro: boolean;
}

export interface ContaNoPainel {
    userId: string;
    nome: string;
    email: string;
    papeis: string[];
    ativa: boolean;
    nivel: AnaliseDaConta["nivel"];
    risco: number;
    resumo: string;
    faixa: string;
    lugares: LugarDaConta[];
    aparelhos: string[];
    achados: Array<{ nivel: string; titulo: string }>;
    maiorEpisodio: { quando: string; duracao: string; forca: string; lados: string[]; plantao: string | null } | null;
    /** Escala do dono (null = conta sem médico vinculado). */
    plantao: { agora: string | null; turnos: number; faixa: string; foraDoTurnoMin: number } | null;
    metricas: {
        minutosSimultaneos: number;
        episodiosFortes: number;
        lugares: number;
        cidades: number;
        aparelhos: number;
        senhas: number;
        redesDeSenha: number;
        agoraRedes: number;
        agoraSessoes: number;
        ultimaAtividadeMs: number | null;
        ultimaAtividade: string | null;
    };
}

export interface LugarNoPainel {
    chave: string;
    rotulo: string;
    detalhe: string | null;
    contas: number;
    contasComSinal: number;
    coletiva: boolean;
    servidor: boolean;
    estrangeiro: boolean;
    /** Plantonistas que usaram a Mesa num PC, no próprio turno, na faixa desta rede. */
    plantonistas: number;
    /** Rede do plantão (redeDoPlantao): a Central. */
    plantao: boolean;
}

export interface Painel {
    geradoEm: string;
    escala: EscalaDoCalor;
    contas: ContaNoPainel[];
    lugares: LugarNoPainel[];
    foco: { userId: string; faixas: FaixaDoAparelho[]; plantao: { rotulo: string; faixa: string } | null } | null;
    temCidade: boolean;
}

function lugaresDaConta(analise: AnaliseDaConta, redes: Map<string, InfoDeRede>): LugarDaConta[] {
    return [...analise.lugares]
        .sort((a, b) => b.pedidos - a.pedidos)
        .map((lugar) => {
            const pais = redes.get(lugar.rede)?.geo.pais;
            return {
                rede: lugar.rede,
                local: lugar.local,
                provedor: lugar.provedor,
                coletiva: lugar.coletiva,
                plantao: lugar.plantao,
                servidor: lugar.servidor,
                estrangeiro: Boolean(pais && pais !== "BR"),
            };
        });
}

export function contaNoPainel(
    analise: AnaliseDaConta,
    bruto: { janelas: JanelaDeAtividade[] },
    redes: Map<string, InfoDeRede>,
    escala: EscalaDoCalor,
    plantoes?: Plantao[],
): ContaNoPainel {
    const simultaneos = analise.episodios.filter((e) => e.forca !== "fraco");
    const maior = [...simultaneos].sort((a, b) => (a.forca === b.forca ? b.duracaoMs - a.duracaoMs : a.forca === "forte" ? -1 : 1))[0];
    const lugares = lugaresDaConta(analise, redes);
    const senhasCertas = analise.entradasComSenha.filter((s) => s.ok);
    return {
        userId: analise.conta.userId,
        nome: analise.conta.nome ?? analise.conta.email,
        email: analise.conta.email,
        papeis: analise.conta.papeis,
        ativa: analise.conta.ativa,
        nivel: analise.nivel,
        risco: riscoDaConta(analise),
        resumo: analise.resumo,
        faixa: faixaDeCalor(bruto.janelas, analise.episodios, escala),
        lugares,
        aparelhos: analise.aparelhos.filter((a) => a.tipo !== "programa").map((a) => a.descricao),
        achados: analise.achados.filter((a) => a.nivel !== "info").slice(0, 4).map((a) => ({ nivel: a.nivel, titulo: a.titulo })),
        maiorEpisodio: maior
            ? {
                quando: intervalo(maior.inicio, maior.fim),
                duracao: duracao(maior.duracaoMs),
                forca: maior.forca,
                plantao: maior.plantao
                    ? `${maior.plantao.rotulo}${maior.plantao.todosNaRedeDoPlantao ? " — todos os aparelhos na rede do plantão" : ` — fora da rede do plantão: ${maior.plantao.aparelhosFora.join(", ")}`}`
                    : null,
                lados: maior.lados.map((lado) => {
                    const info = redes.get(lado.rede);
                    const onde = descreverLocal(info?.geo) ?? lado.rede;
                    return `${lado.aparelho.descricao} · ${onde}${info?.provedor ? ` · ${info.provedor.nome}` : ""}`;
                }),
            }
            : null,
        plantao: analise.plantao
            ? {
                agora: analise.plantao.agora?.rotulo ?? null,
                turnos: analise.plantao.turnos,
                faixa: faixaDePlantao(plantoes ?? [], escala),
                foraDoTurnoMin: analise.plantao.minutosNaRedeForaDoTurno,
            }
            : null,
        metricas: {
            minutosSimultaneos: Math.round(simultaneos.reduce((total, e) => total + e.duracaoMs, 0) / 60_000),
            episodiosFortes: analise.episodios.filter((e) => e.forca === "forte").length,
            lugares: lugares.length,
            cidades: new Set(lugares.map((l) => l.local).filter(Boolean)).size,
            aparelhos: analise.aparelhos.filter((a) => a.tipo !== "programa").length,
            senhas: senhasCertas.length,
            redesDeSenha: new Set(senhasCertas.map((s) => s.rede).filter(Boolean)).size,
            agoraRedes: analise.abertaAgora.redes,
            agoraSessoes: analise.abertaAgora.sessoes,
            ultimaAtividadeMs: analise.ultimaAtividade?.getTime() ?? null,
            ultimaAtividade: analise.ultimaAtividade ? quando(analise.ultimaAtividade) : null,
        },
    };
}

/** Lugares de onde o sistema foi usado no período: cidade quando se sabe, senão a rede. */
export function lugaresDoPainel(analises: AnaliseDaConta[], redes: Map<string, InfoDeRede>, limite = 10): LugarNoPainel[] {
    const grupos = new Map<string, LugarNoPainel & { contasSet: Set<string>; comSinal: Set<string> }>();
    for (const analise of analises) {
        for (const lugar of analise.lugares) {
            const info = redes.get(lugar.rede);
            const pais = info?.geo.pais;
            const chave = lugar.local ?? lugar.rede;
            let grupo = grupos.get(chave);
            if (!grupo) {
                grupo = {
                    chave,
                    rotulo: lugar.local ?? lugar.rede,
                    detalhe: lugar.local ? lugar.provedor : lugar.provedor ?? null,
                    contas: 0,
                    contasComSinal: 0,
                    coletiva: false,
                    servidor: false,
                    estrangeiro: false,
                    plantonistas: 0,
                    plantao: false,
                    contasSet: new Set(),
                    comSinal: new Set(),
                };
                grupos.set(chave, grupo);
            }
            grupo.contasSet.add(analise.conta.userId);
            if (analise.nivel !== "normal") grupo.comSinal.add(analise.conta.userId);
            grupo.coletiva ||= lugar.coletiva || (info?.contas ?? 0) >= CONTAS_REDE_COLETIVA;
            grupo.servidor ||= lugar.servidor;
            grupo.plantonistas = Math.max(grupo.plantonistas, info?.plantonistas ?? 0);
            grupo.plantao ||= Boolean(info && redeDoPlantao(info));
            grupo.estrangeiro ||= Boolean(pais && pais !== "BR");
        }
    }
    return [...grupos.values()]
        .map(({ contasSet, comSinal, ...grupo }) => ({ ...grupo, contas: contasSet.size, contasComSinal: comSinal.size }))
        .sort((a, b) => b.contasComSinal - a.contasComSinal || b.contas - a.contas)
        .slice(0, limite);
}

export function montarPainel(entrada: {
    analises: AnaliseDaConta[];
    brutos: Map<string, { sessoes: SessaoMonitorada[]; janelas: JanelaDeAtividade[] }>;
    redes: Map<string, InfoDeRede>;
    desde: Date;
    ate: Date;
    geradoEm: Date;
    plantoes?: Map<string, Plantao[]>;
}): Painel {
    const escala = escalaDoPeriodo(entrada.desde, entrada.ate);
    const contas = entrada.analises.map((analise) => contaNoPainel(
        analise,
        entrada.brutos.get(analise.conta.userId) ?? { janelas: [] },
        entrada.redes,
        escala,
        entrada.plantoes?.get(analise.conta.userId),
    ));
    const primeira = [...contas].sort((a, b) => b.risco - a.risco || b.metricas.agoraRedes - a.metricas.agoraRedes)[0];
    const focoAnalise = primeira && primeira.risco >= 20 ? entrada.analises.find((a) => a.conta.userId === primeira.userId) : undefined;
    const bruto = focoAnalise ? entrada.brutos.get(focoAnalise.conta.userId) : undefined;
    return {
        geradoEm: `${quando(entrada.geradoEm)}`,
        escala,
        contas,
        lugares: lugaresDoPainel(entrada.analises, entrada.redes),
        foco: focoAnalise && bruto
            ? {
                userId: focoAnalise.conta.userId,
                faixas: faixasPorAparelho(bruto.sessoes, bruto.janelas, focoAnalise.episodios, entrada.redes, escala),
                plantao: raiaDoPlantao(entrada.plantoes?.get(focoAnalise.conta.userId), escala),
            }
            : null,
        temCidade: [...entrada.redes.values()].some((rede) => Boolean(rede.geo.cidade)),
    };
}

/** Raia "De plantão" do quem-está-onde: os locais dos turnos e onde caem no período. */
export function raiaDoPlantao(plantoes: Plantao[] | undefined, escala: EscalaDoCalor) {
    if (!plantoes?.length) return null;
    const locais = [...new Set(plantoes.map((p) => p.rotulo))];
    return {
        rotulo: locais.length <= 2 ? locais.join(" · ") : `${locais.slice(0, 2).join(" · ")} +${locais.length - 2}`,
        faixa: faixaDePlantao(plantoes, escala),
    };
}

/** Texto acessível da faixa: quanto tempo em cada estado. */
export function descreverFaixa(faixa: string, passoMs: number) {
    const conta = (teste: (d: number) => boolean) => [...faixa].filter((c) => teste(Number(c))).length * passoMs;
    const partes = [
        `em uso ${duracao(conta((d) => d >= 1))}`,
        conta((d) => d === 4) ? `duas redes no mesmo intervalo ${duracao(conta((d) => d === 4))}` : null,
        conta((d) => d === 5) ? `uso simultâneo ${duracao(conta((d) => d === 5))}` : null,
        conta((d) => d === 6) ? `uso simultâneo forte ${duracao(conta((d) => d === 6))}` : null,
    ].filter(Boolean);
    return partes.join(", ");
}

/** Rótulo da coluna para a dica: "ter 22/09 19:30–20:00". */
export function rotuloDaColuna(escala: EscalaDoCalor, coluna: number) {
    const inicio = new Date(escala.desde + coluna * escala.passoMs);
    return `${quando(inicio)}–${hora(new Date(inicio.getTime() + escala.passoMs))}`;
}
