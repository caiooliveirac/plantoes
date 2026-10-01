/**
 * Enfermeiro(a) do plantão — regras puras do turno (quem consulta o banco e
 * a escala é services/enfermeiro-plantao.service.ts).
 *
 * Turno = o mesmo da Mesa (resolveOperationalShiftWindow): SD 07–19, SN
 * 19–07 em Salvador; o SN depois da meia-noite pertence à data anterior.
 *
 * Portão do quadro.mnrs.com.br: o enfermeiro(a) registrado passa com as
 * mesmas folgas dos médicos (modules/acessos/portao.ts) — 30 min antes do
 * início do turno e até 60 min depois do fim. Perto da virada valem, então,
 * dois turnos: o que acabou (até 60 min depois) e o que vai começar (30 min
 * antes).
 */

import { FOLGA_ANTES_DO_TURNO_MS, FOLGA_DEPOIS_DO_TURNO_MS } from "@/modules/acessos/portao";
import { getSaoPauloParts, resolveOperationalShiftWindow, type OperationalShiftLabel } from "@/modules/operational/board-rules";

export interface TurnoDoEnfermeiro {
    /** Data operacional (YYYY-MM-DD) do início do turno, em Salvador. */
    data: string;
    turno: OperationalShiftLabel;
    inicio: Date;
    fim: Date;
}

const pad = (valor: number) => String(valor).padStart(2, "0");

export function turnoDoMomento(agora: Date = new Date()): TurnoDoEnfermeiro {
    const janela = resolveOperationalShiftWindow(agora);
    const partes = getSaoPauloParts(janela.startedAt);
    return {
        data: `${partes.year}-${pad(partes.month)}-${pad(partes.day)}`,
        turno: janela.shiftLabel,
        inicio: janela.startedAt,
        fim: janela.nextBoundaryAt,
    };
}

/** Turnos cujo enfermeiro(a) passa no portão agora: o corrente e, perto da
    virada, o anterior (até 60 min depois do fim) ou o seguinte (30 min antes). */
export function turnosDoPortao(agora: Date = new Date()): TurnoDoEnfermeiro[] {
    const atual = turnoDoMomento(agora);
    const turnos = [atual];
    if (agora.getTime() - atual.inicio.getTime() < FOLGA_DEPOIS_DO_TURNO_MS) {
        turnos.push(turnoDoMomento(new Date(atual.inicio.getTime() - 60_000)));
    }
    if (atual.fim.getTime() - agora.getTime() <= FOLGA_ANTES_DO_TURNO_MS) {
        turnos.push(turnoDoMomento(new Date(atual.fim.getTime() + 60_000)));
    }
    return turnos;
}

/** E-mails guardados e comparados sempre assim. */
export function normalizarEmail(email: string) {
    return email.trim().toLowerCase();
}

export function normalizarEmails(emails: readonly unknown[]): string[] {
    const vistos = new Set<string>();
    for (const email of emails) {
        if (typeof email !== "string") continue;
        const limpo = normalizarEmail(email);
        if (limpo.includes("@")) vistos.add(limpo);
    }
    return [...vistos];
}
