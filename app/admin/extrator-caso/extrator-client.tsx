"use client";

import { useState } from "react";
import type { Legenda } from "@/modules/extrator-caso/mascara";

interface Caso {
    texto: string;
    legenda: Legenda;
}

export function ExtratorDeCaso({
    medicos,
    meses,
}: {
    medicos: Array<{ id: string; nome: string; ativo: boolean }>;
    meses: Array<{ key: string; label: string }>;
}) {
    const [medicoId, setMedicoId] = useState("");
    const [mes, setMes] = useState(meses[0]?.key ?? "");
    const [comTextos, setComTextos] = useState(true);
    const [caso, setCaso] = useState<Caso | null>(null);
    const [ocupado, setOcupado] = useState(false);
    const [erro, setErro] = useState<string | null>(null);
    const [copiado, setCopiado] = useState(false);

    async function extrair() {
        setOcupado(true);
        setErro(null);
        setCaso(null);
        setCopiado(false);
        try {
            const resposta = await fetch("/api/admin/extrator-caso", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ medicoId, mes, comTextos }),
            });
            const dados = await resposta.json().catch(() => ({}));
            if (!resposta.ok) throw new Error(dados.error ?? `Falhou (${resposta.status}).`);
            setCaso(dados as Caso);
        } catch (e) {
            setErro(e instanceof Error ? e.message : "Falhou.");
        } finally {
            setOcupado(false);
        }
    }

    async function copiar() {
        if (!caso) return;
        await navigator.clipboard.writeText(caso.texto);
        setCopiado(true);
    }

    const linhas = caso
        ? [
            ...caso.legenda.pessoas.map((p) => ({ chave: p.pseudonimo, valor: p.nome })),
            ...caso.legenda.contas.map((c) => ({ chave: c.pseudonimo, valor: c.email })),
            ...caso.legenda.alvos.map((a) => ({ chave: a.pseudonimo, valor: [a.codigo, a.rotulo].filter(Boolean).join(" · ") })),
            ...caso.legenda.ids.map((i) => ({ chave: i.pseudonimo, valor: i.id })),
        ]
        : [];

    return (
        <>
            <section className="ac-card">
                <form className="ac-rotulo" onSubmit={(e) => { e.preventDefault(); void extrair(); }}>
                    <select value={medicoId} onChange={(e) => setMedicoId(e.target.value)} aria-label="Médico" required>
                        <option value="">Médico…</option>
                        {medicos.map((m) => <option key={m.id} value={m.id}>{m.nome}{m.ativo ? "" : " (inativo)"}</option>)}
                    </select>
                    <select value={mes} onChange={(e) => setMes(e.target.value)} aria-label="Mês" required>
                        {meses.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
                    </select>
                    <label className="ac-sub">
                        <input type="checkbox" checked={comTextos} onChange={(e) => setComTextos(e.target.checked)} />{" "}
                        Incluir anotações escritas à mão (mascaradas). Desmarque se o caso tiver observação sensível.
                    </label>
                    <div className="ac-rotulo-botoes">
                        <button type="submit" className="ac-btn" disabled={ocupado || !medicoId}>{ocupado ? "Extraindo…" : "Extrair caso"}</button>
                    </div>
                    {erro ? <p className="ac-erro">{erro}</p> : null}
                </form>
            </section>

            {caso ? (
                <>
                    <section className="ac-card">
                        <div className="ac-topo">
                            <div>
                                <h2>Texto para colar</h2>
                                <p className="ac-sub">
                                    Leia antes de colar: anotação escrita à mão pode citar alguém que não é médico cadastrado, e esse
                                    nome a máscara não conhece.
                                </p>
                            </div>
                            <button type="button" className="ac-btn" onClick={() => void copiar()}>{copiado ? "Copiado" : "Copiar"}</button>
                        </div>
                        <textarea
                            className="ac-mono"
                            readOnly
                            value={caso.texto}
                            rows={24}
                            aria-label="Caso desidentificado"
                            style={{ width: "100%", fontSize: "0.78rem", background: "var(--superficie)", color: "var(--texto)", border: "1px solid var(--borda)", borderRadius: 8, padding: 8 }}
                        />
                    </section>

                    <section className="ac-card">
                        <h2>Legenda — fica só nesta tela</h2>
                        <p className="ac-sub">Mês do caso (M0): {caso.legenda.mesAncora}. D+00 é o dia 1 desse mês.</p>
                        <div className="ac-tabela-wrap">
                            <table className="ac-tabela">
                                <thead><tr><th>No texto</th><th>É</th></tr></thead>
                                <tbody>
                                    {linhas.map((linha) => (
                                        <tr key={linha.chave}><td className="ac-mono">{linha.chave}</td><td>{linha.valor}</td></tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </section>
                </>
            ) : null}
        </>
    );
}
