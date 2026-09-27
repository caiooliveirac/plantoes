import { redirect } from "next/navigation";
import { KairosTopo } from "@/components/kairos-topo";
import { readAuthenticatedSession } from "@/lib/auth/server";
import { LoginLocal } from "@/app/entrar/login-local";
import "@/app/auth-pages.css";

export const dynamic = "force-dynamic";

/**
 * Porta de emergência do quadro (lib/auth/portao.ts): login local por e-mail e
 * senha, para quando o porteiro do portal estiver fora. Com sessão, segue o
 * atalho antigo — abre a mesa com o popover de login (troca de senha provisória).
 */
export default async function EntrarPage() {
    const session = await readAuthenticatedSession();
    if (session) redirect("/?entrar=1");
    return (
        <div className="pagina-kairos">
        <KairosTopo titulo="Mesa operacional" />
        <main className="et-shell" style={{ alignItems: "center", justifyContent: "center" }}>
            <LoginLocal />
        </main>
        </div>
    );
}
