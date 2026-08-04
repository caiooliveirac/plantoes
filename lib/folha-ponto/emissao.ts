import { SAMU_HOLIDAYS } from "@/modules/operational/holidays";

/**
 * Data de emissão da folha de ponto / relatório de atividades.
 *
 * A folha de um mês só pode ser emitida DEPOIS que o mês fechou: a data mínima
 * é o primeiro dia útil do mês seguinte. Antes disso o documento estaria
 * atestando plantões que ainda nem aconteceram.
 *
 * Regra final: usa a data de HOJE (quando o médico apertou o botão), a não ser
 * que hoje ainda seja anterior a esse mínimo — aí crava o mínimo. Nunca uma
 * data inventada (o comportamento antigo era "dia 1 do próprio mês do
 * relatório", que saía errado em todo mês fechado).
 */

const MESES_PT_MINUSCULO = [
    "janeiro",
    "fevereiro",
    "março",
    "abril",
    "maio",
    "junho",
    "julho",
    "agosto",
    "setembro",
    "outubro",
    "novembro",
    "dezembro",
];

// Feriados de data fixa que caem cedo o bastante no mês para empurrar o
// primeiro dia útil (nacionais + Bahia/Salvador). Feriados móveis (carnaval,
// Corpus Christi) e feriados SAMU vêm de SAMU_HOLIDAYS, que é datado.
const FERIADOS_FIXOS_MM_DD: ReadonlySet<string> = new Set([
    "01-01", // Confraternização Universal
    "05-01", // Dia do Trabalho
    "07-02", // Independência da Bahia
    "09-07", // Independência do Brasil
    "10-12", // Nossa Senhora Aparecida
    "11-02", // Finados
    "11-15", // Proclamação da República
    "11-20", // Consciência Negra
    "12-25", // Natal
]);

function isoDate(ano: number, mes: number, dia: number): string {
    return `${String(ano).padStart(4, "0")}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
}

function isFeriado(iso: string): boolean {
    return FERIADOS_FIXOS_MM_DD.has(iso.slice(5)) || SAMU_HOLIDAYS.has(iso);
}

function isFimDeSemana(iso: string): boolean {
    const [ano, mes, dia] = iso.split("-").map(Number);
    const weekday = new Date(Date.UTC(ano, mes - 1, dia)).getUTCDay();
    return weekday === 0 || weekday === 6;
}

export function isDiaUtil(iso: string): boolean {
    return !isFimDeSemana(iso) && !isFeriado(iso);
}

/** Primeiro dia útil (seg–sex, fora de feriado) do mês informado, em ISO. */
export function primeiroDiaUtilDoMes(ano: number, mes: number): string {
    for (let dia = 1; dia <= 31; dia++) {
        const iso = isoDate(ano, mes, dia);
        // Guarda contra meses curtos: data ISO inválida (ex.: 2026-02-30) para o laço.
        if (Number.isNaN(new Date(`${iso}T12:00:00Z`).getTime())) break;
        if (isDiaUtil(iso)) return iso;
    }
    // Inalcançável na prática (nenhum mês é inteiramente feriado).
    return isoDate(ano, mes, 1);
}

/** Data mínima para emitir a folha de {ano}/{mes}: 1º dia útil do mês seguinte. */
export function dataMinimaEmissao(ano: number, mes: number): string {
    const anoSeguinte = mes === 12 ? ano + 1 : ano;
    const mesSeguinte = mes === 12 ? 1 : mes + 1;
    return primeiroDiaUtilDoMes(anoSeguinte, mesSeguinte);
}

/** Hoje no fuso de São Paulo, em ISO (os timestamps do sistema são UTC). */
export function hojeEmSaoPaulo(now: Date = new Date()): string {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Sao_Paulo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(now);
}

/**
 * Data que sai impressa: hoje, ou o mínimo (1º dia útil do mês seguinte)
 * quando a folha está sendo aberta antes do mês fechar.
 */
export function resolverDataEmissao(ano: number, mes: number, hoje: string = hojeEmSaoPaulo()): string {
    const minimo = dataMinimaEmissao(ano, mes);
    return hoje > minimo ? hoje : minimo;
}

/** "3 de agosto de 2026" */
export function formatarDataExtenso(iso: string): string {
    const [ano, mes, dia] = iso.split("-").map(Number);
    return `${dia} de ${MESES_PT_MINUSCULO[mes - 1]} de ${ano}`;
}

export function formatarLocalData(iso: string): string {
    return `Salvador, ${formatarDataExtenso(iso)}`;
}

/** Atalho usado pela página: "Salvador, 3 de agosto de 2026". */
export function localDataDaFolha(ano: number, mes: number, hoje: string = hojeEmSaoPaulo()): string {
    return formatarLocalData(resolverDataEmissao(ano, mes, hoje));
}
