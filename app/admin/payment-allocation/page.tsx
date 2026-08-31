import { hasDatabaseUrl } from "@/db";
import { ABAS_ADMIN, KairosTopo } from "@/components/kairos-topo";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { PaymentAllocationClient } from "@/app/admin/payment-allocation/payment-allocation-client";
import { AdminGlobalNavigationLinks } from "@/components/admin-global-navigation-links";
import { getPaymentAllocationBoard } from "@/services/board.service";
import { listDoctorsForChiefInvite } from "@/services/chief-access.service";

export const dynamic = "force-dynamic";

function PaymentAllocationUnavailable({ title, copy }: { title: string; copy: string }) {
    return (
        <div className="pagina-kairos">
        <KairosTopo titulo="Alocação de pagamento" abas={ABAS_ADMIN} />
        <main className="payment-shell">
            <section className="payment-empty-state standalone large">
                <strong>{title}</strong>
                <span>{copy}</span>
                <AdminGlobalNavigationLinks current="payment-allocation" containerClassName="payment-actions split" />
            </section>
        </main>
        </div>
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