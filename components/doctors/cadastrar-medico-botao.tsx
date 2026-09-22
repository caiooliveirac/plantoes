"use client";

/**
 * Botão "Cadastrar médico" da barra de topo do admin. Modal curto: nome
 * completo, nome da tela, vínculo, especialista e valor do contrato. PJ já sai
 * com contrato e teto (POST /api/admin/doctors/register) — o passo manual no
 * fechamento era o que sempre ficava esquecido.
 */
import * as Dialog from "@radix-ui/react-dialog";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CEILING_PRESETS, DEFAULT_CEILING_PRESET, type CeilingPreset } from "@/lib/contracts/ceiling-presets";

const formatBrl = (brl: number) => brl.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

const EMPTY = {
    fullName: "",
    displayName: "",
    employmentType: "pj" as "pj" | "estatutario",
    isSpecialist: false,
    preset: DEFAULT_CEILING_PRESET as CeilingPreset,
};

export function CadastrarMedicoBotao() {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [form, setForm] = useState(EMPTY);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState<string | null>(null);

    const isPj = form.employmentType === "pj";

    function toggleSpecialist(isSpecialist: boolean) {
        // Marcar especialista leva a seleção para a mesma CH da outra coluna.
        const category = isSpecialist ? "especialista" : "generalista";
        const preset = CEILING_PRESETS.find((p) => p.weeklyHours === form.preset.weeklyHours && p.category === category)
            ?? form.preset;
        setForm({ ...form, isSpecialist, preset });
    }

    async function submit() {
        setBusy(true);
        setError(null);
        try {
            const response = await fetch("/api/admin/doctors/register", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    fullName: form.fullName,
                    displayName: form.displayName.trim() || null,
                    employmentType: form.employmentType,
                    isSpecialist: form.isSpecialist,
                    ceilingBrl: isPj ? form.preset.brl : null,
                    weeklyHours: isPj ? form.preset.weeklyHours : null,
                }),
            });
            const body = await response.json().catch(() => ({}));
            if (!response.ok) {
                setError(body.error ?? "Não foi possível cadastrar.");
                return;
            }
            setDone(isPj
                ? `${form.fullName.trim()} cadastrado(a), contrato PJ de ${formatBrl(form.preset.brl)}. Nº do contrato fica "A DEFINIR" até ser informado no fechamento.`
                : `${form.fullName.trim()} cadastrado(a) como estatutário.`);
            setForm(EMPTY);
            router.refresh();
        } catch {
            setError("Sem resposta do servidor.");
        } finally {
            setBusy(false);
        }
    }

    const canSubmit = form.fullName.trim().length >= 5 && !busy;

    return (
        <Dialog.Root
            open={open}
            onOpenChange={(next) => {
                setOpen(next);
                if (!next) { setError(null); setDone(null); }
            }}
        >
            <Dialog.Trigger asChild>
                <button type="button" className="k-topo-acao">+ Cadastrar médico</button>
            </Dialog.Trigger>
            {/* Sem Portal: fica dentro de .pagina-kairos e herda os tokens do tema. */}
            <Dialog.Overlay className="board-modal-backdrop" />
            <Dialog.Content className="board-modal cadastro-medico-modal" aria-describedby={undefined}>
                <Dialog.Title className="board-modal-title">Cadastrar médico</Dialog.Title>

                {done ? <div className="board-modal-warning"><p>{done}</p></div> : null}
                {error ? <div className="board-modal-warning danger"><p>{error}</p></div> : null}

                <label className="board-modal-field">
                    <span>Nome completo</span>
                    <input
                        autoFocus
                        value={form.fullName}
                        onChange={(event) => setForm({ ...form, fullName: event.target.value })}
                    />
                </label>
                <label className="board-modal-field">
                    <span>Nome para a tela (opcional)</span>
                    <input
                        placeholder="ex.: Dr. Fulano"
                        value={form.displayName}
                        onChange={(event) => setForm({ ...form, displayName: event.target.value })}
                    />
                </label>

                <div className="cadastro-medico-opcoes" role="radiogroup" aria-label="Vínculo">
                    {(["pj", "estatutario"] as const).map((type) => (
                        <button
                            key={type}
                            type="button"
                            role="radio"
                            aria-checked={form.employmentType === type}
                            onClick={() => setForm({ ...form, employmentType: type })}
                        >
                            {type === "pj" ? "PJ" : "Estatutário"}
                        </button>
                    ))}
                </div>

                <label className="cadastro-medico-check">
                    <input
                        type="checkbox"
                        checked={form.isSpecialist}
                        onChange={(event) => toggleSpecialist(event.target.checked)}
                    />
                    Especialista
                </label>

                {isPj ? (
                    <div className="cadastro-medico-opcoes tetos" role="radiogroup" aria-label="Valor do contrato">
                        {CEILING_PRESETS.map((preset) => (
                            <button
                                key={preset.brl}
                                type="button"
                                role="radio"
                                aria-checked={form.preset.brl === preset.brl}
                                onClick={() => setForm({ ...form, preset })}
                            >
                                <strong>{formatBrl(preset.brl)}</strong>
                                <small>{preset.label}</small>
                            </button>
                        ))}
                    </div>
                ) : (
                    <p className="board-modal-subtitle">Estatutário: valor R$ 0,00 — sem contrato PJ nem teto.</p>
                )}

                <div className="board-modal-actions">
                    <Dialog.Close asChild>
                        <button type="button" className="board-modal-cancel">Fechar</button>
                    </Dialog.Close>
                    <button type="button" className="board-modal-confirm" disabled={!canSubmit} onClick={submit}>
                        {busy ? "Cadastrando…" : "Cadastrar"}
                    </button>
                </div>
            </Dialog.Content>
        </Dialog.Root>
    );
}
