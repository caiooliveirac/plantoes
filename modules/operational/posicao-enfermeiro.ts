/** Posições do ERS (enfermagem reguladora) no turno: uma pessoa em cada.
    Puro, sem servidor: a Mesa (navegador) e a API usam o mesmo. */
export const POSICOES_ENFERMEIRO = ["ADM", "DISP", "FLUXO"] as const;
export type PosicaoEnfermeiro = (typeof POSICOES_ENFERMEIRO)[number];

export const ROTULO_POSICAO: Record<PosicaoEnfermeiro, string> = {
    ADM: "ADM · 4091",
    DISP: "DISP · 4092",
    FLUXO: "Fluxo · 3005",
};

export function ehPosicaoEnfermeiro(valor: unknown): valor is PosicaoEnfermeiro {
    return typeof valor === "string" && (POSICOES_ENFERMEIRO as readonly string[]).includes(valor);
}

/** Médico(a) DISP na Mesa agora: titular ativo do ramal 4092 (legado: o 4091
    com função DISP). É o DISP basal do ERS — vale até a chefia declarar um
    enfermeiro(a) no DISP; removido o enfermeiro(a), volta a ser ele. */
export function medicoDisp(ramais: ReadonlyArray<{ ramal: string; ativo: boolean; funcao: string | null; medico: string | null }>): string | null {
    const ativo = (codigo: string) => ramais.find((r) => r.ramal === codigo && r.ativo && r.medico);
    const legado = ativo("4091");
    return ativo("4092")?.medico ?? (legado?.funcao?.toUpperCase() === "DISP" ? legado.medico : null);
}
