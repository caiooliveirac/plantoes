# Passagem de ocorrências no almoço/descanso

Quem sai da central para almoço/descanso (turno diurno) passa as ocorrências que
tem para quem fica. O sistema decide para quem, mostra acima do quadro e anuncia
no grupo do Telegram. Regras definidas pela chefia em 2026-09-24.

## Regras

- **Quem entra:** MR, RECIP, COI, IES, RMT. **Fora:** CP, DISP, PIAM, Núcleo (não
  passam nem recebem).
- **MRV** só passa, nunca recebe, e informa **só as amarelas**.
- **PSIQ** só passa e **nunca para o RECIP**: o dele vai para os colegas, só para
  equilibrar. O horário dele não é gravado pelo fluxo de refeições — o sistema
  presume 12:30 e avisa a chefia para confirmar.
- **Terminologia:** *Aguardando* (não resolvida, âmbar) e *Regulado* (resolvida,
  verde). Plural só em "Regulados", com quantidade ≠ 1.
- **11:30** (RECIP no primeiro descanso): Regulado → quem sai 12:30; Aguardando →
  quem sai 13:30.
- **12:30, 13:30, 15:30, 16:30:** RECIP recebe até **15**, Aguardando primeiro,
  depois Regulado. O excedente vai para quem **está voltando** do intervalo nesse
  horário; sem ninguém voltando, para quem fica.
- **Quem volta:** quem termina o intervalo no horário. Almoço 13:30 + descanso
  14:30 volta 15:30 (por isso 14:30 costuma não ter saída).
- **Equidade:** entre os receptores comuns, cada tipo difere no máximo 1 — nunca é
  quebrada. Dentro disso, o **menor número de colegas com quem cada um fala**
  (contando os dois tipos juntos), depois o pior caso por médico, depois a carga
  total. **Empate: fica a divisão anterior** (uma tecla não embaralha o quadro).
- **Quem chega para o SN** antes das 19:00 não herda nada da sessão diurna do
  ramal (RECIP, MRV, ALMOÇO/DESCANSO, passagem): a sessão é gravada por ramal,
  e o quadro só a aplica a cartão SD/P (`cardFollowsDayMealSession`).
- **18:00** (descanso fixo de RECIP, MRV, PSIQ) fica sem passagem, por decisão.

## Janela (por horário de saída)

| Momento | Painel | Bot |
|---|---|---|
| −15 min | faixa acima do quadro, linha de quem sai expande | aviso: quem sai, quem volta, link |
| −10 min | contagem abre (sem login) | cobrança com @ de quem falta, a cada 3 min |
| saída / todos informaram | divisão | divisão (uma mensagem) |
| até +10 min | correções recalculam | a mesma mensagem é **editada** |
| +10 a +15 min | divisão fechada | — |

## Onde está

- Algoritmo puro: `modules/operational/occurrence-handoff.ts` (exato por partição
  de somas + busca local; testes de força bruta em `tests/occurrence-handoff-stress.test.ts`).
- Estado: `services/occurrence-handoff.service.ts` — uma linha por chat + dia +
  horário em `telegram_bot_notices` (stage `occ_handoff`), sem migration.
- Rota pública: `app/api/board/occurrence-handoff` (GET estado, POST contagem;
  escopo validado + limite por IP).
- Quadro: `components/board/OccurrenceHandoff.tsx` + `useOccurrenceHandoff.ts`.
- Bot: `modules/telegram/occurrence-handoff-cycle.ts` no worker de lembretes.
  **Desliga** com `OCCURRENCE_HANDOFF_BOT_ENABLED=0` (o painel continua).
