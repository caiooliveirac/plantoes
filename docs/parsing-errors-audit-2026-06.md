# Auditoria de Erros de Parsing — Produção (Junho 2026)

> Registrado em 2026-06-11. Fonte: relato operacional da chefia após revisão de pagamento dos dias 02 a 08 SD/SN.
> Objetivo: fornecer contexto suficiente para que um próximo agente investigue as causas-raiz e proponha correções.

---

## Casos identificados

### 1. Uenderson — Meio plantão não computado (02 SD, 1361, 11:30–17:00)

**Sintoma:** Meio plantão não apareceu em slot de pagamento.  
**Causa mais provável:** `shouldAssumeTelegramHalfShift` pode ter retornado `false` se o horário da mensagem caiu fora da janela de meio plantão, ou outro médico que chegou em 1361 depois das 11:30 fechou a ocupação precocemente via lógica de "médico diferente, mesmo posto".  
**Impacto:** Médico trabalhou mas não consta para pagamento.  
**Ação corretiva imediata:** Checar `regulationOccupancies` para 1361 no dia 02 SD e verificar se a ocupação existe com `scheduledEndAt` correto (17:00). Se necessário, inserir ou corrigir via admin.  
**Fix preventivo:** Revisar `shouldAssumeTelegramHalfShift` e `resolveHalfShiftScheduledEndAt`; garantir que `scheduledEndAt` do meio plantão não é sobrescrito pela chegada de outro médico.

---

### 2. Briang Seguir — Ocupação fantasma (02 SD, 1364, chegada 07:27)

**Sintoma:** Médico não estava no plantão mas consta com chegada 07:27 em slot de payment na 1364.  
**Causa mais provável:** Resolução de nome incorreta (falso positivo fonético via Levenshtein) ou continuidade cross-shift inferida automaticamente de uma ocupação aberta do turno anterior pertencente a outro médico com nome similar.  
**Impacto:** Pagamento creditado indevidamente.  
**Ação corretiva imediata:** Remover ocupação via admin e recalcular banco de horas.  
**Fix preventivo:** Registrar `candidatesConsidered` no log de parsing para auditoria post-mortem; adicionar confirmação para casos de confiança LOW/MEDIUM na resolução de nome.

---

### 3. Karla Pinto — Remanejamento para CRU invisível (03 SD)

**Sintoma:** Médica remanejada para CRU não constou nem na rua nem na CRU; posição 2032 (que seria dela) aparece como sem médico em auditoria.  
**Causa mais provável:** Bug documentado em `RULES.md §16`: o parser não reconhece "CRU" como destino válido e cai em `no_operational_match`. A função `detectLocationWithoutRamal()` existe mas depende de interação extra com o remetente para confirmar o ramal específico.  
**Impacto:** Cobertura não registrada; auditoria informa "sem médico" em 2032.  
**Ação corretiva imediata:** Criar manualmente a ocupação em 2032 para o período correto.  
**Fix preventivo:** Implementar mapping explícito CRU → ramais 2031–2035 no parser ou service, com prompt automático para o remetente informar o ramal específico. Ver `detectLocationWithoutRamal()` e `buildLocationWithoutRamalReply()` em `modules/telegram/service.ts`.

---

### 4. Fernando Bandeira — Ocupação fantasma (03 SD)

**Sintoma:** Consta no slot do dia 03 SD mas não estava no plantão de fato.  
**Causa mais provável:** Mesmo mecanismo dos outros fantasmas — continuidade cross-shift automática (`inferredCrossShiftContinuation`) herdando uma ocupação aberta do turno anterior, ou resolução de nome falsa.  
**Impacto:** Pagamento creditado indevidamente.  
**Ação corretiva imediata:** Remover ocupação e recalcular banco de horas.  
**Fix preventivo:** Ver item de "alerta proativo de continuidade inferida" abaixo.

---

### 5. José Roberto 2153 — SN ausente em pagamento (03 SN)

**Sintoma:** Estava no plantão mas não aparece para pagamento em slot de auditoria.  
**Causa mais provável:** `shiftLabel = null`. O RULES.md documenta que 29% das ocupações de regulação têm `shiftLabel` null. A alocação de pagamento em `getPaymentAllocationBoard()` ranqueia candidatos por turno; com `shiftLabel` null, a ocupação pode ter perdido para outro candidato com `shiftLabel = "SN"` explícito na heurística de `collapseLogicalShiftCandidates`.  
**Impacto:** Médico trabalhou mas não recebe pagamento.  
**Ação corretiva imediata:** Override manual de pagamento via admin.  
**Fix preventivo:** Melhorar heurística de ranqueamento para `shiftLabel = null` — usar `boardStartedAt` como fallback para inferir o turno correto antes de penalizar o candidato.

