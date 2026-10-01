"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { KairosTopo } from "@/components/kairos-topo";
import { AVISO_ANTES_S, BATIDA_MS, type ModoPresenca } from "@/modules/acessos/presenca";
import "@/app/auth-pages.css";
import "@/components/board/mesa-presenca.css";

/* Presença na Mesa (docs/presenca-mesa.md), lado do navegador.

   - Aba visível: batida a cada ~15 s com "segundos parado". Aba escondida não
     bate — a vez vence sozinha em 45 s. Fechar a aba solta a vez na hora.
   - Mexer o mouse, rolar, tocar ou teclar é interação. Nada disso vai ao
     servidor por evento: só o "parado há N s" de cada batida.
   - Parado quase no limite: faixa "Ainda está aí?". No limite: o quadro sai
     da tela (desmonta, não só cobre) e fica a tela de bloqueio com senha.

   Tudo aqui é conforto de interface. Quem manda é o servidor: sem batida
   recente, ou com o aparelho bloqueado, nenhuma rota da Mesa entrega dado. */

type Estado = "ok" | "ocupada" | "bloqueada" | "isento";

interface Props {
    estadoInicial: Estado;
    modo: ModoPresenca | null;
    limiteOciosoSeg: number;
    tenteEmSeg?: number;
    email: string;
    /** Nome do médico da conta (sem médico, vem o e-mail). */
    nome: string;
    children?: ReactNode;
}

const EVENTOS_HUMANOS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;

