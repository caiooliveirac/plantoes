import { redirect } from "next/navigation";
import { hasDatabaseUrl } from "@/db";
import { readAuthenticatedSession } from "@/lib/auth/server";
import { getPreviousOperationalBoard, listPendingDepartureConfirmations } from "@/services/board.service";
import { PreviousShiftGanttPage } from "@/app/historico/turno-anterior/client";

export const dynamic = "force-dynamic";

export default async function HistoricoTurnoAnteriorPage() {
    if (!hasDatabaseUrl()) {
        redirect("/");
    }
    const session = await readAuthenticatedSession();
    const canManage = Boolean(
        session?.user.roles.some((role) => role === "admin" || role === "chief")
        && !session.user.mustChangePassword,
    );
    if (!canManage) {
        redirect("/");
    }

    const [board, pending] = await Promise.all([
        getPreviousOperationalBoard(),
        listPendingDepartureConfirmations({ windowDays: 4 }),
    ]);

    return (
        <PreviousShiftGanttPage
            board={board}
            pending={pending}
        />
    );
}
