# Continuation Bug — Plano de correção aplicado (Fase 3)

> Continuação das Fases 1 (análise técnica) e 2 (vítimas).
> Aplicado em branch `fix/continuation-startedat` em maio/2026.

## Objetivo

Eliminar o defeito documentado em `CONTINUATION_BUG_ANALYSIS.md`, **sem alterar
o comportamento visível no painel** (médico continua aparecendo com o horário
de chegada original — manhã). A correção atua em três frentes complementares.

## Frente 1 — Origem (INSERT em `modules/telegram/service.ts`)

**Onde:** branches de regulação (linhas ~6010–6090) e intervenção
(linhas ~6205–6285) dentro de `processOperationalEntry`.

**Diagnóstico:** quando o pipeline detectava `shouldUseContinuityContext` para
um médico mudando de posto/base entre turnos, o `startedAt` do novo registro
recebia o anchor de continuidade (07:10 do diurno) em vez do `eventAt`
(20:03 do noturno). O `boardStartedAt` já estava correto — só o `startedAt`
era usado como anchor indevidamente.

**Correção:** introduzido o sinalizador local `isCrossTargetContinuation`,
setado quando `sourceCode !== parsed.baseCode`. Quando verdadeiro:

```ts
effectiveContinuationStartedAt = eventAt;        // momento real da chegada AQUI
continuationBoardStartedAt    = anchor;          // 07:10, inalterado
shiftLabel                    = "P";             // mantém 24h coverage
continuityGroupId             = source.continuityGroupId;
```

**Efeito:**
- Painel: continua mostrando 07:10 via `boardStartedAt ?? startedAt` em
  `app/operational-board-client.tsx:458`.
- Pagamento: o sucessor real da Taiane na PR03 SD passa a ser o Caio às
  20:03 (não às 07:10), portanto `resolveCandidateEffectiveEndedAt` mantém
  o `actual_ended_at` explícito da Taiane (19:25) em vez de colapsar para 07:10.
- Banco de horas: continua somando a cadeia via `continuity_group_id` →
  `syncBankHoursByContinuityGroup`. Não há dedução indevida.
- Continua usando `effectiveShiftType = "P"` para herdar a regra de cobertura
  prolongada e o anchor de banco de horas.
- O guard de `crossShiftExpiry` (anchor de turno P já expirado) permanece
  ativo apenas para continuações **mesmo-alvo** (que é seu escopo natural).

## Frente 2 — Defesa em profundidade (`services/board.service.ts`)

**Onde:** `resolveSuccessorStartMap`.

**Motivação:** evitar que qualquer registro backdated remanescente (ou um
novo, caso um caminho até hoje não mapeado contorne a Frente 1) consiga
truncar a cobertura de um colega como "successor".

**Mudanças:**
1. **Mesma `continuity_group_id`** não conta como handoff — registros que
   pertencem à própria cadeia do médico nunca são "outro médico assumindo
   o alvo". Isso é redundante com o filtro `doctorId !== current.doctorId`
   no caso normal, mas blinda contra cadeias com renomeação/realocação.
2. **Telegram backdated > 6h** (`created_at - started_at > 6h` com
   `source = "telegram"`) deixa de ser elegível como sucessor que trunca
   outros. O limiar de 6h corresponde ao critério D1 do
   `CONTINUATION_BUG_VICTIMS.md` e foi escolhido para não capturar
   mensagens normalmente atrasadas (~minutos) nem correções manuais
   (`source = "admin_correction"`).

Para suportar isso, `PaymentAllocationRawRow` ganhou o campo `createdAt`
e as três queries SQL que produzem essas rows (`loadRawRows`,
`getChiefPreviousOperationalShifts` e `loadPaymentAllocationSourceData`)
foram atualizadas para projetar `created_at`.

## Frente 3.5 — Saneamento de auto-close colateral (`scripts/repair-continuation-collateral.ts`)

Descoberto durante a investigação do caso Gabriel Divino × 2034 SD do 03/05/2026:

Quando o ghost com `started_at` retroativo era inserido, a lógica de auto-close em
`modules/regulation/service.ts:478` e `modules/intervention/service.ts` (equivalente)
fechava o ocupante anterior do mesmo target setando `actual_ended_at = ghost.started_at`.
Resultado: o colega aparecia com plantão de 5-30 minutos em vez do plantão completo.

