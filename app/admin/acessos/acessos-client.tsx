"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/** Recarrega os dados do servidor a cada minuto (parado com a aba escondida). */
export function AtualizacaoAutomatica({ geradoEm }: { geradoEm: string }) {
    const router = useRouter();
    useEffect(() => {
        const id = window.setInterval(() => {
            if (document.visibilityState === "visible") router.refresh();
        }, 60_000);
        return () => window.clearInterval(id);
    }, [router]);
    const hora = new Date(geradoEm).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Bahia" });
    return <p className="ac-atualizacao">Atualizado às {hora} · atualiza sozinho a cada minuto</p>;
}

export function ImprimirRelatorio() {
    return (
        <button type="button" className="ac-btn ac-nao-imprimir" onClick={() => window.print()}>
            Imprimir / salvar PDF
        </button>
    );
}

type Acao = "encerrar_sessoes" | "exigir_nova_senha" | "suspender" | "reativar";

const EXPLICACAO: Record<Acao, { rotulo: string; texto: (email: string) => string; perigo: boolean }> = {
    encerrar_sessoes: {
        rotulo: "Encerrar todas as sessões",
        texto: () => "Derruba agora todos os aparelhos logados nesta conta. Quem entrou pelo portal mnrs.com.br precisa digitar a senha de novo. "
            + "Quem sabe a senha consegue voltar — e aparece de novo aqui, com o lugar de onde entrou.",
        perigo: false,
    },
    exigir_nova_senha: {
        rotulo: "Trocar a senha e mandar link",
        texto: (email) => `Troca a senha por uma aleatória que ninguém conhece, derruba todos os aparelhos e manda para ${email} um link para criar senha nova (vale 24 horas). `
            + "É o que corta quem só tem a senha emprestada. O dono da conta fica sem entrar até abrir o e-mail.",
        perigo: true,
    },
    suspender: {
        rotulo: "Suspender a conta",
        texto: () => "Desativa a conta: ninguém entra, nem o dono, até alguém reativar aqui. Use quando o acesso precisa parar imediatamente.",
        perigo: true,
    },
    reativar: {
        rotulo: "Reativar a conta",
        texto: () => "Libera a conta de novo. A senha continua a mesma de antes da suspensão.",
        perigo: false,
    },
};

async function enviar(url: string, corpo: Record<string, unknown>) {
    const resposta = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(corpo),
    });
    const dados = await resposta.json().catch(() => ({}));
    if (!resposta.ok) throw new Error(typeof dados.error === "string" ? dados.error : "Não foi possível concluir.");
    return dados as { sessoesEncerradas?: number; emailEnviado?: boolean; linkDeRedefinicao?: string };
}

