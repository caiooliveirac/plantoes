"use client";

import { useEffect, useState, type ReactNode } from "react";
import "./banco-de-horas-medico.css";

export interface PainelAba {
    /** Também é a âncora da URL (#banco-de-horas, #pagamento). */
    id: string;
    rotulo: string;
    conteudo: ReactNode;
}

/**
 * Abas do Painel do médico. A aba vem da âncora da URL — o bot manda o link do
 * banco sem âncora (abre na primeira) e /medico abre em #pagamento. Todas as
 * abas vêm renderizadas do servidor; aqui só se esconde as outras.
 */
export function PainelAbas({ abas }: { abas: PainelAba[] }) {
    const [ativa, setAtiva] = useState(abas[0]?.id ?? "");
    const ids = abas.map((aba) => aba.id).join("|");

    useEffect(() => {
        const daUrl = () => {
            const hash = window.location.hash.slice(1);
            if (ids.split("|").includes(hash)) setAtiva(hash);
        };
        daUrl();
        window.addEventListener("hashchange", daUrl);
        return () => window.removeEventListener("hashchange", daUrl);
    }, [ids]);

    return (
        <>
            <nav className="painel-abas" aria-label="Seções do painel">
                {abas.map((aba) => (
                    <a
                        key={aba.id}
                        href={`#${aba.id}`}
                        aria-current={aba.id === ativa ? "page" : undefined}
                        onClick={(event) => {
                            event.preventDefault();
                            setAtiva(aba.id);
                            window.history.replaceState(window.history.state, "", `#${aba.id}`);
                        }}
                    >
                        {aba.rotulo}
                    </a>
                ))}
            </nav>
            {abas.map((aba) => (
                <div key={aba.id} id={aba.id} className="painel-aba" hidden={aba.id !== ativa}>
                    {aba.conteudo}
                </div>
            ))}
        </>
    );
}
