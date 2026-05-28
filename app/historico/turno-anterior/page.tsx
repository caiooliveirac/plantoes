import { redirect } from "next/navigation";
import { hasDatabaseUrl } from "@/db";
import { readAuthenticatedSession } from "@/lib/auth/server";
import { resolveOperationalShiftLabel } from "@/modules/operational/board-rules";
import { getPreviousOperationalBoard, listPendingDepartureConfirmations } from "@/services/board.service";
import { PreviousShiftGanttPage } from "@/app/historico/turno-anterior/client";

export const dynamic = "force-dynamic";

export default async function HistoricoTurnoAnteriorPage({
    searchParams,
}: {
    searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
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

    const params = searchParams ? await searchParams : undefined;
    const wantsBack = params?.back === "1";

    // Modo back-sn so faz sentido durante o SN; em SD a request explicita por
    // ?back=1 e ignorada e a default (shift-aware) prevalece.
    const reference = new Date();
    const isCurrentlySn = resolveOperationalShiftLabel(reference) === "SN";

    const [board, pending] = await Promise.all([
        getPreviousOperationalBoard(reference, {
            mode: wantsBack && isCurrentlySn ? "back-sn" : undefined,
        }),
        listPendingDepartureConfirmations({ windowDays: 4 }),
    ]);

    return (
        <PreviousShiftGanttPage
            board={board}
            pending={pending}
        />
    );
}
