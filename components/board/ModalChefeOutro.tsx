"use client";

import { useEffect, useState } from "react";
import { EVENTO_CHEFE_OUTRO } from "@/lib/board/fetch-mesa";
import "@/app/mesa-kit.css";

/**
 * "O chefe de plantão agora é Fulano. Esqueceu de entrar com a sua conta?"
 * Abre quando qualquer escrita da Mesa volta 409 da trava da 2031
 * (lib/auth/server.ts requireMesaEscrita). Folha no celular, diálogo no
 * desktop. Nunca oferece "assumir": a Mesa não tem botão de assumir.
 */
export function ModalChefeOutro({ email, mensagemInicial = null }: { email: string | null; mensagemInicial?: string | null }) {
    const [mensagem, setMensagem] = useState<string | null>(mensagemInicial);
    const [saindo, setSaindo] = useState(false);
    const [armado, setArmado] = useState(false);

    useEffect(() => {
        function abrir(evento: Event) {
            const detalhe = (evento as CustomEvent<{ mensagem?: string }>).detail;
            setMensagem(detalhe?.mensagem ?? "O chefe de plantão agora é outra pessoa. Esqueceu de entrar com a sua conta?");
        }
        window.addEventListener(EVENTO_CHEFE_OUTRO, abrir);
        return () => window.removeEventListener(EVENTO_CHEFE_OUTRO, abrir);
    }, []);

    if (!mensagem) return null;

    const quem = nomeDoChefe(mensagem);

    async function entrarComMinhaConta() {
        setSaindo(true);
        try {
            await fetch("/api/auth/logout", { method: "POST" });
        } catch {
            // segue para a raiz de qualquer jeito: sem sessão, o portão manda ao login
        }
        window.location.href = "/";
    }

    return (
        <div className="mk-veu" role="presentation" onClick={() => setMensagem(null)}>
            <div
                className="mk-folha"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="mk-chefe-outro-titulo"
                onClick={(evento) => evento.stopPropagation()}
            >
                <h2 id="mk-chefe-outro-titulo" className="mk-folha-titulo">A Mesa é de {quem} agora</h2>
                <p className="mk-folha-texto">
                    Se você clicar para logar na Mesa, vai derrubar o chefe de plantão{quem ? ` (${quem})` : ""}.
                    {email ? <> Você está como <strong>{email}</strong>.</> : null}
                </p>
                <div className="mk-folha-acoes">
                    <button type="button" className="mk-botao primario" onClick={() => setMensagem(null)} disabled={saindo}>
                        Continuar só olhando
                    </button>
                    <button
                        type="button"
                        className="mk-botao"
                        disabled={saindo}
                        onClick={() => {
                            if (!armado) {
                                setArmado(true);
                                window.setTimeout(() => setArmado(false), 5000);
                                return;
                            }
                            void entrarComMinhaConta();
                        }}
                    >
                        {saindo ? "Saindo…" : armado ? `Confirmar: derrubar ${quem || "o chefe"} e logar` : "Sou o chefe de plantão e quero logar"}
                        {!armado ? <small>dois toques; só se você assumiu a 2031</small> : null}
                    </button>
                </div>
            </div>
        </div>
    );
}

/** Nome entre "agora é " e " (" ou ".". */
function nomeDoChefe(mensagem: string): string {
    const m = /agora é (.+?)(?: \(|\. Esqueceu|$)/.exec(mensagem);
    return m?.[1]?.trim() ?? "";
}