export function AcoesDaConta({ userId, email, ativa, ehVoceMesmo }: { userId: string; email: string; ativa: boolean; ehVoceMesmo: boolean }) {
    const router = useRouter();
    const [aberta, setAberta] = useState<Acao | null>(null);
    const [motivo, setMotivo] = useState("");
    const [enviando, setEnviando] = useState(false);
    const [resultado, setResultado] = useState<{ tipo: "ok" | "erro"; texto: string; link?: string } | null>(null);

    if (ehVoceMesmo) {
        return (
            <p className="ac-sub ac-nao-imprimir" style={{ margin: 0 }}>
                Esta é a sua conta: as ações daqui derrubariam você também. Para sair dos outros aparelhos, troque a sua senha
                no painel de sessão da Mesa — a troca derruba todos os outros.
            </p>
        );
    }
    const acoes: Acao[] = ativa ? ["encerrar_sessoes", "exigir_nova_senha", "suspender"] : ["reativar"];

    async function confirmar() {
        if (!aberta) return;
        setEnviando(true);
        setResultado(null);
        try {
            const dados = await enviar(`/api/admin/acessos/contas/${userId}`, { acao: aberta, motivo });
            const sessoes = dados.sessoesEncerradas ?? 0;
            const partes = [`Feito. ${sessoes === 1 ? "1 sessão encerrada" : `${sessoes} sessões encerradas`}.`];
            if (aberta === "exigir_nova_senha") {
                partes.push(dados.emailEnviado
                    ? `O link para criar senha nova foi para ${email}.`
                    : "O e-mail NÃO saiu (SMTP indisponível). Mande o link abaixo ao dono da conta por outro meio seguro:");
            }
            setResultado({ tipo: "ok", texto: partes.join(" "), link: dados.linkDeRedefinicao });
            setAberta(null);
            setMotivo("");
            router.refresh();
        } catch (erro) {
            setResultado({ tipo: "erro", texto: erro instanceof Error ? erro.message : "Não foi possível concluir." });
        } finally {
            setEnviando(false);
        }
    }

    return (
        <div className="ac-nao-imprimir">
            <div className="ac-acoes">
                {acoes.map((acao) => (
                    <button
                        key={acao}
                        type="button"
                        className={`ac-btn ${EXPLICACAO[acao].perigo ? "perigo" : ""}`.trim()}
                        onClick={() => {
                            setAberta(acao);
                            setResultado(null);
                        }}
                    >
                        {EXPLICACAO[acao].rotulo}
                    </button>
                ))}
            </div>
            {aberta ? (
                <div className="ac-dialogo" role="dialog" aria-label={EXPLICACAO[aberta].rotulo}>
                    <strong>{EXPLICACAO[aberta].rotulo}</strong>
                    <p className="ac-sub" style={{ margin: 0 }}>{EXPLICACAO[aberta].texto(email)}</p>
                    <label className="ac-sub" style={{ margin: 0 }}>
                        Motivo (fica registrado na conta e na auditoria)
                        <textarea value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ex.: uso simultâneo em Salvador e Feira de Santana em 22/09" />
                    </label>
                    <div className="ac-acoes">
                        <button type="button" className={`ac-btn ${EXPLICACAO[aberta].perigo ? "perigo" : ""}`.trim()} disabled={enviando || motivo.trim().length < 5} onClick={confirmar}>
                            {enviando ? "Enviando…" : "Confirmar"}
                        </button>
                        <button type="button" className="ac-btn" disabled={enviando} onClick={() => setAberta(null)}>
                            Cancelar
                        </button>
                    </div>
                </div>
            ) : null}
            {resultado ? (
                <div className={resultado.tipo === "ok" ? "ac-ok" : "ac-erro"} style={{ marginTop: 12 }}>
                    {resultado.texto}
                    {resultado.link ? <div className="ac-mono" style={{ marginTop: 6 }}>{resultado.link}</div> : null}
                </div>
            ) : null}
        </div>
    );
}

export function EncerrarSessao({ sessionId }: { sessionId: string }) {
    const router = useRouter();
    const [aberto, setAberto] = useState(false);
    const [motivo, setMotivo] = useState("");
    const [enviando, setEnviando] = useState(false);
    const [erro, setErro] = useState<string | null>(null);

    if (!aberto) {
        return (
            <button type="button" className="ac-btn ac-nao-imprimir" onClick={() => setAberto(true)}>
                Encerrar
            </button>
        );
    }
    return (
        <div className="ac-nao-imprimir" style={{ display: "grid", gap: 6, minWidth: 220 }}>
            <input
                className="ac-mono"
                style={{ border: "1px solid var(--borda)", borderRadius: 8, padding: "6px 8px", background: "var(--superficie)", color: "var(--texto-forte)" }}
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                placeholder="Motivo"
                aria-label="Motivo para encerrar esta sessão"
            />
            <div className="ac-acoes">
                <button
                    type="button"
                    className="ac-btn perigo"
                    disabled={enviando || motivo.trim().length < 5}
                    onClick={async () => {
                        setEnviando(true);
                        setErro(null);
                        try {
                            await enviar(`/api/admin/acessos/sessoes/${sessionId}`, { motivo });
                            router.refresh();
                        } catch (falha) {
                            setErro(falha instanceof Error ? falha.message : "Não foi possível encerrar.");
                            setEnviando(false);
                        }
                    }}
                >
                    {enviando ? "…" : "Encerrar sessão"}
                </button>
                <button type="button" className="ac-btn" onClick={() => setAberto(false)}>Cancelar</button>
            </div>
            {erro ? <span className="ac-erro">{erro}</span> : null}
        </div>
    );
}
