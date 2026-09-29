"use client";

/* Casca do admin do plantões: barra lateral (components/ui/sidebar, adaptada
   do 21st) no lugar da barra navy de 6 abas + menu ••• com 10 links.

     (topo)      Mesa · Histórico operacional
     Pagamento   Atesto diário · Fechamento mensal · Pendências de contrato · Alocação
     Horas       Banco de horas
     Auditoria   Relatório mensal · Auditoria de slots · Auditoria do atesto
     Pessoas     Médicos · Acesso de chefia · Monitor de acessos

   Mesma lógica do escala (escalas-e-trocas-samu/components/casca): navy nos
   dois temas, recolhe para trilho de ícones (lembrado no aparelho), tema e
   sair no rodapé. Quem pode ver cada tela continua sendo a própria tela —
   aqui só se decide onde cada uma mora. */

import {
    Activity,
    BarChart3,
    ClipboardCheck,
    FileSpreadsheet,
    FileWarning,
    History,
    Hourglass,
    KeyRound,
    LayoutDashboard,
    ListChecks,
    LogOut,
    Moon,
    ScanSearch,
    Split,
    Stethoscope,
    Sun,
    type LucideIcon,
} from "lucide-react";
import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import {
    Sidebar,
    SidebarFooter,
    SidebarHeader,
    SidebarItem,
    SidebarNav,
    SidebarSection,
    SidebarToggle,
    useSidebar,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

interface ItemNav {
    href: string;
    nome: string;
    icone: LucideIcon;
}

const GRUPOS: { rotulo: string | null; itens: ItemNav[] }[] = [
    {
        rotulo: null,
        itens: [
            { href: "/", nome: "Mesa", icone: LayoutDashboard },
            { href: "/?view=history", nome: "Histórico operacional", icone: History },
        ],
    },
    {
        rotulo: "Pagamento",
        itens: [
            { href: "/admin/payment-attestation", nome: "Atesto diário", icone: ClipboardCheck },
            { href: "/admin/payment-closing", nome: "Fechamento mensal", icone: FileSpreadsheet },
            { href: "/admin/payment-closing/pendencias-contrato", nome: "Pendências de contrato", icone: FileWarning },
            { href: "/admin/payment-allocation", nome: "Alocação", icone: Split },
        ],
    },
    { rotulo: "Horas", itens: [{ href: "/admin/bank-hours", nome: "Banco de horas", icone: Hourglass }] },
    {
        rotulo: "Auditoria",
        itens: [
            { href: "/admin/reports", nome: "Relatório mensal", icone: BarChart3 },
            { href: "/admin/slot-audit", nome: "Auditoria de slots", icone: ListChecks },
            { href: "/admin/payment-attestation/audit", nome: "Auditoria do atesto", icone: ScanSearch },
        ],
    },
    {
        rotulo: "Pessoas",
        itens: [
            { href: "/admin/medicos", nome: "Médicos", icone: Stethoscope },
            { href: "/admin/chief-access", nome: "Acesso de chefia", icone: KeyRound },
            { href: "/admin/acessos", nome: "Monitor de acessos", icone: Activity },
        ],
    },
];

/** Item aceso: prefixo mais longo ("/admin/payment-closing/pendencias-contrato"
    não acende "Fechamento"). A Mesa e o histórico ficam fora do /admin. */
function hrefAtivo(pathname: string): string | undefined {
    let melhor: string | undefined;
    for (const g of GRUPOS) {
        for (const { href } of g.itens) {
            if (!href.startsWith("/admin")) continue;
            if ((pathname === href || pathname.startsWith(`${href}/`)) && href.length > (melhor?.length ?? 0)) melhor = href;
        }
    }
    return melhor;
}

const DentroDaCasca = createContext(false);

/** true dentro da casca do admin: a barra do topo antiga vira cabeçalho enxuto. */
export function useDentroDaCasca() {
    return useContext(DentroDaCasca);
}

const CHAVE_RECOLHIDA = "plantoes:lateral-recolhida";

function Marca() {
    const { collapsed } = useSidebar();
    return (
        <div className="flex min-w-0 items-center gap-2.5">
            <span
                aria-hidden
                className="grid size-8 shrink-0 place-items-center rounded-lg bg-white/10 font-mono text-[10.5px] font-medium text-white ring-1 ring-white/15"
            >
                SAMU
            </span>
            {!collapsed ? (
                <span className="grid min-w-0 leading-tight">
                    <span className="truncate text-[13px] font-semibold text-white">Plantões</span>
                    <span className="truncate text-xs text-[color:var(--muted-foreground)]">SAMU 192 Salvador</span>
                </span>
            ) : null}
        </div>
    );
}

function useTema(): ["claro" | "escuro" | null, (t: "claro" | "escuro") => void] {
    const [tema, setTema] = useState<"claro" | "escuro" | null>(null);
    useEffect(() => {
        setTema(document.documentElement.dataset.tema === "escuro" ? "escuro" : "claro");
    }, []);
    function aplicar(t: "claro" | "escuro") {
        document.documentElement.dataset.tema = t;
        try {
            localStorage.setItem("kairos:tema", t);
        } catch {}
        setTema(t);
    }
    return [tema, aplicar];
}

function Rodape({ email, papel }: { email: string; papel: string }) {
    const { collapsed } = useSidebar();
    const [tema, aplicarTema] = useTema();
    async function sair() {
        await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
        window.location.href = "/entrar";
    }
    const botao =
        "flex size-8 items-center justify-center rounded-lg text-[color:var(--muted-foreground)] hover:bg-[color:var(--primitive-surface-hover)] hover:text-white";
    return (
        <>
            {!collapsed ? (
                <span className="grid min-w-0 flex-1 leading-tight">
                    <span className="truncate text-[12.5px] font-medium text-white" title={email}>
                        {email}
                    </span>
                    <span className="truncate text-[11px] text-[color:var(--muted-foreground)]">{papel}</span>
                </span>
            ) : null}
            <button
                type="button"
                className={botao}
                onClick={() => aplicarTema(tema === "escuro" ? "claro" : "escuro")}
                aria-label={tema === "escuro" ? "Usar o tema claro" : "Usar o tema escuro"}
                title={tema === "escuro" ? "Tema claro" : "Tema escuro"}
            >
                {tema === "escuro" ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            <button type="button" className={botao} onClick={sair} aria-label="Sair" title="Sair">
                <LogOut size={16} />
            </button>
        </>
    );
}

export function CascaAdmin({ children, email, papel }: { children: ReactNode; email: string; papel: string }) {
    const pathname = usePathname();
    const ativo = hrefAtivo(pathname);
    const [recolhida, setRecolhida] = useState(false);
    const [estreita, setEstreita] = useState(false);

    useEffect(() => {
        try {
            setRecolhida(localStorage.getItem(CHAVE_RECOLHIDA) === "1");
        } catch {}
        // celular: a lateral fica no trilho de ícones (não cabe aberta)
        const mq = window.matchMedia("(max-width: 760px)");
        const aplicar = () => setEstreita(mq.matches);
        aplicar();
        mq.addEventListener("change", aplicar);
        return () => mq.removeEventListener("change", aplicar);
    }, []);

    function lembrar(v: boolean) {
        setRecolhida(v);
        try {
            localStorage.setItem(CHAVE_RECOLHIDA, v ? "1" : "0");
        } catch {}
    }

    return (
        <DentroDaCasca.Provider value={true}>
            <div data-casca className="flex min-h-svh bg-[color:var(--casca-fundo)] print:block print:bg-transparent">
                <Sidebar
                    variant={estreita ? "icon-rail" : "collapsible"}
                    collapsed={recolhida}
                    onCollapsedChange={lembrar}
                    width={244}
                    collapsedWidth={60}
                    aria-label="Navegação do plantões"
                    className="casca-lateral sticky top-0 h-svh print:hidden"
                >
                    <SidebarHeader>
                        <Marca />
                        <SidebarToggle className="ml-auto" />
                    </SidebarHeader>
                    <SidebarNav>
                        {GRUPOS.map((g, i) => (
                            <SidebarSection key={g.rotulo ?? i} label={g.rotulo ?? undefined}>
                                {g.itens.map(({ href, nome, icone: Icone }) => (
                                    <SidebarItem
                                        key={href}
                                        href={href}
                                        label={nome}
                                        active={ativo === href}
                                        icon={<Icone className="size-[18px]" strokeWidth={1.75} />}
                                    >
                                        {nome}
                                    </SidebarItem>
                                ))}
                            </SidebarSection>
                        ))}
                    </SidebarNav>
                    <SidebarFooter>
                        <Rodape email={email} papel={papel} />
                    </SidebarFooter>
                </Sidebar>
                {/* folha: as telas antigas continuam como são, num bloco comum */}
                <div
                    className={cn(
                        "min-w-0 flex-1 bg-[color:var(--fundo-app)]",
                        "md:my-2 md:mr-2 md:rounded-xl print:m-0 print:rounded-none",
                    )}
                >
                    {children}
                </div>
            </div>
        </DentroDaCasca.Provider>
    );
}

/** Cabeçalho enxuto da tela dentro da casca: o título (h1 quando a tela não
    tem outro) e as ações da tela à direita. Sem abas, sem tema, sem faixa navy. */
export function CabecalhoDaCasca({ titulo, extra, comoH1 }: { titulo: string; extra?: ReactNode; comoH1?: boolean }) {
    const Titulo = comoH1 ? "h1" : "span";
    return (
        <header data-casca className="flex min-h-14 items-center gap-3 border-b border-borda bg-superficie px-5 print:hidden">
            <Titulo className="m-0 text-[17px] leading-tight font-bold tracking-tight text-texto-forte">{titulo}</Titulo>
            <span className="flex-1" />
            {extra}
        </header>
    );
}
