/* O que um pedido autenticado vira no monitor de acessos: evento individual na
   linha do tempo (página, ação, quadro ao vivo) ou só presença agregada na
   janela de 5 minutos (a consulta periódica do quadro, que é volume). Puro. */
import type { ContextoRequisicao } from "@/lib/acessos/contexto";

export type TipoEventoDePedido = "pagina" | "acao" | "quadro_ao_vivo";

export interface ClassificacaoDoPedido {
    evento: TipoEventoDePedido | null;
    /** A aba estava à vista (cabeçalho do quadro) ou o pedido é navegação de gente. */
    visivel: boolean;
    /** Toque/clique/tecla nos últimos 2 minutos, ou página aberta/ação feita agora. */
    emUso: boolean;
}

/** Até quanto tempo parado a Mesa ainda conta como "em uso". */
export const OCIOSO_EM_USO_SEG = 120;

export function classificarPedido(contexto: ContextoRequisicao, ultimaPaginaDaSessao: string | null): ClassificacaoDoPedido {
    const metodo = contexto.metodo ?? "GET";
    const caminho = contexto.caminho;
    const uso = contexto.usoMesa;
    const visivelPeloQuadro = uso?.visivel === true;
    const emUsoPeloQuadro = visivelPeloQuadro && uso?.ociosoSeg !== null && uso!.ociosoSeg! <= OCIOSO_EM_USO_SEG;

    if (metodo !== "GET" && metodo !== "HEAD") {
        return { evento: "acao", visivel: true, emUso: true };
    }
    if (!caminho) {
        return { evento: null, visivel: visivelPeloQuadro, emUso: emUsoPeloQuadro };
    }
    if (caminho === "/api/board/stream") {
        return { evento: "quadro_ao_vivo", visivel: visivelPeloQuadro, emUso: emUsoPeloQuadro };
    }
    if (caminho.startsWith("/api/")) {
        return { evento: null, visivel: visivelPeloQuadro, emUso: emUsoPeloQuadro };
    }
    // Página. Pré-carregamento de link não é ninguém olhando; router.refresh() da
    // mesma página (o quadro faz isso a cada mudança) não é navegação nova.
    if (contexto.prefetch) {
        return { evento: null, visivel: false, emUso: false };
    }
    if (contexto.rsc && caminho === ultimaPaginaDaSessao) {
        return { evento: null, visivel: visivelPeloQuadro, emUso: emUsoPeloQuadro };
    }
    return { evento: "pagina", visivel: true, emUso: true };
}

/** Segmento que parece segredo (token de redefinição, convite) vira "…"; uuid (id de médico) fica. */
export function mascararCaminho(caminho: string) {
    return caminho
        .split("/")
        .map((segmento) => (
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segmento) || !/^[A-Za-z0-9_.~-]{24,}$/.test(segmento)
                ? segmento
                : "…"
        ))
        .join("/");
}

const PAGINAS: Array<[RegExp, string]> = [
    [/^\/$/, "abriu a Mesa operacional"],
    [/^\/historico-operacional/, "abriu o histórico operacional"],
    [/^\/historico\/turno-anterior/, "abriu o plantão anterior"],
    [/^\/admin\/acessos/, "abriu o monitor de acessos"],
    [/^\/admin\/payment-closing/, "abriu o fechamento de pagamento"],
    [/^\/admin\/bank-hours/, "abriu o banco de horas (admin)"],
    [/^\/admin\/payment-attestation/, "abriu a atestação"],
    [/^\/admin\/reports/, "abriu os relatórios"],
    [/^\/admin\/medicos/, "abriu o cadastro de médicos"],
    [/^\/admin\//, "abriu uma tela da coordenação"],
    [/^\/medico/, "abriu o painel do médico"],
    [/^\/banco-de-horas/, "abriu o banco de horas"],
    [/^\/folha-ponto/, "abriu a folha de ponto"],
];

const ACOES: Array<[RegExp, string]> = [
    [/^\/api\/regulation\//, "mexeu em plantão ou ramal da regulação"],
    [/^\/api\/intervention\//, "mexeu em plantão ou base da intervenção"],
    [/^\/api\/operational\/undo/, "desfez uma ação no quadro"],
    [/^\/api\/operational\//, "remanejou ou corrigiu no quadro"],
    [/^\/api\/board\/occurrence-handoff/, "mexeu na passagem de ocorrências"],
    [/^\/api\/board\/meal-breaks/, "mexeu nas prioridades de refeição"],
    [/^\/api\/auth\/change-password/, "trocou a senha"],
    [/^\/api\/auth\/logout/, "saiu"],
    [/^\/api\/admin\/acessos/, "agiu no monitor de acessos"],
    [/^\/api\/admin\//, "fez uma ação administrativa"],
    [/^\/api\/chief\//, "mexeu em acesso de chefia"],
    [/^\/api\/medico\//, "mexeu nos próprios dados de médico"],
];

/** Frase para a linha do tempo: "abriu a Mesa operacional", "mexeu em plantão da regulação". */
export function descreverPedido(tipo: string, metodo: string | null, caminho: string | null) {
    if (tipo === "quadro_ao_vivo") return "ligou o quadro ao vivo";
    if (!caminho) return tipo === "acao" ? `ação ${metodo ?? ""}`.trim() : "abriu uma página";
    const tabela = tipo === "acao" ? ACOES : PAGINAS;
    for (const [padrao, frase] of tabela) if (padrao.test(caminho)) return frase;
    return tipo === "acao" ? `ação ${metodo ?? ""} em ${caminho}`.replace(/\s+/g, " ") : `abriu ${caminho}`;
}
