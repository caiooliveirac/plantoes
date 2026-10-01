"use client";

import { useId, useMemo, useState } from "react";
import "@/app/mesa-kit.css";
import type { PostoAzulejo } from "./azulejos-do-quadro";
import { formatarHHMM } from "./editor-de-horario-logica";

export type { PostoAzulejo } from "./azulejos-do-quadro";

export interface SeletorDePostoProps {
    azulejos: PostoAzulejo[];
    /** "remanejo" (chefia move alguém) ou "chegada" (médico escolhe onde chegou). */
    modo: "remanejo" | "chegada";
    dominioInicial?: "regulation" | "intervention";
    /** Mostra a fileira "Eventuais" (2266–2270, 4092). Padrão: só no remanejo. */
    mostrarEventuais?: boolean;
    /** Azulejo ocupado aceita clique (quem chama confirma). Padrão true. */
    ocupadoClicavel?: boolean;
    onEscolher(a: PostoAzulejo): void;
    selecionado?: { domain: string; targetId: string } | null;
}

const ABAS: Array<{ dominio: "regulation" | "intervention"; rotulo: string }> = [
    { dominio: "regulation", rotulo: "Regulação" },
    { dominio: "intervention", rotulo: "Intervenção" },
];

const ROTULO_STATUS: Record<PostoAzulejo["status"], string> = {
    livre: "livre",
    ocupado: "ocupado",
    desativado: "desativado",
    origem: "origem",
};

function horaCurta(iso: string | null | undefined): string | null {
    if (!iso) return null;
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? null : formatarHHMM(ms);
}

/**
 * Grade de azulejos compartilhada por "remanejar" (chefia) e "chegar" (médico).
 * Abas Regulação / Intervenção; eventuais numa fileira própria. Cada azulejo é
 * um <button aria-pressed>; desativado e origem não clicam.
 */
export function SeletorDePosto({
    azulejos,
    modo,
    dominioInicial,
    mostrarEventuais = modo === "remanejo",
    ocupadoClicavel = true,
    onEscolher,
    selecionado = null,
}: SeletorDePostoProps) {
    const id = useId();
    const [dominio, setDominio] = useState<"regulation" | "intervention">(
        dominioInicial ?? (selecionado?.domain === "intervention" ? "intervention" : "regulation"),
    );

    const { fixos, eventuais, contagem } = useMemo(() => {
        const doDominio = azulejos.filter((a) => a.domain === dominio);
        const contagem = Object.fromEntries(
            ABAS.map((aba) => [
                aba.dominio,
                azulejos.filter((a) => a.domain === aba.dominio && a.status === "livre" && !a.onDemand).length,
            ]),
        ) as Record<"regulation" | "intervention", number>;
        return {
            fixos: doDominio.filter((a) => !a.onDemand),
            eventuais: mostrarEventuais ? doDominio.filter((a) => a.onDemand) : [],
            contagem,
        };
    }, [azulejos, dominio, mostrarEventuais]);

    const estaSelecionado = (a: PostoAzulejo) =>
        Boolean(selecionado && selecionado.domain === a.domain && String(selecionado.targetId) === a.targetId);

    const clicavel = (a: PostoAzulejo) => {
        if (a.status === "desativado" || a.status === "origem") return false;
        if (a.status === "ocupado") return ocupadoClicavel;
        return true;
    };

    const azulejo = (a: PostoAzulejo) => {
        const desde = horaCurta(a.ocupanteDesde);
        const legenda =
            a.status === "ocupado" || a.status === "origem"
                ? a.ocupante ?? "ocupado"
                : a.status === "desativado"
                  ? "desativado"
                  : a.nome && !a.nome.includes(a.code) ? a.nome : "livre";
        const descricao = [
            `${a.domain === "regulation" ? "Ramal" : "Base"} ${a.code}`,
            a.nome ?? null,
            ROTULO_STATUS[a.status],
            a.ocupante ? `com ${a.ocupante}` : null,
            desde ? `desde ${desde}` : null,
        ]
            .filter(Boolean)
            .join(", ");
        return (
            <button
                key={`${a.domain}:${a.targetId}`}
                type="button"
                className="mk-azulejo"
                data-status={a.status}
                data-eventual={a.onDemand ? "true" : undefined}
                aria-pressed={estaSelecionado(a)}
                aria-label={descricao}
                disabled={!clicavel(a)}
                onClick={() => clicavel(a) && onEscolher(a)}
            >
                <span className="mk-azulejo__codigo">{a.code}</span>
                <span className="mk-azulejo__legenda">{legenda}</span>
                {desde && a.status !== "livre" && <span className="mk-azulejo__desde">{desde}</span>}
            </button>
        );
    };

    return (
        <div className="mk-seletor" data-modo={modo}>
            <div className="mk-abas" role="tablist" aria-label="Domínio do quadro">
                {ABAS.map((aba) => (
                    <button
                        key={aba.dominio}
                        type="button"
                        role="tab"
                        id={`${id}-aba-${aba.dominio}`}
                        aria-selected={dominio === aba.dominio}
                        aria-controls={`${id}-painel-${aba.dominio}`}
                        tabIndex={dominio === aba.dominio ? 0 : -1}
                        className="mk-aba"
                        onClick={() => setDominio(aba.dominio)}
                        onKeyDown={(e) => {
                            if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                                e.preventDefault();
                                const proxima = ABAS[(ABAS.findIndex((x) => x.dominio === dominio) + 1) % ABAS.length];
                                setDominio(proxima.dominio);
                                document.getElementById(`${id}-aba-${proxima.dominio}`)?.focus();
                            }
                        }}
                    >
                        {aba.rotulo}
                        <span className="mk-aba__contagem" aria-label={`${contagem[aba.dominio]} livres`}>
                            {contagem[aba.dominio]}
                        </span>
                    </button>
                ))}
            </div>

            <div
                role="tabpanel"
                id={`${id}-painel-${dominio}`}
                aria-labelledby={`${id}-aba-${dominio}`}
                className="mk-seletor__painel"
            >
                {fixos.length === 0 ? (
                    <p className="mk-seletor__vazio">Nenhum {dominio === "regulation" ? "ramal" : "base"} no quadro.</p>
                ) : (
                    <div className="mk-grade">{fixos.map(azulejo)}</div>
                )}

                {eventuais.length > 0 && (
                    <div className="mk-seletor__eventuais">
                        <span className="mk-seletor__titulo">Eventuais</span>
                        <div className="mk-grade mk-grade--eventuais">{eventuais.map(azulejo)}</div>
                    </div>
                )}
            </div>
        </div>
    );
}
