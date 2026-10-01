"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import "@/app/mesa-kit.css";
import { TimeScrubber } from "./TimeScrubber";
import {
    MINUTO_MS,
    cruzaMeiaNoite,
    formatarHHMM,
    limitar,
    presetsDoEditor,
    resolverHHMM,
    rotuloDelta,
    rotuloDoDia,
} from "./editor-de-horario-logica";

export interface EditorDeHorarioProps {
    /** Valor atual (epoch ms). */
    valorMs: number;
    /** Início da janela programada (ex.: 07:00). */
    janelaInicioMs: number;
    /** Fim da janela programada (ex.: 19:00); null quando não há. */
    janelaFimMs: number | null;
    /** Limite inferior rígido. */
    minMs: number;
    /** Limite superior rígido. */
    maxMs: number;
    tipo: "chegada" | "saida";
    /** Horário declarado originalmente — vira marcador e delta. */
    verbalizadoMs?: number | null;
    onChange(ms: number): void;
    /** Linha de consequência ao vivo, montada por quem chama (banco, pagamento…). */
    consequencia?: ReactNode;
}

const PASSOS = [5, 15, 30] as const;

/**
 * Substitui o `<input type="datetime-local">` na correção de chegada/saída:
 * atalhos da janela, passos de ±5/15/30 min, HH:MM direto e a trilha para
 * arrastar. Sem conta de cabeça: o dia só aparece quando a faixa cruza a
 * meia-noite. Tudo no fuso operacional (lib/time.ts).
 */
export function EditorDeHorario({
    valorMs,
    janelaInicioMs,
    janelaFimMs,
    minMs,
    maxMs,
    tipo,
    verbalizadoMs = null,
    onChange,
    consequencia,
}: EditorDeHorarioProps) {
    // "Agora" só existe no cliente; no servidor renderiza a faixa sem ele.
    const [agoraMs, setAgoraMs] = useState<number | null>(null);
    useEffect(() => {
        setAgoraMs(Date.now());
        const id = window.setInterval(() => setAgoraMs(Date.now()), 30_000);
        return () => window.clearInterval(id);
    }, []);

    const [texto, setTexto] = useState(() => formatarHHMM(valorMs));
    const [editando, setEditando] = useState(false);
    useEffect(() => {
        if (!editando) setTexto(formatarHHMM(valorMs));
    }, [valorMs, editando]);

    const aplicar = (ms: number) => onChange(limitar(ms, minMs, maxMs));

    const presets = useMemo(
        () =>
            presetsDoEditor({ janelaInicioMs, janelaFimMs, minMs, maxMs, agoraMs: agoraMs ?? valorMs }).filter(
                (p) => p.chave !== "agora" || agoraMs !== null,
            ),
        [janelaInicioMs, janelaFimMs, minMs, maxMs, agoraMs, valorMs],
    );

    const mostrarDia = cruzaMeiaNoite(minMs, maxMs);
    const delta = verbalizadoMs !== null && verbalizadoMs !== undefined ? rotuloDelta(valorMs, verbalizadoMs) : "";
    const textoInvalido = editando && resolverHHMM(texto, { valorMs, minMs, maxMs }) === null && texto.trim() !== "";
    const rotuloCampo = tipo === "chegada" ? "Hora da chegada" : "Hora da saída";

    const confirmarTexto = () => {
        const ms = resolverHHMM(texto, { valorMs, minMs, maxMs });
        if (ms !== null) aplicar(ms);
        setEditando(false);
    };

    return (
        <div className="mk-editor" data-tipo={tipo}>
            <div className="mk-editor__chips" role="group" aria-label="Atalhos de horário">
                {presets.map((p) => (
                    <button
                        key={p.chave}
                        type="button"
                        className="mk-chip"
                        aria-pressed={p.ms === valorMs}
                        onClick={() => aplicar(p.ms)}
                    >
                        {p.rotulo}
                    </button>
                ))}
            </div>

            <div className="mk-editor__stepper">
                {[...PASSOS].reverse().map((passo) => (
                    <button
                        key={`-${passo}`}
                        type="button"
                        className="mk-passo"
                        aria-label={`Voltar ${passo} minutos`}
                        disabled={valorMs - passo * MINUTO_MS < minMs}
                        onClick={() => aplicar(valorMs - passo * MINUTO_MS)}
                    >
                        −{passo}
                    </button>
                ))}
                <label className="mk-editor__hora">
                    <span className="mk-visualmente-oculto">{rotuloCampo} (HH:MM)</span>
                    <input
                        className="mk-hora"
                        type="text"
                        inputMode="numeric"
                        autoComplete="off"
                        value={texto}
                        aria-invalid={textoInvalido || undefined}
                        onFocus={(e) => {
                            setEditando(true);
                            e.currentTarget.select();
                        }}
                        onChange={(e) => setTexto(e.target.value)}
                        onBlur={confirmarTexto}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") {
                                e.preventDefault();
                                confirmarTexto();
                                e.currentTarget.blur();
                            } else if (e.key === "Escape") {
                                setTexto(formatarHHMM(valorMs));
                                setEditando(false);
                                e.currentTarget.blur();
                            }
                        }}
                    />
                    {mostrarDia && (
                        <span className="mk-editor__dia">{rotuloDoDia(valorMs, agoraMs ?? valorMs)}</span>
                    )}
                </label>
                {PASSOS.map((passo) => (
                    <button
                        key={`+${passo}`}
                        type="button"
                        className="mk-passo"
                        aria-label={`Avançar ${passo} minutos`}
                        disabled={valorMs + passo * MINUTO_MS > maxMs}
                        onClick={() => aplicar(valorMs + passo * MINUTO_MS)}
                    >
                        +{passo}
                    </button>
                ))}
            </div>

            {delta && (
                <p className="mk-editor__delta">
                    {delta} em relação ao declarado ({formatarHHMM(verbalizadoMs as number)})
                </p>
            )}

            <TimeScrubber
                valueMs={valorMs}
                minMs={minMs}
                maxMs={maxMs}
                verbalizedMs={verbalizadoMs ?? null}
                scheduledEndMs={tipo === "saida" ? janelaFimMs : janelaInicioMs}
                prefixoClasse="mk-scrubber"
                somenteTrilha
                rotuloAcessivel={rotuloCampo}
                onChange={aplicar}
            />

            {consequencia && <div className="mk-editor__consequencia">{consequencia}</div>}
        </div>
    );
}
