"use client";

import { useMemo } from "react";
import * as Slider from "@radix-ui/react-slider";

const FIVE_MIN_MS = 5 * 60 * 1000;
const ONE_MIN_MS = 60 * 1000;

function formatLocalHourMinute(ms: number) {
    const date = new Date(ms);
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function snapTo5Min(ms: number) {
    return Math.round(ms / FIVE_MIN_MS) * FIVE_MIN_MS;
}

function parseHourMinuteIntoDay(value: string, referenceMs: number): number | null {
    const match = /^\s*(\d{1,2})[:.](\d{2})\s*$/.exec(value);
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    const ref = new Date(referenceMs);
    ref.setHours(hour, minute, 0, 0);
    return ref.getTime();
}

export interface TimeScrubberProps {
    /** Current value (milliseconds since epoch). */
    valueMs: number;
    /** Lower bound (inclusive). */
    minMs: number;
    /** Upper bound (inclusive). */
    maxMs: number;
    /** Original verbalized time — shown as a baseline marker. */
    verbalizedMs: number;
    /** Scheduled end of the window — shown as a target marker. */
    scheduledEndMs: number | null;
    /** Highlight "suspect" coloring (e.g., delay >= 60min or pattern). */
    suspect?: boolean;
    onChange: (nextMs: number) => void;
}

/**
 * Drag-to-edit horário da saída. Snap 5min via slider step; ±1 min e ±5 min
 * via stepper buttons; HH:MM input para entrada direta. Teclado: ←/→ = ±5min
 * (Radix default com step=5min), Home/End = início/fim do range.
 */
export function TimeScrubber({ valueMs, minMs, maxMs, verbalizedMs, scheduledEndMs, suspect, onChange }: TimeScrubberProps) {
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

    const clamp = (next: number) => Math.min(maxMs, Math.max(minMs, next));

    const delta = valueMs - verbalizedMs;
    const deltaLabel = delta === 0
        ? ""
        : ` (${delta > 0 ? "+" : "−"}${Math.abs(Math.round(delta / 60000))}min vs verbalizado)`;

    return (
        <div className="departure-verifier-scrubber-shell">
            <div className={`departure-verifier-time ${suspect ? "suspect" : ""}`.trim()}>
                {formatLocalHourMinute(valueMs)}
                <span className="departure-verifier-time__delta">{deltaLabel}</span>
            </div>

            <Slider.Root
                className="departure-verifier-slider"
                data-suspect={suspect ? "true" : "false"}
                min={minMs}
                max={maxMs}
                step={FIVE_MIN_MS}
                value={[valueMs]}
                onValueChange={([next]) => onChange(clamp(snapTo5Min(next)))}
                aria-label="Horário de saída"
            >
                <Slider.Track className="departure-verifier-slider__track">
                    <Slider.Range className="departure-verifier-slider__range" />
                </Slider.Track>
                <Slider.Thumb className="departure-verifier-slider__thumb" aria-label="Arraste para ajustar" />
            </Slider.Root>

            <div className="departure-verifier-slider__ticks">
                {ticks.map((tick) => (
                    <span key={tick}>{formatLocalHourMinute(tick)}</span>
                ))}
            </div>

            <div className="departure-verifier-stepper-row">
                <button type="button" onClick={() => onChange(clamp(valueMs - FIVE_MIN_MS))} aria-label="Voltar 5 minutos">−5m</button>
                <button type="button" onClick={() => onChange(clamp(valueMs - ONE_MIN_MS))} aria-label="Voltar 1 minuto">−1m</button>
                <input
                    type="text"
                    inputMode="numeric"
                    pattern="\d{1,2}:\d{2}"
                    value={formatLocalHourMinute(valueMs)}
                    onChange={(event) => {
                        const parsed = parseHourMinuteIntoDay(event.target.value, valueMs);
                        if (parsed !== null) {
                            onChange(clamp(parsed));
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
                        Janela {formatLocalHourMinute(scheduledEndMs)}
                    </button>
                )}
            </div>
        </div>
    );
}
