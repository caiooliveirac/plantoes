import Link from "next/link";
import { redirect } from "next/navigation";
import { hasDatabaseUrl } from "@/db";
import { KairosTopo } from "@/components/kairos-topo";
import { mesaLiberadaPara, presencaDaPagina, readAuthenticatedSession } from "@/lib/auth/server";
import { MesaPresenca } from "@/components/board/MesaPresenca";
import { limiteOciosoSeg } from "@/modules/acessos/presenca";
import { MENSAGEM_FORA_DO_PLANTAO } from "@/modules/acessos/portao";
import { PORTAL_LOGIN_URL, destinoSemSessao } from "@/lib/auth/portao";
import { escalaUrl, federacaoConfigurada } from "@/lib/auth/federacao";
import { OperationalBoardClient } from "@/app/operational-board-client";
import "@/app/auth-pages.css";
import { resolveOperationalShiftLabel } from "@/modules/operational/board-rules";
import { getExpectedSchedule } from "@/modules/operational/expected-schedule";
import { evaluateMealBreakSessionAgainstBoard, getCurrentOperationalMealBreakSession, getCurrentMealBreakEligibilityOverrides } from "@/modules/telegram/meal-breaks";
import { getOperationalBoard, getPreviousOperationalBoard, listOnDemandRegulationPostOptions } from "@/services/board.service";
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

/* Volta do SSO sem sessão (/api/auth/sso falhou): mostrar a frase aqui, sem
   redirecionar — mandar ao portal de novo viraria ricochete portal↔plantoes. */
function SsoFalhou({ motivo }: { motivo: string }) {
    const frase = motivo === "sem-acesso"
        ? "Sua conta do escala foi reconhecida, mas este e-mail não tem conta liberada aqui. Peça à chefia para criar ou liberar seu acesso."
        : "A entrada pelo escala expirou. Tente de novo pelo botão de lá.";
    return (
        <div className="pagina-kairos">
        <KairosTopo titulo="Mesa operacional" />
        <main className="et-shell" style={{ alignItems: "center", justifyContent: "center" }}>
            <section className="et-panel" style={{ width: "min(480px, 100%)" }}>
                <div className="et-panel-head"><h2>Não foi possível entrar</h2></div>
                <div className="et-empty-state">
                    <strong>{frase}</strong>
                    <p><a href={PORTAL_LOGIN_URL}>Entrar pelo portal</a></p>
                    <p><Link href="/entrar">Entrar com e-mail e senha daqui</Link></p>
                </div>
            </section>
        </main>
        </div>
    );
}

/* Portão de turno (docs/monitor-acessos.md): conta logada, mas fora do
   plantão e fora da Central. O resto do que é do médico segue aberto. */
function ForaDoPlantao() {
    return (
        <div className="pagina-kairos">
        <KairosTopo titulo="Mesa operacional" />
        <main className="et-shell" style={{ alignItems: "center", justifyContent: "center" }}>
            <section className="et-panel" style={{ width: "min(480px, 100%)" }}>
                <div className="et-panel-head"><h2>Mesa fechada fora do plantão</h2></div>
                <div className="et-empty-state">
                    <strong>{MENSAGEM_FORA_DO_PLANTAO}</strong>
                    <p><Link href="/medico">Folha de ponto, banco de horas e dados</Link></p>
                </div>
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

    // Quadro fechado (lib/auth/portao.ts): sem sessão, nenhum dado do quadro.
    const session = await readAuthenticatedSession();
    if (!session) {
        const sso = typeof params?.sso === "string" ? params.sso : null;
        if (sso) return <SsoFalhou motivo={sso} />;
        redirect(destinoSemSessao());
    }
    if (!(await mesaLiberadaPara(session))) {
        return <ForaDoPlantao />;
    }
    // Presença (docs/presenca-mesa.md): outro aparelho com a vez, ou este
    // bloqueado por ociosidade → nenhum dado do quadro sai desta página.
    const presenca = await presencaDaPagina(session);
    const propsPresenca = {
        estadoInicial: presenca.estado,
        modo: "modo" in presenca ? presenca.modo : null,
        limiteOciosoSeg: limiteOciosoSeg(),
        tenteEmSeg: "tenteEmSeg" in presenca ? presenca.tenteEmSeg : undefined,
        email: session.user.email,
    };
    if (presenca.estado === "ocupada" || presenca.estado === "bloqueada") {
        return <MesaPresenca {...propsPresenca} />;
    }
    const canManage = Boolean(
        session.user.roles.some((role) => role === "admin" || role === "chief")
        && !session.user.mustChangePassword,
    );
    const [board, previousShift, doctors, mealBreakSession, mealBreakEligibility, expectedSchedule, onDemandRegulationPosts] = await Promise.all([
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
        // Ramais eventuais (4091): fora do quadro quando vazios; a chefia ainda
        // precisa vê-los nos seletores de chegada manual e remanejamento.
        canManage ? listOnDemandRegulationPostOptions() : Promise.resolve([]),
    ]);

    return (
        <MesaPresenca {...propsPresenca}>
        <OperationalBoardClient
            generatedAt={board.generatedAt}
            shiftLabel={resolveOperationalShiftLabel(new Date())}
            regulation={board.regulation}
            intervention={board.intervention}
            onDemandRegulationPosts={onDemandRegulationPosts}
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
            escalaUrl={federacaoConfigurada() ? escalaUrl() : null}
            session={{
                email: session.user.email,
                roles: session.user.roles,
                mustChangePassword: session.user.mustChangePassword,
                canManage,
                doctorId: session.user.doctorId,
            }}
        />
        </MesaPresenca>
    );
}