export function MesaPresenca({ estadoInicial, modo, limiteOciosoSeg, tenteEmSeg, email, nome, children }: Props) {
    const router = useRouter();
    const valendo = modo === "valendo";
    const [estado, setEstado] = useState<Estado>(estadoInicial);
    const [espera, setEspera] = useState(tenteEmSeg ?? 0);
    const [avisoSeg, setAvisoSeg] = useState<number | null>(null);
    const ultimaInteracao = useRef(Date.now());
    const estadoRef = useRef(estado);
    estadoRef.current = estado;

    // O refresh do servidor (router.refresh) traz o estado dele; ele vence.
    useEffect(() => {
        setEstado(estadoInicial);
        if (tenteEmSeg) setEspera(tenteEmSeg);
    }, [estadoInicial, tenteEmSeg]);

    useEffect(() => {
        const marcar = () => {
            ultimaInteracao.current = Date.now();
        };
        for (const evento of EVENTOS_HUMANOS) window.addEventListener(evento, marcar, { passive: true });
        // Rolagem dentro de painéis não borbulha: escuta na captura.
        document.addEventListener("scroll", marcar, { passive: true, capture: true });
        return () => {
            for (const evento of EVENTOS_HUMANOS) window.removeEventListener(evento, marcar);
            document.removeEventListener("scroll", marcar, { capture: true });
        };
    }, []);

    const bater = useCallback(async () => {
        if (estadoRef.current === "isento" || estadoRef.current === "bloqueada") return;
        if (document.visibilityState !== "visible") return;
        const paradoSeg = Math.max(0, Math.round((Date.now() - ultimaInteracao.current) / 1000));
        try {
            const resposta = await fetch("/api/mesa/presenca", {
                method: "POST",
                cache: "no-store",
                headers: { "content-type": "application/json", "x-mesa-uso": `v=1;o=${paradoSeg}` },
                body: JSON.stringify({ visivel: true, paradoSeg }),
            });
            if (resposta.status === 429) return;
            const corpo = await resposta.json().catch(() => ({})) as { estado?: string; codigo?: string; tenteEmSeg?: number };
            if (corpo.estado === "sem_sessao" || corpo.estado === "fora_do_plantao") {
                window.location.reload();
                return;
            }
            if (!valendo) return;
            if (corpo.estado === "ocupada") {
                setEstado("ocupada");
                setEspera(corpo.tenteEmSeg ?? 45);
                return;
            }
            if (corpo.estado === "bloqueada") {
                setEstado("bloqueada");
                return;
            }
            if ((corpo.estado === "ok" || corpo.estado === "isento") && estadoRef.current !== "ok") {
                // Pegou a vez: o servidor monta o quadro de novo.
                setEstado("ok");
                router.refresh();
            }
        } catch {
            // Rede caiu: a tela fica como está; a vez vence sozinha se não voltar.
        }
    }, [router, valendo]);

    // Batida periódica (com folga aleatória) e imediata ao voltar a aba.
    useEffect(() => {
        if (estadoInicial === "isento" || modo === null || modo === "desligado") return;
        let timer: number | null = null;
        const agendar = () => {
            timer = window.setTimeout(async () => {
                await bater();
                agendar();
            }, BATIDA_MS - 2_000 + Math.random() * 4_000);
        };
        const aoMudarVisibilidade = () => {
            if (document.visibilityState === "visible") void bater();
        };
        const aoSair = () => {
            navigator.sendBeacon?.("/api/mesa/presenca/liberar");
        };
        void bater();
        agendar();
        document.addEventListener("visibilitychange", aoMudarVisibilidade);
        window.addEventListener("pagehide", aoSair);
        return () => {
            if (timer !== null) window.clearTimeout(timer);
            document.removeEventListener("visibilitychange", aoMudarVisibilidade);
            window.removeEventListener("pagehide", aoSair);
        };
    }, [bater, estadoInicial, modo]);

    // Relógio local: aviso antes do limite e bloqueio no limite (só valendo).
    useEffect(() => {
        if (!valendo || estado !== "ok" || limiteOciosoSeg <= 0) {
            setAvisoSeg(null);
            return;
        }
        const id = window.setInterval(() => {
            const parado = (Date.now() - ultimaInteracao.current) / 1000;
            const falta = Math.ceil(limiteOciosoSeg - parado);
            if (falta <= 0) {
                setAvisoSeg(null);
                setEstado("bloqueada");
                // O servidor grava o bloqueio (e solta a vez) na batida com o tempo parado.
                const paradoSeg = Math.round(parado);
                void fetch("/api/mesa/presenca", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ visivel: document.visibilityState === "visible", paradoSeg }),
                }).catch(() => undefined);
                return;
            }
            setAvisoSeg(falta <= AVISO_ANTES_S ? falta : null);
        }, 1_000);
        return () => window.clearInterval(id);
    }, [valendo, estado, limiteOciosoSeg]);

    // Contagem da espera quando outro aparelho está com a vez.
    useEffect(() => {
        if (estado !== "ocupada") return;
        const id = window.setInterval(() => setEspera((s) => Math.max(0, s - 1)), 1_000);
        return () => window.clearInterval(id);
    }, [estado]);

    if (!valendo || estado === "isento") return <>{children}</>;
    if (estado === "bloqueada") return <TelaBloqueada email={email} nome={nome} />;
    if (estado === "ocupada") return <TelaOcupada espera={espera} nome={nome} />;
    if (!children) return <TelaAbrindo />;
    return (
        <>
            {children}
            {avisoSeg !== null ? (
                <div className="mp-aviso" role="alert">
                    <strong>Ainda está aí?</strong>
                    <span>Sem movimento na tela, a Mesa fecha em {avisoSeg} s. Mexa o mouse ou toque na tela para continuar.</span>
                </div>
            ) : null}
        </>
    );
}

function Moldura({ titulo, children }: { titulo: string; children: ReactNode }) {
    return (
        <div className="pagina-kairos">
            <KairosTopo titulo="Mesa operacional" />
            <main className="et-shell" style={{ alignItems: "center", justifyContent: "center" }}>
                <section className="et-panel" style={{ width: "min(480px, 100%)" }}>
                    <div className="et-panel-head"><h2>{titulo}</h2></div>
                    {children}
                </section>
            </main>
        </div>
    );
}

function TelaAbrindo() {
    return (
        <Moldura titulo="Abrindo a Mesa…">
            <div className="et-form"><p>Um instante.</p></div>
        </Moldura>
    );
}

