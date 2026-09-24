import { redirect } from "next/navigation";
import { KairosTopo } from "@/components/kairos-topo";
import { readAuthenticatedSession } from "@/lib/auth/server";
import "@/app/auth-pages.css";

/**
 * Porta de entrada do médico logado: resolve o mês atual (fuso SP) e manda para
 * o painel dele (/banco-de-horas/[medicoId]/[ano]/[mes]) ou para a folha de
 * ponto (/folha-ponto/…) — as mesmas páginas que o bot já entrega por link
 * assinado, agora acessíveis por login. Endereços curtos: /banco-de-horas e
 * /medico (banco), /folha-ponto e /medico/folha-ponto (folha). Sem sessão,
 * vão ao login do portal mnrs.com.br, que devolve a pessoa aqui já logada.
 */
export async function portaDoMedico(destino: "banco-de-horas" | "folha-ponto") {
    const session = await readAuthenticatedSession();
    if (!session) {
        // Login único: entra no portal e volta direto para cá (porteiro → SSO
        // → /medico ou /medico/folha-ponto). Ver kairos ADR 0013.
        redirect(`https://mnrs.com.br/?proximo=${destino === "folha-ponto" ? "folha-ponto" : "banco-horas"}`);
    }
    if (!session.user.doctorId) {
        return (
            <div className="pagina-kairos">
            <KairosTopo titulo="Área do médico" />
            <main className="et-shell" style={{ alignItems: "center", justifyContent: "center" }}>
                <section className="et-panel" style={{ width: "min(480px, 100%)" }}>
                    <div className="et-panel-head"><h2>Painel do médico</h2></div>
                    <div className="et-empty-state">
                        <strong>Sua conta não está vinculada a um médico.</strong>
                        <p>
                            Contas de admin/chefia sem vínculo com a escala não têm painel
                            individual. Se você dá plantões, fale com a coordenação para
                            vincular seu cadastro.
                        </p>
                    </div>
                </section>
            </main>
            </div>
        );
    }

    // Mês corrente no fuso de São Paulo (todos os timestamps do banco são UTC).
    const spNow = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Sao_Paulo",
        year: "numeric",
        month: "2-digit",
    }).format(new Date());
    const [ano, mes] = spNow.split("-");
    redirect(`/${destino}/${session.user.doctorId}/${ano}/${Number(mes)}`);
}
