import type { Plantao, LinhaFreq, LinhaRelatorio } from "./types";

const HORA_SD_ENTRADA_DEFAULT = "07:00";
const HORA_SD_SAIDA_DEFAULT = "19:00";
const HORA_SN_ENTRADA_DEFAULT = "19:00";
const HORA_SN_SAIDA_DEFAULT = "07:00";

export function montarLinhasFrequencia(plantoes: Plantao[]): Record<number, LinhaFreq> {
    const dias: Record<number, LinhaFreq> = {};
    for (let d = 1; d <= 31; d++) {
        dias[d] = { e1: "", s1: "", e2: "", s2: "" };
    }

    for (const p of plantoes) {
        if (p.turno === "SD") {
            dias[p.dia].e1 = p.horaEntrada ?? HORA_SD_ENTRADA_DEFAULT;
            dias[p.dia].s1 = p.horaSaida ?? HORA_SD_SAIDA_DEFAULT;
        } else if (p.turno === "SN") {
            dias[p.dia].e2 = p.horaEntrada ?? HORA_SN_ENTRADA_DEFAULT;
            if (p.dia + 1 <= 31) {
                dias[p.dia + 1].s2 = p.horaSaida ?? HORA_SN_SAIDA_DEFAULT;
            }
        }
    }
    return dias;
}

export function montarRelatorio(plantoes: Plantao[], mes: number): LinhaRelatorio[] {
    const ordenados = [...plantoes].sort((a, b) => {
        if (a.dia !== b.dia) return a.dia - b.dia;
        if (a.turno !== b.turno) return a.turno === "SD" ? -1 : 1;
        return a.baseNomeCurto.localeCompare(b.baseNomeCurto, "pt-BR");
    });

    return ordenados.map((p) => ({
        data: `${String(p.dia).padStart(2, "0")}/${String(mes).padStart(2, "0")}`,
        atividade: `${p.turno} na ${p.baseNomeCurto}`,
    }));
}
