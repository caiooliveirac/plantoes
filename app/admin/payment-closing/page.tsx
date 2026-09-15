import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { ChiefPaymentViewClient } from "@/app/admin/payment-attestation/chief-payment-view-client";
import { AdminGlobalNavigationLinks } from "@/components/admin-global-navigation-links";
import type { DoctorFinancialExtras } from "@/modules/reporting/payable-shifts";
import { loadChiefPayableBoardCore, loadChiefPayableFinancials } from "@/services/payable-shifts.service";

export const dynamic = "force-dynamic";

function PaymentClosingUnavailable({ title, copy }: { title: string; copy: string }) {
    return (
        <div className="pagina-kairos">
            <main className="chief-payable-shell">
                <section className="payment-empty-state standalone large">
                    <strong>{title}</strong>
                    <span>{copy}</span>
                    <AdminGlobalNavigationLinks current="payment-closing" containerClassName="payment-actions split" />
                </section>
            </main>
        </div>
    );
}

export default async function AdminPaymentClosingPage({
    searchParams,
}: {
    searchParams: Promise<{ month?: string; doctor?: string }>;
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

    const { month, doctor } = await searchParams;
    // Grade primeiro; o financeiro (saldo contratual, banco de horas, NF) é a
    // parte cara e só alimenta chips e o modal: começa junto, chega por
    // streaming como Promise e o cliente aplica quando resolve. Falha vira
    // aviso na tela, nunca erro na grade.
    const financials = loadChiefPayableFinancials(month ?? null).then(
        (byDoctor) => ({ byDoctor, error: null as string | null }),
        (error: unknown) => ({
            byDoctor: {} as Record<string, DoctorFinancialExtras>,
            error: error instanceof Error ? error.message : "Falha ao carregar o financeiro.",
        }),
    );
    const board = await loadChiefPayableBoardCore(month ?? null);
    const canManageClosing = Boolean(session.user.roles.includes("admin"));
    // Encaminhamento vindo da aba banco de horas: abre direto o modal do médico
    // para lançar o acerto (plantão verde/vermelho) aqui, onde ele de fato aparece.
    const initialDoctorId = doctor && board.doctors.some((entry) => entry.doctorId === doctor)
        ? doctor
        : null;

    return (
        <ChiefPaymentViewClient
            board={board}
            financials={financials}
            canManageClosing={canManageClosing}
            initialDoctorId={initialDoctorId}
        />
    );
}
