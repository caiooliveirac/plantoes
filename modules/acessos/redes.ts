/* ==========================================================================
   Redes do monitor de acessos (docs/monitor-acessos.md, "Redes"). Puro.

   A unidade é a FAIXA (/24 IPv4, /64 IPv6): a Central sai por um pool de IPs
   da mesma /24, um escritório também. Para cada faixa: quais contas usaram,
   quanto disso foi FORA do turno do dono (mesma folga do portão de turno),
   quantas vezes o portão barrou — e, por conta, um veredito sobre vazamento:

   - vazou (provável): a conta estava em uso aqui enquanto o dono estava na
     Central, na mesma janela de 5 min. Uma pessoa não está nos dois lugares.
   - suspeita: em uso aqui e noutra rede ao mesmo tempo, várias vezes (pode
     ser celular no 4G + PC de casa da mesma pessoa; pode não ser).
   - uso próprio: fora do turno, mas no mesmo navegador (mesma sessão, mesmo
     cookie) que o dono usou no plantão — o celular ou notebook dele que saiu
     da Central. Provavelmente o próprio dono.
   - aparelho estranho: fora do turno num navegador que nunca apareceu no
     plantão do dono. Não prova nada sozinho; pesa quando a rede é coletiva.
   (User-agent não serve para "mesmo aparelho": todo Chrome de Windows manda
   o mesmo texto.)
   - trabalho: só dentro do turno.

   Rede "coletiva fora do plantão" = 2+ contas usando fora do turno, fora da
   Central. É o desenho de um lugar onde logins emprestados são usados.
   ========================================================================== */
import { JANELA_MS, PLANTONISTAS_REDE_DO_PLANTAO } from "@/modules/acessos/analise";
import { faixaDeRede } from "@/modules/acessos/rede";

export type TipoDeRotulo = "central" | "suspeita" | "conhecida";

export interface RotuloDeRede {
    faixa: string;
    kind: TipoDeRotulo;
    label: string;
    note: string | null;
}

/** Uma janela de 5 min de uma sessão num IP (auth_session_activity), já com o turno do dono. */
export interface JanelaDeRede {
    userId: string;
    sessaoId: string;
    ip: string;
    inicio: Date;
    emTurno: boolean;
    emUso: boolean;
    aparelho: string;
}

export interface BarradoNaRede {
    userId: string;
    ip: string;
    em: Date;
    sistema: string;
}

export interface InfoDoIp {
    provedor: string | null;
    dnsReverso: string | null;
    cidade: string | null;
    pais: string | null;
}

export type Veredito = "vazou" | "suspeita" | "uso_proprio" | "aparelho_estranho" | "trabalho";

export const NOME_DO_VEREDITO: Record<Veredito, string> = {
    vazou: "vazou (provável)",
    suspeita: "suspeita",
    uso_proprio: "uso próprio",
    aparelho_estranho: "aparelho estranho",
    trabalho: "trabalho",
};

export interface ContaNaRede {
    userId: string;
    minutos: number;
    minutosFora: number;
    minutosEmUsoFora: number;
    barrados: number;
    /** Janelas em que a conta estava aqui e, ao mesmo tempo, numa faixa da Central. */
    aoMesmoTempoNaCentral: number;
    /** Janelas em que a conta estava aqui e, ao mesmo tempo, noutra faixa qualquer. */
    aoMesmoTempoNoutra: number;
    aparelhos: string[];
    /** Alguma sessão (navegador) daqui também foi usada no turno do dono, em qualquer rede. */
    sessaoDoPlantao: boolean;
    primeira: Date;
    ultima: Date;
    veredito: Veredito;
    porque: string;
}

export interface RedeAnalisada {
    faixa: string;
    ips: string[];
    provedores: string[];
    dominios: string[];
    lugares: string[];
    central: "rotulo" | "medida" | null;
    /** Plantonistas no PC dentro do turno nesta faixa: 1–2 sem rótulo = talvez uma saída da Central ainda não reconhecida. */
    plantonistas: number;
    rotulo: RotuloDeRede | null;
    contas: ContaNaRede[];
    contasFora: number;
    minutosFora: number;
    barrados: number;
    vazamentos: number;
    coletivaFora: boolean;
    /** Janelas fora do turno por hora do dia (0–23, Bahia): horário comercial = local de trabalho. */
    horasFora: number[];
    pontuacao: number;
}

