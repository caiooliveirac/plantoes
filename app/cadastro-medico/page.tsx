"use client";

import { useState } from "react";
import { motion } from "framer-motion";

type Step = "start" | "verify" | "done";

export default function CadastroMedicoPage() {
    const [step, setStep] = useState<Step>("start");
    const [codename, setCodename] = useState("");
    const [email, setEmail] = useState("");
    const [code, setCode] = useState("");
    const [password, setPassword] = useState("");
    const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
    const [busy, setBusy] = useState(false);

    async function post(path: string, body: unknown) {
        const response = await fetch(path, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });
        const payload = await response.json().catch(() => ({}));
        return { ok: response.ok, payload };
    }

    async function submitStart(event: React.FormEvent) {
        event.preventDefault();
        if (busy) return;
        setBusy(true);
        setFeedback(null);
        try {
            const { ok, payload } = await post("/api/auth/signup/start", { codename, email });
            if (!ok) {
                setFeedback({ kind: "err", text: payload.error ?? "Não foi possível enviar o código." });
                return;
            }
            setStep("verify");
            setFeedback({ kind: "ok", text: payload.message ?? "Código enviado." });
        } finally {
            setBusy(false);
        }
    }

    async function submitVerify(event: React.FormEvent) {
        event.preventDefault();
        if (busy) return;
        setBusy(true);
        setFeedback(null);
        try {
            const { ok, payload } = await post("/api/auth/signup/complete", { codename, email, code, password });
            if (!ok) {
                setFeedback({ kind: "err", text: payload.error ?? "Não foi possível concluir o cadastro." });
                return;
            }
            setStep("done");
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
                    <h2>Cadastro de médico</h2>
                </div>

                {step === "done" ? (
                    <div className="et-empty-state">
                        <strong>Conta criada ✓</strong>
                        <p>
                            Seu email foi confirmado e você já está conectado(a).
                            Use este email e a senha escolhida nos próximos acessos —
                            e para recuperar a senha, se precisar.
                        </p>
                        <a className="et-btn primary" href="/">Entrar no painel</a>
                    </div>
                ) : step === "verify" ? (
                    <form className="et-form" style={{ padding: 20 }} onSubmit={submitVerify}>
                        <p style={{ margin: 0, color: "var(--muted)", fontSize: 13.5 }}>
                            Enviamos um código de 6 dígitos para <strong>{email}</strong>.
                            Digite o código e escolha sua senha para concluir.
                        </p>
                        <label>
                            Código de 6 dígitos
                            <input
                                value={code}
                                onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                                required
                                inputMode="numeric"
                                pattern="\d{6}"
                                autoComplete="one-time-code"
                                placeholder="000000"
                            />
                        </label>
                        <label>
                            Senha (mín. 10 caracteres, 3 grupos)
                            <input
                                type="password"
                                value={password}
                                onChange={(event) => setPassword(event.target.value)}
                                required
                                minLength={10}
                                autoComplete="new-password"
                            />
                        </label>
                        {feedback ? <div className={`et-feedback ${feedback.kind}`}>{feedback.text}</div> : null}
                        <button type="submit" className="et-btn primary" disabled={busy}>
                            {busy ? "Confirmando…" : "Confirmar e criar conta"}
                        </button>
                        <button
                            type="button"
                            className="et-btn"
                            disabled={busy}
                            onClick={() => {
                                setStep("start");
                                setCode("");
                                setFeedback(null);
                            }}
                        >
                            Voltar (corrigir email ou reenviar código)
                        </button>
                    </form>
                ) : (
                    <form className="et-form" style={{ padding: 20 }} onSubmit={submitStart}>
                        <p style={{ margin: 0, color: "var(--muted)", fontSize: 13.5 }}>
                            Use o <strong>codinome</strong> que a coordenação te entregou
                            (ex.: <code>tigre-azul-958</code>) e um email que você acessa.
                            Vamos enviar um código de 6 dígitos para confirmar o email antes
                            de criar a conta.
                        </p>
                        <label>
                            Codinome
                            <input
                                value={codename}
                                onChange={(event) => setCodename(event.target.value)}
                                required
                                minLength={3}
                                autoComplete="off"
                                placeholder="tigre-azul-958"
                            />
                        </label>
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
                        {feedback ? <div className={`et-feedback ${feedback.kind}`}>{feedback.text}</div> : null}
                        <button type="submit" className="et-btn primary" disabled={busy}>
                            {busy ? "Enviando…" : "Enviar código de confirmação"}
                        </button>
                    </form>
                )}
            </motion.section>
        </main>
    );
}
