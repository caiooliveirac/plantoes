import { hasDatabaseUrl } from "@/db";
import { ABAS_ADMIN, KairosTopo } from "@/components/kairos-topo";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { PaymentAttestationClient } from "@/app/admin/payment-attestation/payment-attestation-client";
import { AdminGlobalNavigationLinks } from "@/components/admin-global-navigation-links";
import { getPaymentAttestationSlotView } from "@/services/payment-attestation.service";

export const dynamic = "force-dynamic";

function PaymentAttestationUnavailable({ title, copy }: { title: string; copy: string }) {
    return (
        <div className="pagina-kairos">
        <KairosTopo titulo="Auditoria da atestação" abas={ABAS_ADMIN} />
        <main className="payment-shell">
            <section className="payment-empty-state standalone large">
                <strong>{title}</strong>
                <span>{copy}</span>
                <AdminGlobalNavigationLinks current="payment-attestation" containerClassName="payment-actions split" />
            </section>
        </main>
        </div>
    );
}

export default async function AdminPaymentAttestationAuditPage({
    searchParams,
}: {
    searchParams: Promise<{ date?: string; shift?: string }>;
}) {
    if (!hasDatabaseUrl()) {
        return <PaymentAttestationUnavailable title="Banco indisponível" copy="Sem DATABASE_URL não existe base para fechar e atestar o pagamento do turno." />;
    }

    try {
        await requireAuthenticatedSession(["admin"]);
    } catch (error) {
        if (error instanceof AuthError) {
            return (
                <PaymentAttestationUnavailable
                    title={error.status === 403 ? "Acesso restrito" : "Autenticação necessária"}
                    copy={error.message}
                />
            );
        }

        throw error;
    }

    const { date, shift } = await searchParams;
    const initialView = await getPaymentAttestationSlotView({
        operationalDate: date ?? null,
        shiftLabel: shift === "SD" || shift === "SN" ? shift : null,
    });

    return <PaymentAttestationClient initialView={initialView} />;
}
