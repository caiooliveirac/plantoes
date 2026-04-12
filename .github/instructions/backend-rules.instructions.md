---
description: "Use when working on backend logic, Telegram bot, parser, operational rules, bank hours, payment allocation, corrections, regulation service, intervention service, board service, shift rules, occupancy lifecycle, doctor resolution, or any TypeScript module outside app/. Ensures the agent understands business rules, bug patterns, and system invariants before making changes."
applyTo: "modules/**/*.ts,services/**/*.ts,tests/**/*.ts,scripts/**/*.ts,lib/**/*.ts,db/**/*.ts"
---

# Backend Operacional SAMU

Antes de qualquer alteração em backend, leia o arquivo `/RULES.md` na raiz do projeto. Ele contém:

- Todas as regras de negócio do sistema
- Onde cada regra está implementada (arquivo + função)
- Os 3 relógios independentes (quadro, lembrete, banco de horas)
- Diferenças entre regulação e intervenção
- Fluxo completo do Telegram (pipeline, pending states, defer)
- Como o parser funciona e suas limitações
- Padrões de bugs recorrentes que você DEVE evitar
- Checklist obrigatório para alterações

## Invariantes obrigatórias

- Sempre tratar `shiftLabel === null` como caso de primeira classe (29% das ocupações)
- Sempre considerar P-shift cruzando virada de turno em lógica de boundaries
- Nunca assumir que `startedAt` está no mesmo dia que `endedAt` (SN cruza meia-noite)
- Nunca confundir os 3 relógios: tolerância do quadro (60 min) ≠ tolerância financeira (15 min)
- `isActive = false` é estado de domínio, NÃO soft delete
- `endedAt` = handoff agendado; `actualEndedAt` = saída real do médico
- Toda correção de ocupação deve recalcular bank hours (syncBankHours*)

## Antes de alterar

1. Rode `npx tsx --test tests/*.test.ts` e confirme baseline verde
2. Identifique se a mudança afeta regulação, intervenção, ou ambos
3. Verifique se existe teste cobrindo o cenário que você vai tocar
4. Se não existir teste, crie ANTES de mudar o código
5. Após alterar, rode os testes novamente e confirme que continuam verdes
