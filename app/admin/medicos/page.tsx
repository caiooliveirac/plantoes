import { asc, eq } from "drizzle-orm";
import { getDb, hasDatabaseUrl } from "@/db";
import { interventionBases } from "@/db/schema";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { DoctorAdminClient } from "@/components/doctors/DoctorAdminClient";
import { listDoctorsForAdmin } from "@/services/doctor-admin.service";

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

export default async function AdminMedicosPage() {
    if (!hasDatabaseUrl()) {
        return <Unavailable title="Banco indisponível" copy="Sem DATABASE_URL não há médicos para gerenciar." />;
    }

    try {
        await requireAuthenticatedSession(["admin", "chief"]);
    } catch (error) {
        if (error instanceof AuthError) {
            return (
                <Unavailable
                    title={error.status === 403 ? "Acesso restrito" : "Autenticação necessária"}
                    copy="A gestão de médicos é exclusiva da chefia."
                />
            );
        }
        throw error;
    }

    const db = getDb();
    const [doctors, bases] = await Promise.all([
        listDoctorsForAdmin(),
        db.select().from(interventionBases).where(eq(interventionBases.isActive, true)).orderBy(asc(interventionBases.sortOrder)),
    ]);

    return (
        <DoctorAdminClient
            initialDoctors={doctors}
            bases={bases.map((base) => ({ id: base.id, code: base.code, label: base.label }))}
        />
    );
}
