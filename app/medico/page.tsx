import { redirect } from "next/navigation";
import { readAuthenticatedSession } from "@/lib/auth/server";
import "@/app/auth-pages.css";

export const dynamic = "force-dynamic";

/**
 * Porta de entrada do médico logado: resolve o mês atual (fuso SP) e manda para
 * o painel dele (/banco-de-horas/[medicoId]/[ano]/[mes]) — a mesma página que o
 * bot já entrega por link assinado, agora acessível por login.
 */
export default async function MedicoHomePage() {
    const session = await readAuthenticatedSession();
    if (!session) {
        redirect("/");
    }
    if (!session.user.doctorId) {
        return (
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
        );
    }

    // Mês corrente no fuso de São Paulo (todos os timestamps do banco são UTC).
    const spNow = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Sao_Paulo",
        year: "numeric",
        month: "2-digit",
    }).format(new Date());
    const [ano, mes] = spNow.split("-");
    redirect(`/banco-de-horas/${session.user.doctorId}/${ano}/${Number(mes)}`);
}
