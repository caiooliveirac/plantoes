import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { PaymentAllocationClient } from "@/app/admin/payment-allocation/payment-allocation-client";
import { getPaymentAllocationBoard } from "@/services/board.service";
import { listDoctorsForChiefInvite } from "@/services/chief-access.service";

export const dynamic = "force-dynamic";

function PaymentAllocationUnavailable({ title, copy }: { title: string; copy: string }) {
    return (
        <main className="payment-shell">
            <section className="payment-empty-state standalone large">
                <strong>{title}</strong>
                <span>{copy}</span>
                <div className="payment-actions split">
                    <a className="reports-secondary-link" href="/">Voltar ao quadro</a>
                    <a className="reports-secondary-link" href="/admin/bank-hours">Abrir banco de horas</a>
                </div>
            </section>
        </main>
    );
}

export default async function AdminPaymentAllocationPage() {
    if (!hasDatabaseUrl()) {
        return <PaymentAllocationUnavailable title="Banco indisponível" copy="Sem DATABASE_URL não existe base para montar a alocação de pagamento do turno." />;
    }

    try {
        await requireAuthenticatedSession(["admin"]);
    } catch (error) {
        if (error instanceof AuthError) {
            return (
                <PaymentAllocationUnavailable
                    title={error.status === 403 ? "Acesso restrito" : "Autenticação necessária"}
                    copy={error.message}
                />
            );
        }

        throw error;
    }

    const [initialBoard, doctors] = await Promise.all([
        getPaymentAllocationBoard(),
        listDoctorsForChiefInvite(),
    ]);

    return <PaymentAllocationClient initialBoard={initialBoard} doctors={doctors} />;
}