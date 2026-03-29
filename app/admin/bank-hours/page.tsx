import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { BankHoursHistoryClient } from "@/app/admin/bank-hours/bank-hours-history-client";
import { getBankHoursHistory } from "@/services/bank-hours-history.service";

export const dynamic = "force-dynamic";

function BankHoursUnavailable({ title, copy }: { title: string; copy: string }) {
    return (
        <main className="hours-shell">
            <section className="hours-empty-state standalone">
                <strong>{title}</strong>
                <span>{copy}</span>
                <div className="hours-empty-actions">
                    <a className="reports-secondary-link" href="/">Voltar ao quadro</a>
                    <a className="reports-secondary-link" href="/admin/reports">Abrir auditoria mensal</a>
                </div>
            </section>
        </main>
    );
}

export default async function AdminBankHoursPage() {
    if (!hasDatabaseUrl()) {
        return <BankHoursUnavailable title="Banco indisponível" copy="Sem DATABASE_URL não existe histórico de banco de horas para consulta gerencial." />;
    }

    try {
        await requireAuthenticatedSession(["admin", "chief"]);
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

    const history = await getBankHoursHistory();
    return <BankHoursHistoryClient history={history} />;
}