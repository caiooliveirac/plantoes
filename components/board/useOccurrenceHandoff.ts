"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    checkHandoffSchedule,
    planOccurrenceHandoff,
    resolveBreakLabel,
    resolveHandoffWindow,
    type HandoffCounts,
    type HandoffRosterEntry,
    type HandoffTransfer,
} from "@/modules/operational/occurrence-handoff";

interface PublicHandoffState {
    operationalDate: string;
    roster: HandoffRosterEntry[];
    record: { counts: Record<string, HandoffCounts>; transfers: HandoffTransfer[] } | null;
    window: { slot: string } | null;
}

function saoPauloHHMM(date: Date) {
    return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

/**
 * Estado da passagem de ocorrências no quadro. A divisão é recalculada aqui a cada
 * tecla (mesmo algoritmo e mesma divisão anterior do servidor, então o que aparece
 * é o que o servidor grava) e a contagem vai para o servidor com debounce.
 */
export function useOccurrenceHandoff(boardVersion: string) {
    const [state, setState] = useState<PublicHandoffState | null>(null);
    const [local, setLocal] = useState<Record<string, HandoffCounts>>({});
    const [error, setError] = useState<string | null>(null);
    const [now, setNow] = useState(() => saoPauloHHMM(new Date()));
    const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

    const window = resolveHandoffWindow(now);
    const slot = window?.slot ?? null;

    const load = useCallback(async () => {
        try {
            const response = await fetch("/api/board/occurrence-handoff", { cache: "no-store" });
            if (!response.ok) return;
            const body = await response.json() as { state: PublicHandoffState | null };
            setState(body.state);
        } catch {
            // sem rede: mantém o último estado
        }
    }, []);

    useEffect(() => { void load(); }, [load, boardVersion, slot]);

    useEffect(() => {
        const tick = globalThis.setInterval(() => setNow(saoPauloHHMM(new Date())), 15_000);
        return () => globalThis.clearInterval(tick);
    }, []);

    // Dentro da janela, acompanha o que os outros digitam; fora dela, só de vez em quando.
    useEffect(() => {
        const poll = globalThis.setInterval(() => { void load(); }, slot ? 5_000 : 60_000);
        return () => globalThis.clearInterval(poll);
    }, [load, slot]);

    useEffect(() => { setLocal({}); }, [slot]);

    const serverSlotMatches = Boolean(slot && state?.window?.slot === slot);
    const serverCounts = useMemo(() => (serverSlotMatches ? state?.record?.counts ?? {} : {}), [serverSlotMatches, state]);
    const previous = serverSlotMatches ? state?.record?.transfers : undefined;
    const counts = useMemo(() => ({ ...serverCounts, ...local }), [serverCounts, local]);

    const plan = useMemo(() => {
        if (!slot || !state) return null;
        return planOccurrenceHandoff({ roster: state.roster, slot, counts, seed: state.operationalDate, previous });
    }, [slot, state, counts, previous]);

    const setCounts = useCallback((ramal: string, next: HandoffCounts) => {
        if (!slot) return;
        setLocal((prev) => ({ ...prev, [ramal]: next }));
        setError(null);
        const pending = timers.current.get(ramal);
        if (pending) globalThis.clearTimeout(pending);
        timers.current.set(ramal, globalThis.setTimeout(async () => {
            timers.current.delete(ramal);
            try {
                const response = await fetch("/api/board/occurrence-handoff", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ slot, ramal, ...next }),
                });
                const body = await response.json().catch(() => ({})) as { error?: string; counts?: Record<string, HandoffCounts>; transfers?: HandoffTransfer[] };
                if (!response.ok) {
                    setError(body.error ?? "Não foi possível salvar a contagem.");
                    return;
                }
                setState((prev) => (prev && body.counts && body.transfers
                    ? { ...prev, window: { slot }, record: { counts: body.counts, transfers: body.transfers } }
                    : prev));
                setLocal((prev) => {
                    const rest = { ...prev };
                    delete rest[ramal];
                    return rest;
                });
            } catch {
                setError("Sem conexão: a contagem não foi salva.");
            }
        }, 400));
    }, [slot]);

    const byRamal = useMemo(() => new Map((state?.roster ?? []).map((entry) => [entry.ramal, entry])), [state]);
    const breakLabel = useCallback((ramal: string) => {
        const entry = byRamal.get(ramal);
        return entry ? resolveBreakLabel(entry, now) : null;
    }, [byRamal, now]);

    return {
        window,
        plan,
        counts,
        setCounts,
        breakLabel,
        role: (ramal: string) => byRamal.get(ramal)?.role ?? null,
        scheduleWarnings: state ? checkHandoffSchedule(state.roster) : [],
        error,
    };
}
