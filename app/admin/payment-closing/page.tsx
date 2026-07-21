import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { ChiefPaymentViewClient } from "@/app/admin/payment-attestation/chief-payment-view-client";
import { toChiefPayableClientBoard } from "@/modules/reporting/payable-shifts";
import { AdminGlobalNavigationLinks } from "@/components/admin-global-navigation-links";
import { getChiefPayableShiftsBoard } from "@/services/payable-shifts.service";

export const dynamic = "force-dynamic";

function PaymentClosingUnavailable({ title, copy }: { title: string; copy: string }) {
    return (
        <main className="chief-payable-shell">
            <section className="payment-empty-state standalone large">
                <strong>{title}</strong>
                <span>{copy}</span>
                <AdminGlobalNavigationLinks current="payment-closing" containerClassName="payment-actions split" />
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

    let session;
    try {
        session = await requireAuthenticatedSession(["admin", "payment_closing_limited"]);
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
    const canManageClosing = Boolean(session.user.roles.includes("admin"));

    // O client component recebe o board ENXUTO: sem a lista plana duplicada de
    // payableShifts (derivável das células) nem os attestationSegments inteiros
    // — isso cortava ~2/3 do payload RSC serializado no HTML.
    return <ChiefPaymentViewClient board={toChiefPayableClientBoard(board)} canManageClosing={canManageClosing} />;
}
