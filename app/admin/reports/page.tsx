import { hasDatabaseUrl } from "@/db";
import { ABAS_ADMIN, KairosTopo } from "@/components/kairos-topo";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { MonthlyReportClient } from "@/app/admin/reports/monthly-report-client";
import { AdminGlobalNavigationLinks } from "@/components/admin-global-navigation-links";
import { getMonthlyAdminReport } from "@/services/monthly-report.service";

export const dynamic = "force-dynamic";

function ReportsUnavailable({ title, copy }: { title: string; copy: string }) {
    return (
        <div className="pagina-kairos">
        <KairosTopo titulo="Relatórios" abas={ABAS_ADMIN} />
        <main className="reports-shell">
            <section className="reports-empty-state standalone">
                <strong>{title}</strong>
                <span>{copy}</span>
                <AdminGlobalNavigationLinks current="reports" />
            </section>
        </main>
        </div>
    );
}

export default async function AdminReportsPage({
    searchParams,
}: {
    searchParams: Promise<{ month?: string }>;
}) {
    if (!hasDatabaseUrl()) {
        return <ReportsUnavailable title="Banco indisponível" copy="Sem DATABASE_URL não existe consolidado mensal para auditoria." />;
    }

    try {
        await requireAuthenticatedSession(["admin"]);
    } catch (error) {
        if (error instanceof AuthError) {
            return (
                <ReportsUnavailable
                    title={error.status === 403 ? "Acesso restrito" : "Autenticação necessária"}
                    copy={error.message}
                />
            );
        }

        throw error;
    }

    const { month } = await searchParams;
    const report = await getMonthlyAdminReport(month);

    return <MonthlyReportClient report={report} />;
}