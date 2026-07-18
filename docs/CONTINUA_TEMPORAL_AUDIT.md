# Auditoria temporal do fluxo "continua" — bug Manuella Barreto

> Auditoria 2026-05-15. Sistema: bot Telegram do SAMU (TypeScript + Drizzle).
> Objetivo: garantir que "continua" seja interpretado como **intenção temporal
> discreta** (próximo turno), nunca como permanência indefinida / plantão de 36h.

---

## 0. TL;DR

- O bug **já está parcialmente corrigido no working tree** (mudanças sem commit).
  Um guard em `resolveRegulationContinuationScheduledEndAt` impede que uma
  mensagem de "reforço" dentro da janela já coberta estenda o plantão para 36h.
- Existe **código morto**: `resolveContinuationCoverage` /
  `resolveAnnouncedContinuationEndAt` foram adicionados em
  `modules/operational/rules.ts` mas **não estão ligados a nada**. Era o esboço
  de uma camada central de interpretação que ficou pela metade.
- A semântica de "continua" continua **espalhada** por ~5 funções em 3 módulos.
- Não existe **teste de regressão nomeado para o caso Manuella Barreto**.
- Risco residual de **assimetria**: regulação e intervenção continuam plantão
  com lógicas diferentes (`resolveRegulationContinuationScheduledEndAt` vs.
  cálculo inline em `continueInterventionOccupancy`).

---

## 1. Mapa dos arquivos envolvidos

| # | Etapa | Arquivo | Símbolos-chave |
|---|-------|---------|----------------|
| 1 | Recepção da mensagem Telegram | `modules/telegram/service.ts` | `processTelegramUpdate`, `logTelegramMessage` |
| 2 | Parser de texto | `modules/telegram/parser.ts` | `parseMessage`, `parseMessageMulti`, `CONTINUATION_SIGNALS` (linhas 40-50) |
| 3 | Interpretação de "continua" | `modules/telegram/service.ts` | `isTelegramContinuationEntry`, `isTelegramContinuationIntent`, `shouldTreatTelegramArrivalAsContinuation`, `applyParsedEntry` |
| 3 | Cálculo de cobertura | `modules/operational/rules.ts` | `resolveContinuationCoverage` *(morto)*, `inferRegulationScheduledEndAt`, `resolveContinuationBoardStartedAt` |
| 4 | Persistência (regulação) | `modules/regulation/service.ts` | `continueRegulationOccupancy`, `resolveRegulationContinuationScheduledEndAt`, `resolveRegulationContinuationExplicitScheduledEndAt` |
| 4 | Persistência (intervenção) | `modules/intervention/service.ts` | `continueInterventionOccupancy` (lógica inline própria) |
| 5 | Painel operacional | `services/board.service.ts`, `modules/operational/board-rules.ts` | `shouldKeepRegulationOccupancyVisible`, `resolveProlongedShiftExpiry`, `resolveImplicitOccupancyExpiry`, `doesCandidateCoverPaymentSlot` |
| 6 | Bank Hours | `modules/bank-hours/{calculator,continuity,service}.ts` | `buildContinuityBankHoursSpan`, `syncBankHoursByContinuityGroup` |
| 7 | Payment Attestation | `services/payment-attestation.service.ts` | `buildPaymentAttestationPreview` |
| 8 | Slot Audit | `services/slot-audit.service.ts` | `mapAuditEntry` |
| 9 | Payment Closing | `services/payable-shifts.service.ts`, `modules/reporting/payable-shifts.ts` | `resolveDurationMinutes` |
| 10 | Folha de ponto / relatório mensal | `services/monthly-report.service.ts`, `modules/reporting/monthly-report*.ts` | `hasOpenShift`, `buildContinuityCarrierLookup` |
| 11 | Schema | `db/schema.ts` | `regulationOccupancies`, `interventionOccupancies`, `telegramIngestedMessages`, coluna `continuityGroupId` |

Tabelas que participam da inferência de presença: `regulation_occupancies`,
`intervention_occupancies` (colunas `started_at`, `ended_at`, `actual_ended_at`,
`scheduled_start_at`, `scheduled_end_at`, `board_started_at`, `shift_label`,
`continuity_group_id`), `bank_hours_entries`, `telegram_ingested_messages`.

