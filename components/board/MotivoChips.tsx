"use client";

import { useEffect, useId, useRef, useState } from "react";
import "@/app/mesa-kit.css";

export { MOTIVOS_ATRASO, MOTIVOS_HORARIO, MOTIVOS_REMANEJO, motivoValido } from "./motivo-chips-logica";

export interface MotivoChipsProps {
    /** Motivos prontos, um chip cada. */
    opcoes: string[];
    /** Texto final da observação (chip escolhido ou o que foi digitado em "Outro…"). */
    valor: string;
    onChange(v: string): void;
    /** Mínimo de caracteres para valer (padrão 8). */
    minimo?: number;
    /** Rótulo do grupo (padrão "Motivo"). */
    rotulo?: string;
}

/**
 * Seleção única entre motivos prontos + "Outro…" que abre um campo de texto.
 * `valor` é sempre a string final: um chip casa quando o texto é igual a ele;
 * qualquer outro texto não vazio cai em "Outro…".
 */
export function MotivoChips({ opcoes, valor, onChange, minimo = 8, rotulo = "Motivo" }: MotivoChipsProps) {
    const id = useId();
    const casaChip = opcoes.includes(valor);
    const [outroAberto, setOutroAberto] = useState(() => valor !== "" && !casaChip);
    const campoRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (valor !== "" && !opcoes.includes(valor)) setOutroAberto(true);
    }, [valor, opcoes]);

    const faltam = Math.max(0, minimo - valor.trim().length);
    const abrirOutro = () => {
        setOutroAberto(true);
        if (casaChip) onChange("");
        requestAnimationFrame(() => campoRef.current?.focus());
    };

    return (
        <div className="mk-motivo" role="group" aria-labelledby={`${id}-rotulo`}>
            <span id={`${id}-rotulo`} className="mk-motivo__rotulo">{rotulo}</span>
            <div className="mk-motivo__chips">
                {opcoes.map((opcao) => (
                    <button
                        key={opcao}
                        type="button"
                        className="mk-chip"
                        aria-pressed={valor === opcao}
                        onClick={() => {
                            setOutroAberto(false);
                            onChange(opcao);
                        }}
                    >
                        {opcao}
                    </button>
                ))}
                <button
                    type="button"
                    className="mk-chip"
                    aria-pressed={outroAberto && !casaChip}
                    aria-expanded={outroAberto}
                    aria-controls={`${id}-outro`}
                    onClick={abrirOutro}
                >
                    Outro…
                </button>
            </div>
            {outroAberto && (
                <div className="mk-motivo__outro" id={`${id}-outro`}>
                    <input
                        ref={campoRef}
                        className="mk-campo"
                        type="text"
                        value={casaChip ? "" : valor}
                        placeholder="Descreva o motivo"
                        maxLength={240}
                        aria-label={`${rotulo} — outro`}
                        aria-describedby={`${id}-ajuda`}
                        onChange={(e) => onChange(e.target.value)}
                    />
                    <span id={`${id}-ajuda`} className="mk-motivo__ajuda" aria-live="polite">
                        {faltam > 0 ? `Faltam ${faltam} caracteres` : "Pronto"}
                    </span>
                </div>
            )}
        </div>
    );
}
