/**
 * Competência aberta ao autoatendimento do médico (banco de horas e chefia).
 *
 * Não é "o mês corrente". A nota fiscal de um mês só é emitida no mês seguinte,
 * e é na hora de emitir que o médico lembra do plantão extra que faltou: em
 * setembro ele precisa mexer em agosto. Por isso a janela é mês corrente MAIS
 * mês anterior.
 *
 * O que fecha o mês anterior é a ATESTAÇÃO da chefia, não a virada do
 * calendário. Assinada, o valor daquele mês já virou lançamento no razão do
 * contrato e o médico não mexe mais sozinho — quem mexe é a coordenação, pelo
 * /admin/payment-closing (que reconcilia o razão). Por isso o admin agindo pela
 * tela do médico passa reto por este gate: ele já podia fazer a mesma coisa na
 * outra tela.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { paymentClosingAttestations } from "@/db/schema";
import { getSaoPauloParts } from "@/modules/operational/board-rules";

export type JanelaDeCompetencia = "corrente" | "anterior" | "fora";

/** Mês corrente em São Paulo, 'AAAA-MM' (os timestamps do sistema são UTC). */
export function mesCorrenteSP(now: Date = new Date()): string {
    const parts = getSaoPauloParts(now);
    return `${parts.year}-${String(parts.month).padStart(2, "0")}`;
}

export function mesAnteriorDe(monthKey: string): string {
    const [ano, mes] = monthKey.split("-").map(Number);
    return mes === 1 ? `${ano - 1}-12` : `${ano}-${String(mes - 1).padStart(2, "0")}`;
}

/** Onde o mês pedido cai em relação a hoje. Puro — é o que os testes cobrem. */
export function janelaDeCompetencia(monthKey: string, mesCorrente: string): JanelaDeCompetencia {
    if (monthKey === mesCorrente) return "corrente";
    if (monthKey === mesAnteriorDe(mesCorrente)) return "anterior";
    return "fora";
}

export interface Competencia {
    aberta: boolean;
    /** Mensagem pronta para o médico quando fechada. */
    erro: string | null;
}

const FORA_DA_JANELA = "Só o mês corrente e o mês anterior aceitam este registro.";
const JA_ATESTADO = "A chefia já assinou o fechamento deste mês. Fale com a coordenação.";

export async function competenciaDoAutoatendimento(params: {
    doctorId: string;
    monthKey: string;
    /** Coordenador agindo pela tela do médico: não passa pelo gate da atestação. */
    isAdmin?: boolean;
    now?: Date;
}): Promise<Competencia> {
    const janela = janelaDeCompetencia(params.monthKey, mesCorrenteSP(params.now));
    if (janela === "corrente") return { aberta: true, erro: null };
    if (janela === "fora") return { aberta: false, erro: FORA_DA_JANELA };
    if (params.isAdmin) return { aberta: true, erro: null };

    const [atestacao] = await getDb()
        .select({ id: paymentClosingAttestations.id })
        .from(paymentClosingAttestations)
        .where(and(
            eq(paymentClosingAttestations.doctorId, params.doctorId),
            eq(paymentClosingAttestations.monthKey, params.monthKey),
        ))
        .limit(1);

    return atestacao ? { aberta: false, erro: JA_ATESTADO } : { aberta: true, erro: null };
}