---

## 2. Fluxo atual (diagrama textual)

```
Mensagem Telegram ("Manuella continua")
   │
   ▼
processTelegramUpdate()                          modules/telegram/service.ts
   │  logTelegramMessage() → INSERT telegram_ingested_messages
   │                         (onConflictDoNothing em chatId+messageId → idempotência por msg)
   ▼
parseMessageMulti() → parseMessage()             modules/telegram/parser.ts
   │  CONTINUATION_SIGNALS.some(...) → isContinuation = true
   │  multi-médico: split por linha/pontuação; flag propagada por contexto
   ▼
applyParsedEntry()                               modules/telegram/service.ts
   │  effectiveShiftType forçado para "P" quando isContinuation
   │  busca occupancy ATIVA no posto/base
   │
   ├── shouldTreatTelegramArrivalAsContinuation() == true  ─┐
   │       e existe occupancy ativa                          │
   │                                                         ▼
   │   continueRegulationOccupancy(activeOccupancy.id)   modules/regulation/service.ts
   │       │  shiftLabel := "P"
   │       │  scheduledEndAt := resolveRegulationContinuationScheduledEndAt(...)
   │       │  endedAt permanece NULL  ◄── ocupação segue ABERTA
   │       ▼
   │   UPDATE regulation_occupancies
   │
   └── senão → startRegulationOccupancy() cria NOVA ocupação (turno discreto)
   │
   ▼
sendSuccessReply()  → resposta ao médico (com aviso de plantão prolongado se >25h)
```

Leitura a jusante: o painel mostra a ocupação como ativa até `scheduled_end_at`
(+ grace). Bank Hours / Payment / Folha só consolidam quando a ocupação fecha
(`ended_at`/`actual_ended_at` preenchidos).

---

## 3. Hipótese da causa do bug (Manuella Barreto)

Manuella estava num plantão **P** (continuidade já registrada, p.ex. desde
07:00). Alguém escreveu "Manuella continua" **dentro da janela de 24h já
coberta** (ex.: às 19:00 do mesmo dia — virada de turno).

Na lógica **antiga**, `resolveRegulationContinuationScheduledEndAt` calculava
`fromContinuation` = janela P **nova** ancorada na hora da mensagem (19:00) e
devolvia `max(fromExisting, fromContinuation)`. Como a mensagem das 19:00 gera
uma janela P que termina às 07:15 do **dia seguinte ao seguinte**, o
`scheduledEndAt` saltava para ~36h. A ocupação seguia **aberta** (`ended_at`
NULL) e o painel exibia Manuella ativa por 36h — sem que ela jamais tivesse
avisado saída, e sem evento explícito do turno seguinte.

Raiz conceitual: o código tratava "continua" como **extensão da duração** do
plantão atual, não como **declaração discreta sobre o próximo turno**. Ausência
de saída + palavra "continua" = permanência inflada.

---

## 4. Riscos encontrados

| ID | Risco | Local | Severidade |
|----|-------|-------|------------|
| R1 | "continua" dentro da janela coberta estende para 36h | `resolveRegulationContinuationScheduledEndAt` | **Alto** — *corrigido no working tree* |
| R2 | Camada central `resolveContinuationCoverage` é código morto; semântica real continua espalhada | `modules/operational/rules.ts` | Médio |
| R3 | Regulação e intervenção usam lógicas de continuação diferentes (regulação tem o guard; intervenção calcula inline e não o tem) | `continueInterventionOccupancy` | Médio |
| R4 | Ocupação continuada nunca recebe `ended_at`; depende de `scheduled_end_at` + auto-checkout para fechar | `continueRegulationOccupancy` | Médio |
| R5 | Sem teste de regressão nomeado para o caso Manuella | `tests/` | Médio |
| R6 | `isContinuation` propagado por contexto em mensagens multi-médico pode contaminar entradas vizinhas sem sinal próprio | `parser.ts` `enrichParsedEntryFromContext` | Baixo/Médio |
| R7 | Idempotência só por `(chatId, telegramMessageId)`; "continua" reenviado como nova mensagem reprocessa | `telegram_ingested_messages` | Baixo |

