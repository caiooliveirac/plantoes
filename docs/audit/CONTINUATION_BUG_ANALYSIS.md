# Continuation Bug — Análise técnica (Fase 1)

> Auditoria somente de leitura. Nenhum dado foi alterado. Caso de validação:
> 26/04/2026, PR03, Caio Oliveira (continuou) vs Taiane Pinto (prejudicada).
> Caio estava na regulação 2153 no diurno e enviou "Caio continua PR03" no noturno.

## Resumo executivo

O bug **NÃO** é uma sobrescrita de `doctor_id` no registro do colega prejudicado.
A linha de Taiane na `intervention_occupancies` está intacta (ver query abaixo).
O que o usuário vê como "PR03 diurno reescrito como Caio Oliveira" é **deslocamento
na projeção de pagamento**: o snapshot `payment_attestation_slot_entries` de
26/04 SD PR03 atribui a Caio (`payment_status: ready_for_payment`) e Taiane
desaparece do alvo.

A causa é **anterior** ao snapshot: o registro da `intervention_occupancies` que
o bot cria para "Caio continua PR03" nasce com `started_at = 07:10` (horário
de chegada original do Caio no diurno na 2153) em vez de `started_at = ~20:00`
(quando ele de fato passou para a PR03). Esse "fantasma de cobertura" faz com
que `resolveSuccessorStartMap` enxergue Caio como sucessor da Taiane na PR03 e
**colapse a `effectiveEndedAt` da Taiane para 07:10**, derrubando-a a 5 minutos
de duração — abaixo de `MIN_TITULAR_DURATION_MINUTES = 45` — e ela é filtrada
como `isMicroCoverage`, sumindo do alvo.

## Mapeamento dos arquivos relevantes (escopo real do repo)

| Camada | Arquivo | Função-chave |
|---|---|---|
| Parser de mensagem | `modules/telegram/parser.ts` | `parseMessage`, `CONTINUATION_SIGNALS`, `extractNames` |
| Processor (orquestrador) | `modules/telegram/service.ts` | `findTelegramContinuityContext`, `resolveTelegramContinuationStartedAt`, `closeTelegramActiveContinuityOccupancies`, branches de regulação e intervenção em `processOperationalEntry` (linhas ~5950–6280) |
| Domínio operacional | `modules/regulation/service.ts` | `startRegulationOccupancy`, `continueRegulationOccupancy`, `endRegulationOccupancy` |
| Domínio operacional | `modules/intervention/service.ts` | `startInterventionOccupancy`, `continueInterventionOccupancy`, `endInterventionOccupancy` |
| Schema | `db/schema.ts` | `regulationOccupancies`, `interventionOccupancies`, `shiftEvents`, `paymentAttestationSlotEntries` |
| Projeção/alocação | `services/board.service.ts` | `buildPaymentAllocationBoardModel`, `resolveSuccessorStartMap`, `resolveCandidateEffectiveEndedAt`, `isMicroCoverage`, `rankPaymentAllocationCandidate`, `resolvePaymentAllocationTargetChoices` |
| Projeção/alocação | `services/payable-shifts.service.ts` | `loadRawRows`, `buildBoardsForRange`, `getChiefPayableShiftsBoard` |
| Projeção/alocação | `services/payment-attestation.service.ts` | gera/persiste o snapshot `payment_attestation_slot_entries` |

> Observação importante: o enunciado original referia `src/server/telegram/*` e
> uma tabela `shift_current_state` que **não existem** no repo. O equivalente
> conceitual de "estado atual do slot" é derivado em runtime das duas tabelas
> de ocupância (`regulation_occupancies` / `intervention_occupancies`) pelas
> funções de board.

## Schema das tabelas envolvidas

`operations_v2` (ver `db/schema.ts`):

- `regulation_occupancies` (PK uuid `id`):
  `doctor_id`, `post_id`, `continuity_group_id`, `started_at`, `board_started_at`,
  `scheduled_start_at`, `scheduled_end_at`, `ended_at`, `actual_ended_at`,
  `shift_label` ("SD"/"SN"/"P"/null), `role_label`, `ramal_label`, `source`,
  `notes`, `updated_by_user_id`.
