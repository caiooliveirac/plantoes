# Retirar — a chefia escolhe o que acontece com o plantão

O botão **Retirar** do quadro (titular, deslocado ou dupla) abre o modal com a
hora da saída e **quatro opções**. A régua de saída antecipada só **sugere** e
pré-seleciona; quem decide é o chefe.

| Opção | Pagamento | Banco de horas | Gravado |
|---|---|---|---|
| Remover sem saldo | não recebe | nada | `no_balance` |
| Saldo para o banco de horas | não recebe | horas trabalhadas na janela | `bank_only` |
| Pagar meio plantão | meio | o que passar de 6h trabalhadas | `half_shift` |
| Pagar plantão inteiro | inteiro | nada | `full_shift` |

"Sem saldo" é para quem **nem estava no plantão**: erro de chefia que não
retirou antes, madrugada declarada como SD antes de existir o comando
([madrugada.md](madrugada.md)). Caso de origem: 1362, 29/09/2026 — quem cobriu
a madrugada ficou com um SD aberto, deslocado às 07:02, e sairia pago em dobro
com o titular do dia (deslocado segue pago, [chegada.md](chegada.md)).

## Régua (sugestão)

Medida da **janela** do turno, nunca da chegada
(`modules/operational/early-departure.ts`):

- menos de 6h de janela → banco; de 6h até faltar 2h → meio; faltando 2h ou
  menos → inteiro;
- horas trabalhadas contam do início da janela: chegar cedo não infla;
  atraso **até 15 min** não tira nada (mesma tolerância do banco de horas);
  acima disso conta da chegada.

## Limites

- **Pagar acima da régua pede justificativa** (8+ caracteres), exceto inteiro
  na faixa de meio — mesma regra da fila de saídas. Pagar abaixo (sem saldo,
  banco) é um clique.
- **Saída que já não é antecipada** (no fim da janela ou depois) só aceita o
  plantão inteiro: o pagamento ignora desfecho fora do slot, e um "sem saldo"
  ali seria pago calado.
- Meio plantão declarado (`MEIO_PLANTAO`) não entra na régua: o modal não
  mostra as opções e o servidor recusa escolha.
- Bot e desativação de posto continuam gravando a sugestão da régua.

Validação: `validateChiefWithdrawalChoice` (pura) e
`resolveChiefWithdrawalOutcome` (`modules/operational/departure-triage.ts`),
chamadas em `endRegulationOccupancy`/`endInterventionOccupancy`.

## Onde o desfecho é lido (mexer aqui se nascer valor novo)

- `modules/operational/early-departure.ts` — `isStored…`,
  `isPaymentAffecting…`, `resolveEarlyDeparturePaymentUnit`;
- `modules/reporting/payable-shifts.ts` — unidade e tag (`SEM SALDO`, `BANCO`,
  `MEIO`) só no slot em que a saída caiu;
- `modules/bank-hours/service.ts` + `calculator.ts`
  (`buildEarlyDepartureBankHours`) — crédito do desfecho;
- `modules/reporting/turno-outcome.ts` — sombra do ADR-007;
- `modules/operational/early-departure-copy.ts` — texto do aviso no grupo;
- `components/payment-closing/half-shift-decision.tsx` — rótulo no fechamento.

Guardas: `tests/early-departure.test.ts`, `tests/payable-shifts.test.ts`,
`tests/retirar-desfecho-db.test.ts` (Postgres real, caso 1362).
