"use client";

import { useState } from "react";
import { KairosTopo } from "@/components/kairos-topo";
import { motion } from "framer-motion";
import "@/app/auth-pages.css";

export default function EsqueciSenhaPage() {
    const [email, setEmail] = useState("");
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function submit(event: React.FormEvent) {
        event.preventDefault();
        if (busy) return;
        setBusy(true);
        setError(null);
        try {
            const response = await fetch("/api/auth/password-reset", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ email }),
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
                setError(payload.error ?? "Não foi possível enviar o email.");
                return;
            }
            setDone(true);
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="pagina-kairos">
        <KairosTopo titulo="Recuperar acesso" />
        <main className="et-shell" style={{ alignItems: "center", justifyContent: "center" }}>
            <motion.section
                className="et-panel"
                style={{ width: "min(480px, 100%)" }}
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
            >
                <div className="et-panel-head">
                    <h2>Esqueci a senha</h2>
                </div>
                {done ? (
                    <div className="et-empty-state">
                        <strong>Pedido recebido ✓</strong>
                        <p>
                            Se existir uma conta com esse email, você vai receber um link
                            para redefinir a senha (vale por 2 horas). Confira também o spam.
                        </p>
                    </div>
                ) : (
                    <form className="et-form" onSubmit={submit}>
                        <p>
                            Informe o email do seu cadastro. Enviaremos um link para você
                            escolher uma nova senha.
                        </p>
                        <label>
                            Email
                            <input
                                type="email"
                                value={email}
                                onChange={(event) => setEmail(event.target.value)}
                                required
                                autoComplete="email"
                            />
                        </label>
                        {error ? <div className="et-feedback err">{error}</div> : null}
                        <button type="submit" className="et-btn primary" disabled={busy}>
                            {busy ? "Enviando…" : "Enviar link de redefinição"}
                        </button>
                    </form>
                )}
            </motion.section>
        </main>
        </div>
    );
}
