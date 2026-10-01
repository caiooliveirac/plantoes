"use client";

import { useMemo } from "react";
import * as Slider from "@radix-ui/react-slider";
import { formatarHHMM, limitar, resolverHHMM, rotuloDelta } from "./editor-de-horario-logica";

const FIVE_MIN_MS = 5 * 60 * 1000;
const ONE_MIN_MS = 60 * 1000;

function snapTo5Min(ms: number) {
    return Math.round(ms / FIVE_MIN_MS) * FIVE_MIN_MS;
}

export interface TimeScrubberProps {
    /** Valor atual (epoch ms). */
    valueMs: number;
    /** Limite inferior (inclusivo). */
    minMs: number;
    /** Limite superior (inclusivo). */
    maxMs: number;
    /** Horário verbalizado originalmente — marcador de referência na trilha. */
    verbalizedMs: number | null;
    /** Fim programado da janela — marcador de alvo na trilha. */
    scheduledEndMs: number | null;
    /** Pinta como suspeito (ex.: atraso >= 60min ou padrão). */
    suspect?: boolean;
    /**
     * Prefixo das classes CSS. Padrão `departure-verifier` (estilos legados em
     * globals.css). O EditorDeHorario passa `mk-scrubber` (app/mesa-kit.css).
     */
    prefixoClasse?: string;
    /** Esconde o relógio grande e a linha de ±1/±5 min (quando o pai já os tem). */
    somenteTrilha?: boolean;
    /** Texto do aria-label do slider. */
    rotuloAcessivel?: string;
    onChange: (nextMs: number) => void;
}

/**
 * Arrasta para editar horário. Snap de 5min no slider; ±1 e ±5 min nos
 * botões; HH:MM para entrada direta. Teclado: ←/→ = ±5min, Home/End =
 * extremos. Horas sempre no fuso operacional (lib/time.ts), não no do
 * navegador.
 */
export function TimeScrubber({
    valueMs,
    minMs,
    maxMs,
    verbalizedMs,
    scheduledEndMs,
    suspect,
    prefixoClasse = "departure-verifier",
    somenteTrilha = false,
    rotuloAcessivel = "Horário",
    onChange,
}: TimeScrubberProps) {
    const p = prefixoClasse;
    const ticks = useMemo(() => {
        const span = maxMs - minMs;
        const targetCount = 6;
        const stepHours = Math.max(1, Math.round(span / 3600000 / (targetCount - 1)));
        const stepMs = stepHours * 3600000;
        const start = Math.ceil(minMs / stepMs) * stepMs;
        const items: number[] = [];
        for (let t = start; t <= maxMs; t += stepMs) {
            items.push(t);
        }
        if (items[0] !== minMs) items.unshift(minMs);
        if (items[items.length - 1] !== maxMs) items.push(maxMs);
        return items;
    }, [minMs, maxMs]);

    const clamp = (next: number) => limitar(next, minMs, maxMs);
    const posicao = (ms: number) => `${((clamp(ms) - minMs) / Math.max(1, maxMs - minMs)) * 100}%`;

    const deltaLabel = verbalizedMs === null ? "" : rotuloDelta(valueMs, verbalizedMs);

    return (
        <div className={`${p}-shell`}>
            {!somenteTrilha && (
                <div className={`${p}-time ${suspect ? "suspect" : ""}`.trim()}>
                    {formatarHHMM(valueMs)}
                    {deltaLabel && <span className={`${p}-time__delta`}> ({deltaLabel} vs verbalizado)</span>}
                </div>
            )}

            <div className={`${p}-trilha`}>
                {verbalizedMs !== null && verbalizedMs >= minMs && verbalizedMs <= maxMs && (
                    <span
                        className={`${p}-marcador ${p}-marcador--verbalizado`}
                        style={{ left: posicao(verbalizedMs) }}
                        title={`Verbalizado ${formatarHHMM(verbalizedMs)}`}
                        aria-hidden="true"
                    />
                )}
                {scheduledEndMs !== null && scheduledEndMs >= minMs && scheduledEndMs <= maxMs && (
                    <span
                        className={`${p}-marcador ${p}-marcador--janela`}
                        style={{ left: posicao(scheduledEndMs) }}
                        title={`Fim da janela ${formatarHHMM(scheduledEndMs)}`}
                        aria-hidden="true"
                    />
                )}
                <Slider.Root
                    className={`${p}-slider`}
                    data-suspect={suspect ? "true" : "false"}
                    min={minMs}
                    max={maxMs}
                    step={FIVE_MIN_MS}
                    value={[valueMs]}
                    onValueChange={([next]) => onChange(clamp(snapTo5Min(next)))}
                    aria-label={rotuloAcessivel}
                >
                    <Slider.Track className={`${p}-slider__track`}>
                        <Slider.Range className={`${p}-slider__range`} />
                    </Slider.Track>
                    <Slider.Thumb className={`${p}-slider__thumb`} aria-label="Arraste para ajustar" />
                </Slider.Root>
            </div>

            <div className={`${p}-slider__ticks`}>
                {ticks.map((tick) => (
                    <span key={tick}>{formatarHHMM(tick)}</span>
                ))}
            </div>

            {!somenteTrilha && (
                <div className={`${p}-stepper-row`}>
                    <button type="button" onClick={() => onChange(clamp(valueMs - FIVE_MIN_MS))} aria-label="Voltar 5 minutos">−5m</button>
                    <button type="button" onClick={() => onChange(clamp(valueMs - ONE_MIN_MS))} aria-label="Voltar 1 minuto">−1m</button>
                    <input
                        type="text"
                        inputMode="numeric"
                        pattern="\d{1,2}:\d{2}"
                        value={formatarHHMM(valueMs)}
                        onChange={(event) => {
                            const parsed = resolverHHMM(event.target.value, { valorMs: valueMs, minMs, maxMs });
                            if (parsed !== null) {
                                onChange(parsed);
                            }
                        }}
                        aria-label="Hora exata HH:MM"
                    />
                    <button type="button" onClick={() => onChange(clamp(valueMs + ONE_MIN_MS))} aria-label="Avançar 1 minuto">+1m</button>
                    <button type="button" onClick={() => onChange(clamp(valueMs + FIVE_MIN_MS))} aria-label="Avançar 5 minutos">+5m</button>
                    {scheduledEndMs !== null && (
                        <button
                            type="button"
                            onClick={() => onChange(clamp(scheduledEndMs))}
                            aria-label="Pular para o fim de janela"
                            style={{ marginLeft: "auto" }}
                        >
                            Janela {formatarHHMM(scheduledEndMs)}
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}
