/* Atitude automática diante de risco alto (docs/monitor-acessos.md).
   Admin não entra. Os outros: primeiro derruba as sessões; se depois disso
   a conta volta a aparecer em lugares diferentes, troca a senha. */

export const JANELA_ATITUDE_MS = 20 * 60 * 1000;
/** Conta forte que segue aberta em 2+ redes: o episódio pode ter "acabado" no
    papel enquanto as sessões continuam. Olha o mesmo intervalo do ciclo (3 h). */
export const AINDA_ABERTO_MS = 3 * 60 * 60 * 1000;
/** Segunda vez dentro deste prazo é insistência, não um caso novo. */
export const INSISTENCIA_MS = 24 * 60 * 60 * 1000;

export type AtitudeDeRisco = "isento" | "nada" | "derrubar" | "trocar_senha";

export function atitudeDeRiscoLigada() {
    const valor = process.env.ACESSOS_ATITUDE_RISCO?.trim().toLowerCase();
    return valor !== "0" && valor !== "false";
}

interface Episodio {
    forca: string;
    inicio: Date;
    fim: Date;
}

interface Marca {
    tipo: string;
    em: Date;
}

/** Admin nunca. Risco alto recente: derruba. Novo episódio forte depois de uma
    derrubada, dentro de 24 h: troca a senha. Já derrubada neste episódio: espera. */
export function decidirAtitude(entrada: {
    papeis: readonly string[];
    nivel: string;
    episodios: readonly Episodio[];
    eventos: readonly Marca[];
    agora: Date;
    /** Ainda há sessão aberta em 2+ redes. */
    aindaAberto: boolean;
}): AtitudeDeRisco {
    if (entrada.papeis.includes("admin")) return "isento";
    if (entrada.nivel !== "forte") return "nada";

    const agora = entrada.agora.getTime();
    const fortes = entrada.episodios.filter((episodio) => episodio.forca === "forte" && (
        agora - episodio.fim.getTime() <= JANELA_ATITUDE_MS
        || (entrada.aindaAberto && agora - episodio.fim.getTime() <= AINDA_ABERTO_MS)
    ));
    let recente = fortes.sort((a, b) => b.fim.getTime() - a.fim.getTime())[0];
    if (!recente && entrada.aindaAberto) {
        recente = { forca: "forte", inicio: entrada.agora, fim: entrada.agora };
    }
    if (!recente) return "nada";

    const exigiuSenha = entrada.eventos.some((evento) => (
        (evento.tipo === "auto_exigir_nova_senha" || evento.tipo === "admin_exigir_nova_senha")
        && evento.em.getTime() >= recente.inicio.getTime()
    ));
    if (exigiuSenha) return "nada";

    const derrubadas = entrada.eventos.filter((evento) => (
        evento.tipo === "auto_encerrar_sessoes" || evento.tipo === "admin_encerrar_sessoes"
    ));
    const ultima = derrubadas.sort((a, b) => b.em.getTime() - a.em.getTime())[0];
    if (!ultima) return "derrubar";
    if (ultima.em.getTime() >= recente.inicio.getTime()) return "nada";
    if (recente.inicio.getTime() - ultima.em.getTime() <= INSISTENCIA_MS) return "trocar_senha";
    return "derrubar";
}
