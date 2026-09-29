# Madrugada — cobrir o horário de outro médico na noite

Quem vem fazer a madrugada **por alguém** avisa no grupo:

> Maria Souza 2266 madrugada

O bot pergunta **"Por quem você está?"** com botões dos médicos daquele horário.
Ao tocar num nome:

- quem cobre **aparece no quadro** no ramal declarado, com o selo 🌙 *por Fulano*;
- quem foi coberto **some do quadro** enquanto a cobertura vale;
- quem cobre fica **de plantão** para o portão (Mesa e Tabela liberadas), porque
  tem uma ocupação aberta;
- quem cobre **não entra em pagamento nem em banco de horas**;
- quem foi coberto **não perde nada**: pagamento e banco de horas dele seguem
  exatamente como se tivesse trabalhado (a ocupação dele não é tocada).

## Janela

Pela hora do aviso (horário local):

| Aviso | Fica de |
|---|---|
| 20:00–00:59 (em torno das 23h) | 23:00 às 03:00 |
| 01:00–05:59 (em torno das 3h) | 03:00 às 07:00 |
| fora disso | recusado ("madrugada só vale entre 20h e 6h") |

A cobertura expira sozinha no fim da janela (`expireStaleRegulationOccupancies`)
e o coberto, se ainda estiver aberto, volta ao quadro.

## Botões

Os médicos oferecidos são os que a **divisão da noite** (`/almoco` noturno,
`nightWorkAssignments`) pôs para trabalhar no mesmo horário — 23:00 ou 03:00.
Sem divisão da noite, ou sem ninguém naquele horário, o bot oferece todos os
ativos da regulação no quadro (até 8). Nunca oferece outra cobertura nem o
próprio médico que avisou. Há um botão **❌ Cancelar**. A pergunta expira em 30
min, como as demais pendências (`pending_madrugada_cover`).

## Ramais 2266–2270

Cinco ramais novos (migration `0051`), **eventuais** como o 4091: só aparecem no
quadro com alguém dentro e nunca contam como vaga descoberta. São o lugar
natural de quem cobre. Também vale declarar o **próprio ramal do coberto** — a
cobertura toma o lugar dele no quadro. Ramal ocupado por um **terceiro** é
recusado no toque do botão (pede outro ramal).

## Como é gravado

`regulation_occupancies` ganhou duas colunas (migration `0051`):

- `madrugada_cobertura boolean` — **a marca que exclui do pagamento/banco**;
- `madrugada_cobre_ocupacao_id uuid` — a ocupação coberta.

A ocupação de quem cobre nasce **sem board** (`board_started_at` nulo), por
`modules/regulation/madrugada-cobertura.ts` — não passa por
`startRegulationOccupancy`, então não rende, não desloca, não herda
continuidade. O quadro (`listRegulationBoard`) a mostra mesmo assim e esconde a
ocupação coberta enquanto a cobertura estiver aberta.

Onde a exclusão está aplicada (e onde mexer se nascer leitor novo de pagamento):

- `services/payable-shifts.service.ts` — fechamento mensal, folha de ponto,
  saldo de contrato, autoatendimento;
- `services/board.service.ts` (`getPaymentAllocationBoard`) — alocação e
  auditoria de slot;
- `services/monthly-report.service.ts` — relatório mensal;
- `modules/bank-hours/service.ts` (`listContinuityGroupOccupancies`) — banco de
  horas;
- `modules/regulation/service.ts` — a cobertura nunca é origem de continuidade
  implícita de um plantão pagável.

Guardas: `tests/madrugada.test.ts` (regras puras) e `tests/madrugada-db.test.ts`
(quadro, pagamento, banco de horas e o fluxo do bot contra Postgres real).
