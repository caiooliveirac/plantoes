import { getDb, hasDatabaseUrl } from "@/db";
import { interventionBases, regulationPosts } from "@/db/schema";
import { AuthError, requireAuthenticatedSession } from "@/lib/auth/server";
import { SwapCenterClient } from "@/components/swaps/SwapCenterClient";
import { getSwapBoard, listOfferableShifts } from "@/services/shift-offers.service";

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
        return <Unavailable title="Banco indisponível" copy="Sem DATABASE_URL não há mural de trocas." />;
    }

    let session;
    try {
        session = await requireAuthenticatedSession(["admin", "chief", "doctor"]);
    } catch (error) {
        if (error instanceof AuthError) {
            return (
                <Unavailable
                    title={error.status === 403 ? "Acesso restrito" : "Autenticação necessária"}
                    copy="Entre com sua conta para ver o mural. Médicos podem se cadastrar em /cadastro-medico."
                />
            );
        }
        throw error;
    }

    const isChief = session.user.roles.includes("admin") || session.user.roles.includes("chief");
    const today = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);

    const db = getDb();
    const [board, offerable, posts, bases] = await Promise.all([
        getSwapBoard(today, 14),
        session.user.doctorId ? listOfferableShifts(session.user.doctorId, today) : Promise.resolve([]),
        db.select().from(regulationPosts),
        db.select().from(interventionBases),
    ]);
    const postLabels = new Map(posts.map((post) => [post.id, post.label]));
    const baseLabels = new Map(bases.map((base) => [base.id, base.label]));

    return (
        <SwapCenterClient
            isChief={isChief}
            myDoctorId={session.user.doctorId}
            today={today}
            initialBoard={board}
            myShifts={offerable.map((shift) => ({
                id: shift.id,
                domain: shift.domain,
                operationalDate: shift.operationalDate,
                shiftLabel: shift.shiftLabel,
                targetLabel: shift.domain === "regulation"
                    ? (shift.roleLabel ? `Regulação · ${shift.roleLabel}` : "Regulação")
                    : baseLabels.get(shift.baseId!) ?? `base ${shift.baseId}`,
            }))}
        />
    );
}
