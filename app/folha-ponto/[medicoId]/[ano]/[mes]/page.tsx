import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb, hasDatabaseUrl } from "@/db";
import { doctors } from "@/db/schema";
import { getChiefPayableShiftsBoard } from "@/services/payable-shifts.service";
import { requireAuthenticatedSession } from "@/lib/auth/server";
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

// "HH:MM" no fuso de operação (America/Sao_Paulo) a partir de um ISO; undefined se vazio.
function horaSaoPaulo(iso: string | null | undefined): string | undefined {
    if (!iso) {
        return undefined;
    }
    return new Intl.DateTimeFormat("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "America/Sao_Paulo",
    }).format(new Date(iso));
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

    // Acesso: link assinado (médico, via bot) OU sessão admin (botão do site).
    if (!isValidFolhaToken(t, { medicoId, ano, mes })) {
        await requireAuthenticatedSession(["admin"]);
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
        .map((shift) => {
            // Plantão cheio usa o horário padrão do turno (07–19 / 19–07). Meio
            // plantão (paymentUnit < 1) precisa do horário REAL trabalhado, senão a
            // folha sai 07–19 errado em vez de, ex., 11–17.
            const horaEntrada = horaSaoPaulo(shift.startedAt);
            const horaSaida = horaSaoPaulo(shift.endedAt);
            const meioPlantao = shift.paymentUnit < 1 && Boolean(horaEntrada) && Boolean(horaSaida);
            return {
                dia: dayFromOperationalDate(shift.operationalDate),
                turno: shift.shiftLabel as Turno,
                baseNomeCurto: baseNomeCurto(shift.domain),
                ...(meioPlantao ? { horaEntrada, horaSaida } : {}),
            };
        })
        .filter((p) => p.dia >= 1 && p.dia <= 31);

    const metadata = (doctor.metadata ?? {}) as Record<string, unknown>;
    const cnpj = typeof metadata.cnpj === "string" ? metadata.cnpj : null;
    const razaoSocial = typeof metadata.razaoSocial === "string" ? metadata.razaoSocial : null;

    const data: DadosFolhaPonto = {
        medico: {
            id: doctor.id,
            nome: doctor.displayName ?? doctor.fullName,
            cnpj,
            razaoSocial,
        },
        ano,
        mes,
        plantoes,
    };

    return <FolhaPontoClient data={data} />;
}
