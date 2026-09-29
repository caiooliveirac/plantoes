# Saídas a confirmar — o que o sistema resolve sozinho

A fila do rail "Saídas a confirmar" separa três classes
(`modules/operational/departure-autonomy.ts`, puro). Decidido com a coordenação
em 29/09/2026, a partir de 30 dias de produção: 1097 saídas na fila, chefe
mudou algo em 4,8%, confirmava 87% em rajadas de segundos.

| Classe | O que é | Parte da fila | Chefe mexeu | O sistema |
|---|---|---|---|---|
| **Rotina** (`auto`) | rotina avisada pelo médico ou explicada pela chegada de quem assumiu | 64% | 3,4% | confirma na **virada seguinte** (pelo menos 1h de fila) |
| **Confira a sugestão** (`glance`) | janela vencida sem aviso; crédito tardio acima de 1h; saída faltando ≤2h | 32% | 6,9% | aplica a sugestão após **24h** |
| **Precisa de você** (`decide`) | anomalia, P emendado (6h+), saída antes de 6h ou na faixa de meio, ocorrência sem número, padrão, fechamento sem origem conhecida | 4,6% | 45% | **nunca** decide; após 24h avisa os admins no privado, uma vez |

Crédito tardio de até 1h já é rotina pela triagem
(`LATE_CREDIT_ATTENTION_THRESHOLD_MINUTES`).

## Sugestão

Uma linha: o que o toque faz e o efeito, com o número que o banco vai gravar
(`calculateGuardedBankHours`). Saída faltando ≤2h sugere **plantão inteiro** e
grava o desfecho `full_shift`. "Aceitar", Enter e a paleta aplicam a sugestão;
sem sugestão (classe `decide`) abrem o verificador — Enter nunca confirma sem
desfecho.

## Confirmação do sistema

- Confirmação **reivindicada** num UPDATE condicional (ainda não confirmada,
  mesma hora de saída): nunca sobrescreve a chefia. Nenhuma hora muda; o banco
  é recalculado pelo mesmo sync da confirmação da chefia
  (`services/departure-autonomy.service.ts`).
- Marca: `departure_confirmed_note` começa com "Confirmada pelo sistema". O
  médico vê "Confirmado automaticamente", não "Validado pela chefia"
  (`modules/reporting/bank-hours-approval.ts`).
- Auditoria: `*_occupancy.departure_auto_confirmed` (ator nulo).
- Chefia que confirma por cima de uma confirmação do sistema tira a marca.

## Desfazer

O rail lista "Confirmadas pelo sistema" das últimas 24h
(`GET/POST /api/operational/auto-confirmed-departures`). Desfazer tira a
confirmação e o desfecho que o sistema gravou, devolve o banco ao estado
retido e grava `*_occupancy.departure_auto_confirm_undone`. Daí em diante a
saída é da chefia: o sistema não confirma de novo, só escala no prazo.

## Operação

- Ciclo no worker (`modules/telegram/saidas-autonomas-cycle.ts`), a cada 5 min.
- Flag `SAIDAS_AUTONOMAS`: ligado por padrão; `sombra` só registra no log o que
  faria; `0` desliga (o rail deixa de prometer automático).
- A fila só enxerga 7 dias. Saídas mais antigas nunca confirmadas continuam
  retendo banco — 259 em 29/09/2026, quase todas de junho (`source=import`).
  Não tratadas aqui.

Guardas: `tests/departure-autonomy.test.ts`, `tests/saidas-autonomas.test.ts`,
`tests/saidas-autonomas-db.test.ts`, `tests/bank-hours-approval.test.ts`.
