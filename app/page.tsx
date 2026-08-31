import { hasDatabaseUrl } from "@/db";
import { readAuthenticatedSession } from "@/lib/auth/server";
import { OperationalBoardClient } from "@/app/operational-board-client";
import { resolveOperationalShiftLabel } from "@/modules/operational/board-rules";
import { getExpectedSchedule } from "@/modules/operational/expected-schedule";
import { evaluateMealBreakSessionAgainstBoard, getCurrentOperationalMealBreakSession, getCurrentMealBreakEligibilityOverrides } from "@/modules/telegram/meal-breaks";
import { getOperationalBoard, getPreviousOperationalBoard } from "@/services/board.service";
import { listDoctorsForChiefInvite } from "@/services/chief-access.service";

export const dynamic = "force-dynamic";

function EmptyState() {
    return (
        <div className="pagina-kairos">
        <main className="ops-shell">
            <section className="ops-hero-panel offline">
                <div>
                    <p className="ops-kicker">Mesa operacional</p>
                    <h1>Banco indisponível para montar o quadro agora.</h1>
                    <p className="ops-subtitle">
                        Assim que a conexão voltar, esta tela retoma regulação e intervenção com leitura operacional em tempo real.
                    </p>
                </div>
                <div className="ops-inline-status danger">:/ Sem fonte de dados operacional</div>
            </section>
        </main>
        </div>
    );
}

export default async function HomePage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
    const params = searchParams ? await searchParams : undefined;
    const initialViewMode = params?.view === "history" ? "history" : "live";

    if (!hasDatabaseUrl()) {
        return <EmptyState />;
    }

    const session = await readAuthenticatedSession();
    const canManage = Boolean(
        session?.user.roles.some((role) => role === "admin" || role === "chief")
        && !session.user.mustChangePassword,
    );
    const [board, previousShift, doctors, mealBreakSession, mealBreakEligibility, expectedSchedule] = await Promise.all([
        getOperationalBoard(),
        // Dashboard mantem a visao legada (dia operacional anterior completo,
        // tudo editavel) independente do turno corrente. A pivotagem shift-aware
        // vive na pagina /historico/turno-anterior dedicada.
        getPreviousOperationalBoard(new Date(), { mode: "full-prev" }),
        canManage ? listDoctorsForChiefInvite() : Promise.resolve([]),
        getCurrentOperationalMealBreakSession(),
        getCurrentMealBreakEligibilityOverrides(),
        // Nomes previstos da escala externa seguem a mesma regra das faltas
        // nominais: leitura da chefia — anônimo continua vendo o quadro puro.
        canManage ? getExpectedSchedule() : Promise.resolve(null),
    ]);

    return (
        <OperationalBoardClient
            generatedAt={board.generatedAt}
            shiftLabel={resolveOperationalShiftLabel(new Date())}
            regulation={board.regulation}
            intervention={board.intervention}
            mealBreakSession={mealBreakSession}
            mealBreakEligibility={mealBreakEligibility}
            mealBreakEvaluation={mealBreakSession
                ? evaluateMealBreakSessionAgainstBoard({
                    session: mealBreakSession,
                    board,
                    lunchExcludedRamals: mealBreakEligibility.lunchExcludedRamals,
                    restExcludedRamals: mealBreakEligibility.restExcludedRamals,
                    referenceAt: new Date(board.generatedAt),
                }).evaluation
                : null}
            previousShift={previousShift}
            doctors={doctors}
            initialViewMode={initialViewMode}
            pendingDepartures={board.pendingDepartures ?? []}
            recentHandoffs={board.recentHandoffs ?? []}
            pendingChiefExits={board.pendingChiefExits ?? []}
            expectedSchedule={expectedSchedule}
            session={session ? {
                email: session.user.email,
                roles: session.user.roles,
                mustChangePassword: session.user.mustChangePassword,
                canManage,
                doctorId: session.user.doctorId,
            } : null}
        />
    );
}