const MIN_POR_JANELA = JANELA_MS / 60_000;
/** Mínimo de janelas simultâneas com a Central para "vazou". */
export const VAZOU_COM_CENTRAL = 2;
/** Mínimo de janelas simultâneas com outra rede para "suspeita". */
export const SUSPEITA_OUTRA_REDE = 3;

function horaNaBahia(data: Date) {
    return (data.getUTCHours() + 21) % 24; // America/Bahia = UTC−3, sem horário de verão
}

/** Domínio do DNS reverso sem o nome da máquina: "200-1-2-3.ssp.ba.gov.br" → "ssp.ba.gov.br". */
export function dominioDoDns(ptr: string | null | undefined): string | null {
    if (!ptr) return null;
    const partes = ptr.toLowerCase().replace(/\.$/, "").split(".");
    return partes.length > 2 ? partes.slice(1).join(".") : partes.join(".");
}

function vereditoDaConta(c: Omit<ContaNaRede, "veredito" | "porque">, central: boolean): { veredito: Veredito; porque: string } {
    if (central) {
        return c.minutosFora > 0
            ? { veredito: "trabalho", porque: "Rede da Central: fora do turno aqui é gente na Central (ver achado da conta)." }
            : { veredito: "trabalho", porque: "Só dentro do turno, na Central." };
    }
    if (c.aoMesmoTempoNaCentral >= VAZOU_COM_CENTRAL) {
        return {
            veredito: "vazou",
            porque: `Em uso aqui ${c.aoMesmoTempoNaCentral}× na mesma janela de 5 min em que o dono estava na Central. Uma pessoa não está nos dois lugares.`,
        };
    }
    if (c.aoMesmoTempoNoutra >= SUSPEITA_OUTRA_REDE) {
        return {
            veredito: "suspeita",
            porque: `Em uso aqui e noutra rede ao mesmo tempo ${c.aoMesmoTempoNoutra}×. Pode ser celular no 4G + PC da mesma pessoa; pode ser outra pessoa.`,
        };
    }
    if (c.minutosFora === 0) return { veredito: "trabalho", porque: "Só dentro do turno do dono." };
    if (c.sessaoDoPlantao) {
        return { veredito: "uso_proprio", porque: "Fora do turno, mas no mesmo navegador que o dono usou no plantão: provavelmente o próprio dono." };
    }
    return { veredito: "aparelho_estranho", porque: "Fora do turno, num navegador que nunca apareceu no plantão do dono." };
}

export interface EntradaDeRedes {
    janelas: JanelaDeRede[];
    barrados: BarradoNaRede[];
    infoDosIps: Map<string, InfoDoIp>;
    /** Por faixa, plantonistas diferentes que usaram a Mesa num PC dentro do próprio turno (3+ = rede do plantão). */
    plantonistasPorFaixa: Map<string, number>;
    rotulos: RotuloDeRede[];
}

