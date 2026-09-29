import type { ReactNode } from "react";
import { CascaDaSessao } from "@/components/casca/casca-da-sessao";
import { readAuthenticatedSession } from "@/lib/auth/server";

/* Casca do admin: barra lateral no lugar da barra navy de abas. Sem sessão
   não há navegação a mostrar — a própria tela diz "Autenticação necessária". */

export default async function AdminLayout({ children }: { children: ReactNode }) {
    const sessao = await readAuthenticatedSession().catch(() => null);
    if (!sessao) return <>{children}</>;
    return (
        <CascaDaSessao email={sessao.user.email} roles={sessao.user.roles}>
            {children}
        </CascaDaSessao>
    );
}
