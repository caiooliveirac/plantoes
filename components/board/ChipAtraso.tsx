"use client";

import "@/app/mesa-kit.css";

/**
 * Chip depois do nome (a hora de chegada fica visível na coluna própria):
 * "⏳ +22 min" avermelhado, mais forte a partir de 60, nada dentro da tolerância, e um "OK" pequeno quando a chefia
 * desconsiderou o atraso (docs/plano-mesa-chefe-plantonista.md).
 */
export function ChipAtraso({ minutos, abonado }: { minutos: number | null; abonado: boolean }) {
    if (abonado) {
        return <span className="mk-atraso ok" title="Atraso desconsiderado pela chefia: banco e pagamento como pontual">OK</span>;
    }
    if (minutos === null || minutos <= 0) return null;
    return (
        <span className={`mk-atraso ${minutos >= 60 ? "grave" : ""}`.trim()} title={`Chegou ${minutos} min depois do previsto`}>
            <span aria-hidden="true">⏳</span>+{minutos} min
        </span>
    );
}
