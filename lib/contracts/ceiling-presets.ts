/**
 * Tetos habituais por CH/categoria — mesma tabela de referência do backfill
 * (scripts/backfill-saldo-contrato.ts, REFERENCE_CEILINGS). Usada no modal do
 * fechamento (redefinir teto) e no cadastro de médico novo.
 */
export interface CeilingPreset {
    label: string;
    brl: number;
    weeklyHours: 24 | 36 | 48;
    category: "generalista" | "especialista";
}

export const CEILING_PRESETS: CeilingPreset[] = [
    { label: "24h generalista", brl: 165732, weeklyHours: 24, category: "generalista" },
    { label: "24h especialista", brl: 174858, weeklyHours: 24, category: "especialista" },
    { label: "36h generalista", brl: 248598, weeklyHours: 36, category: "generalista" },
    { label: "36h especialista", brl: 262287, weeklyHours: 36, category: "especialista" },
    { label: "48h generalista", brl: 331464, weeklyHours: 48, category: "generalista" },
    { label: "48h especialista", brl: 349716, weeklyHours: 48, category: "especialista" },
];

/** Quase todo médico novo entra como 24h generalista. */
export const DEFAULT_CEILING_PRESET = CEILING_PRESETS[0];
