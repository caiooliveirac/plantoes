"use client";

import { use, useEffect, useState } from "react";
import { motion } from "framer-motion";
import "@/app/auth-pages.css";

type TokenState = "checking" | "valid" | "invalid";

export default function RedefinirSenhaPage({ params }: { params: Promise<{ token: string }> }) {
    const { token } = use(params);
    const [tokenState, setTokenState] = useState<TokenState>("checking");
    const [email, setEmail] = useState<string | null>(null);
    const [password, setPassword] = useState("");
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        fetch(`/api/auth/password-reset/${token}`)
            .then(async (response) => {
                const payload = await response.json().catch(() => ({}));
                if (cancelled) return;
                if (!response.ok) {
                    setTokenState("invalid");
                    return;
                }
                setEmail(payload.email ?? null);
                setTokenState("valid");
            })
            .catch(() => {
                if (!cancelled) setTokenState("invalid");
            });
        return () => {
            cancelled = true;
        };
    }, [token]);

    async function submit(event: React.FormEvent) {
        event.preventDefault();
        if (busy) return;
        setBusy(true);
        setError(null);
        try {
            const response = await fetch(`/api/auth/password-reset/${token}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ password }),
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
                setError(payload.error ?? "Não foi possível redefinir a senha.");
                return;
            }
            setDone(true);
        } finally {
            setBusy(false);
        }
    }

    return (
        <main className="et-shell" style={{ alignItems: "center", justifyContent: "center" }}>
            <motion.section
                className="et-panel"
                style={{ width: "min(480px, 100%)" }}
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
            >
                <div className="et-panel-head">
                    <h2>Redefinir senha</h2>
                </div>
                {tokenState === "checking" ? (
                    <div className="et-empty-state"><p>Verificando o link…</p></div>
                ) : tokenState === "invalid" ? (
                    <div className="et-empty-state">
                        <strong>Link inválido ou expirado</strong>
                        <p>
                            Este link de redefinição não vale mais. Peça um novo em{" "}
                            <a href="/esqueci-senha">esqueci a senha</a>.
                        </p>
                    </div>
                ) : done ? (
                    <div className="et-empty-state">
                        <strong>Senha redefinida ✓</strong>
                        <p>Já pode entrar com a nova senha.</p>
                        <a className="et-btn primary" href="/">Ir para o login</a>
                    </div>
                ) : (
                    <form className="et-form" onSubmit={submit}>
                        <p>
                            {email ? <>Definindo nova senha para <strong>{email}</strong>.</> : "Escolha sua nova senha."}
                        </p>
                        <label>
                            Nova senha (mín. 10 caracteres, 3 grupos)
                            <input
                                type="password"
                                value={password}
                                onChange={(event) => setPassword(event.target.value)}
                                required
                                minLength={10}
                                autoComplete="new-password"
                            />
                        </label>
                        {error ? <div className="et-feedback err">{error}</div> : null}
                        <button type="submit" className="et-btn primary" disabled={busy}>
                            {busy ? "Salvando…" : "Salvar nova senha"}
                        </button>
                    </form>
                )}
            </motion.section>
        </main>
    );
}
