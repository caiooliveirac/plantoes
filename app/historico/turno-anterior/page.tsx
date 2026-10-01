import { redirect } from "next/navigation";
import { nomeDoMedicoDaSessao } from "@/services/chefe-de-plantao.service";
import { hasDatabaseUrl } from "@/db";
import { mesaLiberadaPara, presencaDaPagina, readAuthenticatedSession } from "@/lib/auth/server";
import { MesaPresenca } from "@/components/board/MesaPresenca";
import { CascaDaSessao } from "@/components/casca/casca-da-sessao";
import { limiteOciosoSeg } from "@/modules/acessos/presenca";
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
    // Portão de turno: fora do plantão, "/" explica por quê.
    if (!canManage || !(await mesaLiberadaPara(session!))) {
        redirect("/");
    }

    // Mesma presença da Mesa: é o mesmo dado, pelo mesmo aparelho (docs/presenca-mesa.md).
    const presenca = await presencaDaPagina(session!);
    const propsPresenca = {
        estadoInicial: presenca.estado,
        modo: "modo" in presenca ? presenca.modo : null,
        limiteOciosoSeg: limiteOciosoSeg(),
        tenteEmSeg: "tenteEmSeg" in presenca ? presenca.tenteEmSeg : undefined,
        email: session!.user.email,
        nome: (await nomeDoMedicoDaSessao(session!.user.doctorId)) ?? session!.user.email,
    };
    if (presenca.estado === "ocupada" || presenca.estado === "bloqueada") {
        return <MesaPresenca {...propsPresenca} />;
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
        <CascaDaSessao email={session!.user.email} roles={session!.user.roles}>
            <MesaPresenca {...propsPresenca}>
                <PreviousShiftGanttPage
                    board={board}
                    pending={pending}
                />
            </MesaPresenca>
        </CascaDaSessao>
    );
}
