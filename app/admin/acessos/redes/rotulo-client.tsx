"use client";

/* Rótulo de uma faixa de rede (/admin/acessos/redes). "Central" vale na hora
   no portão de turno: PC nessa faixa abre Mesa e Tabela mesmo sem chegada. */
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { RotuloDeRede, TipoDeRotulo } from "@/modules/acessos/redes";

const TIPOS: Array<{ id: TipoDeRotulo; nome: string }> = [
    { id: "central", nome: "Central (abre Mesa e Tabela)" },
    { id: "suspeita", nome: "Suspeita (ex.: Vitalmed)" },
    { id: "conhecida", nome: "Conhecida (hospital, base…)" },
];

export function RotuloDaRede({ faixa, rotulo }: { faixa: string; rotulo: RotuloDeRede | null }) {
    const router = useRouter();
    const [aberto, setAberto] = useState(false);
    const [kind, setKind] = useState<TipoDeRotulo>(rotulo?.kind ?? "suspeita");
    const [label, setLabel] = useState(rotulo?.label ?? "");
    const [note, setNote] = useState(rotulo?.note ?? "");
    const [ocupado, setOcupado] = useState(false);
    const [erro, setErro] = useState<string | null>(null);

    async function enviar(metodo: "POST" | "DELETE") {
        if (metodo === "POST" && kind === "central" && !window.confirm(`Tratar ${faixa} como Central? Qualquer conta logada nessa faixa passa a abrir Mesa e Tabela fora do plantão.`)) return;
        setOcupado(true);
        setErro(null);
        try {
            const resposta = await fetch("/api/admin/acessos/redes", {
                method: metodo,
                headers: { "content-type": "application/json" },
                body: JSON.stringify(metodo === "POST" ? { faixa, kind, label, note } : { faixa }),
            });
            const dados = await resposta.json().catch(() => ({}));
            if (!resposta.ok) throw new Error(dados.error ?? `Falhou (${resposta.status}).`);
            setAberto(false);
            router.refresh();
        } catch (e) {
            setErro(e instanceof Error ? e.message : "Falhou.");
        } finally {
            setOcupado(false);
        }
    }

    if (!aberto) {
        return (
            <button type="button" className="ac-btn ac-nao-imprimir" onClick={() => setAberto(true)}>
                {rotulo ? "Editar rótulo" : "Rotular rede"}
            </button>
        );
    }
    return (
        <form className="ac-rotulo ac-nao-imprimir" onSubmit={(e) => { e.preventDefault(); void enviar("POST"); }}>
            <select value={kind} onChange={(e) => setKind(e.target.value as TipoDeRotulo)} aria-label="Tipo">
                {TIPOS.map((t) => <option key={t.id} value={t.id}>{t.nome}</option>)}
            </select>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Nome (ex.: Vitalmed)" aria-label="Nome" required minLength={2} maxLength={80} />
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Observação (opcional)" aria-label="Observação" maxLength={500} />
            <div className="ac-rotulo-botoes">
                <button type="submit" className="ac-btn" disabled={ocupado}>Salvar</button>
                {rotulo ? <button type="button" className="ac-btn perigo" disabled={ocupado} onClick={() => void enviar("DELETE")}>Remover</button> : null}
                <button type="button" className="ac-btn" disabled={ocupado} onClick={() => setAberto(false)}>Cancelar</button>
            </div>
            {erro ? <p className="ac-sub" role="alert">{erro}</p> : null}
        </form>
    );
}
