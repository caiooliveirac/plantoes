import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { ChiefPaymentViewClient } from "@/app/admin/payment-attestation/chief-payment-view-client";
import { getChiefPayableShiftsBoard } from "@/services/payable-shifts.service";

export const dynamic = "force-dynamic";

function PaymentClosingUnavailable({ title, copy }: { title: string; copy: string }) {
    return (
        <main className="chief-payable-shell">
            <section className="payment-empty-state standalone large">
                <strong>{title}</strong>
                <span>{copy}</span>
                <div className="payment-actions split">
                    <a className="reports-secondary-link" href="/admin/payment-attestation">Abrir atesto turno a turno</a>
                    <a className="reports-secondary-link" href="/admin/reports">Abrir auditoria mensal</a>
                </div>
            </section>
        </main>
    );
}

export default async function AdminPaymentClosingPage({
    searchParams,
}: {
    searchParams: Promise<{ month?: string }>;
}) {
    if (!hasDatabaseUrl()) {
        return <PaymentClosingUnavailable title="Banco indisponível" copy="Sem DATABASE_URL não existe base para fechar e atestar o pagamento do turno." />;
    }

    try {
        await requireAuthenticatedSession(["admin"]);
    } catch (error) {
        if (error instanceof AuthError) {
            return (
                <PaymentClosingUnavailable
                    title={error.status === 403 ? "Acesso restrito" : "Autenticação necessária"}
                    copy={error.message}
                />
            );
        }

        throw error;
    }

    const { month } = await searchParams;
    const board = await getChiefPayableShiftsBoard(month ?? null);

    return <ChiefPaymentViewClient board={board} />;
}
