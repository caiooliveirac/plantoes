"use client";

import { useState } from "react";
import { motion } from "framer-motion";

export default function CadastroMedicoPage() {
    const [form, setForm] = useState({ fullName: "", email: "", password: "" });
    const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState(false);

    async function submit(event: React.FormEvent) {
        event.preventDefault();
        if (busy) return;
        setBusy(true);
        setFeedback(null);
        try {
            const response = await fetch("/api/auth/register-doctor", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(form),
            });
            const payload = await response.json();
            if (!response.ok) {
                setFeedback({ kind: "err", text: payload.error ?? "Não foi possível concluir o cadastro." });
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
                    <h2>Cadastro de médico</h2>
                </div>
                {done ? (
                    <div className="et-empty-state">
                        <strong>Cadastro recebido ✓</strong>
                        <p>
                            Sua conta foi criada e aguarda ativação pela chefia de plantão.
                            Depois de ativada, entre em <code>/trocas</code> para operar suas trocas.
                        </p>
                    </div>
                ) : (
                    <form className="et-form" style={{ padding: 20 }} onSubmit={submit}>
                        <p style={{ margin: 0, color: "var(--muted)", fontSize: 13.5 }}>
                            Use o nome exatamente como aparece na escala. A conta nasce pendente e só
                            funciona após ativação pela chefia. Check-ins continuam pelo robô do Telegram.
                        </p>
                        <label>
                            Nome completo (como na escala)
                            <input
                                value={form.fullName}
                                onChange={(event) => setForm({ ...form, fullName: event.target.value })}
                                required
                                minLength={5}
                                autoComplete="name"
                            />
                        </label>
                        <label>
                            E-mail
                            <input
                                type="email"
                                value={form.email}
                                onChange={(event) => setForm({ ...form, email: event.target.value })}
                                required
                                autoComplete="email"
                            />
                        </label>
                        <label>
                            Senha (mín. 10 caracteres, 3 grupos)
                            <input
                                type="password"
                                value={form.password}
                                onChange={(event) => setForm({ ...form, password: event.target.value })}
                                required
                                minLength={10}
                                autoComplete="new-password"
                            />
                        </label>
                        {feedback ? <div className={`et-feedback ${feedback.kind}`}>{feedback.text}</div> : null}
                        <button type="submit" className="et-btn primary" disabled={busy}>
                            {busy ? "Enviando…" : "Criar conta"}
                        </button>
                    </form>
                )}
            </motion.section>
        </main>
    );
}