- `intervention_occupancies` (PK uuid `id`): mesmo formato com `base_id` no
  lugar de `post_id`.
- `shift_events`: log genérico (domain, entity, eventType, payload, occurredAt).
  Não é usado como projeção de slot — só auditoria.
- `payment_attestation_slot_entries` (e `payment_attestation_slots`): snapshots
  que materializam a alocação por (operational_date, shift_label, target_code).
  Cada entry guarda `occupancy_id`, `doctor_id`, `payment_status`, `issues`.

`shift_label = "P"` significa "plantão de 24h / cobertura prolongada" e
desbloqueia regras de continuidade na projeção (ex.: `doesCandidateCoverPaymentSlot`
permite que um candidato com `shiftLabel="P"` cubra também o slot seguinte).

## Regex de continuação (parser)

`modules/telegram/parser.ts:40-50` — `CONTINUATION_SIGNALS`:

```
/\b(?:CONT\.?|CONTINHA|CONTINUO|CONTINUA|CONTINUANDO|CONTINUEI|CONTINUAREI|CONTINUAR)\b/i
/\b(?:SEGUINDO|SEGUE|SEGUI|SIGO|SEGUIR)\b/i
/\b(?:FICO|FICANDO|FIQUEI|FICAR)\b/i
/\b(?:PERMANEC?O|PERMANECENDO|PERMANECE|PERMANECER)\b/i
/\b(?:EMENDO|EMENDANDO|EMENDA|EMENDAR)\b/i
/\b(?:PROSSIGO|PROSSEGUINDO|PROSSEGUIR)\b/i
/\bJA\s+(?:TO|TO|ESTOU)\s+(?:NA|NO)\b/i
/\bNAO\s+(?:SAI[O]?|SAIO)\b/i
/\b(?:VOU|VAI|VAMOS)\s+(?:CONTINUAR|...)\b/i
```

`parseMessage()` (`parser.ts:262-383`) extrai `baseCode`, `arrivalTime`,
`shiftType`, `roleFunction`, `extractedNames` e seta `isContinuation = true`
quando algum dos regex acima casa e `isReassignment` é falso. A entidade
parseada é apenas estrutural — toda a lógica de DB acontece no processor.

## Fluxograma textual do processamento atual

Para uma mensagem `"Caio Oliveira continua PR03"` recebida no horário
2026-04-26 20:03 (noturno):

1. `parseMessage` → `{ sector: "INTERVENTION", baseCode: "PR03", isContinuation: true, shiftType: null, extractedNames: ["Caio Oliveira"] }`.
2. Resolve médico via `name-resolution`. → `resolvedDoctor.id = Caio.id`.
3. Branch de intervenção (`service.ts:6090-6282`):
   - `activeOccupancy` = `intervention_occupancies` ativa de **Caio em PR03** → **NULL** (Caio nunca esteve na PR03).
   - `shouldContinueActiveOccupancy = false` (não há ativa do mesmo médico nessa base).
   - Cai no _else_ a partir de `service.ts:6190`.
   - `continuityContext = findTelegramContinuityContext({ doctorId: Caio.id, eventAt })` (`service.ts:963-1002`).
     Procura todas as ocupâncias de Caio em ambos domínios.
     - Encontra a 2153 diurna (ativa ou recém-fechada) como `source`.
     - `continuityStartedAt = source.boardStartedAt ?? source.startedAt = 07:10` (Caio na 2153 às 07:10 do dia).
   - `shouldUseContinuityContext = true` (cross-domain regulação→intervenção, dentro da janela).
   - `closeTelegramActiveContinuityOccupancies({ doctorId: Caio.id, eventAt })` (`service.ts:1117-1152`):
     fecha ativas próprias do **Caio** com `endedAt = eventAt = 20:03`. Importante:
     **não toca em ocupâncias de outros médicos** (filtro `doctorId`). Taiane
     está intacta após esse passo.
   - `continuationStartedAt = resolveTelegramContinuationStartedAt({ eventAt, continuityStartedAt: 07:10, ... })` (`service.ts:1103-1115`):
     como `07:10 <= 20:03 + 15min`, retorna **07:10**.
   - `continuationBoardStartedAtIntv = continuityContext.continuityStartedAt = 07:10`.
   - `effectiveShiftType = "P"` (cross-shift link força "P").
   - `crossShiftExpiryIntv = resolveProlongedShiftExpiry(07:10, "P")` ≈ 27/04 07:00. Como `27/04 07:00 > 20:03`, **`effectiveContinuationStartedAtIntv = 07:10`** (não recua para `eventAt`).
   - Chama `startInterventionOccupancy({ doctorId: Caio, baseId: PR03, continuityGroupId: <herdado>, startedAt: 07:10, boardStartedAt: 07:10, shiftLabel: "P", ... })` (`service.ts:6257-6271`).