export function analisarRedes(entrada: EntradaDeRedes): RedeAnalisada[] {
    const rotulos = new Map(entrada.rotulos.map((r) => [r.faixa, r]));
    const medida = (faixa: string) => (entrada.plantonistasPorFaixa.get(faixa) ?? 0) >= PLANTONISTAS_REDE_DO_PLANTAO;
    const ehCentral = (faixa: string) => medida(faixa) || rotulos.get(faixa)?.kind === "central";

    // Onde cada conta estava em cada janela; que sessões cada conta usou dentro do turno.
    const faixasPorContaJanela = new Map<string, Set<string>>();
    const sessoesNoTurno = new Set<string>();
    for (const j of entrada.janelas) {
        const chave = `${j.userId}|${j.inicio.getTime()}`;
        const faixas = faixasPorContaJanela.get(chave) ?? new Set<string>();
        faixas.add(faixaDeRede(j.ip));
        faixasPorContaJanela.set(chave, faixas);
        if (j.emTurno) sessoesNoTurno.add(j.sessaoId);
    }

    interface Acumulado {
        ips: Set<string>;
        contas: Map<string, {
            janelas: Set<number>; fora: Set<number>; emUsoFora: Set<number>;
            centralJunto: Set<number>; outraJunto: Set<number>;
            aparelhos: Set<string>; sessoes: Set<string>; primeira: number; ultima: number; barrados: number;
        }>;
        horasFora: number[];
        barrados: number;
    }
    const porFaixa = new Map<string, Acumulado>();
    const pegar = (faixa: string) => {
        let a = porFaixa.get(faixa);
        if (!a) {
            a = { ips: new Set(), contas: new Map(), horasFora: Array.from({ length: 24 }, () => 0), barrados: 0 };
            porFaixa.set(faixa, a);
        }
        return a;
    };
    const pegarConta = (a: Acumulado, userId: string, t: number) => {
        let c = a.contas.get(userId);
        if (!c) {
            c = { janelas: new Set(), fora: new Set(), emUsoFora: new Set(), centralJunto: new Set(), outraJunto: new Set(), aparelhos: new Set(), sessoes: new Set(), primeira: t, ultima: t, barrados: 0 };
            a.contas.set(userId, c);
        }
        c.primeira = Math.min(c.primeira, t);
        c.ultima = Math.max(c.ultima, t);
        return c;
    };

    for (const j of entrada.janelas) {
        const faixa = faixaDeRede(j.ip);
        const t = j.inicio.getTime();
        const a = pegar(faixa);
        a.ips.add(j.ip);
        const c = pegarConta(a, j.userId, t);
        c.aparelhos.add(j.aparelho);
        c.sessoes.add(j.sessaoId);
        c.janelas.add(t);
        if (!j.emTurno) {
            if (!c.fora.has(t)) {
                c.fora.add(t);
                a.horasFora[horaNaBahia(j.inicio)] += 1;
            }
            if (j.emUso) c.emUsoFora.add(t);
        }
        for (const outra of faixasPorContaJanela.get(`${j.userId}|${t}`) ?? []) {
            if (outra === faixa) continue;
            c.outraJunto.add(t);
            if (ehCentral(outra)) c.centralJunto.add(t);
        }
    }
    for (const b of entrada.barrados) {
        const faixa = faixaDeRede(b.ip);
        const a = pegar(faixa);
        a.ips.add(b.ip);
        a.barrados += 1;
        pegarConta(a, b.userId, b.em.getTime()).barrados += 1;
    }

    const redes: RedeAnalisada[] = [];
    for (const [faixa, a] of porFaixa) {
        const central = medida(faixa) ? "medida" : rotulos.get(faixa)?.kind === "central" ? "rotulo" : null;
        const contas: ContaNaRede[] = [...a.contas].map(([userId, c]) => {
            const base = {
                userId,
                minutos: c.janelas.size * MIN_POR_JANELA,
                minutosFora: c.fora.size * MIN_POR_JANELA,
                minutosEmUsoFora: c.emUsoFora.size * MIN_POR_JANELA,
                barrados: c.barrados,
                aoMesmoTempoNaCentral: c.centralJunto.size,
                aoMesmoTempoNoutra: c.outraJunto.size,
                aparelhos: [...c.aparelhos],
                sessaoDoPlantao: [...c.sessoes].some((sessao) => sessoesNoTurno.has(sessao)),
                primeira: new Date(c.primeira),
                ultima: new Date(c.ultima),
            };
            return { ...base, ...vereditoDaConta(base, central !== null) };
        });
        const ordemVeredito: Veredito[] = ["vazou", "suspeita", "aparelho_estranho", "uso_proprio", "trabalho"];
        contas.sort((x, y) => ordemVeredito.indexOf(x.veredito) - ordemVeredito.indexOf(y.veredito) || y.minutosFora - x.minutosFora);

        const infos = [...a.ips].map((ip) => entrada.infoDosIps.get(ip)).filter((i): i is InfoDoIp => Boolean(i));
        const unicos = (valores: Array<string | null>) => [...new Set(valores.filter((v): v is string => Boolean(v)))].sort();
        const contasFora = contas.filter((c) => c.minutosFora > 0 || c.barrados > 0).length;
        const minutosFora = contas.reduce((t, c) => t + c.minutosFora, 0);
        const vazamentos = contas.filter((c) => c.veredito === "vazou").length;
        const coletivaFora = central === null && contasFora >= 2;
        redes.push({
            faixa,
            ips: [...a.ips].sort(),
            provedores: unicos(infos.map((i) => i.provedor)),
            dominios: unicos(infos.map((i) => dominioDoDns(i.dnsReverso))),
            lugares: unicos(infos.map((i) => i.cidade ?? i.pais)),
            central,
            plantonistas: entrada.plantonistasPorFaixa.get(faixa) ?? 0,
            rotulo: rotulos.get(faixa) ?? null,
            contas,
            contasFora,
            minutosFora,
            barrados: a.barrados,
            vazamentos,
            coletivaFora,
            horasFora: a.horasFora,
            pontuacao: central ? 0 : minutosFora + 60 * contasFora * contasFora + 20 * a.barrados + 240 * vazamentos,
        });
    }
    return redes.sort((x, y) => y.pontuacao - x.pontuacao || y.contas.length - x.contas.length);
}
