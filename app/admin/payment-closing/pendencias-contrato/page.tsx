import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { ABAS_ADMIN, KairosTopo } from "@/components/kairos-topo";
import { ContractPendencyQueueView } from "@/components/payment-closing/contract-pendency-queue";
import { loadContractPendencyQueue } from "@/services/contract-pendency-queue.service";

export const dynamic = "force-dynamic";

/**
 * Fila de pendências de contrato (aba do Fechamento). Leitura: a correção é
 * feita nas telas que já existem, para onde cada linha aponta.
 */
function Shell({ children }: { children: React.ReactNode }) {
    return (
        <div className="pagina-kairos">
            <KairosTopo titulo="Pendências de contrato" abas={ABAS_ADMIN} />
            <main className="chief-payable-shell">
                <p className="contract-queue-back">
                    <a href="/admin/payment-closing">← Voltar ao fechamento</a>
                </p>
                {children}
            </main>
        </div>
    );
}

export default async function ContractPendenciesPage() {
    if (!hasDatabaseUrl()) {
        return (
            <Shell>
                <section className="payment-empty-state standalone">
                    <strong>Banco indisponível</strong>
                    <span>Sem DATABASE_URL não há contratos para conferir.</span>
                </section>
            </Shell>
        );
    }

    try {
        // Mesma régua das rotas de escrita de contrato: quem corrige é admin.
        await requireAuthenticatedSession(["admin"]);
    } catch (error) {
        if (error instanceof AuthError) {
            return (
                <Shell>
                    <section className="payment-empty-state standalone">
                        <strong>{error.status === 403 ? "Acesso restrito" : "Autenticação necessária"}</strong>
                        <span>{error.message}</span>
                    </section>
                </Shell>
            );
        }
        throw error;
    }

    const queue = await loadContractPendencyQueue();
    return (
        <Shell>
            <ContractPendencyQueueView queue={queue} />
        </Shell>
    );
}
