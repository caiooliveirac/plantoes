/**
 * Escala EXTERNA (app escala.mnrs.com.br) — médicos esperados por posto.
 *
 * O quadro consome GET {ESCALA_API_URL}/api/esperados?data&turno para saber
 * quem é o médico previsto do turno corrente e do turno seguinte: nas
 * avançadas por base (SM01, CB02…); na regulação só o conjunto (o ramal de
 * cada um se decide na hora); COI e chefia (CP) têm posto próprio na escala.
 *
 * Fail-soft por desenho: sem ESCALA_API_URL, com o app de escala fora do ar
 * ou resposta inválida, devolve null e o quadro segue exatamente como hoje.
 */

import { getSaoPauloParts, resolveOperationalShiftWindow, type OperationalShiftLabel } from "@/modules/operational/board-rules";

export interface ExpectedDoctor {
    id: string;
    nome: string;
    nomeCurto: string;
    /** Código do turno na escala: SD/SN = chegada; P = 24 h (na noite, segue de serviço). */
    codigo: string;
}

export interface ExpectedShiftBoard {
    operationalDate: string;
    shiftLabel: OperationalShiftLabel;
    /** Fronteira de início do turno (ISO UTC) — a janela "1 h antes" conta a partir daqui. */
    shiftStartAt: string;
    /** Por código da base (SM01, CB02…). */
    intervention: Record<string, ExpectedDoctor[]>;
    /** Conjunto esperado na regulação (CRU), sem ramal definido. */
    regulation: ExpectedDoctor[];
    coi: ExpectedDoctor[];
    chief: ExpectedDoctor[];
}

export interface ExpectedScheduleData {
    current: ExpectedShiftBoard | null;
    upcoming: ExpectedShiftBoard | null;
}

const SUCCESS_TTL_MS = 5 * 60_000;
const FAILURE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 2_500;

const cache = new Map<string, { at: number; value: ExpectedShiftBoard | null }>();

function pad(value: number) {
    return String(value).padStart(2, "0");
}

function operationalDateOf(shiftStartAt: Date) {
    const parts = getSaoPauloParts(shiftStartAt);
    return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

function asDoctorList(value: unknown): ExpectedDoctor[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
        .map((item) => ({
            id: String(item.id ?? ""),
            nome: String(item.nome ?? ""),
            nomeCurto: String(item.nomeCurto ?? item.nome ?? ""),
            codigo: String(item.codigo ?? ""),
        }))
        .filter((item) => item.nome.length > 0);
}

async function fetchExpectedShift(
    operationalDate: string,
    shiftLabel: OperationalShiftLabel,
    shiftStartAt: Date,
): Promise<ExpectedShiftBoard | null> {
    const baseUrl = process.env.ESCALA_API_URL?.trim().replace(/\/+$/, "");
    if (!baseUrl) {
        return null;
    }

    const cacheKey = `${operationalDate}|${shiftLabel}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.at < (cached.value ? SUCCESS_TTL_MS : FAILURE_TTL_MS)) {
        return cached.value;
    }

    let value: ExpectedShiftBoard | null = null;
    try {
        const headers: Record<string, string> = {};
        const token = process.env.ESCALA_API_TOKEN?.trim();
        if (token) {
            headers["x-esperados-token"] = token;
        }

        const response = await fetch(
            `${baseUrl}/api/esperados?data=${operationalDate}&turno=${shiftLabel}`,
            { headers, cache: "no-store", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
        );
        if (response.ok) {
            const payload = await response.json() as Record<string, unknown>;
            if (payload.ok === true) {
                const intervention: Record<string, ExpectedDoctor[]> = {};
                const rawIntervention = payload.intervencao;
                if (rawIntervention && typeof rawIntervention === "object") {
                    for (const [code, list] of Object.entries(rawIntervention as Record<string, unknown>)) {
                        const doctors = asDoctorList(list);
                        if (doctors.length > 0) {
                            intervention[code.toUpperCase()] = doctors;
                        }
                    }
                }
                value = {
                    operationalDate,
                    shiftLabel,
                    shiftStartAt: shiftStartAt.toISOString(),
                    intervention,
                    regulation: asDoctorList(payload.regulacao),
                    coi: asDoctorList(payload.coi),
                    chief: asDoctorList(payload.chefia),
                };
            }
        }
    } catch {
        value = null;
    }

    cache.set(cacheKey, { at: Date.now(), value });
    return value;
}

/** Esperados do turno corrente e do seguinte — o cliente escolhe qual exibir
    conforme a janela pré-turno (1 h antes da fronteira 07:00/19:00). */
export async function getExpectedSchedule(reference: Date = new Date()): Promise<ExpectedScheduleData | null> {
    if (!process.env.ESCALA_API_URL?.trim()) {
        return null;
    }

    const currentWindow = resolveOperationalShiftWindow(reference);
    const upcomingWindow = resolveOperationalShiftWindow(new Date(currentWindow.nextBoundaryAt.getTime() + 60_000));

    const [current, upcoming] = await Promise.all([
        fetchExpectedShift(operationalDateOf(currentWindow.startedAt), currentWindow.shiftLabel, currentWindow.startedAt),
        fetchExpectedShift(operationalDateOf(upcomingWindow.startedAt), upcomingWindow.shiftLabel, upcomingWindow.startedAt),
    ]);

    if (!current && !upcoming) {
        return null;
    }

    return { current, upcoming };
}
