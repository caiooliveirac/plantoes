"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { AdminGlobalNavigationLinks, type AdminNavKey } from "@/components/admin-global-navigation-links";

interface AdminBarNavMenuProps {
    current?: AdminNavKey;
    /** Itens extras (ex.: auditoria técnica) anexados ao fim do menu. */
    children?: ReactNode;
}

/** Botão ••• da faixa de comando admin: dropdown com a navegação global. */
export function AdminBarNavMenu({ current, children }: AdminBarNavMenuProps) {
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!open) {
            return;
        }
        const onPointerDown = (event: PointerEvent) => {
            if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
                setOpen(false);
            }
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                setOpen(false);
            }
        };
        window.addEventListener("pointerdown", onPointerDown);
        window.addEventListener("keydown", onKeyDown);
        return () => {
            window.removeEventListener("pointerdown", onPointerDown);
            window.removeEventListener("keydown", onKeyDown);
        };
    }, [open]);

    return (
        <div className="admin-bar-menu" ref={rootRef}>
            <button
                type="button"
                className="admin-bar-menu-toggle"
                onClick={() => setOpen((prev) => !prev)}
                aria-haspopup="menu"
                aria-expanded={open}
                title="Navegação admin"
            >
                •••
            </button>
            {open ? (
                <div className="admin-bar-menu-panel">
                    <AdminGlobalNavigationLinks current={current} variant="menu" containerClassName="admin-bar-menu-list">
                        {children}
                    </AdminGlobalNavigationLinks>
                </div>
            ) : null}
        </div>
    );
}