---

### 6. João Victor Simões Castro Perrone — Ocupação fantasma (05 SD)

**Sintoma:** Estava já saindo (turno anterior), mas aparece em slot de auditoria e em payment closing como se estivesse no SD.  
**Descrição:** "Algum erro de interpretação de comando de chat que estendeu para turno seguinte sem necessidade."  
**Causa mais provável:** Médico estava em SN e enviou uma mensagem de despedida/saída que o parser não reconheceu como `isDeparture = true`. Com a ocupação de SN ainda aberta na virada para SD, a lógica de `shouldTreatTelegramArrivalAsContinuation` ou `inferredCrossShiftContinuation` gerou herança automática para SD sem declaração explícita do médico.  
**Impacto:** Pagamento creditado indevidamente por um turno extra.  
**Ação corretiva imediata:** Remover a ocupação do SD (ou corrigir `endedAt` para o final do SN).  
**Fix preventivo:** Ver proposta de rejeitar continuidade de fonte além do turno imediatamente anterior (seção "melhorias estruturais" abaixo).

---

### 7. Mateus Uriel 2033 — SD ausente após migração para PM40 (06 SD)

**Sintoma:** Estava no plantão do SD com certeza em 2033, mas não consta para slots. Possível relação com migração de domínio para PM40 no noturno.  
**Causa mais provável:** Quando ele migrou de 2033 (regulação) para PM40 (intervenção) durante o SN, `closeTelegramActiveContinuityOccupancies` foi chamado e fechou a ocupação 2033 com `endedAt` antes do início do SD. Alternativa: alguém removeu manualmente a ocupação 2033 sem perceber o impacto no pagamento do SD.  
**Impacto:** Médico trabalhou mas não consta para pagamento.  
**Ação corretiva imediata:** Recriar ou corrigir a ocupação 2033 para o período do SD.  
**Fix preventivo:** Auditar `closeTelegramActiveContinuityOccupancies` — ao migrar de regulação para intervenção, verificar se a ocupação de regulação está sendo fechada no horário correto (não retroativamente antes do turno que deve cobrir).

---

### 8. Taisa — Ocupação fantasma (08 SD, 1362)

**Sintoma:** Não estava na 1362, mas aparece em slot de auditoria. Em payment closing não ficou com 36h (o que seria erro grave).  
**Causa mais provável:** Mesmo padrão de João Perrone (caso 6) — ocupação de SN sem saída declarada herdada automaticamente para SD.  
**Impacto:** Auditoria incorreta; pagamento aparentemente não foi gerado (favorável), mas a ocupação fantasma polui o histórico.  
**Ação corretiva imediata:** Remover a ocupação ou corrigir `endedAt`.  
**Fix preventivo:** Mesma correção estrutural do caso João Perrone.

---

## Padrões de falha recorrentes

### Padrão A — Ocupação fantasma por continuidade cross-shift automática indevida
**Casos afetados:** Briang (2), Fernando (4), João Perrone (6), Taisa (8)  
**Mecanismo:** `inferredCrossShiftContinuation` ou `shouldTreatTelegramArrivalAsContinuation` herdam uma ocupação não encerrada de um turno distante como fonte de continuidade para o turno atual.  
**Invariante violada:** "Continuidade automática só pode ser inferida a partir do turno atual ou do turno imediatamente anterior" (ver `RULES.md` e instrução customizada do repositório).  
**Localização no código:** `modules/telegram/service.ts` ~linhas 7401–7416 (regulação) e ~7669–7683 (intervenção); função `shouldLinkActiveTelegramContinuitySource`.

### Padrão B — Ocupação real invisível em pagamento
**Casos afetados:** Uenderson (1), José Roberto (5), Mateus Uriel (7)  
**Mecanismos distintos:**
- Meio plantão com `scheduledEndAt` incorreto ou ocupação fechada precocemente
- `shiftLabel = null` prejudicando ranking de pagamento
- Ocupação fechada retroativamente ao migrar de domínio

### Padrão C — Remaneuvering com destino não-ramal
**Caso afetado:** Karla Pinto (3)  
**Mecanismo:** Bug documentado — CRU não mapeado como ramal válido pelo parser.

---

## Melhorias estruturais sugeridas

### 1. Rejeitar continuidade de fonte além do turno imediatamente anterior *(urgente)*

