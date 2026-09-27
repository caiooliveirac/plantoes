/* Textos do monitor de acessos para o privado dos admins no Telegram. Texto
   puro (sem Markdown: nome e rede não precisam de escape), curto no topo e
   detalhado embaixo — quem lê no celular decide pela primeira linha. */
import { descreverRede, type AnaliseDaConta, type EpisodioSimultaneo, type InfoDeRede } from "@/modules/acessos/analise";
import { duracao, intervalo, plural, quando } from "@/modules/acessos/texto";

/** O Telegram corta em 4096 caracteres; sobra folga para o rodapé. */
const LIMITE_TELEGRAM = 3800;

function limitar(linhas: string[], rodape: string[]) {
    const corpo: string[] = [];
    let tamanho = rodape.join("\n").length;
    for (const linha of linhas) {
        if (tamanho + linha.length + 1 > LIMITE_TELEGRAM) {
            corpo.push("… (o resto está no monitor)");
            break;
        }
        corpo.push(linha);
        tamanho += linha.length + 1;
    }
    return [...corpo, ...rodape].join("\n");
}

function nomeDaConta(analise: AnaliseDaConta) {
    return analise.conta.nome ? `${analise.conta.nome} (${analise.conta.email})` : analise.conta.email;
}

function estadoDoLado(lado: EpisodioSimultaneo["lados"][number]) {
    if (lado.emUso > 0 || lado.interacoes > 0) return "em uso";
    return lado.visiveis > 0 ? "tela à vista, sem toque" : "só aberta";
}

/** Alerta na hora: um episódio forte de uso simultâneo. */
export function mensagemDeUsoSimultaneo(analise: AnaliseDaConta, episodio: EpisodioSimultaneo, redes: Map<string, InfoDeRede>, linkDoRelatorio: string) {
    const lados = episodio.lados.map((lado, indice) => (
        `• ${String.fromCharCode(65 + indice)}: ${lado.aparelho.descricao} — ${descreverRede(lado.rede, redes.get(lado.rede))} — ${estadoDoLado(lado)}`
    ));
    return limitar([
        `USO SIMULTÂNEO — ${nomeDaConta(analise)}`,
        "",
        `${intervalo(episodio.inicio, episodio.fim)} (${duracao(episodio.duracaoMs)}): a conta estava em uso em ${plural(episodio.redes.length, "lugar", "lugares")} ao mesmo tempo.`,
        ...lados,
        "",
        `Por quê: ${episodio.motivos.join(" ")}`,
        ...(episodio.ressalvas.length ? [`Ressalva: ${episodio.ressalvas.join(" ")}`] : []),
        "",
    ], [
        `Relatório completo: ${linkDoRelatorio}`,
        "Nada foi bloqueado. As ações (encerrar sessões, trocar a senha, suspender) ficam no relatório.",
    ]);
}

/** Resumo diário das últimas 24 h. Sai todo dia, mesmo sem nada — prova que o monitor está vivo. */
export function mensagemDoResumoDiario(analises: AnaliseDaConta[], geradoEm: Date, linkDoMonitor: string) {
    const fortes = analises.filter((a) => a.nivel === "forte");
    const atencao = analises.filter((a) => a.nivel === "atencao");
    const semSinal = analises.length - fortes.length - atencao.length;
    const cabecalho = `Monitor de acessos — últimas 24 h (${quando(geradoEm)})`;
    if (fortes.length === 0 && atencao.length === 0) {
        return [
            cabecalho,
            "",
            `Nenhuma conta com sinal de senha compartilhada. ${plural(analises.length, "conta usou", "contas usaram")} o sistema no período.`,
            "",
            `Monitor: ${linkDoMonitor}`,
        ].join("\n");
    }
    const linha = (analise: AnaliseDaConta) => `• ${nomeDaConta(analise)} — ${analise.resumo}`;
    return limitar([
        cabecalho,
        "",
        ...(fortes.length ? [`Indício forte (${fortes.length}):`, ...fortes.map(linha), ""] : []),
        ...(atencao.length ? [`Atenção (${atencao.length}):`, ...atencao.map(linha), ""] : []),
    ], [`Sem sinal: ${plural(semSinal, "conta", "contas")}.`, "", `Monitor: ${linkDoMonitor}`]);
}
