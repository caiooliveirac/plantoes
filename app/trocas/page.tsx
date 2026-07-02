import { asc, eq } from "drizzle-orm";
import { getDb, hasDatabaseUrl } from "@/db";
import { doctors } from "@/db/schema";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { SwapCenterClient } from "@/components/swaps/SwapCenterClient";
import { listScheduledShiftsForDoctor } from "@/services/schedule.service";

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

export default async function TrocasPage() {
    if (!hasDatabaseUrl()) {
        return <Unavailable title="Banco indisponível" copy="Sem DATABASE_URL não há trocas para operar." />;
    }

    let session;
    try {
        session = await requireAuthenticatedSession(["admin", "chief", "doctor"]);
    } catch (error) {
        if (error instanceof AuthError) {
            return (
                <Unavailable
                    title={error.status === 403 ? "Acesso restrito" : "Autenticação necessária"}
                    copy="Entre com sua conta para operar trocas de plantão. Médicos podem se cadastrar em /cadastro-medico."
                />
            );
        }
        throw error;
    }

    const db = getDb();
    const isChief = session.user.roles.includes("admin") || session.user.roles.includes("chief");
    const today = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);

    const [myShifts, activeDoctors] = await Promise.all([
        session.user.doctorId ? listScheduledShiftsForDoctor(session.user.doctorId, today) : Promise.resolve([]),
        db.select().from(doctors).where(eq(doctors.isActive, true)).orderBy(asc(doctors.fullName)),
    ]);

    return (
        <SwapCenterClient
            isChief={isChief}
            myDoctorId={session.user.doctorId}
            myShifts={myShifts.map((shift) => ({
                id: shift.id,
                domain: shift.domain,
                operationalDate: shift.operationalDate,
                shiftLabel: shift.shiftLabel,
            }))}
            doctorOptions={activeDoctors
                .filter((doctor) => doctor.id !== session.user.doctorId)
                .map((doctor) => ({ id: doctor.id, name: doctor.displayName ?? doctor.fullName }))}
        />
    );
}
