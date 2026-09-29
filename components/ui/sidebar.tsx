"use client";

/* Barra lateral — adaptada do componente "Sidebar" de wensity no 21st.dev
   (https://21st.dev/@wensity/components/sidebar). Mantidos: seções com rótulo,
   item com selo, rodapé, trilho de ícones ao recolher e a pílula do item ativo
   que desliza entre itens. Adaptações para o plantões: ícones lucide (o repo
   já usa; o original trazia @tabler/icons-react), <Link> do Next no lugar de
   <a> (navegação sem recarregar), sem @base-ui (asChild não é usado aqui), só
   as variantes "collapsible" e "icon-rail", textos em português.

   Cores por variável (--background, --foreground, --border,
   --muted-foreground, --primitive-*): quem usa define — a casca do admin
   (components/casca) pinta navy, como a barra antiga. */

import * as React from "react";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { cn } from "@/lib/utils";

export type SidebarVariant = "collapsible" | "icon-rail";

type SidebarContextValue = {
    variant: SidebarVariant;
    collapsed: boolean;
    toggleCollapsed: () => void;
    navId: string;
};

const SidebarContext = React.createContext<SidebarContextValue | null>(null);

function useSidebarContext() {
    const ctx = React.useContext(SidebarContext);
    if (!ctx) throw new Error("As peças da barra lateral precisam estar dentro de <Sidebar>");
    return ctx;
}

/** Estado da barra (recolhida ou não) para cabeçalho/rodapé reagirem. */
export function useSidebar() {
    const { variant, collapsed, toggleCollapsed } = useSidebarContext();
    return { variant, collapsed, toggleCollapsed };
}

const EASE_OUT: [number, number, number, number] = [0.23, 1, 0.32, 1];

const itemBase = cn(
    "group/sidebar-item relative flex w-full items-center gap-2.5 rounded-[0.625rem] px-3 py-[7px]",
    "text-[13.5px] font-medium leading-none outline-none select-none whitespace-nowrap",
    "transition-colors duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]",
    "focus-visible:ring-2 focus-visible:ring-[color:var(--primitive-ring)]",
);
const itemInativo = cn(
    "text-[color:var(--primitive-text-secondary)]",
    "hover:text-[var(--foreground)] hover:bg-[color:var(--primitive-surface-hover)]",
);
const itemAtivo = "text-[var(--foreground)]";
const pilulaAtiva = "pointer-events-none absolute inset-0 rounded-[0.625rem] bg-[color:var(--primitive-surface-selected)]";

export interface SidebarProps extends Omit<React.HTMLAttributes<HTMLElement>, "onChange"> {
    variant?: SidebarVariant;
    collapsed?: boolean;
    defaultCollapsed?: boolean;
    onCollapsedChange?: (collapsed: boolean) => void;
    /** Largura aberta, em px. */
    width?: number;
    /** Largura recolhida (trilho), em px. */
    collapsedWidth?: number;
    "aria-label"?: string;
    children: React.ReactNode;
}

export const Sidebar = React.forwardRef<HTMLElement, SidebarProps>(
    (
        {
            variant = "collapsible",
            collapsed: controlado,
            defaultCollapsed = false,
            onCollapsedChange,
            width = 240,
            collapsedWidth = 60,
            className,
            children,
            "aria-label": ariaLabel = "Navegação",
            style,
            ...props
        },
        ref,
    ) => {
        const reactId = React.useId();
        const reduzir = useReducedMotion();
        const [interno, setInterno] = React.useState(defaultCollapsed);
        const ehControlado = controlado !== undefined;
        const collapsed = variant === "icon-rail" ? true : ehControlado ? controlado : interno;

        const toggleCollapsed = React.useCallback(() => {
            if (variant !== "collapsible") return;
            const proximo = !collapsed;
            if (!ehControlado) setInterno(proximo);
            onCollapsedChange?.(proximo);
        }, [variant, collapsed, ehControlado, onCollapsedChange]);

        const ctx = React.useMemo<SidebarContextValue>(
            () => ({ variant, collapsed, toggleCollapsed, navId: `sidebar-${reactId}` }),
            [variant, collapsed, toggleCollapsed, reactId],
        );

        return (
            <SidebarContext.Provider value={ctx}>
                <nav
                    ref={ref}
                    aria-label={ariaLabel}
                    data-slot="sidebar"
                    data-collapsed={collapsed ? "true" : "false"}
                    style={{
                        ...style,
                        width: collapsed ? collapsedWidth : width,
                        flexShrink: 0,
                        transition: reduzir ? "none" : "width 240ms cubic-bezier(0.23,1,0.32,1)",
                    }}
                    className={cn(
                        "relative isolate flex h-full flex-col overflow-hidden",
                        "bg-[var(--background)] text-[var(--foreground)] border-r border-[var(--border)]",
                        className,
                    )}
                    {...props}
                >
                    {children}
                </nav>
            </SidebarContext.Provider>
        );
    },
);
Sidebar.displayName = "Sidebar";

function RotuloQueSome({ show, className, children }: { show: boolean; className?: string; children: React.ReactNode }) {
    const reduzir = useReducedMotion();
    return (
        <AnimatePresence initial={false}>
            {show && (
                <motion.span
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: reduzir ? 0 : 0.12, ease: EASE_OUT }}
                    className={className}
                >
                    {children}
                </motion.span>
            )}
        </AnimatePresence>
    );
}