4. Dentro de `startInterventionOccupancy` (`modules/intervention/service.ts:295-654`):
   - `existingSameDoctor` (Caio, PR03, ativo) → null.
   - `otherBaseOccupancy` (Caio, base != PR03, ativo em **intervenção**) → null (a 2153 é regulação, não intervenção).
   - `currentBoardCarrier` (PR03, com boardStartedAt e ativo) → **Taiane** (PR03 SD, ainda ativa às 19:25? — ela só fechou às 19:25; o bot dispara aqui às 20:03, então quando o pipeline rodou ela já estava fechada). Se ela está fechada, esse carrier vem null e nada é fechado.
   - `INSERT` em `intervention_occupancies`:
     ```
     started_at      = 2026-04-26 07:10:00  ← AQUI O DEFEITO
     board_started_at = 2026-04-26 07:10:00
     scheduled_end_at = 2026-04-27 07:00:00
     shift_label     = "P"
     continuity_group_id = (mesmo da 2153 do Caio)
     source          = "telegram"
     doctor_id       = Caio
     base_id         = PR03
     ```
5. Resultado em DB (verificado por SELECT — ver Apêndice A):
   - Taiane PR03 SD: intacta, `started_at=07:05`, `actual_ended_at=19:25`.
   - Caio PR03 P: novo, `started_at=07:10`, `actual_ended_at=27/04 08:03`.

## Trecho exato do defeito

`modules/telegram/service.ts:6229-6271` (branch de intervenção, mesmo padrão
existe em `service.ts:6034-6079` para regulação):

```ts
const continuationStartedAt = shouldUseContinuityContext
    ? resolveTelegramContinuationStartedAt({
        eventAt,
        shiftType: parsed.shiftType,
        continuityStartedAt: continuityContext?.continuityStartedAt,
        sourceStartedAt: continuityContext?.source?.startedAt,
    })
    : eventAt;
const continuationBoardStartedAtIntv = shouldUseContinuityContext && continuityContext?.source
    ? new Date(continuityContext.continuityStartedAt ?? continuityContext.source.startedAt)
    : undefined;

// ... crossShiftExpiry guard ...
const effectiveContinuationStartedAtIntv = crossShiftExpiryIntv && crossShiftExpiryIntv.getTime() <= eventAt.getTime()
    ? eventAt
    : continuationStartedAt;

const intResult = await startInterventionOccupancy({
    doctorId: resolvedDoctor.id,
    baseId: base.id,
    continuityGroupId: shouldUseContinuityContext ? continuityContext?.source?.continuityGroupId ?? null : null,
    startedAt: effectiveContinuationStartedAtIntv,        // ← passa 07:10
    boardStartedAt: continuationBoardStartedAtIntv,       // ← passa 07:10
    shiftLabel: effectiveShiftType,                       // "P"
    ...
});
```

`resolveTelegramContinuationStartedAt` (`service.ts:1103-1115`):

```ts
export function resolveTelegramContinuationStartedAt(params: {...}) {
    const continuityAnchor = params.continuityStartedAt ?? params.sourceStartedAt ?? null;
    if (continuityAnchor && continuityAnchor.getTime() <= params.eventAt.getTime() + 900000) {
        return new Date(continuityAnchor);
    }
    return resolveContinuationShiftStart(params.eventAt, params.shiftType);
}
```