**Arquivo:** `modules/telegram/service.ts`, função `shouldLinkActiveTelegramContinuitySource`  
**Proposta:** Além de verificar `expiry`, verificar se `activeStartedAt` pertence ao turno atual **ou** ao turno imediatamente anterior. Se pertencer a dois ou mais turnos atrás, rejeitar a continuidade automática e enviar para revisão humana.

```
turno atual = resolveOperationalShiftWindow(eventAt)
turno anterior = turno que precede imediatamente o turno atual
se activeStartedAt < turno_anterior.startedAt → rejeitar continuidade automática
```

### 2. Alerta proativo quando continuidade é inferida automaticamente

Quando `inferredCrossShiftContinuation = true`, o bot deve notificar a chefia em canal privado antes de confirmar a herança, ou ao menos registrar um aviso na resposta pública para que seja revisado.

### 3. Observabilidade de decisões de parsing

Adicionar ao `telegramIngestedMessages` (ou tabela de audit separada):
- `isContinuationInferred: boolean` — se a continuidade foi inferida automaticamente (vs. declarada explicitamente)
- `continuitySourceOccupancyId` — ID da ocupação fonte quando herança ocorreu
- `candidatesConsidered` — lista de médicos candidatos na resolução de nome
- `parserDecisionPath` — qual branch do parser foi ativado

Isso permite reconstruir o raciocínio post-mortem sem acesso ao DB de produção.

### 4. Mapeamento CRU/COI → ramais no parser/service

Implementar mapeamento explícito para localizações não-ramal:
- CRU → ramais 2031–2035 (pedir ramal específico ao remetente)
- COI → PIAM ou ramal específico

Ver `detectLocationWithoutRamal()` e `buildLocationWithoutRamalReply()` já existentes em `modules/telegram/service.ts` — expandir para cobrir CRU/COI.

### 5. Heurística de `shiftLabel = null` no ranking de pagamento

Em `services/board.service.ts`, função `collapseLogicalShiftCandidates` (e ranking em `getPaymentAllocationBoard`): quando `shiftLabel = null`, usar `boardStartedAt` para inferir o turno antes de comparar com candidatos que têm `shiftLabel` explícito. Não penalizar ocupações sem `shiftLabel` se a inferência temporal as coloca no mesmo slot.

### 6. Processo de curadoria semanal

Para cada fechamento de pagamento, gerar relatório automático com:
1. Ocupações com `shiftLabel = null` que disputaram slots (verificar se impactaram alocação)
2. Ocupações com `inferredCrossShiftContinuation = true` (revisão manual da chefia)
3. Ocupações criadas dentro de 30 min da virada de turno via continuidade automática (alta taxa de falsos positivos)

---

## Arquivos-chave para investigação

| Arquivo | Relevância |
|---------|-----------|
| `modules/telegram/service.ts` | `shouldLinkActiveTelegramContinuitySource`, `findTelegramContinuityContext`, `inferredCrossShiftContinuation`, `closeTelegramActiveContinuityOccupancies` |
| `modules/telegram/service.ts` | `shouldTreatTelegramArrivalAsContinuation`, `shouldReopenStaleTelegramRegulationContinuation` |
| `modules/telegram/service.ts` | `shouldAssumeTelegramHalfShift`, `resolveHalfShiftScheduledEndAt` |
| `services/board.service.ts` | `getPaymentAllocationBoard`, `collapseLogicalShiftCandidates` |
| `modules/telegram/parser.ts` | `detectLocationWithoutRamal`, mapeamento CRU/COI |
| `modules/telegram/name-resolution.ts` | Resolução fonética de nomes (falsos positivos) |
| `tests/payment-allocation.test.ts` | Testes de regressão a ampliar |
| `tests/operational-rules.test.ts` | Testes de regressão a ampliar |

---

## Testes de regressão a criar

Cada caso pode virar um teste unitário em `tests/`:

1. **Médico com ocupação de SN aberta na virada SD** → mensagem de chegada no SD não deve criar continuidade automática se a ocupação de SN pertence a mais de um turno atrás
2. **Médico com `shiftLabel = null`** → deve aparecer em pagamento se foi o único ocupante do slot, com turno inferido por `boardStartedAt`
3. **Migração de regulação para intervenção** → ocupação de regulação deve ser fechada com `endedAt = eventAt` (não retroativamente)
4. **Meio plantão 11:30** → `scheduledEndAt` deve ser 17:00 e não deve ser sobrescrito por chegada posterior de outro médico
5. **Remaneuvering para CRU** → deve detectar localização sem ramal e acionar fluxo de confirmação, não silenciosamente criar `no_operational_match`
