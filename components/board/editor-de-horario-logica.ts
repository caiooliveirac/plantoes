/**
 * Lógica pura do EditorDeHorario — sem React, testável em node:test.
 *
 * Todo instante é epoch ms (UTC). "Dia" e "HH:MM" são do fuso operacional
 * (UTC-3 fixo, ver lib/time.ts) — nunca do TZ do navegador, porque a chefia
 * pode estar com o celular em outro fuso e o quadro tem de bater com o bot.
 */
import { BAHIA_OFFSET_MINUTES, bahiaClockHHMM, bahiaDateIso } from "@/lib/time";

export const MINUTO_MS = 60_000;
export const DIA_MS = 24 * 60 * MINUTO_MS;
const OFFSET_MS = BAHIA_OFFSET_MINUTES * MINUTO_MS;

/** "HH:MM" no fuso operacional. */
export function formatarHHMM(ms: number): string {
    return bahiaClockHHMM(new Date(ms));
}

/** "AAAA-MM-DD" no fuso operacional. */
export function dataOperacional(ms: number): string {
    return bahiaDateIso(new Date(ms));
}

/** Meia-noite (fuso operacional) do dia civil que contém `ms`. */
export function inicioDoDia(ms: number): number {
    const relogio = ms + OFFSET_MS;
    return Math.floor(relogio / DIA_MS) * DIA_MS - OFFSET_MS;
}

export function limitar(ms: number, minMs: number, maxMs: number): number {
    return Math.min(maxMs, Math.max(minMs, ms));
}

export function arredondarMinuto(ms: number): number {
    return Math.round(ms / MINUTO_MS) * MINUTO_MS;
}

/** Aceita "7:05", "07:05", "0705", "07.05". Devolve minutos desde 00:00 ou null. */
export function interpretarHHMM(texto: string): number | null {
    const limpo = texto.trim();
    const comSeparador = /^(\d{1,2})[:.hH](\d{2})$/.exec(limpo);
    const semSeparador = /^(\d{2})(\d{2})$/.exec(limpo);
    const match = comSeparador ?? semSeparador;
    if (!match) return null;
    const hora = Number(match[1]);
    const minuto = Number(match[2]);
    if (hora > 23 || minuto > 59) return null;
    return hora * 60 + minuto;
}

export interface ContextoResolucao {
    valorMs: number;
    minMs: number;
    maxMs: number;
}

/**
 * Resolve um "HH:MM" digitado para um instante.
 * Regra: o dia é o do valor atual. Se a janela cruza a meia-noite e a hora cabe
 * em mais de um dia dentro de [min, max], vence o instante mais perto do valor
 * atual. Se não cabe em dia nenhum, cai no dia atual limitado à faixa.
 */
export function resolverHHMM(texto: string, ctx: ContextoResolucao): number | null {
    const minutos = interpretarHHMM(texto);
    if (minutos === null) return null;
    const noDia = inicioDoDia(ctx.valorMs) + minutos * MINUTO_MS;
    const candidatos = [noDia - DIA_MS, noDia, noDia + DIA_MS].filter(
        (c) => c >= ctx.minMs && c <= ctx.maxMs,
    );
    if (candidatos.length === 0) return limitar(noDia, ctx.minMs, ctx.maxMs);
    let melhor = candidatos[0];
    for (const c of candidatos) {
        if (Math.abs(c - ctx.valorMs) < Math.abs(melhor - ctx.valorMs)) melhor = c;
    }
    return melhor;
}

/** A faixa editável atravessa a meia-noite (fuso operacional)? */
export function cruzaMeiaNoite(minMs: number, maxMs: number): boolean {
    return dataOperacional(minMs) !== dataOperacional(maxMs);
}

/**
 * Etiqueta curta do dia de `ms` relativa a `agoraMs`: "hoje", "ontem",
 * "amanhã" ou "dd/mm" quando está mais longe.
 */
export function rotuloDoDia(ms: number, agoraMs: number): string {
    const diff = Math.round((inicioDoDia(ms) - inicioDoDia(agoraMs)) / DIA_MS);
    if (diff === 0) return "hoje";
    if (diff === -1) return "ontem";
    if (diff === 1) return "amanhã";
    const iso = dataOperacional(ms);
    return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

export interface PresetDeHorario {
    chave: "inicio" | "fim" | "agora";
    rotulo: string;
    ms: number;
}

/** Chips de atalho: início/fim da janela programada e "Agora", já limitados. */
export function presetsDoEditor(args: {
    janelaInicioMs: number;
    janelaFimMs: number | null;
    minMs: number;
    maxMs: number;
    agoraMs: number;
}): PresetDeHorario[] {
    const lista: PresetDeHorario[] = [
        {
            chave: "inicio",
            rotulo: `Início da janela (${formatarHHMM(args.janelaInicioMs)})`,
            ms: limitar(args.janelaInicioMs, args.minMs, args.maxMs),
        },
    ];
    if (args.janelaFimMs !== null) {
        lista.push({
            chave: "fim",
            rotulo: `Fim da janela (${formatarHHMM(args.janelaFimMs)})`,
            ms: limitar(args.janelaFimMs, args.minMs, args.maxMs),
        });
    }
    lista.push({
        chave: "agora",
        rotulo: "Agora",
        ms: limitar(arredondarMinuto(args.agoraMs), args.minMs, args.maxMs),
    });
    return lista;
}

/** Diferença em minutos entre dois instantes, formatada "+15 min" / "−5 min" / "". */
export function rotuloDelta(ms: number, referenciaMs: number): string {
    const minutos = Math.round((ms - referenciaMs) / MINUTO_MS);
    if (minutos === 0) return "";
    return `${minutos > 0 ? "+" : "−"}${Math.abs(minutos)} min`;
}
