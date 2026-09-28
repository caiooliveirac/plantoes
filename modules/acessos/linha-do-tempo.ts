/* Linha do tempo de prova do monitor de acessos: o que cada aparelho da conta
   fez, minuto a minuto, intercalado. É o que se mostra (e imprime) para provar
   que dois aparelhos estavam em uso ao mesmo tempo em lugares diferentes. Puro. */
import type { InfoDeRede, EventoDeSessao, JanelaDeAtividade, SessaoMonitorada } from "@/modules/acessos/analise";
import { descreverRede } from "@/modules/acessos/analise";
import { descreverAparelho } from "@/modules/acessos/aparelho";
import { chaveDeRede } from "@/modules/acessos/rede";
import { descreverPedido } from "@/modules/acessos/registro";
import { hora } from "@/modules/acessos/texto";

export interface LinhaDoTempo {
    em: Date;
    /** "A", "B"… — um rótulo por sessão (aparelho), na ordem em que aparecem. */
    lado: string | null;
    aparelho: string | null;
    rede: string | null;
    oque: string;
    /** Linha de presença (consultas agregadas) × evento pontual. */
    tipo: "presenca" | "evento";
}

const FRASES: Record<string, string> = {
    sessao_criada: "entrou",
    nova_rede: "a mesma sessão apareceu numa rede nova",
    senha_trocada: "trocou a senha",
    saida: "saiu (botão Sair)",
    sso_recusado: "entrada pelo portal recusada (login antigo)",
    portal_recusado: "login do portal recusado (senha trocada, sessões encerradas ou conta suspensa)",
    senha_login_ok: "digitou a senha certa no login do Plantões",
    senha_login_falhou: "errou a senha no login do Plantões",
    senha_portal_ok: "digitou a senha certa no portal",
    senha_portal_falhou: "errou a senha no portal",
    lugares_demais_admin: "em uso em mais de 3 lugares ao mesmo tempo (admin: só registrado)",
    mesa_troca_de_aparelho: "a Mesa passou para este aparelho (saiu do anterior)",
    mesa_ocupada_negada: "tentou abrir a Mesa com ela aberta em outro aparelho — esperou a vez",
    mesa_ocupada_negada_sombra: "abriu a Mesa com ela aberta em outro aparelho (sombra: não bloqueou)",
    mesa_bloqueada_ociosa: "Mesa fechada neste aparelho por falta de uso",
    mesa_bloqueada_ociosa_sombra: "a Mesa teria sido fechada por falta de uso (sombra)",
    mesa_desbloqueada: "digitou a senha e reabriu a Mesa neste aparelho",
};

const ORIGENS: Record<string, string> = {
    login: "com e-mail e senha no Plantões",
    portal: "pelo portal mnrs.com.br",
    escala: "pelo app Escalas",
    cadastro: "no cadastro de médico",
    anterior: "(login anterior ao monitor — vista pela primeira vez)",
    portal_cookie: "com o login do portal mnrs.com.br (Tabela e outros sistemas)",
};

function fraseDoEvento(evento: EventoDeSessao) {
    if (evento.tipo === "pagina" || evento.tipo === "acao" || evento.tipo === "quadro_ao_vivo") {
        return descreverPedido(evento.tipo, evento.metodo, evento.caminho);
    }
    if (evento.tipo === "sessao_criada") {
        const origem = ORIGENS[String(evento.detalhes.origem ?? "")] ?? "";
        return `entrou ${origem}`.trim();
    }
    if (evento.tipo.startsWith("admin_")) return `coordenação: ${String(evento.detalhes.descricao ?? evento.tipo)}`;
    if (evento.tipo.startsWith("auto_")) return `automático: ${String(evento.detalhes.motivo ?? evento.tipo)} — ${String(evento.detalhes.descricao ?? "")}`;
    if (evento.tipo === "barrado_fora_do_plantao") {
        return `barrado fora do plantão (${evento.detalhes.sistema === "tabela" ? "Tabela" : "Mesa operacional"})`;
    }
    return FRASES[evento.tipo] ?? evento.tipo;
}

