import "@/app/admin/acessos/acessos.css";
import { LancarPlantao } from "@/app/admin/lancar-plantao/lancar-plantao-client";
import { ABAS_ADMIN, KairosTopo } from "@/components/kairos-topo";
import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { listarMedicosDoExtrator } from "@/services/extrator-caso.service";
import { listManualShiftTargets } from "@/services/admin-manual-shift.service";

export const dynamic = "force-dynamic";

/* Lançar plantão passado (qualquer médico, titular ou sombra) com prévia do banco de horas. */
export default async function LancarPlantaoPage() {
    if (!hasDatabaseUrl()) return null;
    try {
        await requireAuthenticatedSession(["admin"]);
    } catch (error) {
        if (error instanceof AuthError) {
            return (
                <div className="pagina-kairos">
                    <KairosTopo titulo="Lançar plantão" abas={ABAS_ADMIN} />
                    <main className="ac-shell"><div className="ac-conteudo"><section className="ac-card"><h1>Acesso restrito</h1></section></div></main>
                </div>
            );
        }
        throw error;
    }

    const [medicos, alvos] = await Promise.all([listarMedicosDoExtrator(), listManualShiftTargets()]);

    return (
        <div className="pagina-kairos">
            <KairosTopo titulo="Lançar plantão" abas={ABAS_ADMIN} />
            <main className="ac-shell">
                <div className="ac-conteudo">
                    <section className="ac-card">
                        <h1>Lançar plantão passado</h1>
                        <p className="ac-sub">
                            Registra chegada e saída de um plantão já cumprido — como titular ou sombra, em qualquer ramal ou base.
                            Antes de gravar, mostra quanto o banco de horas vai ganhar ou perder. Passa pelos mesmos serviços do painel
                            (banco de horas, continuidade e auditoria).
                        </p>
                    </section>
                    <LancarPlantao medicos={medicos} alvos={alvos} />
                </div>
            </main>
        </div>
    );
}
