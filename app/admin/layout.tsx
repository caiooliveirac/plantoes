import type { ReactNode } from "react";
import { CascaAdmin } from "@/components/casca/casca-admin";
import { readAuthenticatedSession } from "@/lib/auth/server";

/* Casca do admin: barra lateral no lugar da barra navy de abas. Sem sessão
   não há navegação a mostrar — a própria tela diz "Autenticação necessária". */

const PAPEL: Record<string, string> = {
    admin: "Administração",
    chief: "Chefia",
    doctor: "Médico",
    payment_closing_limited: "Fechamento (NF/processo)",
    radio_operador: "Rádio-operador",
    tarm: "TARM",
};

export default async function AdminLayout({ children }: { children: ReactNode }) {
    const sessao = await readAuthenticatedSession().catch(() => null);
    if (!sessao) return <>{children}</>;
    const papel = sessao.user.roles.filter((r) => r !== "portal").map((r) => PAPEL[r] ?? r).join(" · ");
    return (
        <CascaAdmin email={sessao.user.email} papel={papel}>
            {children}
        </CascaAdmin>
    );
}
