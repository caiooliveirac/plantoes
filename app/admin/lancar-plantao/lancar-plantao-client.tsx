"use client";

import { useState } from "react";
import { MANUAL_SHIFT_DEFAULT_TIMES, type ManualShiftLabel } from "@/modules/operational/manual-shift";

interface Alvo { domain: "regulation" | "intervention"; id: number; code: string; label: string }
interface Previa {
    target: { code: string; label: string };
    scheduledStartAt: string;
    scheduledEndAt: string;
    calculation: {
        arrivalDelayMinutes: number; overtimeMinutes: number; overtimeMultiplier: number;
        balanceMinutes: number; explanation: string;
    };
    balanceBeforeMinutes: number;
    balanceAfterMinutes: number;
    overlaps: Array<{ id: string; code: string; startedAt: string; endsAt: string | null }>;
}

function horas(min: number) {
    const sinal = min < 0 ? "−" : min > 0 ? "+" : "";
    const abs = Math.abs(min);
    return `${sinal}${Math.floor(abs / 60)}h${String(abs % 60).padStart(2, "0")}`;
}

function hora(iso: string) {
    return new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function LancarPlantao({ medicos, alvos }: {
    medicos: Array<{ id: string; nome: string; ativo: boolean }>;
    alvos: Alvo[];
}) {
    const [medicoId, setMedicoId] = useState("");
    const [alvoKey, setAlvoKey] = useState("");
    const [data, setData] = useState("");
    const [turno, setTurno] = useState<ManualShiftLabel>("SD");
    const [chegada, setChegada] = useState(MANUAL_SHIFT_DEFAULT_TIMES.SD.arrival);
    const [saida, setSaida] = useState(MANUAL_SHIFT_DEFAULT_TIMES.SD.departure);
    const [sombra, setSombra] = useState(false);
    const [motivo, setMotivo] = useState("");
    const [previa, setPrevia] = useState<Previa | null>(null);
    const [ocupado, setOcupado] = useState(false);
    const [erro, setErro] = useState<string | null>(null);
    const [feito, setFeito] = useState<string | null>(null);

    function corpo(mode: "preview" | "create") {
        const alvo = alvos.find((a) => `${a.domain}:${a.id}` === alvoKey);
        return JSON.stringify({
            mode, doctorId: medicoId, domain: alvo?.domain, targetId: alvo?.id, operationalDate: data,
            shiftLabel: turno, arrivalTime: chegada, departureTime: saida, isShadow: sombra, reason: motivo,
        });
    }

    async function enviar(mode: "preview" | "create") {
        setOcupado(true);
        setErro(null);
        setFeito(null);
        try {
            const resposta = await fetch("/api/admin/occupancies/manual-shift", {
                method: "POST", headers: { "content-type": "application/json" }, body: corpo(mode),
            });
            const dados = await resposta.json().catch(() => ({}));
            if (!resposta.ok) throw new Error(dados.error ?? `Falhou (${resposta.status}).`);
            if (mode === "preview") {
                setPrevia(dados.preview as Previa);
            } else {
                const real = dados.bankEntry?.balanceMinutes;
                setFeito(`Plantão lançado para ${dados.doctorName ?? "o médico"}. Banco gravado: ${real === undefined ? "sem entrada (sem saldo)" : horas(real)}.`);
                setPrevia(null);
            }
        } catch (e) {
            setErro(e instanceof Error ? e.message : "Falhou.");
        } finally {
            setOcupado(false);
        }
    }

    function mudou<T>(set: (v: T) => void) {
        return (v: T) => { set(v); setPrevia(null); setFeito(null); };
    }

    function trocarTurno(valor: ManualShiftLabel) {
        mudou(setTurno)(valor);
        setChegada(MANUAL_SHIFT_DEFAULT_TIMES[valor].arrival);
        setSaida(MANUAL_SHIFT_DEFAULT_TIMES[valor].departure);
    }

    const completo = Boolean(medicoId && alvoKey && data && chegada && saida);
    const c = previa?.calculation;

    return (
        <section className="ac-card">
            <form className="ac-rotulo" onSubmit={(e) => { e.preventDefault(); void enviar("preview"); }}>
                <select value={medicoId} onChange={(e) => mudou(setMedicoId)(e.target.value)} aria-label="Médico" required>
                    <option value="">Médico…</option>
                    {medicos.map((m) => <option key={m.id} value={m.id}>{m.nome}{m.ativo ? "" : " (inativo)"}</option>)}
                </select>
                <select value={alvoKey} onChange={(e) => mudou(setAlvoKey)(e.target.value)} aria-label="Ramal ou base" required>
                    <option value="">Ramal ou base…</option>
                    <optgroup label="Regulação (ramais)">
                        {alvos.filter((a) => a.domain === "regulation").map((a) => <option key={`r${a.id}`} value={`regulation:${a.id}`}>{a.code} · {a.label}</option>)}
                    </optgroup>
                    <optgroup label="Intervenção (bases)">
                        {alvos.filter((a) => a.domain === "intervention").map((a) => <option key={`i${a.id}`} value={`intervention:${a.id}`}>{a.code} · {a.label}</option>)}
                    </optgroup>
                </select>
                <label className="ac-sub">Dia do plantão <input type="date" value={data} onChange={(e) => mudou(setData)(e.target.value)} required /></label>
                <select value={turno} onChange={(e) => trocarTurno(e.target.value as ManualShiftLabel)} aria-label="Turno">
                    <option value="SD">SD (07h–19h)</option>
                    <option value="SN">SN (19h–07h)</option>
                </select>
                <label className="ac-sub">Chegada <input type="time" value={chegada} onChange={(e) => mudou(setChegada)(e.target.value)} required /></label>
                <label className="ac-sub">Saída <input type="time" value={saida} onChange={(e) => mudou(setSaida)(e.target.value)} required /></label>
                <label className="ac-sub">
                    <input type="checkbox" checked={sombra} onChange={(e) => mudou(setSombra)(e.target.checked)} /> Sombra (acompanha o titular, fora do quadro)
                </label>
                <input type="text" value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Motivo (ex.: ficou em ocorrência 1027)" aria-label="Motivo" />
                <div className="ac-rotulo-botoes">
                    <button type="submit" className="ac-btn" disabled={ocupado || !completo}>{ocupado ? "Calculando…" : "Calcular banco de horas"}</button>
                </div>
                {erro ? <p className="ac-erro">{erro}</p> : null}
                {feito ? <p className="ac-sub">{feito}</p> : null}
            </form>

            {previa && c ? (
                <div>
                    <h2>Antes de confirmar</h2>
                    <p className="ac-sub">
                        {previa.target.code} · janela prevista {hora(previa.scheduledStartAt)} → {hora(previa.scheduledEndAt)}.
                        Atraso {c.arrivalDelayMinutes} min · excedente {c.overtimeMinutes} min
                        {c.overtimeMultiplier === 2 ? " × 2 (chegou no horário)" : " (simples, chegou atrasado)"}.
                    </p>
                    <p><strong>Banco de horas deste plantão: {horas(c.balanceMinutes)}</strong>
                        {" "}— saldo {horas(previa.balanceBeforeMinutes)} → {horas(previa.balanceAfterMinutes)}</p>
                    <p className="ac-sub">{c.explanation}</p>
                    {previa.overlaps.length > 0 ? (
                        <p className="ac-erro">
                            Atenção: o médico já tem plantão nesta janela ({previa.overlaps.map((o) => `${o.code} ${hora(o.startedAt)}`).join(", ")}).
                            Um médico recebe no máximo um plantão por turno de 12h, e a continuidade pode somar este lançamento ao vizinho.
                        </p>
                    ) : null}
                    <div className="ac-rotulo-botoes">
                        <button type="button" className="ac-btn" disabled={ocupado || motivo.trim().length < 8} onClick={() => void enviar("create")}>
                            {ocupado ? "Gravando…" : "Confirmar e lançar"}
                        </button>
                        {motivo.trim().length < 8 ? <span className="ac-sub">Escreva o motivo (mín. 8 caracteres) para confirmar.</span> : null}
                    </div>
                </div>
            ) : null}
        </section>
    );
}
