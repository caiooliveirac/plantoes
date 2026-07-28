import type { ReactNode } from "react";

export type AdminNavKey =
    | "payment-attestation"
    | "payment-closing"
    | "payment-allocation"
    | "reports"
    | "slot-audit"
    | "bank-hours"
    | "chief-access"
    | "history"
    | "board";

const ADMIN_NAV_ITEMS: Array<{ key: AdminNavKey; href: string; label: string }> = [
    { key: "payment-attestation", href: "/admin/payment-attestation", label: "Abrir atesto diario" },
    { key: "payment-closing", href: "/admin/payment-closing", label: "Abrir fechamento mensal" },
    { key: "payment-allocation", href: "/admin/payment-allocation", label: "Ajustar alocacao" },
    { key: "reports", href: "/admin/reports", label: "Abrir auditoria mensal" },
    { key: "slot-audit", href: "/admin/slot-audit", label: "Abrir auditoria de slots" },
    { key: "bank-hours", href: "/admin/bank-hours", label: "Abrir banco de horas" },
    { key: "chief-access", href: "/admin/chief-access", label: "Abrir acesso de chefia" },
    { key: "history", href: "/?view=history", label: "Abrir historico operacional" },
    { key: "board", href: "/", label: "Voltar ao quadro" },
];

interface AdminGlobalNavigationLinksProps {
    current?: AdminNavKey;
    containerClassName?: string;
    children?: ReactNode;
    /** "links" = pills soltas (padrão); "menu" = itens compactos para dropdown (ex.: botão •••). */
    variant?: "links" | "menu";
}

export function AdminGlobalNavigationLinks({
    current,
    containerClassName = "reports-hero-actions",
    children,
    variant = "links",
}: AdminGlobalNavigationLinksProps) {
    return (
        <div className={containerClassName} role={variant === "menu" ? "menu" : undefined}>
            {ADMIN_NAV_ITEMS.map((item) => {
                const active = item.key === current;
                const className = variant === "menu"
                    ? `admin-nav-menu-link ${active ? "active" : ""}`.trim()
                    : (active ? "reports-primary-link" : "reports-secondary-link");
                return (
                    <a
                        key={item.key}
                        className={className}
                        href={item.href}
                        role={variant === "menu" ? "menuitem" : undefined}
                        aria-current={active ? "page" : undefined}
                    >
                        {item.label}
                    </a>
                );
            })}
            {children}
        </div>
    );
}
