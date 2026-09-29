"use client";

/* Abas com contagem — adaptadas de "Tabs with Count Badge" (coss.com) no
   21st.dev (https://21st.dev/@coss.com/components/tabs-count-badge): trilho
   cinza, a aba ativa sobe em branco com sombra leve, e cada rótulo leva a sua
   contagem num selo contornado (cinza quando a aba não está ativa).

   Aqui são FILTROS de uma lista (aria-pressed), não abas com painel: o
   original trazia o componente de abas do Base UI com TabsPanel, que não
   cabe — a lista filtrada é a mesma tabela embaixo. */

import { cn } from "@/lib/utils";

export interface OpcaoContagem<T extends string> {
    valor: T;
    rotulo: string;
    contagem?: number;
    /** Tom do selo quando há algo a fazer (ex.: "atencao" para pendências). */
    tom?: "neutro" | "atencao" | "alerta";
    title?: string;
    disabled?: boolean;
}

export function AbasContagem<T extends string>({
    opcoes,
    valor,
    aoMudar,
    rotulo,
    className,
}: {
    opcoes: OpcaoContagem<T>[];
    valor: T;
    aoMudar: (v: T) => void;
    /** Nome do grupo para o leitor de tela. */
    rotulo: string;
    className?: string;
}) {
    return (
        <div
            data-casca
            role="group"
            aria-label={rotulo}
            className={cn("inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-lg bg-superficie-alt p-1", className)}
        >
            {opcoes.map((o) => {
                const ativa = o.valor === valor;
                return (
                    <button
                        key={o.valor}
                        type="button"
                        aria-pressed={ativa}
                        title={o.title}
                        disabled={o.disabled}
                        onClick={() => aoMudar(o.valor)}
                        className={cn(
                            "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium whitespace-nowrap",
                            "transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-acao/40",
                            "disabled:cursor-not-allowed disabled:opacity-45",
                            ativa
                                ? "bg-superficie text-texto-forte shadow-[0_1px_2px_rgba(15,23,42,0.08),0_1px_1px_rgba(15,23,42,0.04)]"
                                : "text-texto-medio hover:text-texto-forte",
                        )}
                    >
                        {o.rotulo}
                        {o.contagem !== undefined ? (
                            <span
                                className={cn(
                                    "inline-flex h-5 min-w-5 items-center justify-center rounded-md border px-1.5 font-mono text-[11px] tabular-nums",
                                    o.tom === "alerta" && o.contagem > 0
                                        ? "border-[color:var(--vermelho-200)] text-[color:var(--vermelho-700)]"
                                        : o.tom === "atencao" && o.contagem > 0
                                          ? "border-[color:var(--ambar-200)] text-[color:var(--ambar-700)]"
                                          : ativa
                                            ? "border-borda text-texto-forte"
                                            : "border-borda text-texto-medio",
                                )}
                            >
                                {o.contagem}
                            </span>
                        ) : null}
                    </button>
                );
            })}
        </div>
    );
}
