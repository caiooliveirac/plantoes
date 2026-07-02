import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { ScheduleBoardClient } from "@/components/schedule/ScheduleBoardClient";
import { getScheduleBoard } from "@/services/schedule.service";

export const dynamic = "force-dynamic";

function Unavailable({ title, copy }: { title: string; copy: string }) {
    return (
        <main className="et-shell">
            <div className="et-empty-state">
                <strong>{title}</strong>
                <p>{copy}</p>
            </div>
        </main>
    );
}

function todaySaoPaulo() {
    return new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
}

export default async function EscalaPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
    if (!hasDatabaseUrl()) {
        return <Unavailable title="Banco indisponível" copy="Sem DATABASE_URL não há escala para montar." />;
    }

    // Chefia/admin editam; médico logado vê a escala em modo leitura.
    let canEdit = false;
    try {
        const session = await requireAuthenticatedSession(["admin", "chief", "doctor"]);
        canEdit = session.user.roles.includes("admin") || session.user.roles.includes("chief");
    } catch (error) {
        if (error instanceof AuthError) {
            return (
                <Unavailable
                    title={error.status === 403 ? "Acesso restrito" : "Autenticação necessária"}
                    copy="Entre com sua conta para ver a escala. Médicos podem se cadastrar em /cadastro-medico."
                />
            );
        }
        throw error;
    }

    const { date } = await searchParams;
    const operationalDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : todaySaoPaulo();
    const board = await getScheduleBoard(operationalDate);

    return <ScheduleBoardClient initialBoard={board} canEdit={canEdit} />;
}