function fraseDaPresenca(janela: JanelaDeAtividade) {
    const estado = janela.emUso > 0 ? "em uso" : janela.visiveis > 0 ? "tela à vista, parada" : "aberta em segundo plano";
    return `consultou o quadro ${janela.pedidos}× de ${hora(janela.primeira)} a ${hora(janela.ultima)} — ${estado}`;
}

/** Letra do aparelho: A, B… Z, A1, B1… — a mesma sessão sempre com a mesma letra no relatório. */
export function rotuloDaSessao(rotulos: Map<string, string>, sessaoId: string) {
    let rotulo = rotulos.get(sessaoId);
    if (!rotulo) {
        rotulo = String.fromCharCode(65 + (rotulos.size % 26)) + (rotulos.size >= 26 ? String(Math.floor(rotulos.size / 26)) : "");
        rotulos.set(sessaoId, rotulo);
    }
    return rotulo;
}

export function montarLinhaDoTempo(entrada: {
    sessoes: SessaoMonitorada[];
    janelas: JanelaDeAtividade[];
    eventos: EventoDeSessao[];
    redes: Map<string, InfoDeRede>;
    inicio: Date;
    fim: Date;
    /** Rótulos já dados (para o mesmo aparelho ter a mesma letra em todo o relatório). */
    rotulos?: Map<string, string>;
    limite?: number;
}): { linhas: LinhaDoTempo[]; rotulos: Map<string, string> } {
    const rotulos = entrada.rotulos ?? new Map<string, string>();
    const sessaoPorId = new Map(entrada.sessoes.map((s) => [s.id, s]));
    const rotuloDe = (sessaoId: string | null) => (sessaoId ? rotuloDaSessao(rotulos, sessaoId) : null);
    const aparelhoDe = (sessaoId: string | null, userAgent: string | null) => {
        const ua = (sessaoId ? sessaoPorId.get(sessaoId)?.userAgent : null) ?? userAgent;
        return descreverAparelho(ua).descricao;
    };
    const redeDe = (ip: string | null) => {
        if (!ip) return null;
        const chave = chaveDeRede(ip);
        return descreverRede(chave, entrada.redes.get(chave));
    };
    const dentro = (data: Date) => data >= entrada.inicio && data <= entrada.fim;

    // Letras na ordem em que os aparelhos aparecem no tempo: monta, ordena, depois rotula.
    const brutas: Array<Omit<LinhaDoTempo, "lado"> & { sessaoId: string | null }> = [];
    for (const evento of entrada.eventos) {
        if (!dentro(evento.em)) continue;
        brutas.push({
            em: evento.em,
            sessaoId: evento.sessaoId,
            aparelho: evento.sessaoId ? aparelhoDe(evento.sessaoId, evento.userAgent) : null,
            rede: redeDe(evento.ip),
            oque: fraseDoEvento(evento),
            tipo: "evento",
        });
    }
    for (const janela of entrada.janelas) {
        if (janela.ultima < entrada.inicio || janela.primeira > entrada.fim) continue;
        brutas.push({
            em: janela.primeira,
            sessaoId: janela.sessaoId,
            aparelho: aparelhoDe(janela.sessaoId, null),
            rede: redeDe(janela.ip),
            oque: fraseDaPresenca(janela),
            tipo: "presenca",
        });
    }
    // Presença antes de evento no mesmo instante: a janela começa quando o primeiro pedido chega.
    brutas.sort((a, b) => a.em.getTime() - b.em.getTime() || (a.tipo === b.tipo ? 0 : a.tipo === "presenca" ? -1 : 1));
    const linhas: LinhaDoTempo[] = brutas.map(({ sessaoId, ...linha }) => ({ ...linha, lado: rotuloDe(sessaoId) }));
    return { linhas: entrada.limite ? linhas.slice(-entrada.limite) : linhas, rotulos };
}
