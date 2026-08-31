"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Barra de topo Kairós do plantões — espelho da .topnav do app
 * escalas-e-trocas-samu (navy nos dois temas, eyebrow, título, abas pill e
 * chave de tema). Vive DENTRO de .pagina-kairos, só nas telas migradas;
 * as telas dark glass seguem com as barras que já têm.
 */

export interface KairosAba {
    href: string;
    nome: string;
}

/** Abas padrão das telas de coordenação (as "abas plantões"). */
export const ABAS_ADMIN: KairosAba[] = [
    { href: "/", nome: "Mesa" },
    { href: "/admin/payment-closing", nome: "Fechamento" },
    { href: "/admin/bank-hours", nome: "Banco de horas" },
    { href: "/admin/payment-attestation", nome: "Atestação" },
    { href: "/admin/reports", nome: "Relatórios" },
];

function abaAtiva(pathname: string, href: string): boolean {
    // "/" casaria com tudo por prefixo — a Mesa só acende na raiz.
    return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

/* Chave de tema Kairós: grava localStorage["kairos:tema"] e seta data-tema
   no <html>. Estado inicial vem do DOM (o script anti-FOUC do layout já
   decidiu antes da pintura); antes do mount nenhum botão fica "on" — evita
   mismatch de hidratação. Mesmo contrato do escalas. */
function ChaveTema() {
    const [tema, setTema] = useState<"claro" | "escuro" | null>(null);
    useEffect(() => {
        setTema(document.documentElement.dataset.tema === "escuro" ? "escuro" : "claro");
    }, []);
    function aplicar(t: "claro" | "escuro") {
        document.documentElement.dataset.tema = t;
        try {
            localStorage.setItem("kairos:tema", t);
        } catch {}
        setTema(t);
    }
    return (
        <span className="chave-tema" role="group" aria-label="Tema da interface">
            <button type="button" aria-pressed={tema === "claro"} onClick={() => aplicar("claro")}>
                ☀️ Claro
            </button>
            <button type="button" aria-pressed={tema === "escuro"} onClick={() => aplicar("escuro")}>
                🌙 Escuro
            </button>
        </span>
    );
}

export function KairosTopo({
    titulo,
    abas,
    extra,
}: {
    titulo: string;
    /** Sem abas (painel do médico via link do bot) a barra mostra só marca + tema. */
    abas?: KairosAba[];
    /** Conteúdo extra encostado à direita (ex.: menu ⋯ existente da tela). */
    extra?: React.ReactNode;
}) {
    const pathname = usePathname();
    return (
        <nav className="k-topo" aria-label="Navegação do plantões">
            <span className="k-topo-brand">
                <span className="k-topo-eyebrow">Plantões · SAMU 192 Salvador</span>
                <span className="k-topo-titulo">{titulo}</span>
            </span>
            {abas && abas.length > 0 ? (
                <div className="k-topo-abas">
                    {abas.map((aba) => (
                        <Link key={aba.href} href={aba.href} className={abaAtiva(pathname, aba.href) ? "on" : ""}>
                            {aba.nome}
                        </Link>
                    ))}
                </div>
            ) : null}
            <span className="k-topo-vao" />
            {extra}
            <ChaveTema />
        </nav>
    );
}
