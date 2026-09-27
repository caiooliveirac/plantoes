"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Props {
    medicoId: string;
    monthKey: string;
    token: string | null;
    razaoSocial: string | null;
    cnpj: string | null;
}

/**
 * Empresa (razão social) e CNPJ que saem impressos na folha de ponto. O médico
 * troca aqui, no painel, quando muda de empresa — antes só dava pelo bot.
 */
export function DadosFiscais({ medicoId, monthKey, token, razaoSocial, cnpj }: Props) {
    const router = useRouter();
    const vazio = !razaoSocial || !cnpj;
    const [editing, setEditing] = useState(vazio);
    const [nome, setNome] = useState(razaoSocial ?? "");
    const [numero, setNumero] = useState(cnpj ?? "");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function save() {
        setBusy(true);
        setError(null);
        try {
            const response = await fetch("/api/medico/dados-fiscais", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    medicoId,
                    monthKey,
                    razaoSocial: nome,
                    cnpj: numero,
                    ...(token ? { t: token } : {}),
                }),
            });
            const body = await response.json().catch(() => null) as { error?: string; razaoSocial?: string; cnpj?: string } | null;
            if (!response.ok) {
                setError(body?.error ?? "Não foi possível salvar.");
                return;
            }
            setNome(body?.razaoSocial ?? nome);
            setNumero(body?.cnpj ?? numero);
            setEditing(false);
            router.refresh();
        } finally {
            setBusy(false);
        }
    }

    if (!editing) {
        return (
            <div className="panel-self-service-row">
                <p className="panel-note">
                    Empresa: <strong>{razaoSocial}</strong> · CNPJ: <strong>{cnpj}</strong>
                </p>
                <button type="button" className="panel-link-btn" onClick={() => setEditing(true)}>
                    Alterar empresa/CNPJ
                </button>
            </div>
        );
    }

    return (
        <>
            {vazio ? (
                <p className="panel-note">Informe a empresa e o CNPJ que devem sair na folha.</p>
            ) : null}
            <div className="panel-self-service-row">
                <label className="panel-field">
                    <span className="panel-field-label">Razão social</span>
                    <input type="text" value={nome} onChange={(event) => setNome(event.target.value)} />
                </label>
                <label className="panel-field">
                    <span className="panel-field-label">CNPJ</span>
                    <input
                        type="text"
                        inputMode="numeric"
                        placeholder="00.000.000/0000-00"
                        value={numero}
                        onChange={(event) => setNumero(event.target.value)}
                    />
                </label>
                <button
                    type="button"
                    className="panel-action-btn"
                    disabled={busy || !nome.trim() || !numero.trim()}
                    onClick={() => void save()}
                >
                    {busy ? "Salvando…" : "Salvar"}
                </button>
                {!vazio ? (
                    <button
                        type="button"
                        className="panel-link-btn"
                        onClick={() => {
                            setEditing(false);
                            setNome(razaoSocial ?? "");
                            setNumero(cnpj ?? "");
                            setError(null);
                        }}
                    >
                        Cancelar
                    </button>
                ) : null}
            </div>
            {error ? <p className="panel-self-service-error" role="alert">{error}</p> : null}
        </>
    );
}
