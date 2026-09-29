/**
 * Painel do médico — o link que o bot manda no /pagamento.
 *
 * Reúne, em leitura pura, o que antes só existia em duas telas de admin:
 * o fechamento do mês (/admin/payment-closing, ao clicar no nome dele), o saldo
 * de contrato, e o banco de horas completo (/admin/bank-hours) com a validação
 * da chefia — que é o que vinha gerando questionamento.
 *
 * Exceção de escrita: o autoatendimento do banco de horas (registrar plantão
 * extra / retirar um plantão da folha), servido por
 * /api/medico/bank-hours-self-service — que revalida identidade, saldo e
 * competência no servidor. Todo o resto é leitura pura.
 *
 * Acesso: token assinado do bot (validade de 7 dias) OU sessão admin.
 */
import { notFound } from "next/navigation";
import { readAuthenticatedSession, requireAuthenticatedSession } from "@/lib/auth/server";
import { isValidFolhaToken } from "@/lib/folha-ponto/token";
import { dataMinimaEmissao, formatarDataExtenso, hojeEmSaoPaulo } from "@/lib/folha-ponto/emissao";
import { eq } from "drizzle-orm";
import { getDb, hasDatabaseUrl } from "@/db";
import { doctors } from "@/db/schema";
import { getBankHoursHistory } from "@/services/bank-hours-history.service";
import { getChiefPayableShiftsBoard } from "@/services/payable-shifts.service";
import { ContractBalanceCard } from "@/components/payment-closing/contract-balance-card";
import { KairosTopo } from "@/components/kairos-topo";
import { SelfServiceBankHours, type SelfServiceShiftOption } from "@/components/doctor-panel/self-service-bank-hours";
import { ChiefExtraShifts } from "@/components/doctor-panel/chief-extra-shifts";
import { DadosFiscais } from "@/components/doctor-panel/dados-fiscais";
import { BancoDeHorasMedico } from "@/components/doctor-panel/banco-de-horas-medico";
import { PainelAbas, type PainelAba } from "@/components/doctor-panel/painel-abas";
import { buildDoctorBankHoursView } from "@/modules/reporting/doctor-bank-hours-view";
import {
    canDeclareChiefExtraShift,
    loadChiefExtraShifts,
} from "@/services/chief-extra-shifts.service";
import { resolveBankHoursSettlementBalance } from "@/modules/reporting/bank-hours-settlement-rule";
import { competenciaDoAutoatendimento } from "@/lib/medico/competencia";
import {
    BANK_HOURS_SETTLEMENT_THRESHOLD_MINUTES,
    loadSelfDeclaredExtras,
} from "@/services/bank-hours-settlements.service";

export const dynamic = "force-dynamic";

function formatDateTime(value: string | null) {
    if (!value) return "—";
    return new Intl.DateTimeFormat("pt-BR", {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: "America/Sao_Paulo",
    }).format(new Date(value));
}

