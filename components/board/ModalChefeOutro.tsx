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

    useEffect(() => {
        function abrir(evento: Event) {
            const detalhe = (evento as CustomEvent<{ mensagem?: string }>).detail;
            setMensagem(detalhe?.mensagem ?? "O chefe de plantão agora é outra pessoa. Esqueceu de entrar com a sua conta?");
        }
        window.addEventListener(EVENTO_CHEFE_OUTRO, abrir);
        return () => window.removeEventListener(EVENTO_CHEFE_OUTRO, abrir);
    }, []);

    if (!mensagem) return null;

    const [quem, pergunta] = dividir(mensagem);

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
                <h2 id="mk-chefe-outro-titulo" className="mk-folha-titulo">{quem}</h2>
                <p className="mk-folha-texto">
                    {email ? <>Você está entrando como <strong>{email}</strong>. </> : null}
                    {pergunta}
                </p>
                <div className="mk-folha-acoes">
                    <button type="button" className="mk-botao primario" onClick={entrarComMinhaConta} disabled={saindo}>
                        {saindo ? "Saindo…" : "Entrar com a minha conta"}
                    </button>
                    <button type="button" className="mk-botao" onClick={() => setMensagem(null)} disabled={saindo}>
                        Continuar só olhando
                    </button>
                </div>
            </div>
        </div>
    );
}

function dividir(mensagem: string): [string, string] {
    // "O chefe de plantão agora é Dr. Paulo (…). Esqueceu de entrar…": o nome
    // pode ter ponto ("Dr."), então o corte é antes da pergunta, não no 1º ponto.
    const corte = mensagem.indexOf(" Esqueceu");
    if (corte < 0) return [mensagem, ""];
    return [mensagem.slice(0, corte), mensagem.slice(corte + 1)];
}
