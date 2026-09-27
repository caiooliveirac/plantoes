/* Peças visuais do calor do monitor de acessos — sem estado: servem ao painel
   (cliente) e ao relatório da conta (servidor). Cada coluna é um trecho do
   período (30 min, 3 h ou 12 h); a cor diz o que aconteceu nele. */
import type { CSSProperties } from "react";
import { descreverFaixa, rotuloDaColuna, type EscalaDoCalor, type FaixaDoAparelho } from "@/modules/acessos/painel";
import { classeDoLado } from "@/app/admin/acessos/rotulos";

const ESTADOS = ["sem uso", "pouco uso", "uso", "uso intenso", "duas redes no mesmo intervalo", "uso simultâneo", "uso simultâneo forte"];

function estiloDaGrade(escala: EscalaDoCalor): CSSProperties {
    return { "--colunas": escala.colunas } as CSSProperties;
}

/** Uma linha do calor. `detalhe` põe a dica em cada coluna (poucas linhas: o "quem está onde"). */
export function FaixaDeCalor({ faixa, escala, rotulo, detalhe = false, alta = false }: {
    faixa: string;
    escala: EscalaDoCalor;
    rotulo: string;
    detalhe?: boolean;
    alta?: boolean;
}) {
    // span (não div): a faixa vive dentro do botão de cada linha do ranking.
    return (
        <span
            className={`ac-calor${alta ? " alta" : ""}`}
            style={estiloDaGrade(escala)}
            role="img"
            aria-label={`${rotulo}: ${descreverFaixa(faixa, escala.passoMs) || "sem uso no período"}`}
        >
            {[...faixa].map((estado, coluna) => (
                <span
                    key={coluna}
                    className={`ac-c ac-c${estado}`}
                    title={detalhe ? `${rotuloDaColuna(escala, coluna)} · ${ESTADOS[Number(estado)]}` : undefined}
                />
            ))}
        </span>
    );
}

export function EixoDoCalor({ escala }: { escala: EscalaDoCalor }) {
    return (
        <div className="ac-eixo" style={estiloDaGrade(escala)} aria-hidden="true">
            {escala.marcas.map((marca) => (
                <span key={marca.coluna} style={{ gridColumn: `${marca.coluna + 1} / span 6` }}>{marca.texto}</span>
            ))}
        </div>
    );
}

export function LegendaDoCalor() {
    const itens: Array<[string, string]> = [
        ["0", "sem uso"],
        ["2", "em uso"],
        ["4", "duas redes no intervalo"],
        ["5", "simultâneo"],
        ["6", "simultâneo forte"],
    ];
    return (
        <ul className="ac-legenda" aria-label="Legenda do calor">
            {itens.map(([estado, texto]) => (
                <li key={estado}><span className={`ac-c ac-c${estado}`} aria-hidden="true" />{texto}</li>
            ))}
        </ul>
    );
}

/** "Quem está onde": uma raia por aparelho, com o lugar de onde ele usa. Vermelho = aquele aparelho estava num uso simultâneo forte. */
export function RaiasPorAparelho({ faixas, escala }: { faixas: FaixaDoAparelho[]; escala: EscalaDoCalor }) {
    if (faixas.length === 0) return <p className="ac-vazio">Sem uso registrado no período.</p>;
    return (
        <div className="ac-raias">
            {faixas.map((raia, indice) => {
                const letra = String.fromCharCode(65 + indice);
                return (
                    <div key={raia.sessaoId} className="ac-raia">
                        <div className="ac-raia-quem">
                            <span className={classeDoLado(letra)}>{letra}</span>
                            <span className="ac-raia-texto" title={`${raia.onde} — ${raia.aparelho}${raia.provedor ? ` · ${raia.provedor}` : ""}`}>
                                <strong>{raia.onde}</strong>
                                <small>{raia.aparelho}{raia.provedor ? ` · ${raia.provedor}` : ""}</small>
                            </span>
                        </div>
                        <FaixaDeCalor faixa={raia.faixa} escala={escala} rotulo={`Aparelho ${letra}`} detalhe alta />
                    </div>
                );
            })}
            <div className="ac-raia ac-raia-eixo">
                <span />
                <EixoDoCalor escala={escala} />
            </div>
        </div>
    );
}