A intenção comentada em volta dessa lógica (linhas 6046-6048 e 6242-6245) é
explícita: _"Any continuity link means the doctor is crossing from a previous
shift occupation into this one — the effective shift is always P (24h coverage)"_.

A implementação herda corretamente o `boardStartedAt` (que é o anchor de
continuidade — campo correto) — mas **também** sobrescreve o `startedAt`
do novo registro com o anchor antigo. **Isso é o defeito**: `started_at`
representa "quando esse médico chegou neste posto"; usá-lo como anchor de
continuidade cria um registro que afirma, pela presença em DB, que o
Caio chegou na **PR03 às 07:10** — quando na verdade ele só passou a
ocupar a PR03 às 20:03.

## Hipótese técnica precisa do defeito

> Em `modules/telegram/service.ts:6034-6079` (regulação) e `:6229-6271`
> (intervenção), quando `shouldUseContinuityContext` é verdadeiro e o médico
> está mudando de posto/base entre turnos, o cálculo de `continuationStartedAt`
> usa o `continuityStartedAt` (o `started_at`/`boardStartedAt` da ocupância
> anterior em outro alvo) como o **`startedAt`** da nova ocupância. O
> `boardStartedAt` é o campo correto para o anchor de continuidade — ele
> existe exatamente para preservar prioridade de fila e cálculo de banco
> de horas. O `startedAt` deveria ser **`eventAt`** (o instante real em que a
> mensagem "continua X" foi processada), porque é o instante em que o médico
> efetivamente passou a ocupar o NOVO alvo.

Como o `started_at` da nova ocupância cai dentro da janela do **turno
anterior**, três efeitos colaterais lethal acontecem na projeção:

1. **`resolveSuccessorStartMap`** (`board.service.ts:734-775`) agrupa os candidatos
   por `(domain, targetCode)` e, para cada candidato, pega como sucessor o
   próximo `startedAt` de um médico **diferente**. Para Taiane (PR03 SD,
   started 07:05), o sucessor passa a ser Caio (PR03 P, started 07:10).
2. **`resolveCandidateEffectiveEndedAt`** (`board.service.ts:777-826`) linha 797:
   `if (explicitEndAt && successorStartedAt && explicitEndAt > successorStartedAt) return successorStartedAt`.
   Como Taiane fechou às 19:25 e o "sucessor" Caio começou 07:10,
   `effectiveEndedAt` da Taiane é colapsado para **07:10**.
3. **`isMicroCoverage`** (`board.service.ts:1122-1127`) marca duração 5 min
   como ruído. O filtro em `buildPaymentAllocationBoardModel`
   (`board.service.ts:2497`) remove a Taiane completamente do conjunto de
   candidatos. Caio fica sozinho na disputa pela PR03 SD e ganha. Em seguida,
   na 2153 SD, Caio é considerado já alocado e o slot fica como
   `displacedByDoctorConflict` — exatamente o que o snapshot mostra
   (Apêndice B).

A regra adjacente importante: a função `closeTelegramActiveContinuityOccupancies`
(`service.ts:1117-1152`) está correta — ela só fecha ocupâncias do **mesmo médico**
que está continuando, nunca toca em registros de terceiros. **Não é por aí
que a Taiane some**; ela some na projeção, derivada do `started_at` mentiroso
do Caio.

## Apêndice A — evidência bruta no DB (`SELECT` apenas)

```sql
SET search_path = operations_v2;
SELECT d.full_name, io.id, ib.code AS base, io.continuity_group_id,
       io.shift_label, io.role_label,
       io.started_at AT TIME ZONE 'America/Sao_Paulo'  AS started_local,
       io.board_started_at AT TIME ZONE 'America/Sao_Paulo' AS board_started_local,
       io.scheduled_end_at AT TIME ZONE 'America/Sao_Paulo' AS sched_end_local,
       io.ended_at         AT TIME ZONE 'America/Sao_Paulo' AS ended_local,
       io.actual_ended_at  AT TIME ZONE 'America/Sao_Paulo' AS actual_end_local,
       io.notes, io.created_at AT TIME ZONE 'America/Sao_Paulo' AS created_local
FROM intervention_occupancies io
JOIN doctors d ON d.id = io.doctor_id
JOIN intervention_bases ib ON ib.id = io.base_id
WHERE ib.code = 'PR03'
  AND io.started_at >= '2026-04-26 00:00:00-03'
  AND io.started_at <  '2026-04-27 00:00:00-03'
ORDER BY io.started_at;
```

