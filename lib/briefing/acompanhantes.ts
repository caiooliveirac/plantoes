/**
 * Sombra e deslocado do quadro ao vivo, no formato que o secretário consome.
 *
 * Sombra é o segundo médico na mesma base ou ramal, marcado na nota da ocupação.
 * Não toma o lugar do titular. Deslocado perdeu o board numa tomada e segue
 * ativo fora do quadro. Os dois já vêm prontos de listInterventionBoard /
 * listRegulationBoard — aqui só se achata a linha.
 */

type Pessoa = {
    displayName?: string | null;
    doctorName?: string | null;
};

type Linha = {
    baseCode?: string;
    postCode?: string;
    displayName?: string | null;
    doctorName?: string | null;
    shiftLabel?: string | null;
    shadowOccupants?: Pessoa[];
    displacedOccupants?: Pessoa[];
};

export type Acompanhante = {
    dominio: "base" | "ramal";
    code: string;
    doctorName: string;
    titular: string | null;
    shiftLabel: string | null;
};

const nome = (pessoa?: Pessoa | null) => pessoa?.displayName || pessoa?.doctorName || null;

function achatar(
    rows: Linha[],
    dominio: "base" | "ramal",
    codeKey: "baseCode" | "postCode",
    campo: "shadowOccupants" | "displacedOccupants",
): Acompanhante[] {
    return rows.flatMap((row) => (row[campo] ?? []).flatMap((pessoa) => {
        const doctorName = nome(pessoa);
        const code = row[codeKey];
        if (!doctorName || !code) return [];
        return [{
            dominio,
            code,
            doctorName,
            titular: nome(row),
            shiftLabel: row.shiftLabel ?? null,
        }];
    }));
}

export function acompanantesDoQuadro(board: Linha[], regulacao: Linha[]) {
    return {
        sombras: [
            ...achatar(board, "base", "baseCode", "shadowOccupants"),
            ...achatar(regulacao, "ramal", "postCode", "shadowOccupants"),
        ],
        deslocados: [
            ...achatar(board, "base", "baseCode", "displacedOccupants"),
            ...achatar(regulacao, "ramal", "postCode", "displacedOccupants"),
        ],
    };
}
