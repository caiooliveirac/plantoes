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

/** Acerto de banco de horas do mês, para o aviso destacado na folha. */
export interface AjusteBancoHoras {
    /** payroll = abatimento em folha do estatutário (só aviso; não mexe em plantão). */
    kind: "bonus" | "penalty" | "payroll";
    /** ISO — quando o coordenador lançou. */
    lancadoEm: string;
    lancadoPor: string | null;
    /** Dia do plantão verde/vermelho gerado (YYYY-MM-DD), se houver. */
    dataPlantao: string | null;
    observacao: string;
    /** true quando este lançamento estorna um acerto anterior. */
    estorno: boolean;
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
    /** Acertos de banco de horas do mês (aviso destacado, não sai na impressão). */
    ajustesBancoHoras: AjusteBancoHoras[];
}
