import { hasDatabaseUrl } from "@/db";
import { ABAS_ADMIN, KairosTopo } from "@/components/kairos-topo";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { ChiefAccessClient } from "@/app/admin/chief-access/chief-access-client";
import { AdminGlobalNavigationLinks } from "@/components/admin-global-navigation-links";
import { listChiefAssignments, listDoctorsForChiefInvite } from "@/services/chief-access.service";

export const dynamic = "force-dynamic";

function ChiefAccessUnavailable({ title, copy }: { title: string; copy: string }) {
    return (
        <div className="pagina-kairos">
        <KairosTopo titulo="Acesso da chefia" abas={ABAS_ADMIN} />
        <main className="chief-access-shell">
            <section className="chief-access-empty-state standalone large">
                <strong>{title}</strong>
                <span>{copy}</span>
                <AdminGlobalNavigationLinks current="chief-access" containerClassName="chief-access-hero-actions" />
            </section>
        </main>
        </div>
    );
}

export default async function AdminChiefAccessPage() {
    if (!hasDatabaseUrl()) {
        return <ChiefAccessUnavailable title="Banco indisponível" copy="Sem DATABASE_URL não existe base para provisionar acessos de chefia." />;
    }

    try {
        await requireAuthenticatedSession(["admin"]);
    } catch (error) {
        if (error instanceof AuthError) {
            return (
                <ChiefAccessUnavailable
                    title={error.status === 403 ? "Acesso restrito" : "Autenticação necessária"}
                    copy={error.message}
                />
            );
        }

        throw error;
    }

    const [doctors, assignments] = await Promise.all([
        listDoctorsForChiefInvite(),
        listChiefAssignments(),
    ]);

    return (
        <ChiefAccessClient
            doctors={doctors}
            assignments={assignments.map((assignment) => ({
                id: assignment.id,
                email: assignment.email,
                isActive: assignment.is_active,
                mustChangePassword: assignment.must_change_password,
                doctorId: assignment.doctor_id,
                fullName: assignment.full_name,
                displayName: assignment.display_name,
            }))}
        />
    );
}