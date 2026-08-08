/**
 * Onde pendurar o plantão extra que o médico declarou quando o dia/turno
 * escolhido deixa de estar livre — porque ele acabou trabalhando de verdade
 * naquele turno.
 *
 * O extra é uma unidade de pagamento pendurada num dia; dois lançamentos no
 * mesmo dia+turno viram um pagamento duplicado do mesmo slot. Então o extra
 * anda para o primeiro slot livre, e o valor não pode mudar por causa disso:
 * dia de semana e dia premium (fim de semana/feriado) pagam diferente, por isso
 * a primeira varredura só aceita dia da MESMA classe. Só se não sobrar nada é
 * que aceita a outra classe — e aí o aviso ao coordenador é o que resolve.
 */
export interface ExtraSlot {
    operationalDate: string;
    shiftLabel: "SD" | "SN";
}

export function slotKey(slot: ExtraSlot): string {
    return `${slot.operationalDate}|${slot.shiftLabel}`;
}

function daysInMonth(monthKey: string): number {
    const [year, month] = monthKey.split("-").map(Number);
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Ordem de tentativa a partir do slot atual: o outro turno do mesmo dia, depois
 * os dias vizinhos (1 à frente, 1 atrás, 2 à frente, …), SD antes de SN.
 */
function candidateSlots(current: ExtraSlot, monthKey: string): ExtraSlot[] {
    const total = daysInMonth(monthKey);
    const currentDay = Number(current.operationalDate.slice(8, 10));
    const otherShift: "SD" | "SN" = current.shiftLabel === "SD" ? "SN" : "SD";
    const candidates: ExtraSlot[] = [
        { operationalDate: current.operationalDate, shiftLabel: otherShift },
    ];
    for (let offset = 1; offset <= total; offset += 1) {
        for (const day of [currentDay + offset, currentDay - offset]) {
            if (day < 1 || day > total) continue;
            const operationalDate = `${monthKey}-${String(day).padStart(2, "0")}`;
            candidates.push({ operationalDate, shiftLabel: "SD" });
            candidates.push({ operationalDate, shiftLabel: "SN" });
        }
    }
    return candidates;
}

/**
 * Primeiro slot livre do mês para o extra. `occupied` traz as chaves
 * `YYYY-MM-DD|SD` já tomadas pelo médico (plantões reais + outros extras dele).
 * `isPremium` diz se o dia paga como fim de semana/feriado.
 *
 * Devolve null quando o mês inteiro está tomado — aí o coordenador decide.
 */
export function findFreeExtraSlot(params: {
    current: ExtraSlot;
    monthKey: string;
    occupied: ReadonlySet<string>;
    isPremium: (operationalDate: string) => boolean;
}): ExtraSlot | null {
    const { current, monthKey, occupied, isPremium } = params;
    const currentIsPremium = isPremium(current.operationalDate);
    const candidates = candidateSlots(current, monthKey).filter((slot) => !occupied.has(slotKey(slot)));

    return candidates.find((slot) => isPremium(slot.operationalDate) === currentIsPremium)
        ?? candidates[0]
        ?? null;
}
