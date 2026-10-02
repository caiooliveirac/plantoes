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