/** Manda a senha a uma rota da presença; ok recarrega a página. Devolve o erro a mostrar. */
async function enviarSenha(rota: string, senha: string, falha: string): Promise<string | null> {
    try {
        const resposta = await fetch(rota, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ senha }),
        });
        if (resposta.ok) {
            window.location.reload();
            return null;
        }
        const corpo = await resposta.json().catch(() => ({})) as { error?: string };
        if (resposta.status === 401 && corpo.error === "sem_sessao") {
            window.location.href = "/entrar";
            return null;
        }
        return corpo.error ?? falha;
    } catch {
        return falha;
    }
}

function TelaOcupada({ espera, nome }: { espera: number; nome: string }) {
    const [senha, setSenha] = useState("");
    const [ocupado, setOcupado] = useState(false);
    const [erro, setErro] = useState<string | null>(null);

    async function usarAqui(evento: React.FormEvent) {
        evento.preventDefault();
        if (ocupado) return;
        setOcupado(true);
        setErro(null);
        setErro(await enviarSenha("/api/mesa/assumir", senha, "Não foi possível usar a Mesa aqui agora."));
        setOcupado(false);
    }

    return (
        <Moldura titulo="Este painel está aberto em outro dispositivo">
            <form className="et-form" onSubmit={usarAqui}>
                <p>A Mesa de {nome} está à vista em outro aparelho. Ela abre aqui sozinha quando aquela tela for fechada ou ficar em segundo plano.</p>
                <p className="mp-espera">
                    {espera > 0 ? <>Tentando de novo — a vez do outro aparelho vence em até <strong>{espera} s</strong>.</> : <>Tentando de novo…</>}
                </p>
                <p>Esqueceu a Mesa aberta em outro lugar? Digite a senha para usar aqui. O outro aparelho trava e só volta com a senha.</p>
                <label>
                    Senha
                    <input type="password" value={senha} onChange={(e) => setSenha(e.target.value)} required autoComplete="current-password" />
                </label>
                {erro ? <div className="et-feedback err">{erro}</div> : null}
                <button type="submit" className="et-btn primary" disabled={ocupado}>
                    {ocupado ? "Conferindo…" : "Usar aqui"}
                </button>
                <p className="mp-nota">Se não é você usando a conta em outro lugar, troque a senha e avise a coordenação.</p>
            </form>
        </Moldura>
    );
}

function TelaBloqueada({ email, nome }: { email: string; nome: string }) {
    const [senha, setSenha] = useState("");
    const [ocupado, setOcupado] = useState(false);
    const [erro, setErro] = useState<string | null>(null);

    async function desbloquear(evento: React.FormEvent) {
        evento.preventDefault();
        if (ocupado) return;
        setOcupado(true);
        setErro(null);
        setErro(await enviarSenha("/api/mesa/desbloquear", senha, "Não foi possível desbloquear agora."));
        setOcupado(false);
    }

    async function outraConta() {
        await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
        // Login local, não o do portal: o portal lembraria a conta anterior.
        window.location.href = "/entrar";
    }

    return (
        <Moldura titulo={`Ainda é ${nome}?`}>
            <form className="et-form" onSubmit={desbloquear}>
                <p>A Mesa foi fechada neste aparelho — ficou parada ou foi aberta em outro. Quem está aqui agora pode não ser {nome}. Para continuar, digite a senha desta conta.</p>
                <p>Conta: <strong>{email}</strong></p>
                <label>
                    Senha
                    <input type="password" value={senha} onChange={(e) => setSenha(e.target.value)} required autoComplete="current-password" autoFocus />
                </label>
                {erro ? <div className="et-feedback err">{erro}</div> : null}
                <button type="submit" className="et-btn primary" disabled={ocupado}>
                    {ocupado ? "Conferindo…" : "Voltar à Mesa"}
                </button>
                <p><button type="button" className="mp-link" onClick={() => void outraConta()}>Não sou {nome} — entrar com a minha conta</button></p>
            </form>
        </Moldura>
    );
}
