/* Presença na Mesa (docs/presenca-mesa.md) — regras puras.

   1. Uma tela da Mesa por conta: o aparelho que abriu primeiro fica com a vez
      (lease) enquanto renovar; outro aparelho da mesma conta espera ela vencer.
      Não há botão de "assumir".
   2. Tela parada expira: sem mexer, rolar, tocar ou teclar por OCIOSO_MIN, o
      aparelho é bloqueado e só volta com a senha. O bloqueio é do aparelho —
      entrar de novo pelo portal não o desfaz.

   O cliente informa "visível" e "segundos parado". É sinal, não prova: quem
   forja o sinal mantém UMA tela viva, nunca duas (o lease não depende dele).
   O servidor é quem decide, com o relógio do banco. */

export type ModoPresenca = "desligado" | "sombra" | "valendo";

/** MESA_PRESENCA: "0" desliga, "1" vale, qualquer outra coisa (inclusive vazio) é sombra — registra sem bloquear. */
export function modoPresenca(env: Record<string, string | undefined> = process.env): ModoPresenca {
    const valor = env.MESA_PRESENCA?.trim().toLowerCase();
    if (valor === "0" || valor === "desligado") return "desligado";
    if (valor === "1" || valor === "valendo") return "valendo";
    return "sombra";
}

export const OCIOSO_MIN_PADRAO = 15;

/** Minutos sem interação até bloquear (MESA_OCIOSO_MIN, 5 a 240; padrão 15). */
export function limiteOciosoSeg(env: Record<string, string | undefined> = process.env): number {
    const minutos = Number(env.MESA_OCIOSO_MIN);
    const valido = Number.isFinite(minutos) && minutos >= 5 && minutos <= 240 ? minutos : OCIOSO_MIN_PADRAO;
    return Math.round(valido * 60);
}

/** O cliente renova a cada 15 s com a aba visível; o lease vale 45 s (3 batidas perdidas). */
export const BATIDA_MS = 15_000;
export const LEASE_TTL_S = 45;
/** O aviso "Ainda está aí?" aparece este tanto antes do bloqueio. */
export const AVISO_ANTES_S = 60;
/** Recurso protegido. Tabela entra depois (docs/presenca-mesa.md, "Próximos passos"). */
export const RECURSO_MESA = "mesa";

export type EstadoPresenca = "ok" | "ocupada" | "bloqueada";

/** Bloqueado se o último bloqueio não foi desfeito por um desbloqueio posterior. */
export function estaBloqueado(p: { lockedAt: Date | null; unlockedAt: Date | null } | null | undefined): boolean {
    if (!p?.lockedAt) return false;
    return !p.unlockedAt || p.unlockedAt < p.lockedAt;
}

/**
 * Última interação humana depois desta batida. `paradoSeg` é o que o cliente
 * diz; `humanoAgora` é abertura de página (navegação = alguém clicou/digitou).
 * Nunca volta no tempo: a maior entre a guardada e a informada.
 */
export function ultimaInteracao(entrada: {
    agora: Date;
    guardada: Date | null;
    paradoSeg: number | null;
    humanoAgora: boolean;
}): Date | null {
    const candidatos: number[] = [];
    if (entrada.guardada) candidatos.push(entrada.guardada.getTime());
    if (entrada.humanoAgora) candidatos.push(entrada.agora.getTime());
    if (entrada.paradoSeg !== null && Number.isFinite(entrada.paradoSeg) && entrada.paradoSeg >= 0) {
        candidatos.push(entrada.agora.getTime() - Math.round(entrada.paradoSeg) * 1000);
    }
    if (candidatos.length === 0) return null;
    return new Date(Math.min(entrada.agora.getTime(), Math.max(...candidatos)));
}

/** Ocioso demais? Sem nenhuma interação conhecida ainda, não (é o primeiro contato). */
export function passouDoLimite(agora: Date, ultima: Date | null, limiteSeg: number): boolean {
    if (!ultima) return false;
    return agora.getTime() - ultima.getTime() > limiteSeg * 1000;
}

/** Lê o corpo da batida sem confiar nele: tudo que não for número/booleano vira null/false. */
export function lerBatida(corpo: unknown): { visivel: boolean; paradoSeg: number | null } {
    const obj = (corpo && typeof corpo === "object" ? corpo : {}) as Record<string, unknown>;
    const parado = typeof obj.paradoSeg === "number" && Number.isFinite(obj.paradoSeg) && obj.paradoSeg >= 0
        ? Math.min(Math.round(obj.paradoSeg), 7 * 24 * 3600)
        : null;
    return { visivel: obj.visivel === true, paradoSeg: parado };
}

export const MENSAGEM_OCUPADA = "A Mesa desta conta está aberta em outro aparelho. Ela abre aqui quando aquela tela for fechada.";
export const MENSAGEM_BLOQUEADA = "A Mesa foi fechada neste aparelho por falta de uso. Digite a senha para voltar.";
