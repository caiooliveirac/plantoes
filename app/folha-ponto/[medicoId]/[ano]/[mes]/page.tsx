import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb, hasDatabaseUrl } from "@/db";
import { doctors } from "@/db/schema";
import { getChiefPayableShiftsBoard } from "@/services/payable-shifts.service";
import { readAuthenticatedSession, requireAuthenticatedSession } from "@/lib/auth/server";
import { isValidFolhaToken } from "@/lib/folha-ponto/token";
import type { DadosFolhaPonto, Plantao, Turno } from "@/lib/folha-ponto/types";
import { FolhaPontoClient } from "./FolhaPontoClient";

export const dynamic = "force-dynamic";

function dayFromOperationalDate(operationalDate: string): number {
    const parts = operationalDate.split("-");
    const day = Number(parts[2]);
    return Number.isFinite(day) ? day : 0;
}

function baseNomeCurto(domain: "regulation" | "intervention"): string {
    return domain === "regulation" ? "CRU" : "intervenção";
}

// Meio plantão entra na folha com horário fixo padronizado (cravado), não com o
// horário real de chegada.
const MEIO_PLANTAO_ENTRADA = "11:00";
const MEIO_PLANTAO_SAIDA = "17:00";

function horaSaoPaulo(value: string | null): string | null {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleTimeString("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "America/Sao_Paulo",
    });
}

export default async function FolhaPontoPage({
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

    // Acesso: link assinado (médico, via bot), sessão do PRÓPRIO médico
    // (cadastro por codinome+email) OU sessão admin (botão do site).
    if (!isValidFolhaToken(t, { medicoId, ano, mes })) {
        const session = await readAuthenticatedSession();
        if (!session || session.user.doctorId !== medicoId) {
            await requireAuthenticatedSession(["admin"]);
        }
    }

    if (!hasDatabaseUrl()) notFound();

    const db = getDb();
    const [doctor] = await db
        .select({
            id: doctors.id,
            fullName: doctors.fullName,
            displayName: doctors.displayName,
            metadata: doctors.metadata,
        })
        .from(doctors)
        .where(eq(doctors.id, medicoId))
        .limit(1);

    if (!doctor) notFound();

    const monthKey = `${anoStr.padStart(4, "0")}-${String(mes).padStart(2, "0")}`;
    const board = await getChiefPayableShiftsBoard(monthKey);

    const plantoes: Plantao[] = board.payableShifts
        .filter((shift) => shift.doctorId === medicoId)
        // Retirada antecipada antes de 6h de janela: o plantão não é assinado
        // (paymentUnit 0, só banco de horas) — não entra na folha.
        .filter((shift) => shift.paymentUnit > 0)
        .map((shift) => {
            // Plantão cheio usa o horário padrão do turno (07–19 / 19–07). Meio
            // plantão (paymentUnit < 1) entra com horário FIXO cravado 11:00–17:00,
            // independentemente do horário real de chegada. Exceção: meio plantão
            // por RETIRADA antecipada usa os horários reais de chegada/saída —
            // cravar 11:00–17:00 inventaria uma janela que não aconteceu.
            const meioPlantao = shift.paymentUnit < 1;
            const meioPorRetirada = shift.earlyDepartureOutcome === "half_shift";
            const horaEntradaReal = meioPorRetirada ? horaSaoPaulo(shift.startedAt) : null;
            const horaSaidaReal = meioPorRetirada ? horaSaoPaulo(shift.endedAt) : null;
            const horarioReal = horaEntradaReal && horaSaidaReal
                ? { horaEntrada: horaEntradaReal, horaSaida: horaSaidaReal }
                : null;
            return {
                dia: dayFromOperationalDate(shift.operationalDate),
                turno: shift.shiftLabel as Turno,
                baseNomeCurto: baseNomeCurto(shift.domain),
                ...(horarioReal ?? (meioPlantao ? { horaEntrada: MEIO_PLANTAO_ENTRADA, horaSaida: MEIO_PLANTAO_SAIDA } : {})),
            };
        })
        .filter((p) => p.dia >= 1 && p.dia <= 31);

    const metadata = (doctor.metadata ?? {}) as Record<string, unknown>;
    const cnpj = typeof metadata.cnpj === "string" ? metadata.cnpj : null;
    const razaoSocial = typeof metadata.razaoSocial === "string" ? metadata.razaoSocial : null;

    const data: DadosFolhaPonto = {
        medico: {
            id: doctor.id,
            nome: doctor.fullName,
            cnpj,
            razaoSocial,
        },
        ano,
        mes,
        plantoes,
    };

    return <FolhaPontoClient data={data} />;
}
