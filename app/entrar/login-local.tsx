"use client";

import { useState } from "react";
import { PORTAL_LOGIN_URL } from "@/lib/auth/portao";

/* Mesmas frases do popover de login do quadro (translateAuthError em
   app/operational-board-client.tsx). */
function traduzirErro(code?: string) {
    if (code === "invalid_credentials") return "Email ou senha invalidos.";
    if (code === "inactive_account") return "Conta inativa. Procure um admin.";
    if (code === "no_roles_assigned") return "Conta sem papel operacional ativo.";
    if (code === "pending_chief_approval") return "Cadastro pendente de aprovacao do admin.";
    if (code === "rejected_chief_approval") return "Cadastro rejeitado. Solicite nova validacao ao admin.";
    if (code === "too_many_attempts") return "Muitas tentativas de login. Aguarde 15 minutos e tente de novo.";
    return "Nao foi possivel autenticar agora.";
}

export function LoginLocal() {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function submit(event: React.FormEvent) {
        event.preventDefault();
        if (busy) return;
        setBusy(true);
        setError(null);
        try {
            const response = await fetch("/api/auth/login", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ email, password }),
            });
            if (response.ok) {
                window.location.href = "/";
                return;
            }
            const payload = await response.json().catch(() => ({})) as { error?: string };
            setError(traduzirErro(payload.error));
        } catch {
            setError(traduzirErro());
        } finally {
            setBusy(false);
        }
    }

    return (
        <section className="et-panel" style={{ width: "min(480px, 100%)" }}>
            <div className="et-panel-head"><h2>Entrar</h2></div>
            <form className="et-form" onSubmit={submit}>
                <p>O quadro operacional é só para quem tem conta. O caminho normal é o <a href={PORTAL_LOGIN_URL}>login do portal</a>; este é o login local.</p>
                <label>
                    Email
                    <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
                </label>
                <label>
                    Senha
                    <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
                </label>
                {error ? <div className="et-feedback err">{error}</div> : null}
                <button type="submit" className="et-btn primary" disabled={busy}>
                    {busy ? "Entrando…" : "Entrar"}
                </button>
                <p><a href="/esqueci-senha">Esqueci a senha</a> · <a href="/cadastro-medico">Criar conta de médico</a></p>
            </form>
        </section>
    );
}