A Frente 3 original só corrigia o `started_at` do ghost — não desfazia o fechamento
retroativo aplicado ao colega. O script `repair-continuation-collateral.ts` faz isso
em uma segunda passada:

1. Lê os `shift_events` do tipo `continuation_startedat_repaired` (gerados na Frente 3).
2. Para cada um, busca ocupantes do mesmo target cujo `actual_ended_at` bate com
   `ghost.previousStartedAt` **e** cujo `updated_at` bate com `ghost.created_at`
   dentro de 5 segundos (assinatura de mesma transação).
3. Estende `ended_at` para o próximo handoff legítimo no target (próximo registro
   começando depois do `ghost.previousStartedAt`); limpa `actual_ended_at` para
   sinalizar que a saída real precisa ser revisada manualmente.
4. Insere `shift_events` de auditoria (`continuation_collateral_repaired`) e
   re-sincroniza banco de horas.

**Por que estender em vez de NULLar:** existe constraint
`*_one_active_board_per_*_idx` (UNIQUE WHERE ended_at IS NULL AND board_started_at IS NOT NULL).
Reabrir vítimas antigas violaria a constraint contra o registro hoje ativo no mesmo target.

Em produção (11/05/2026), 9 vítimas colaterais corrigidas. Caso de validação:
Gabriel Divino 2034 SD 03/05 passou de 27 min (07:09-07:36) para 763 min (07:09-19:52),
com ele agora aparecendo como `ready_for_payment` no snapshot 03/05 SD.

## Frente 3 — Saneamento dos registros existentes (`scripts/repair-continuation-startedat.ts`)

**Por que script append-only-friendly:** o repo segue regra de não deletar
registros operacionais. O script:

1. Detecta candidatos pelos critérios D1+D3+D4 do `VICTIMS.md`:
   - `source = "telegram"`
   - `shift_label = "P"`
   - `created_at - started_at > 6h`
   - Existe outro registro com mesmo `continuity_group_id` em **outro**
     `target_code` com `started_at` anterior.
2. Para cada candidato:
   - `UPDATE ... SET started_at = created_at` (move para o eventAt real).
   - `board_started_at` é mantido (preserva exibição da chegada original).
   - Insere `shift_events` com `event_type = "continuation_startedat_repaired"`
     guardando o `started_at` antigo e o novo.
   - Re-sincroniza banco de horas via `syncBankHoursByContinuityGroup`.

**Uso:**

```bash
# Preview (default):
npx tsx scripts/repair-continuation-startedat.ts

# Apenas últimos N dias:
npx tsx scripts/repair-continuation-startedat.ts --since=2026-04-01

# Aplicar:
npx tsx scripts/repair-continuation-startedat.ts --apply
```

**Casos delicados conhecidos** (ver tabela do `VICTIMS.md`):

- **05/05 PM04 (Mariana)** — snapshot `payment_attestation_slot_entries`
  está stale (gerado 13:54, bug criado 20:01). Após rodar o script:
  regenerar o snapshot do dia 05/05 para que Mariana volte ao alvo.
- **03/05 2153 SN (Felipe)** — snapshot SN ainda não foi gerado. Rodar
  o script ANTES da geração — assim Felipe será computado corretamente
  como cobertura legítima do 2153 SN.
- **PM04 26/04 SN, PM40 23/04 SN, PM40 25/04 SD, CN10 25/04 SN** —
  já corrigidos via `manual_assign`. O script vai propor reverter o
  started_at do registro telegram subjacente. A correção manual
  continua válida no `payment_attestation_slot_entries`.
- Os 4 casos `manual_assign` podem ser revertidos para alocação automática
  após o saneamento (opcional — exige decisão operacional).

## Validação pós-merge

1. **Typecheck + testes**: `npm run typecheck && npm test` na branch.
2. **Preview do saneamento**: rodar sem `--apply`, conferir contagem
   vs. tabela do `VICTIMS.md` (~14 candidatos esperados).
3. **Aplicar saneamento** em janela operacional baixa (madrugada).
4. **Regenerar snapshots stale** dos dias citados acima.
5. **Smoke test de continuidade**: enviar uma mensagem de teste
   "Dr X continua YYY" no Telegram homolog/staging e conferir que:
   - O registro inserido tem `started_at = eventAt`.
   - O registro inserido tem `board_started_at = anchor` (chegada original).
   - O painel exibe o horário de chegada original.
   - O pagamento não derruba a cobertura do colega anterior.