export function SidebarHeader({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
    const { collapsed } = useSidebarContext();
    // recolhida, o botão de recolher não cabe: some, e a marca continua
    const visiveis = collapsed
        ? React.Children.toArray(children).filter((c) => !(React.isValidElement(c) && c.type === SidebarToggle))
        : children;
    return (
        <div
            data-slot="sidebar-header"
            className={cn(
                "flex shrink-0 items-center",
                collapsed ? "flex-col justify-center gap-2 px-0 py-3" : "h-[56px] gap-2.5 px-[16px]",
                className,
            )}
            {...props}
        >
            {visiveis}
        </div>
    );
}

export function SidebarNav({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
    const { navId } = useSidebarContext();
    return (
        <div
            id={navId}
            data-slot="sidebar-nav"
            className={cn("min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-y-contain py-2", className)}
            {...props}
        >
            {children}
        </div>
    );
}

export function SidebarSection({
    className,
    label,
    children,
    ...props
}: React.HTMLAttributes<HTMLDivElement> & { label?: string }) {
    const { collapsed } = useSidebarContext();
    return (
        <div data-slot="sidebar-section" role="group" aria-label={label} className={cn("py-1", className)} {...props}>
            {label && (
                <div className="flex h-[26px] items-end px-[18px] pb-1.5">
                    <RotuloQueSome
                        show={!collapsed}
                        className="text-[11px] font-semibold leading-none text-[var(--muted-foreground)] whitespace-nowrap"
                    >
                        {label}
                    </RotuloQueSome>
                </div>
            )}
            <div className="flex flex-col gap-px px-2">{children}</div>
        </div>
    );
}

function PilulaAtiva({ navId }: { navId: string }) {
    const reduzir = useReducedMotion();
    if (reduzir) return <span aria-hidden="true" className={pilulaAtiva} />;
    return (
        <motion.span
            aria-hidden="true"
            layoutId={`${navId}-pilula-ativa`}
            transition={{ type: "spring", stiffness: 520, damping: 42 }}
            className={pilulaAtiva}
        />
    );
}

export interface SidebarItemProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    icon?: React.ReactNode;
    active?: boolean;
    /** Com href vira <Link> do Next (navegação sem recarregar). */
    href?: string;
    badge?: React.ReactNode;
    /** Rótulo para a dica e o leitor de tela quando a barra está recolhida. */
    label?: string;
}

export function SidebarItem({ className, icon, active = false, href, badge, label, children, ...props }: SidebarItemProps) {
    const { collapsed, navId } = useSidebarContext();
    const classes = cn(itemBase, active ? itemAtivo : itemInativo, className);
    const title = collapsed ? label ?? (typeof children === "string" ? children : undefined) : undefined;
    const conteudo = (
        <>
            {active ? <PilulaAtiva navId={navId} /> : null}
            {icon ? (
                <span
                    data-slot="sidebar-item-icon"
                    className={cn(
                        "relative z-10 flex size-5 shrink-0 items-center justify-center",
                        active
                            ? "text-[color:var(--primitive-icon-active)]"
                            : "text-[var(--muted-foreground)] transition-colors duration-150 group-hover/sidebar-item:text-[var(--foreground)]",
                    )}
                >
                    {icon}
                </span>
            ) : null}
            <RotuloQueSome show={!collapsed} className="relative z-10 min-w-0 flex-1 truncate text-left">
                {children}
            </RotuloQueSome>
            {badge ? (
                <RotuloQueSome show={!collapsed} className="relative z-10 flex shrink-0 items-center">
                    {badge}
                </RotuloQueSome>
            ) : null}
            {badge && collapsed ? (
                <span aria-hidden className="absolute top-1 right-1.5 z-10 size-2 rounded-full bg-[color:var(--primitive-dot)]" />
            ) : null}
        </>
    );
    if (href) {
        return (
            <Link
                href={href}
                data-slot="sidebar-item"
                data-active={active ? "true" : undefined}
                aria-current={active ? "page" : undefined}
                aria-label={collapsed ? title : undefined}
                title={title}
                className={classes}
            >
                {conteudo}
            </Link>
        );
    }
    return (
        <button
            type="button"
            data-slot="sidebar-item"
            data-active={active ? "true" : undefined}
            aria-current={active ? "page" : undefined}
            aria-label={collapsed ? title : undefined}
            title={title}
            className={classes}
            {...props}
        >
            {conteudo}
        </button>
    );
}

export function SidebarFooter({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
    const { collapsed } = useSidebarContext();
    return (
        <div
            data-slot="sidebar-footer"
            className={cn(
                "flex shrink-0 items-center py-3 border-t border-[var(--border)]",
                collapsed ? "flex-col justify-center gap-2 px-0" : "gap-2.5 px-[16px]",
                className,
            )}
            {...props}
        >
            {children}
        </div>
    );
}

export function SidebarToggle({ className, ...props }: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children">) {
    const { collapsed, toggleCollapsed, variant } = useSidebarContext();
    if (variant !== "collapsible") return null;
    return (
        <button
            type="button"
            data-slot="sidebar-toggle"
            onClick={toggleCollapsed}
            aria-label={collapsed ? "Abrir a barra lateral" : "Recolher a barra lateral"}
            aria-expanded={!collapsed}
            title={collapsed ? "Abrir a barra lateral" : "Recolher a barra lateral"}
            className={cn(
                "flex size-7 shrink-0 items-center justify-center rounded-[0.625rem] outline-none",
                "text-[var(--muted-foreground)] hover:bg-[color:var(--primitive-surface-hover)] hover:text-[var(--foreground)]",
                "focus-visible:ring-2 focus-visible:ring-[color:var(--primitive-ring)]",
                className,
            )}
            {...props}
        >
            {collapsed ? <PanelLeftOpen className="size-[17px]" strokeWidth={1.75} /> : <PanelLeftClose className="size-[17px]" strokeWidth={1.75} />}
        </button>
    );
}