function formatBrl(value: number | null | undefined) {
    if (value === null || value === undefined) return "—";
    return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export default async function PainelDoMedicoPage({
    params,
    searchParams,
}: {
    params: Promise<{ medicoId: string; ano: string; mes: string }>;
    searchParams: Promise<{ t?: string }>;
}) {
    const { medicoId, ano: anoStr, mes: mesStr } = await params;
    const { t } = await searchParams;

    const ano = Number(anoStr);
    const mes = Number(mesStr);
    if (!Number.isInteger(ano) || ano < 2020 || ano > 2100) notFound();
    if (!Number.isInteger(mes) || mes < 1 || mes > 12) notFound();

    const tokenValido = isValidFolhaToken(t, { medicoId, ano, mes });
    // A sessão é lida sempre: além do acesso, é dela que sai o `isAdmin` que
    // libera o coordenador a mexer no mês já atestado.
    const session = await readAuthenticatedSession();
    const isAdmin = Boolean(session?.user.roles.includes("admin"));
    if (!tokenValido && session?.user.doctorId !== medicoId) {
        // Sessão do PRÓPRIO médico (cadastro por codinome+email) também entra;
        // qualquer outra sessão continua exigindo admin.
        await requireAuthenticatedSession(["admin"]);
    }
    if (!hasDatabaseUrl()) notFound();

    const monthKey = `${ano}-${String(mes).padStart(2, "0")}`;
    const [history, board, [doctorRow]] = await Promise.all([
        getBankHoursHistory({ doctorId: medicoId }),
        getChiefPayableShiftsBoard(monthKey),
        getDb().select({ metadata: doctors.metadata }).from(doctors).where(eq(doctors.id, medicoId)).limit(1),
    ]);
    const metadata = (doctorRow?.metadata ?? {}) as Record<string, unknown>;
    const razaoSocial = typeof metadata.razaoSocial === "string" ? metadata.razaoSocial : null;
    const cnpj = typeof metadata.cnpj === "string" ? metadata.cnpj : null;

    const doctor = history.doctors.find((row) => row.doctorId === medicoId);
    const paymentRow = board.doctors.find((row) => row.doctorId === medicoId);
    const contracts = paymentRow?.contractBalances ?? [];

    // Navegação de mês só faz sentido para quem está logado: o token do bot vale
    // para UM mês, então mudar de mês com ele na URL derrubaria o acesso.
    const mesAnterior = mes === 1 ? { ano: ano - 1, mes: 12 } : { ano, mes: mes - 1 };
    const mesSeguinte = mes === 12 ? { ano: ano + 1, mes: 1 } : { ano, mes: mes + 1 };
    const painelHref = (alvo: { ano: number; mes: number }) =>
        `/banco-de-horas/${medicoId}/${alvo.ano}/${alvo.mes}`;
    const mesNav = !tokenValido ? (
        <nav className="panel-month-nav">
            <a href={painelHref(mesAnterior)}>← mês anterior</a>
            <a href={painelHref(mesSeguinte)}>próximo mês →</a>
        </nav>
    ) : null;

    if (!doctor && !paymentRow) {
        return (
            <div className="pagina-kairos">
                <KairosTopo titulo="Seu painel" />
                <main className="panel-shell">
                    {mesNav}
                    <section className="hours-empty-state standalone">
                        <strong>Ainda não há nada por aqui.</strong>
                        <span>Assim que seus plantões forem consolidados, tudo aparece nesta página.</span>
                    </section>
                </main>
            </div>
        );
    }

    // Folha de ponto: até agora só saía por comando no bot (codinome). Aqui ela
    // fica a um clique de quem está logado. O token do bot, quando é por ele que
    // a pessoa chegou, é repassado — senão o acesso sem login se perderia.
    const folhaHref = `/folha-ponto/${medicoId}/${ano}/${String(mes).padStart(2, "0")}`
        + (tokenValido && t ? `?t=${encodeURIComponent(t)}` : "");
    const dataMinimaFolha = dataMinimaEmissao(ano, mes);
    const folhaAindaNaoEmissivel = hojeEmSaoPaulo() <= dataMinimaFolha;

    // Autoatendimento: mês corrente OU mês anterior ainda não atestado — a nota
    // do mês passado é emitida agora, e é agora que o médico lembra do extra
    // (ver lib/medico/competencia.ts). Verde = data livre para o extra (exige
    // saldo elegível ≥ +12h); vermelho = escolher um plantão real do mês para
    // retirar (saldo elegível ≤ -12h). Turno de chefia NÃO entra aqui — tem
    // bloco próprio, sem relação com saldo.
    const competencia = await competenciaDoAutoatendimento({ doctorId: medicoId, monthKey, isAdmin });
    const competenciaAberta = competencia.aberta;
    const isStatutory = doctor?.employmentType === "estatutario";
    const settleBalance = resolveBankHoursSettlementBalance({
        oldMinutes: doctor?.legacy?.preMay2025Minutes ?? 0,
        recentMinutes: (doctor?.legacy?.spreadsheetPeriodMinutes ?? 0) + (doctor?.applicationBalanceMinutes ?? 0),
        employmentType: doctor?.employmentType,
    });
    const canBonus = competenciaAberta
        && settleBalance.bonusEligibleMinutes >= BANK_HOURS_SETTLEMENT_THRESHOLD_MINUTES;
    // Estatutário não tem plantão retirado: o atraso dele vai à folha.
    const canPenalty = competenciaAberta
        && !isStatutory
        && settleBalance.penaltyEligibleMinutes <= -BANK_HOURS_SETTLEMENT_THRESHOLD_MINUTES;
    const selfServiceShiftOptions: SelfServiceShiftOption[] = canPenalty
        ? board.payableShifts
            .filter((shift) => shift.doctorId === medicoId && shift.paymentUnit > 0 && shift.source !== "admin_extra")
            .map((shift) => ({
                operationalDate: shift.operationalDate,
                shiftLabel: shift.shiftLabel,
                label: `${shift.operationalDate.split("-").reverse().slice(0, 2).join("/")} · ${shift.shiftLabel} · ${shift.targetCode}`,
            }))
            .sort((a, b) => a.operationalDate.localeCompare(b.operationalDate))
        : [];

    // Plantão de chefia: bloco separado, sem nenhuma relação com o banco de horas.
    const podeDeclararChefia = competenciaAberta ? await canDeclareChiefExtraShift(medicoId) : false;
    const plantoesDeChefia = podeDeclararChefia ? await loadChiefExtraShifts(medicoId, monthKey) : [];

    // O que ele mesmo declarou no mês — é o que ele pode trocar de dia/turno ou tirar.
    const extrasDeclarados = competenciaAberta ? await loadSelfDeclaredExtras(medicoId, monthKey) : [];

    // Dia+turno em que ele já tem plantão pagável (trabalhado, extra ou chefia):
    // o extra declarado não pode cair em cima (a API também barra).
    const takenSlots = board.payableShifts
        .filter((shift) => shift.doctorId === medicoId && shift.paymentUnit > 0)
        .map((shift) => `${shift.operationalDate}|${shift.shiftLabel}`);

    const bankView = doctor
        ? buildDoctorBankHoursView({
            doctor,
            bonusEligibleMinutes: settleBalance.bonusEligibleMinutes,
            penaltyEligibleMinutes: settleBalance.penaltyEligibleMinutes,
            competenciaAberta,
            monthKey,
            now: new Date(),
        })
        : null;

    const abas: PainelAba[] = [];
    if (doctor && bankView) {
        abas.push({
            id: "banco-de-horas",
            rotulo: "Banco de horas",
            conteudo: (
                <BancoDeHorasMedico
                    view={bankView}
                    troca={(
                        <SelfServiceBankHours
                            medicoId={medicoId}
                            monthKey={monthKey}
                            token={tokenValido && t ? t : null}
                            canBonus={canBonus}
                            canPenalty={canPenalty}
                            shiftOptions={selfServiceShiftOptions}
                            declaredExtras={extrasDeclarados}
                            takenSlots={takenSlots}
                        />
                    )}
                />
            ),
        });
    }
    abas.push({
        id: "pagamento",
        rotulo: "Pagamento e folha",
        conteudo: (
            <>
                {paymentRow ? (
                    <section className="panel-section">
                        <h2>Pagamento de {board.monthLabel}</h2>
                        <div className="panel-kpi-grid">
                            <article className="panel-kpi">
                                <span>Plantões</span>
                                <strong>{paymentRow.total}</strong>
                                <small>{paymentRow.totalSD} diurnos · {paymentRow.totalSN} noturnos</small>
                            </article>
                            <article className="panel-kpi highlight">
                                <span>Valor da nota</span>
                                <strong>{formatBrl(paymentRow.totalDue)}</strong>
                                <small>
                                    {paymentRow.weekdayShiftCount ?? 0} de semana · {paymentRow.weekendShiftCount ?? 0} de fim de semana
                                </small>
                            </article>
                            <article className="panel-kpi">
                                <span>Nota fiscal</span>
                                <strong>{paymentRow.invoiceNumber || "—"}</strong>
                                <small>{paymentRow.paymentProcessNumber ? `processo ${paymentRow.paymentProcessNumber}` : "processo não informado"}</small>
                            </article>
                            <article className="panel-kpi">
                                <span>Conferência da chefia</span>
                                <strong>{paymentRow.attestedAt ? "Assinada" : "Pendente"}</strong>
                                <small>{paymentRow.attestedAt ? formatDateTime(paymentRow.attestedAt) : "aguardando o fechamento"}</small>
                            </article>
                        </div>
                    </section>
                ) : null}

                {/* Plantão de chefia (NÃO é banco de horas) */}
                {podeDeclararChefia ? (
                    <ChiefExtraShifts
                        medicoId={medicoId}
                        monthKey={monthKey}
                        token={tokenValido && t ? t : null}
                        shifts={plantoesDeChefia}
                    />
                ) : null}

                <section className="panel-section">
                    <h2>Folha de ponto de {board.monthLabel}</h2>
                    <p className="panel-note">
                        A folha de frequência e o relatório de atividades saem prontos, com os
                        plantões do mês já preenchidos. É só conferir, imprimir e assinar.
                    </p>
                    <DadosFiscais
                        medicoId={medicoId}
                        monthKey={monthKey}
                        token={tokenValido && t ? t : null}
                        razaoSocial={razaoSocial}
                        cnpj={cnpj}
                    />
                    <a className="panel-action-btn" href={folhaHref}>
                        Gerar folha de ponto
                    </a>
                    <p className="panel-note">
                        {folhaAindaNaoEmissivel
                            ? `A data que sai impressa é ${formatarDataExtenso(dataMinimaFolha)} — o primeiro dia útil do mês seguinte, que é o mais cedo que a folha deste mês pode ser entregue.`
                            : "A data que sai impressa é a de hoje, o dia em que você gerou a folha."}
                    </p>
                </section>

                {contracts.length > 0 ? (
                    <section className="panel-section">
                        <h2>Seu saldo de contrato</h2>
                        <ContractBalanceCard
                            contracts={contracts}
                            draft={{
                                amountCents: Math.round((paymentRow?.totalDue ?? 0) * 100),
                                weekdayShifts: paymentRow?.weekdayShiftCount ?? 0,
                                weekendShifts: paymentRow?.weekendShiftCount ?? 0,
                            }}
                            canManage={false}
                            readOnly
                            monthLabel={board.monthLabel}
                            monthKey={board.monthKey}
                            alreadyAttested={Boolean(paymentRow?.attestedAt)}
                        />
                    </section>
                ) : null}
            </>
        ),
    });

    return (
        // Tela migrada ao Kairós: o wrapper dá tokens, fundo e tema (docs/kairos.md).
        <div className="pagina-kairos">
        <KairosTopo titulo="Seu painel" />
        <main className="panel-shell">
            <header className="panel-hero">
                <p className="reports-kicker">Seu painel</p>
                <h1>{doctor?.doctorName ?? paymentRow?.doctorName}</h1>
                <p className="panel-hero-sub">
                    {board.monthLabel}
                    {doctor ? ` · ${isStatutory ? "estatutário" : "PJ"}` : ""}
                </p>
                {mesNav}
            </header>

            {competencia.erro ? (
                <section className="panel-alert">
                    <strong>Este mês não aceita mais lançamento seu.</strong>
                    <span>{competencia.erro}</span>
                </section>
            ) : null}

            <PainelAbas abas={abas} />

            <footer className="panel-footer">
                Para corrigir qualquer coisa, fale com a chefia de plantão.
            </footer>
        </main>
        </div>
    );
}
