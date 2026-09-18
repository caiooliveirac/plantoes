# modules/ e services/ — lógica de domínio

> Carregado sob demanda: só entra no contexto quando um arquivo desta pasta é lido. Índice na raiz: [CLAUDE.md](../CLAUDE.md)

**Lógica de negócio central** (`modules/`, o que mais importa para novas features):
- `modules/operational/` — regras de turno/horário SP, correções administrativas
  (`corrections.ts`), sistema de undo com journaling (`undo.ts`), feriados
- `modules/regulation/` e `modules/intervention/` — operações de criar/encerrar/corrigir
  ocupações nos dois domínios paralelos (regulação = ramais telefônicos; intervenção =
  bases de ambulância)
- `modules/bank-hours/` — cálculo de banco de horas (atraso, hora extra, continuidade)
- `lib/contracts/` (puro) + `services/contract-balance.service.ts` + as varreduras de
  `modules/telegram/contract-balance-alerts.ts` — saldo de contrato: métricas do ciclo,
  read model e os avisos que saem às 8h para os admins. Domínio com armadilhas de dado
  documentadas — ver [docs/saldo-contrato/README.md](../docs/saldo-contrato/README.md).
- `modules/reporting/` — turnos pagáveis, histórico de banco de horas, relatório mensal
  (inclui exportação XLSX)
  > ⚠️ **Risco financeiro.** Um médico recebe no máximo um plantão por slot de 12h,
  > mesmo registrado em dois alvos (`suppressSameDoctorDuplicateRows` em
  > `services/board.service.ts`). Regra e cenários em
  > [docs/adr/006-one-payment-per-doctor-slot.md](../docs/adr/006-one-payment-per-doctor-slot.md);
  > `tests/payment-duplicate-guard.test.ts` é o guarda no CI — não relaxe sem ler o ADR.
- `modules/telegram/` — o maior módulo do repo; `service.ts` é um "god module" de
  ~12k linhas que roteia toda a lógica do bot (parsing, comandos, meal breaks,
  lembretes, pagamento). Está fragmentado em vários arquivos auxiliares
  (`parser.ts`, `meal-breaks.ts`, `departure-flow.ts`, `reminders.ts`, etc.) mas
  `service.ts` continua sendo o hub.

> **Dois bots, não um.** O bot deste repo ("Plantões SAMU", webhook) vive no
> grupo da escala e cuida de chegada/saída. O "bot regulador" é outro token,
> outro grupo e **outro repo** (`tabela`): vagas de leito e restrição de UPA. Os
> avisos periódicos de UPA restrita saem de lá, não daqui — este app só lê
> `GET {TABELA_API_URL}/upas/restrictions` para a chegada do regulador e o
> `/upas`. Ver [docs/upas-restritas.md](../docs/upas-restritas.md).

**`services/`** é a camada que monta read models para as páginas/API a partir dos
`modules/` + queries diretas ao banco — ex.: `board.service.ts` monta o estado do
quadro ao vivo; `payment-attestation.service.ts` e `payment-closing-*.service.ts`
cuidam do fechamento mensal.

