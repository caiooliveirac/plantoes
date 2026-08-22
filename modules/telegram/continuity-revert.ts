// Turno-base de um "P forward" — o que o balão de confirmação anuncia ao médico.
//
// Antes existia aqui um botão inline "Foi só esta noite (SN)" / "Foi só este dia
// (SD)" que rebaixava a ocupação de P para o turno-base com um toque. Removido
// em 22/08/2026: um toque acidental derrubava o P para SD sem confirmação e sem
// rastro visível — o médico seguia na base a noite inteira enquanto o sistema já
// tinha encerrado o plantão dele às 19h (caso Murilo Damasceno, PR03, 21/08).
// Correção de turno agora é por mensagem/chefia, que passa pela auditoria.

import { resolvePShiftAwareBaseShiftLabel } from "@/modules/operational/rules";

export type ContinuityRevertDomain = "regulation" | "intervention";

/**
 * Turno-base que um P declarado em `startedAt` realmente assume — a MESMA regra
 * que a camada de domínio usa para montar a cobertura (rules.ts), não o relógio.
 *
 * Chegada adiantada (04:00–06:59) é P do DIA: cobre 07h→07h de amanhã. Só quem
 * declara P já dentro da noite (ou adiantado para ela, 16:00–18:59) é P noturno,
 * 19h→19h de amanhã.
 */
export function resolveContinuityRevertTarget(startedAt: Date): "SD" | "SN" {
    return resolvePShiftAwareBaseShiftLabel(startedAt, "P") === "SN" ? "SN" : "SD";
}
