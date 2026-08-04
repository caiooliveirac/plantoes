export type Turno = "SD" | "SN";

export interface Plantao {
    dia: number;
    turno: Turno;
    baseNomeCurto: string;
    horaEntrada?: string;
    horaSaida?: string;
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
    /**
     * "Local e Data" já resolvido no servidor (fuso SP): a data de hoje, ou o
     * primeiro dia útil do mês seguinte quando hoje ainda é anterior a ele.
     * Ver lib/folha-ponto/emissao.ts.
     */
    localData: string;
}
