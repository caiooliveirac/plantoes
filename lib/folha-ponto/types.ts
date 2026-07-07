export type Turno = "SD" | "SN";

export interface Plantao {
    dia: number;
    turno: Turno;
    baseNomeCurto: string;
    horaEntrada?: string;
    horaSaida?: string;
    meioPlantao?: boolean;
}

export interface LinhaFreq {
    e1: string;
    s1: string;
    e2: string;
    s2: string;
}

export interface LinhaRelatorio {
    data: string;
    atividade: string;
}

export interface DadosFolhaPonto {
    medico: {
        id: string;
        nome: string;
        cnpj?: string | null;
        razaoSocial?: string | null;
    };
    ano: number;
    mes: number;
    plantoes: Plantao[];
}
