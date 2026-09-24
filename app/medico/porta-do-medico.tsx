import { redirect } from "next/navigation";
import { KairosTopo } from "@/components/kairos-topo";
import { readAuthenticatedSession } from "@/lib/auth/server";
import "@/app/auth-pages.css";

/**
 * Porta de entrada do médico logado: resolve o mês atual (fuso SP) e manda para
 * o painel dele (/banco-de-horas/[medicoId]/[ano]/[mes]) ou para a folha de
 * ponto (/folha-ponto/…) — as mesmas páginas que o bot já entrega por link
 * assinado, agora acessíveis por login. Endereços curtos: /medico, /folha-ponto
 * e /medico/folha-ponto (painel, topo) e /banco-de-horas (painel, na seção do
 * banco). Sem sessão, vão ao login do portal mnrs.com.br, que devolve a pessoa
 * aqui já logada.
 */
/* Para onde cada porta leva, dentro do Painel do médico (o link do /pagamento
   do bot): "painel" = topo (pagamento do mês e, logo abaixo, a folha de ponto
   para gerar — o médico confere antes de emitir); "banco-de-horas" = o mesmo
   painel já na seção dos extras e do saldo. O PDF da folha
   (/folha-ponto/<médico>/<ano>/<mês>) sai do botão "Gerar" do painel. */
export type PortaDoMedico = "painel" | "banco-de-horas";

export async function portaDoMedico(destino: PortaDoMedico) {
    const session = await readAuthenticatedSession();
    if (!session) {
        // Login único (kairos ADR 0013): o endereço curto do portal decide no
        // servidor — com o login do portal, volta para cá já logado sem mostrar
        // tela nenhuma (porteiro → SSO); sem ele, abre o login do portal.
        redirect(`https://mnrs.com.br/${destino === "painel" ? "folha-ponto" : "banco-de-horas"}`);
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
    const ancora = destino === "banco-de-horas" ? "#banco-de-horas" : "";
    redirect(`/banco-de-horas/${session.user.doctorId}/${ano}/${Number(mes)}${ancora}`);
}
