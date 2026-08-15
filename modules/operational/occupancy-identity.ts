/**
 * Identidade do plantão: qual ocupação uma chegada representa.
 *
 * A tabela de ocupações faz dois papéis ao mesmo tempo — o EVENTO ("fulano
 * avisou chegada às 07:36") e o PLANTÃO ("fulano cobriu o 2151 no SD de 13/08").
 * Evento repetido é rotina: o médico reenvia, o chefe lança de novo, alguém
 * corrige. Como a linha é a mesma coisa, todo evento repetido virava um plantão
 * repetido — e plantão repetido paga em dobro.
 *
 * Inventário de 4 meses (pares sobrepostos do mesmo médico no mesmo alvo, fora
 * da carga `import`, sobreposição > 30min):
 *
 *   - 16 pares nasceram com a anterior AINDA ABERTA   → "reuse"
 *   - 131 pares nasceram com a anterior JÁ FECHADA    → "merge"
 *
 * Os 131 são o caso que ninguém tratava: o médico "saiu" (ou foi rendido por
 * engano, como Maria Juliana na BR05 em 14/08) e a chegada seguinte do MESMO
 * médico no MESMO alvo, dentro da MESMA janela, criava uma segunda linha em vez
 * de juntar com a primeira — as duas com horários diferentes, e ninguém sabendo
 * qual valia.
 *
 * Este módulo é puro: decide, não escreve. Quem escreve são os serviços dos dois
 * domínios (regulação e intervenção), que precisam concordar sobre o que é o
 * mesmo plantão.
 */

export interface OccupancyIdentitySnapshot {
    id: string;
    doctorId: string;
    startedAt: Date;
    /** Fechada quando não é nulo. */
    endedAt: Date | null;
    /** Saída verbalizada — nulo quando o fechamento foi automático/por terceiro. */
    actualEndedAt: Date | null;
    scheduledEndAt: Date | null;
    /** Sombra nunca é o mesmo plantão: ela existe justamente para coexistir. */
    isShadow?: boolean;
    /**
     * Saída já validada por um humano. Aí a chegada seguinte é um plantão novo,
     * não o desmentido de um registro automático — juntar apagaria a decisão da
     * chefia (inclusive o desfecho de pagamento que ela assinou).
     */
    departureConfirmed?: boolean;
}

export type ArrivalIdentity =
    /** Nenhuma ocupação anterior representa este plantão: pode inserir. */
    | { kind: "create" }
    /** Mesmo plantão, ainda aberto: atualizar no lugar em vez de inserir. */
    | {
        kind: "reuse";
        occupancyId: string;
        keptStartedAt: Date;
        /** Chegada anterior, quando a nova diverge dela. */
        previousStartedAt: Date;
    }
    /** Mesmo plantão, já fechado: juntar (reabrir) em vez de criar duplicata. */
    | {
        kind: "merge";
        occupancyId: string;
        keptStartedAt: Date;
        previousStartedAt: Date;
        /** Saída registrada que a nova chegada contradiz (nula = fechamento automático). */
        previousDepartureAt: Date | null;
    };

/** Chegada até 1h antes do registro anterior ainda é o mesmo plantão (correção de horário). */
export const ARRIVAL_IDENTITY_LEAD_MINUTES = 60;

/**
 * Chegada nos últimos 30min da janela é o plantão SEGUINTE, não este. É o que
 * separa "o médico emendou SD e SN no mesmo ramal" (duas ocupações, correto) de
 * "o médico redeclarou o plantão que já estava rolando" (uma ocupação).
 */
export const ARRIVAL_IDENTITY_TAIL_MINUTES = 30;

/** Janela presumida quando a ocupação não tem fim programado. */
export const ARRIVAL_IDENTITY_DEFAULT_WINDOW_MINUTES = 12 * 60;

function minutesToMs(minutes: number) {
    return minutes * 60_000;
}

function resolveWindowEndAt(existing: OccupancyIdentitySnapshot) {
    return existing.scheduledEndAt
        ?? new Date(existing.startedAt.getTime() + minutesToMs(ARRIVAL_IDENTITY_DEFAULT_WINDOW_MINUTES));
}

/**
 * A chegada cai dentro da janela desta ocupação?
 *
 * Exportada porque a guarda de duplicidade da tela usa a mesma pergunta para
 * decidir se pede confirmação — a tela e o serviço têm que concordar.
 */
export function coversArrival(existing: OccupancyIdentitySnapshot, arrivalAt: Date) {
    const windowEndAt = resolveWindowEndAt(existing);
    const earliest = existing.startedAt.getTime() - minutesToMs(ARRIVAL_IDENTITY_LEAD_MINUTES);
    const latest = windowEndAt.getTime() - minutesToMs(ARRIVAL_IDENTITY_TAIL_MINUTES);

    // Janela curta demais (meio plantão já quase no fim): não sobra faixa de
    // reaproveitamento e a chegada vira plantão novo.
    if (latest <= earliest) {
        return false;
    }

    return arrivalAt.getTime() >= earliest && arrivalAt.getTime() < latest;
}

/**
 * Decide o que uma chegada é: plantão novo, redeclaração do que está aberto, ou
 * junção com o que foi fechado dentro da mesma janela.
 *
 * `existing` deve conter apenas ocupações do MESMO médico no MESMO alvo — o
 * chamador já filtrou por isso. Ocupação de outro médico é rendição/tomada e
 * segue por outro caminho.
 */
export function resolveArrivalIdentity(params: {
    startedAt: Date;
    existing: OccupancyIdentitySnapshot[];
}): ArrivalIdentity {
    const candidates = params.existing
        .filter((existing) => !existing.isShadow)
        .filter((existing) => !(existing.endedAt && existing.departureConfirmed))
        .filter((existing) => coversArrival(existing, params.startedAt))
        // Mais recente primeiro: é a que representa o plantão em curso.
        .sort((left, right) => right.startedAt.getTime() - left.startedAt.getTime());

    const chosen = candidates[0];
    if (!chosen) {
        return { kind: "create" };
    }

    // A chegada só move o início para TRÁS (correção de horário esquecido).
    // Para frente seria apagar tempo já registrado — quase sempre é a hora do
    // reenvio, não a hora em que o médico chegou.
    const keptStartedAt = params.startedAt.getTime() < chosen.startedAt.getTime()
        ? params.startedAt
        : chosen.startedAt;

    if (!chosen.endedAt) {
        return {
            kind: "reuse",
            occupancyId: chosen.id,
            keptStartedAt,
            previousStartedAt: chosen.startedAt,
        };
    }

    return {
        kind: "merge",
        occupancyId: chosen.id,
        keptStartedAt,
        previousStartedAt: chosen.startedAt,
        previousDepartureAt: chosen.actualEndedAt ?? null,
    };
}

/** Nota de auditoria da junção: a saída que a chegada nova contradisse. */
export function describeMergedArrival(params: {
    previousDepartureAt: Date | null;
    arrivalAt: Date;
}) {
    const hora = (value: Date) => new Intl.DateTimeFormat("pt-BR", {
        hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo",
    }).format(value);

    const chegada = hora(params.arrivalAt);
    return params.previousDepartureAt
        ? `[JUNTADO] nova chegada às ${chegada} no mesmo plantão: a saída registrada às `
        + `${hora(params.previousDepartureAt)} não encerrou o plantão. Confira os horários.`
        : `[JUNTADO] nova chegada às ${chegada} no mesmo plantão, que tinha sido encerrado sem saída verbalizada.`;
}
