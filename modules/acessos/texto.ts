/* Formatação em português para os relatórios do monitor de acessos. Horário
   sempre o da Bahia (UTC-3 fixo, lib/time.ts) — o processo roda em UTC. */
import { BAHIA_OFFSET_MINUTES } from "@/lib/time";

const DIAS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

function naBahia(data: Date) {
    return new Date(data.getTime() + BAHIA_OFFSET_MINUTES * 60_000);
}

const doisDigitos = (valor: number) => String(valor).padStart(2, "0");

/** "19:40" */
export function hora(data: Date) {
    const local = naBahia(data);
    return `${doisDigitos(local.getUTCHours())}:${doisDigitos(local.getUTCMinutes())}`;
}

/** "19:40:12" — para a linha do tempo de prova. */
export function horaComSegundos(data: Date) {
    return `${hora(data)}:${doisDigitos(naBahia(data).getUTCSeconds())}`;
}

/** "22/09" */
export function dia(data: Date) {
    const local = naBahia(data);
    return `${doisDigitos(local.getUTCDate())}/${doisDigitos(local.getUTCMonth() + 1)}`;
}

/** "ter 22/09 19:40" */
export function quando(data: Date) {
    return `${DIAS[naBahia(data).getUTCDay()]} ${dia(data)} ${hora(data)}`;
}

/** "ter 22/09, 19:40–21:50" (mesmo dia) ou "ter 22/09 23:50 – qua 23/09 00:20". */
export function intervalo(inicio: Date, fim: Date) {
    if (dia(inicio) === dia(fim)) return `${DIAS[naBahia(inicio).getUTCDay()]} ${dia(inicio)}, ${hora(inicio)}–${hora(fim)}`;
    return `${quando(inicio)} – ${quando(fim)}`;
}

/** "2h10", "35 min", "menos de 1 min" */
export function duracao(ms: number) {
    const minutos = Math.round(ms / 60_000);
    if (minutos < 1) return "menos de 1 min";
    if (minutos < 60) return `${minutos} min`;
    const horas = Math.floor(minutos / 60);
    const resto = minutos % 60;
    return resto ? `${horas}h${doisDigitos(resto)}` : `${horas}h`;
}

/** "a, b e c" */
export function lista(itens: string[]) {
    if (itens.length <= 1) return itens[0] ?? "";
    return `${itens.slice(0, -1).join(", ")} e ${itens[itens.length - 1]}`;
}

/** plural(3, "aparelho", "aparelhos") → "3 aparelhos" */
export function plural(n: number, singular: string, pluralForma: string) {
    return `${n} ${n === 1 ? singular : pluralForma}`;
}

/** Data AAAA-MM-DD na Bahia — chave de "dia" para deduplicar avisos. */
export function diaIso(data: Date) {
    return naBahia(data).toISOString().slice(0, 10);
}
