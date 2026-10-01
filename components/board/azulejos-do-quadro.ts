/**
 * Transforma o snapshot do quadro em azulejos para o SeletorDePosto.
 * Sem React: puro, testável em node:test.
 */
import type {
    InterventionBoardRow,
    OperationalBoardSnapshot,
    RegulationBoardRow,
} from "@/services/board.service";

export type PostoAzulejo = {
    domain: "regulation" | "intervention";
    /** id do posto / da base, como string. */
    targetId: string;
    /** "1362", "CB02". */
    code: string;
    /** Nome de exibição da base/posto, se houver e for diferente do código. */
    nome?: string | null;
    status: "livre" | "ocupado" | "desativado" | "origem";
    /** Nome do médico quando ocupado. */
    ocupante?: string | null;
    /** ISO da chegada do ocupante. */
    ocupanteDesde?: string | null;
    /** Ramal eventual (2266–2270, 4091). */
    onDemand?: boolean;
};

export interface OrigemDoAzulejo {
    domain: string;
    targetId: string;
}

export interface OpcoesAzulejos {
    /** Posto/base de onde o médico sai — vira `status: "origem"`. */
    origem?: OrigemDoAzulejo | null;
}

type SnapshotParaAzulejos = Pick<OperationalBoardSnapshot, "regulation" | "intervention">;

function ehOrigem(origem: OrigemDoAzulejo | null | undefined, domain: string, targetId: string): boolean {
    return Boolean(origem && origem.domain === domain && String(origem.targetId) === targetId);
}

function statusDaLinha(
    row: Pick<RegulationBoardRow, "status" | "doctorId">,
): PostoAzulejo["status"] {
    if (row.status === "disabled") return "desativado";
    if (row.status === "active" && row.doctorId) return "ocupado";
    return "livre";
}

function nomeOuNulo(code: string, label: string | null | undefined): string | null {
    const limpo = (label ?? "").trim();
    return limpo && limpo !== code ? limpo : null;
}

function azulejoDaRegulacao(row: RegulationBoardRow, origem: OrigemDoAzulejo | null | undefined): PostoAzulejo {
    const targetId = String(row.postId);
    const base = {
        domain: "regulation" as const,
        targetId,
        code: row.postCode,
        nome: nomeOuNulo(row.postCode, row.postLabel),
        onDemand: Boolean(row.onDemand),
    };
    if (ehOrigem(origem, "regulation", targetId)) {
        return { ...base, status: "origem", ocupante: row.displayName ?? row.doctorName ?? null, ocupanteDesde: row.startedAt };
    }
    const status = statusDaLinha(row);
    return {
        ...base,
        status,
        ocupante: status === "ocupado" ? row.displayName ?? row.doctorName ?? null : null,
        ocupanteDesde: status === "ocupado" ? row.startedAt : null,
    };
}

function azulejoDaIntervencao(row: InterventionBoardRow, origem: OrigemDoAzulejo | null | undefined): PostoAzulejo {
    const targetId = String(row.baseId);
    const base = {
        domain: "intervention" as const,
        targetId,
        code: row.baseCode,
        nome: nomeOuNulo(row.baseCode, row.baseLabel),
        onDemand: false,
    };
    if (ehOrigem(origem, "intervention", targetId)) {
        return { ...base, status: "origem", ocupante: row.displayName ?? row.doctorName ?? null, ocupanteDesde: row.startedAt };
    }
    const status = statusDaLinha(row);
    const dupla = row.companionOccupants?.map((c) => c.displayName ?? c.doctorName).filter(Boolean) ?? [];
    const titular = row.displayName ?? row.doctorName ?? null;
    const ocupante = status === "ocupado" ? [titular, ...dupla].filter(Boolean).join(" + ") || null : null;
    return {
        ...base,
        status,
        ocupante,
        ocupanteDesde: status === "ocupado" ? row.startedAt : null,
    };
}

/**
 * Um azulejo por linha do quadro, na ordem do snapshot. Linhas repetidas do
 * mesmo posto/base (cobertura de madrugada, carry-over) ficam só com a
 * primeira; linhas de madrugada expõem os ocultos como ocupantes reais.
 */
export function azulejosDoSnapshot(snapshot: SnapshotParaAzulejos, opts: OpcoesAzulejos = {}): PostoAzulejo[] {
    const origem = opts.origem ?? null;
    const vistos = new Set<string>();
    const saida: PostoAzulejo[] = [];
    const empurrar = (a: PostoAzulejo) => {
        const chave = `${a.domain}:${a.targetId}`;
        if (vistos.has(chave)) return;
        vistos.add(chave);
        saida.push(a);
    };
    for (const row of snapshot.regulation) {
        empurrar(azulejoDaRegulacao(row, origem));
        for (const oculto of row.madrugadaOcultos ?? []) {
            empurrar(azulejoDaRegulacao(oculto, origem));
        }
    }
    for (const row of snapshot.intervention) {
        empurrar(azulejoDaIntervencao(row, origem));
    }
    return saida;
}
