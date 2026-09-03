import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { BankHoursHistoryClient } from "@/app/admin/bank-hours/bank-hours-history-client";
import { AdminGlobalNavigationLinks } from "@/components/admin-global-navigation-links";
import { getBankHoursHistory } from "@/services/bank-hours-history.service";
import { resolveMonthlyReportRange } from "@/modules/reporting/monthly-report";

export const dynamic = "force-dynamic";

function BankHoursUnavailable({ title, copy }: { title: string; copy: string }) {
    return (
        <div className="pagina-kairos">
            <main className="hours-shell">
                <section className="hours-empty-state standalone">
                    <strong>{title}</strong>
                    <span>{copy}</span>
                    <AdminGlobalNavigationLinks current="bank-hours" containerClassName="hours-empty-actions" />
                </section>
            </main>
        </div>
    );
}

export default async function AdminBankHoursPage({
    searchParams,
}: {
    searchParams: Promise<{ month?: string }>;
}) {
    if (!hasDatabaseUrl()) {
        return <BankHoursUnavailable title="Banco indisponível" copy="Sem DATABASE_URL não existe histórico de banco de horas para consulta gerencial." />;
    }

    let session;
    try {
        session = await requireAuthenticatedSession(["admin"]);
    } catch (error) {
        if (error instanceof AuthError) {
            return (
                <BankHoursUnavailable
                    title={error.status === 403 ? "Acesso restrito" : "Autenticação necessária"}
                    copy={error.message}
                />
            );
        }

        throw error;
    }

    const { month } = await searchParams;
    const history = await getBankHoursHistory();
    // Meses de fechamento onde o acerto (plantão verde/vermelho) pode ser lançado:
    // do mês corrente até abril/2026, igual ao seletor do payment-closing.
    const range = resolveMonthlyReportRange(month ?? null);
    return (
        <BankHoursHistoryClient
            history={history}
            canManageOverrides={Boolean(session?.user.roles.includes("admin"))}
            settlementMonths={range.presetMonths}
            // De cara a vida inteira; ?month=AAAA-MM (vindo de um link) foca um mês.
            initialMonthKey={month ? range.monthKey : "all"}
            currentMonthKey={resolveMonthlyReportRange(null).monthKey}
        />
    );
}
