import { hasDatabaseUrl } from "@/db";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { CoverageReportClient } from "@/components/swaps/CoverageReportClient";
import { getCoverageReport } from "@/services/shift-swaps.service";

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

export default async function CoverageReportPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
    if (!hasDatabaseUrl()) {
        return <Unavailable title="Banco indisponível" copy="Sem DATABASE_URL não há relatório de cobertura." />;
    }

    try {
        await requireAuthenticatedSession(["admin", "chief"]);
    } catch (error) {
        if (error instanceof AuthError) {
            return (
                <Unavailable
                    title={error.status === 403 ? "Acesso restrito" : "Autenticação necessária"}
                    copy="O relatório de cobertura é exclusivo da chefia."
                />
            );
        }
        throw error;
    }

    const { date } = await searchParams;
    const operationalDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date)
        ? date
        : new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
    const rows = await getCoverageReport(operationalDate);

    return <CoverageReportClient initialDate={operationalDate} initialRows={rows} />;
}
