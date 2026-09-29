import "@/app/admin/acessos/acessos.css";
import { ExtratorDeCaso } from "@/app/admin/extrator-caso/extrator-client";
import { ABAS_ADMIN, KairosTopo } from "@/components/kairos-topo";
import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { resolveMonthlyReportRange } from "@/modules/reporting/monthly-report";
import { listarMedicosDoExtrator } from "@/services/extrator-caso.service";

export const dynamic = "force-dynamic";

/* Extrator de caso (docs/extrator-caso.md): pagamento e banco de horas de um
   médico num mês, sem nome, unidade nem data, para colar numa sessão de IA. */
export default async function ExtratorDeCasoPage() {
    if (!hasDatabaseUrl()) return null;
    try {
        await requireAuthenticatedSession(["admin"]);
    } catch (error) {
        if (error instanceof AuthError) {
            return (
                <div className="pagina-kairos">
                    <KairosTopo titulo="Extrator de caso" abas={ABAS_ADMIN} />
                    <main className="ac-shell"><div className="ac-conteudo"><section className="ac-card"><h1>Acesso restrito</h1></section></div></main>
                </div>
            );
        }
        throw error;
    }

    const medicos = await listarMedicosDoExtrator();
    const meses = resolveMonthlyReportRange(null).presetMonths;

    return (
        <div className="pagina-kairos">
            <KairosTopo titulo="Extrator de caso" abas={ABAS_ADMIN} />
            <main className="ac-shell">
                <div className="ac-conteudo">
                    <section className="ac-card">
                        <h1>Extrator de caso</h1>
                        <p className="ac-sub">
                            Pagamento e banco de horas de um médico num mês, com a prova e a trilha de cada plantão. O texto sai sem
                            nome, e-mail, unidade nem data: pessoa vira pseudônimo, dia vira posição no mês. A legenda que desfaz a
                            troca aparece só aqui e não entra no texto copiado. Cada extração fica registrada.
                        </p>
                    </section>
                    <ExtratorDeCaso medicos={medicos} meses={meses} />
                </div>
            </main>
        </div>
    );
}