Resultado:

| full_name | shift_label | started_local | actual_end_local | continuity_group_id | notes | created_local |
|---|---|---|---|---|---|---|
| Taiane Pinto Menezes  | SD | 2026-04-26 07:05:40 | 2026-04-26 19:25:22 | f9df1f76-… | Taiane Pinto pr03 sd | 2026-04-26 07:05:40 |
| Caio Oliveira do Carmo | **P** | **2026-04-26 07:10:00** | 2026-04-27 08:03:36 | **7ffdf42f-…** | Caio continua PR03 | **2026-04-26 20:03:21** |

Caio na regulação 2153 no mesmo dia (mesmo `continuity_group_id`):

| full_name | post | shift_label | role | started_local | actual_end_local | continuity_group_id |
|---|---|---|---|---|---|---|
| Caio Oliveira do Carmo | 2153 | _(null)_ | RECIP | 2026-04-26 07:10:00 | 2026-04-26 18:54:00 | **7ffdf42f-…** |

Notas:
- A linha do Caio na PR03 foi **inserida** às 20:03:21, mas afirma `started_at = 07:10`.
- O `continuity_group_id` `7ffdf42f-…` é compartilhado entre a 2153 do diurno
  e a PR03 do "P". Isso confirma que o pipeline de continuidade ligou
  corretamente os dois eventos — o problema é só na escolha do `started_at`.

## Apêndice B — efeito no snapshot de pagamento

```sql
SELECT pas.shift_label, pase.target_code, pase.doctor_name,
       pase.payment_status, pase.candidate_count, pase.issues, pase.occupancy_id
FROM payment_attestation_slots pas
JOIN payment_attestation_slot_entries pase ON pase.slot_id = pas.id
WHERE pas.operational_date::date = '2026-04-26'
  AND pase.target_code IN ('PR03','2153')
ORDER BY pas.shift_label, pase.target_code;
```

| shift | target | doctor | status | issues |
|---|---|---|---|---|
| SD | 2153 | _(empty)_ | needs_review | "Todos os candidatos deste alvo conflitam com alocacoes mais confiaveis do mesmo turno" |
| **SD** | **PR03** | **Caio Oliveira do Carmo** | **ready_for_payment** | [] |
| SN | 2153 | Indira Aparecida Parron Costa | ready_for_payment | [] |
| SN | PR03 | Caio Oliveira do Carmo | ready_for_payment | [] |

Taiane **não aparece** no alvo PR03 SD do snapshot. Caio é apresentado como
plantonista PR03 do diurno. É exatamente esse o "Diurno PR03 reescrito como
Caio Oliveira" que o usuário relata — ele acontece na projeção, não na linha
da Taiane na `intervention_occupancies` (que continua intacta).

## Conclusão da Fase 1

- O bug não é uma sobrescrita de `doctor_id`. As linhas do colega prejudicado
  permanecem intactas em `intervention_occupancies` / `regulation_occupancies`.
- O defeito está em **`modules/telegram/service.ts`** nas linhas
  **6034-6079** (regulação) e **6229-6271** (intervenção): ao continuar para
  outro alvo entre turnos, o `startedAt` do novo registro recebe o anchor
  de continuidade (07:10 do diurno) em vez do `eventAt` (20:03 do noturno).
- O efeito visível ("PR03 reescrito como Caio") é mediado por
  `services/board.service.ts` em `resolveSuccessorStartMap`,
  `resolveCandidateEffectiveEndedAt`, `isMicroCoverage` e
  `resolvePaymentAllocationTargetChoices`, que cooperam para descartar a
  Taiane como candidata válida.

Aguardando aprovação para Fase 2 (busca retroativa de vítimas nos últimos
60 dias).
