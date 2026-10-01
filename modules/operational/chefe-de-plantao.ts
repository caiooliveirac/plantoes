/**
 * Chefe de plantão = quem ocupa a 2031 agora (CHIEF_REGULATION_POST_CODE).
 *
 * Regra decidida em 01/10/2026 (docs/plano-mesa-chefe-plantonista.md): um
 * chief logado que NÃO é quem está na 2031, enquanto OUTRO médico está lá,
 * continua vendo o quadro mas toda escrita da Mesa é barrada com 409 e o
 * cliente pergunta "esqueceu de entrar com a sua conta?". Admin é isento.
 * 2031 vazia (madrugada, virada) libera qualquer chief em turno, como antes.
 *
 * Módulo puro: decide e escreve o texto. Quem consulta o banco é o service.
 */

export const CHEFE_DE_PLANTAO_OUTRO_CODE = "chefe_de_plantao_outro";

export interface ChefeDePlantaoAtual {
    doctorId: string;
    nome: string;
    /** ISO da chegada ao quadro na 2031. */
    desde: string | null;
}

export function travaChefeDePlantaoLigada(env: Record<string, string | undefined> = process.env) {
    return env.MESA_TRAVA_2031 !== "0";
}

/** true quando a escrita deve ser barrada. */
export function deveBarrarEscritaDaMesa(params: {
    isAdmin: boolean;
    isChief: boolean;
    sessionDoctorId: string | null;
    chefe: ChefeDePlantaoAtual | null;
}) {
    if (params.isAdmin || !params.isChief) return false;
    if (!params.chefe) return false;
    return params.chefe.doctorId !== params.sessionDoctorId;
}

function horaSP(iso: string | null) {
    if (!iso) return null;
    const data = new Date(iso);
    if (Number.isNaN(data.getTime())) return null;
    return new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/Sao_Paulo" }).format(data);
}

/** Mensagem do 409. O cliente reconhece pelo prefixo "O chefe de plantão agora é". */
export function mensagemChefeDePlantaoOutro(chefe: ChefeDePlantaoAtual) {
    const hora = horaSP(chefe.desde);
    return `O chefe de plantão agora é ${chefe.nome}${hora ? ` (na 2031 desde ${hora})` : ""}. Esqueceu de entrar com a sua conta?`;
}

export const PREFIXO_MENSAGEM_CHEFE_OUTRO = "O chefe de plantão agora é ";