Onde **não** há risco financeiro relevante (verificado): Bank Hours rejeita span
não fechado (`syncBankHoursByContinuityGroup` exige `isClosed`), Payment
Attestation/Slot Audit trabalham em janela de 12h, Payable Shifts/Folha marcam
`needs_review`/`hasOpenShift` para ocupação aberta. O dano do bug é
**operacional/percepção** (painel), não pagamento automático — mas vira dano
financeiro se um humano atestar o painel inflado.

---

## 5. Estado atual do working tree (sem commit)

Já aplicado (e com 87 testes `operational-rules` passando):

- `modules/regulation/service.ts`: guard em `resolveRegulationContinuationScheduledEndAt`
  — se a continuação ocorre **antes** do fim já coberto, não estende (R1).
- `modules/operational/rules.ts`: `resolveContinuationCoverage` /
  `resolveAnnouncedContinuationEndAt` adicionados — **NÃO ligados** (R2).
- `services/board.service.ts`: `doesCandidateCoverPaymentSlot` limita cobertura
  de um P a 24h lógicas (não vaza para um 3º slot de pagamento).
- `modules/telegram/service.ts`: flag `extendedLongShift` + aviso na resposta
  do bot quando a cobertura passa de 25h.
- `tests/operational-rules.test.ts`: expectativas atualizadas.

Pendente: wiring/limpeza de R2, paridade de intervenção (R3), regressão
Manuella (R5).

---

## 6. Onde a regra deve ficar centralizada

`modules/operational/rules.ts` já é o ponto correto. `resolveContinuationCoverage`
é o candidato natural a função única de interpretação. Decisão necessária:
**ligar e usar** essa função (regulação + intervenção) **ou removê-la** e
documentar o guard atual como a regra canônica. Não deixar as duas coexistindo.

---

## 7. Plano de testes proposto

1. Unit — `resolveContinuationCoverage`/`resolveRegulationContinuationScheduledEndAt`:
   continuação dentro da janela = reforço (não estende); após a janela = +1 bloco;
   além de 36h = rejeitada.
2. Parser — `isContinuation` para "continua/segue/fica/permanece"; multi-médico
   não contamina vizinhos (R6).
3. Persistência/idempotência — "continua" repetido não duplica ocupação/pagamento.
4. Integração painel — médico de SD às 18:00 "continua": SD discreto + SN
   preparado; sem bloco 36h.
5. Regressão nomeada **Manuella Barreto**: P desde 07:00, "continua" às 19:00 →
   `scheduledEndAt` continua em ~24h, nunca 36h.
6. Timezone America/Bahia (UTC-3) na virada 07:00/19:00.

---

## 8. Como auditar manualmente um caso como Manuella no banco

```sql
-- Ocupações da médica nos últimos 3 dias
SELECT ro.id, d.full_name, ro.shift_label, ro.started_at, ro.board_started_at,
       ro.scheduled_start_at, ro.scheduled_end_at, ro.ended_at, ro.actual_ended_at,
       ro.continuity_group_id, ro.source
FROM regulation_occupancies ro
JOIN doctors d ON d.id = ro.doctor_id
WHERE d.full_name ILIKE '%manuella%barreto%'
ORDER BY ro.started_at DESC;
```

Sinais de alerta: `scheduled_end_at - board_started_at > 24h`; `ended_at` NULL
muito além de `scheduled_end_at`; uma única linha cobrindo SD+SN+SD.

```sql
-- Mensagem Telegram que originou a continuidade
SELECT raw_text, parsed_action, status, related_occupancy_id, processed_at
FROM telegram_ingested_messages
WHERE raw_text ILIKE '%manuella%' AND raw_text ILIKE '%continu%'
ORDER BY processed_at DESC;
```

---

## 9. Próximos hardenings sugeridos

- Auto-checkout determinístico ao fim de `scheduled_end_at` (não depender de
  nova mensagem para fechar a ocupação).
- Persistir a classificação da continuidade (`reinforcement`/`standard`/
  `extended`/`rejected`) em `resolution_data` para audit trail.
- Resposta do bot sempre verbosa: "Entendi que <médica> continuou do SD para o
  SN de hoje; registrei o SN como turno separado."
- Unificar regulação e intervenção numa única função de continuidade.
