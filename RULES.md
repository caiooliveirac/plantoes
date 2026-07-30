# Guia Completo de Regras de Negócio — SAMU Plantões

> **Para agentes de IA**: Este é o ponto de entrada. Leia este documento ANTES de tocar em qualquer arquivo.
> Ele mapeia TODAS as regras de negócio, onde cada uma está implementada, e os perigos conhecidos.
> Ao final, há uma seção sobre o parser e seus pontos de melhoria.

---

## Índice

1. [O que é este sistema](#1-o-que-é-este-sistema)
2. [Modelo de dados resumido](#2-modelo-de-dados-resumido)
3. [Turnos e relógios](#3-turnos-e-relógios)
4. [Regulação — regras de ocupação](#4-regulação--regras-de-ocupação)
5. [Intervenção — regras de ocupação](#5-intervenção--regras-de-ocupação)
6. [Continuidade (P-shift)](#6-continuidade-p-shift)
7. [Banco de horas](#7-banco-de-horas)
8. [Telegram — fluxo de processamento](#8-telegram--fluxo-de-processamento)
9. [Parser — como a mensagem vira dados](#9-parser--como-a-mensagem-vira-dados)
10. [Alocação de pagamento](#10-alocação-de-pagamento)
11. [Correções operacionais](#11-correções-operacionais)
12. [Meal breaks (almoco/jantar)](#12-meal-breaks)
13. [Desativação de postos/bases](#13-desativação-de-postosbases)
14. [Lembretes automáticos](#14-lembretes-automáticos)
15. [Bugs recorrentes — padrões perigosos](#15-bugs-recorrentes--padrões-perigosos)
16. [Parser — pontos de melhoria](#16-parser--pontos-de-melhoria)
17. [Checklist para alterações](#17-checklist-para-alterações)

---

## 1. O que é este sistema

Quadro operacional do SAMU São Paulo. Rastreia a presença de médicos em:
- **Bases de intervenção** (USA/ambulâncias): SM01, SM02, PR03, PM04, PM05, CC10, CC20, CC30, CC40, CC50, CC60, CC70
- **Postos de regulação** (ramais telefônicos): 1321–1329, 1361–1368, 2031–2035, 2151–2154, 2377, NUCLEO, PIAM

O sistema recebe mensagens de grupos no Telegram, interpreta chegadas/saídas/continuidades, e mantém um quadro em tempo real via Next.js. Também gera relatórios de pagamento, auditorias de cobertura, e alertas operacionais.

**Stack**: Next.js (App Router), TypeScript, Drizzle ORM, PostgreSQL (schema `operations_v2`), Telegram Bot API.

---

## 2. Modelo de dados resumido

```
doctors                         → cadastro de médicos (id, fullName, displayName, isActive)
regulationPosts                 → postos de regulação (id, code, label, isActive)
interventionBases               → bases de intervenção (id, code, label, isActive)
regulationOccupancies           → presença em posto de regulação
interventionOccupancies         → presença em base de intervenção
regulationPostDeactivations     → desativações temporárias de postos
interventionBaseDeactivations   → desativações temporárias de bases
bankHoursEntries                → saldo de banco de horas por ocupação
bankHoursBalanceOverrides       → ajustes manuais de saldo
continuityGroups                → agrupamento de ocupações consecutivas (P-shift)
telegramIngestedMessages        → log de todas as mensagens Telegram processadas
telegramBotNotices              → dedupe de avisos automáticos e estado de meal breaks
users / userRoles / loginAttempts → autenticação admin/chefia
paymentAttestations             → atestações de pagamento por turno
```

**Relacionamentos-chave:**
- Ocupação → Posto/Base (via postId/baseId)
- Ocupação → Médico (via doctorId)
- Ocupação → ContinuityGroup (via continuityGroupId)
- BankHoursEntry → Ocupação (via regulationOccupancyId/interventionOccupancyId)

**⚠️ Atenção**: `isActive = false` em doctor/post/base é **estado de domínio**, não soft delete. Postos desativados APARECEM no quadro como "DSV". Ver [ADR-001](docs/adr/001-disabled-is-domain-state.md).

**Arquivo**: [db/schema.ts](db/schema.ts)

---

## 3. Turnos e relógios

### Turnos operacionais

| Turno | Horário (São Paulo, UTC-3) | Label |
|-------|---------------------------|-------|
| Serviço Diurno | 07:00 – 18:59 | `SD` |
| Serviço Noturno | 19:00 – 06:59 | `SN` |
| Plantão extra | Continua além da virada | `P` |

### Três relógios independentes

O sistema tem **3 relógios que NÃO devem ser confundidos**:

| Relógio | Usa | Tolerância | Arquivo fonte |
|---------|-----|-----------|---------------|
| **Quadro (visibilidade)** | Quem aparece, quem some, quem entra em "Verificar" | 60 min antes da virada | [board-rules.ts](modules/operational/board-rules.ts) |
| **Lembrete (bot)** | Quando o bot cobra confirmação | Snapshots a cada 10 min na 1ª hora | [reminders.ts](modules/telegram/reminders.ts) |
| **Banco de horas (financeiro)** | Crédito/débito de tempo | 15 min após horário previsto | [calculator.ts](modules/bank-hours/calculator.ts) |

**Regra de ouro**: Uma mesma pessoa pode continuar visível no quadro, não receber lembrete naquele minuto, e ter apuração diferente no banco de horas.

### Constantes temporais

| Constante | Valor | Onde |
|-----------|-------|------|
| `OPERATIONAL_LOCAL_OFFSET_MINUTES` | -180 (UTC-3) | [rules.ts](modules/operational/rules.ts) |
| `PRE_SHIFT_TOLERANCE_MINUTES` | 60 | [board-rules.ts](modules/operational/board-rules.ts) |
| `VERIFICATION_GRACE_MINUTES` | 15 | [board-rules.ts](modules/operational/board-rules.ts) |
| `OVERTIME_JUSTIFICATION_MINUTES` | 15 | [board-rules.ts](modules/operational/board-rules.ts) |
| `P_SHIFT_PRE_BOUNDARY_TOLERANCE_MS` | 60 min | [rules.ts](modules/operational/rules.ts) |

**Arquivo de regras formais**: [OPERATIONAL_RULES.md](OPERATIONAL_RULES.md)

---

## 4. Regulação — regras de ocupação

**Arquivo fonte**: [modules/regulation/service.ts](modules/regulation/service.ts) (~580 linhas)

### Criar ocupação (`startRegulationOccupancy`)

1. **Resolve continuidade**: busca ocupação anterior do médico (mesmo ou outro ramal) para herdar `continuityGroupId`
2. **Verifica desativação**: bloqueia se o ramal está desativado no momento
3. **Duplicata**: se mesmo médico + mesmo posto + mesmo startedAt + mesmo shiftLabel → retorna existente
4. **Mesmo médico, mesmo posto**: update in-place (evita registros fantasma de duração zero)
5. **Médico diferente, mesmo posto**: fecha ocupação anterior com `resolveRegulationBoardEndAt`
6. **Troca de ramal pelo mesmo médico**: fecha ocupação ativa em **outro** ramal automaticamente e herda `continuityGroupId`
7. Insere nova ocupação com `inferRegulationCoverageWindow`

### Encerramento previsto

| Turno | scheduledEndAt |
|-------|----------------|
| SD | **19:15** (15 min além da virada) |
| SN | **07:15** do dia seguinte |
| P | Estende até o próximo turno completo |

**⚠️**: Os `:15` da regulação são **diferentes** da virada do quadro (07:00/19:00). São usados para fechamento e lembretes.

**⚠️ Regra financeira importante**: no banco de horas da regulação, a matemática usa a virada-base `07:00/19:00` e aplica a tolerância financeira de 15 min no calculador. Em outras palavras, `scheduledEndAt = 07:15/19:15` continua existindo para operação e lembretes, mas não pode virar uma segunda tolerância financeira na apuração.

### Visibilidade no quadro

- Sem `P`: some do quadro quando a virada torna a ocupação inequivocamente antiga
- Com `P`: visível até 07:00 do dia seguinte ao `startedAt` + 30 min de graça
- Badge "Continua às HH:mm": só aparece para `P`, apenas na janela [boundary, boundary+15min)

### Continuar (`continueRegulationOccupancy`)

- Seta `shiftLabel = "P"`, recalcula `scheduledEndAt`, ajusta `boardStartedAt`

### Encerrar (`endRegulationOccupancy`)

- Aplica `resolveRegulationBoardEndAt(endedAt, scheduledEndAt)` para limitar endedAt ao scheduledEnd

**Arquivo de testes**: [tests/operational-rules.test.ts](tests/operational-rules.test.ts)

---

## 5. Intervenção — regras de ocupação

**Arquivo fonte**: [modules/intervention/service.ts](modules/intervention/service.ts) (~560 linhas)

### Criar ocupação (`startInterventionOccupancy`)

1. **Resolve continuidade**: mesmos 3 passos da regulação
2. **Verifica desativação**: bloqueia se base desativada
3. **Mesmo médico, mesma base**: update in-place (preserva boardStartedAt mais antigo)
4. **Médico diferente** (source ≠ "import"):
   - Fecha ocupação existente (endedAt = startedAt da nova)
   - Insere nova com boardStartedAt
   - Limpa `boardStartedAt` de todas ocupações abertas da base e seta no novo (garante unicidade do board carrier)
5. **Source "import"**: insere sem tomar o board automaticamente

### Diferenças-chave vs regulação

| Aspecto | Regulação | Intervenção |
|---------|-----------|-------------|
| Remoção automática na virada | Sim (sem P) | Não — permanece até ação |
| scheduledEndAt | SD→19:15, SN→07:15 | SD→19:00, SN→07:00 |
| Verificar (destaque visual) | Não | Sim — quando ocupação é do turno anterior |
| Board carrier | Implícito | Explícito via `boardStartedAt` unicidade |
| Deactivation expiry | Baseada em shift | Infinita (9999-12-31) |

### Encerrar (`endInterventionOccupancy`)

- **Promoção automática**: após fechar, busca replacement (ocupação sem `boardStartedAt` na mesma base, mais antiga) e promove ao board

**Arquivo de testes**: [tests/intervention-base-state.test.ts](tests/intervention-base-state.test.ts)

---

## 6. Continuidade (P-shift)

### O que é

Quando um médico continua trabalhando além da virada de turno (SD→SN ou SN→SD), a ocupação recebe `shiftLabel = "P"`. Isso cria um **grupo de continuidade** que liga as ocupações consecutivas.

### Detecção automática no Telegram

A função `shouldTreatTelegramArrivalAsContinuation()` decide se uma nova mensagem é continuidade:

| Cenário | Continuação? | Motivo |
|----|------|--------|
| Mensagem contém "continuo", "fico", "emendo" | ✅ Sim | `isContinuation = true` no parser |
| Incoming P + active SD/SN | ✅ Sim | P explícito com plantão anterior |
| Incoming SN + active SD (regulação) | ✅ Sim | Cross-shift location update |
| Incoming SD/SN diferente do ativo (intervenção) | ✅ Sim | Cross-shift |
| Active = P (intervenção) | ✅ Sim | Já em continuidade |
| Mensagem é departure | ❌ Não | Saída, não continuidade |

**Arquivo**: [modules/telegram/service.ts](modules/telegram/service.ts), linhas ~343-405

### Continuidade sem base

Quando o médico diz "Ana Luiza continua SN" sem mencionar base/ramal:
1. O bot resolve o médico pelo nome
2. Busca ocupação ativa do médico (`findActiveOccupancyByDoctorId`)
3. Auto-preenche o target com a base/ramal da ocupação ativa

**Função**: `resolveContinuationWithoutBase()` em [service.ts](modules/telegram/service.ts)

### Bank hours com continuidade

- Calculado como span único: `chegada real do 1º plantão` → `saída real do plantão de continuidade`
- Membros intermediários da mesma cadeia NÃO geram segundo débito de chegada
- Continuidade NÃO zera a chegada original

**Arquivo**: [modules/bank-hours/continuity.ts](modules/bank-hours/continuity.ts), ver [ADR-005](docs/adr/005-p-shift-continuity-groups.md)

---

## 7. Banco de horas

**Arquivo fonte**: [modules/bank-hours/calculator.ts](modules/bank-hours/calculator.ts) (puro, sem DB)

### Regra de tolerância de 15 minutos

| Situação | Resultado |
|----------|-----------|
| Chegou com < 15 min de atraso | Atraso **perdoado**; excedente na saída: **dobrado** |
| Chegou com ≥ 15 min de atraso | Atraso entra integralmente; excedente na saída: **simples** |
| Saiu com < 15 min além do previsto | **Zero** crédito de excedente |
| Saiu com ≥ 15 min além do previsto | Excedente entra integralmente |

### Exemplos canônicos

| Chegada | Saída | Saldo |
|---------|-------|-------|
| 07:14 | 19:14 | 0 min (dentro da tolerância em ambos) |
| 07:14 | 19:15 | +30 min (atraso perdoado → excedente dobrado) |
| 07:15 | 19:15 | 0 min (atraso = 15 min, sem perdão; excedente < 15 min) |
| 07:16 | 19:16 | 0 min (atraso > 15 min anula crédito duplo; excedente < 15 min) |

Para regulação, isso significa: uma saída às `07:20` ou `19:20` deve ser lida como `20 min` além da virada-base, não `5 min` além do encerramento operacional `:15`.

### Justificativa de overtime

A partir de **07:15** ou **19:15**, `Continuar` e `Informar saída` exigem **justificativa por escrito**.

**Função**: `requiresOvertimeJustification(startedAt, reference)` em [board-rules.ts](modules/operational/board-rules.ts)

No Telegram, justificativas válidas são **ocorrência** ou **higienização**. Detecção por fuzzy matching (Levenshtein) em [departure-flow.ts](modules/telegram/departure-flow.ts).

### Sync e persistência

- `syncRegulationBankHours(tx, occupancyId)` / `syncInterventionBankHours(tx, occupancyId)` — recalcula e persiste
- `syncBankHoursByContinuityGroup(tx, continuityGroupId)` — recalcula toda a cadeia
- Overrides manuais em `bank_hours_balance_overrides`, aplicados via `applyBankHoursBalanceOverride`

**Arquivo de sync**: [modules/bank-hours/service.ts](modules/bank-hours/service.ts)
**Arquivo de testes**: [tests/bank-hours.test.ts](tests/bank-hours.test.ts)

---

## 8. Telegram — fluxo de processamento

**Arquivo fonte**: [modules/telegram/service.ts](modules/telegram/service.ts) (~5600 linhas, god module)

### Pipeline completo

```
Webhook POST (api/telegram/route.ts)
  └─> processTelegramUpdate(update)
        │
        ├─ 1. Verificar chat permitido (config.ts)
        ├─ 2. Logar mensagem em telegramIngestedMessages
        │
        ├─ 3. Checar pending state do remetente:
        │     ├─ pending_name_selection → handlePendingNameSelectionReply()
        │     ├─ pending_departure_justification → handlePendingDepartureJustificationReply()
        │     ├─ pending_departure_correction → handlePendingDepartureCorrectionReply()
        │     └─ pending_batch_confirmation → handleBatchConfirmation()
        │
        │     ⚠️ DEFER CHECK: Se a resposta parece uma nova mensagem operacional
        │        (contém base, horário, ou keywords operacionais), o pending é
        │        SUPERSEDED e a mensagem é processada do zero.
        │        Funções: shouldDefer*ToFreshParsing()
        │
        ├─ 4. Meal break routing (se aplicável)
        ├─ 5. Comando explícito (/plantao, /corrigir, /almoco, etc.)
        ├─ 6. Mensagem casual → ignorar
        ├─ 7. Parse como chegada/saída/continuação
        │     ├─ parseMessage(text) → ParsedMessage
        │     ├─ Resolver médico: resolveDoctorWithFallback(name)
        │     ├─ Verificar continuidade: shouldTreatTelegramArrivalAsContinuation()
        │     └─ Aplicar: applyParsedEntry()
        │
        └─ 8. Responder no chat
```

### Estados de mensagem (lifecycle)

| Status | Significado |
|--------|-------------|
| `processing` | Recebida, em processamento |
| `applied` | Ocupação criada/encerrada com sucesso |
| `pending_name_selection` | Múltiplos candidatos de médico, esperando escolha |
| `pending_departure_justification` | Saída tardia, esperando motivo |
| `pending_departure_correction` | `/corrigirsaida` encontrou candidato, esperando hora correta |
| `pending_batch_confirmation` | Lote preparado, esperando CONFIRMAR |
| `superseded` | Substituída por mensagem mais recente do mesmo remetente |
| `ignored` | Mensagem casual, sem conteúdo operacional |
| `error` | Falha no processamento |

### Defer — mecanismo de segurança

As funções `shouldDefer*ToFreshParsing()` evitam que uma mensagem operacional seja engolida por um pending state antigo. Exemplo: médico responde "1366 SD 07:00" quando o bot esperava uma justificativa → o pending é superseded e a mensagem é processada como chegada nova.

**Arquivo de testes**: [tests/telegram-commands.test.ts](tests/telegram-commands.test.ts)

---

## 9. Parser — como a mensagem vira dados

**Arquivo fonte**: [modules/telegram/parser.ts](modules/telegram/parser.ts) (~434 linhas)

### Entrada e saída

```
parseMessage("Vagner 1366 SD 07:00") → {
    sector: "REGULATION",
    baseCode: "1366",
    arrivalTime: "07:00",
    shiftType: "SD",
    roleFunction: null,
    confidence: "HIGH",
    isDeparture: false,
    isContinuation: false,
    extractedNames: ["VAGNER"]
}
```

### Detecção de setor

1. Regex `[A-Z]{2}\d{2}` → testa contra `BASES_INTERVENCAO` (12 bases) → INTERVENTION
2. Regex `\d{4}` → testa contra `RAMAIS_REGULACAO` (25 ramais) → REGULATION
3. Número nu (`01`, `70`, etc.) → resolve via `ABBREVIATION_MAP` → INTERVENTION

### Vocabulário reconhecido

| Categoria | Sinais | Destino |
|-----------|--------|---------|
| Chegada | CHEGUEI, TO AQUI, DESLOCANDO PARA | Flag normal |
| Saída | SAINDO, ENCERREI, LIBERADO, FIM DE PLANTAO, INDO EMBORA | `isDeparture = true` |
| Continuação | CONT, SEGUINDO, FICO, PERMANEÇO, EMENDO, PROSSIGO, JA TO NA, NAO SAI, VOU CONTINUAR | `isContinuation = true` |
| Casual | OI, BOM DIA, VALEU, KKK, OBRIGADO, etc. | Mensagem ignorada |
| Turno | SD, SN, P | `shiftType` |
| Função | CM, CIR, PED, PSIQ, RMT, IES, COI, RECIP, MRV, CP | `roleFunction` |
| Horário | `07:00`, `7h`, `às 7` | `arrivalTime` |

### Extração de nome (extractNames)

1. Limpa: @mentions, horários, base codes, shift labels, números, pontuação, prefixos Dr/Dra
2. Filtra tokens com `NAME_NOISE_TOKENS` (100+ tokens: artigos, sinais operacionais, complementos)
3. Para saídas com "rendida por": corta o texto ANTES do split para pegar quem está saindo
4. Retorna `[tokens restantes como string única]` ou `[]`

### Multi-message (`parseMessageMulti`)

Divide por `\n` ou `[.!?;]\s+`, parseia cada parte, enriquece com contexto vizinho (nome/horário/turno do bloco anterior), filtra apenas entradas com `baseCode`.

### Batch (`parseTelegramBatchLines`)

Divide por `\n`, detecta headings REGULAÇÃO/INTERVENÇÃO para propagar `headingSector`, ignora separadores (`---`, `***`).

---

## 10. Alocação de pagamento

**Arquivo fonte**: [services/board.service.ts](services/board.service.ts), função `getPaymentAllocationBoard()`

### Heurísticas de ranking

1. **Override manual da chefia** → prioridade absoluta
2. **Chegada mais cedo no slot** → prioridade de abertura
3. **Cobertura agendada** → acima de walk-in
4. **Menor saldo de banco de horas** → alocação compensatória em ties
5. **Status ativo** → acima de quem já saiu

### Regras adicionais

- Um médico NÃO pode fechar dois alvos no mesmo slot → resolver conflito escolhendo o alvo com candidato mais forte
- Predecessores carregados em `P` pesam menos que cobertura explícita do turno atual
- Bases desativadas o turno inteiro: excluídas de `totalTargets`/`unassignedCount`
- `arrivalDelayMinutes` e `balanceMinutes` são informativos; sozinhos NÃO geram `needs_review`

**Arquivo de testes**: [tests/payment-allocation.test.ts](tests/payment-allocation.test.ts)

---

## 11. Correções operacionais

**Arquivo fonte**: [modules/operational/corrections.ts](modules/operational/corrections.ts) (~794 linhas)

### Funções disponíveis

| Função | O que faz |
|--------|-----------|
| `correctRegulationOccupancy(id, input)` | Corrige horários, turno, função, ramal |
| `correctInterventionOccupancy(id, input)` | Corrige horários, turno, função |
| `removeRegulationOccupancyRecord(id)` | Remove ocupação + cascata para bank hours |
| `removeInterventionOccupancyRecord(id)` | Remove ocupação + cascata para bank hours |
| `transferOperationalOccupancy(id, input)` | Move ocupação para outro posto/base |

### Side effects de cada correção

- ✅ Recalcula bank hours (`syncBankHours*`)
- ✅ Reconcilia board state da intervenção (`reconcileInterventionBoardState`)
- ✅ Emite evento de live board (`publishBoardUpdate`)
- ✅ Valida cronologia (`validateChronology`: startedAt < endedAt)

### Transfer — resolução de conflitos

Se o destino já está ocupado, o `conflictResolution` pode ser:
- `remove_destination` — remove quem está lá
- `move_destination` — remaneja quem está lá para um terceiro posto/base

**⚠️ PERIGO**: Este módulo tem cobertura de testes **mínima** (apenas `validateChronology` e `mergeOperationalNotes`). Alterações aqui exigem verificação manual.

**Arquivo de testes**: [tests/operational-corrections.test.ts](tests/operational-corrections.test.ts)

### Undo — desfazer última ação

**Arquivo fonte**: [modules/operational/undo.ts](modules/operational/undo.ts)

**API**: `POST /api/operational/undo` e `GET /api/operational/undoable-actions`

Permite que a chefia desfaça sua última ação dentro de uma janela de segurança.

| Trava de segurança | Descrição |
|--------------------|-----------|
| Janela de 30 min | Só desfaz ações dos últimos 30 min (web) |
| Só a própria ação | `actorUserId` deve ser o do usuário logado (web) |
| Conflito de quadro | Se o posto/base foi modificado depois, bloqueia |
| Mais recente apenas | Se outra ação editou a mesma ocupação, bloqueia |
| Sem undo de undo | Ações `.undone` não são desfeitas novamente |
| Nota obrigatória | Mínimo 8 caracteres de justificativa (web) |
| Auditoria completa | Gera registro `*.undone` no audit_logs |

**Ações suportadas**: `.started`, `.corrected`, `.deleted`, `.transferred`

**Telegram `/desfazer`** (admin, privado):
- Janela estendida de 12h (`ADMIN_UNDO_WINDOW_MS`)
- Admin pode desfazer ações de qualquer usuário
- `/desfazer` lista ações desfeíveis; `/desfazer N` confirma o undo do item N
- Nota automática com texto do comando Telegram

**Arquivo de testes**: [tests/operational-undo.test.ts](tests/operational-undo.test.ts), [tests/telegram-undo-command.test.ts](tests/telegram-undo-command.test.ts)

---

## 12. Meal breaks

**Arquivo fonte**: [modules/telegram/meal-breaks.ts](modules/telegram/meal-breaks.ts) (~3700 linhas)

### Fluxo

1. `/almoco` ou `/jantar` → abre sessão de meal break
2. Bot calcula fila de prioridade baseado na chegada operacional
3. Bot divide médicos em slots de horário (almoço: 2 slots, descanso: 2 slots)
4. Cada médico recebe prompt com teclado inline
5. Médico escolhe horário → bot confirma e avança para o próximo

### Regras de prioridade

- Presencial/COI/IES: usa hora real de chegada
- RMT e ramais remotos fixos (1321-1325, 1361-1365): piso em 07:15 ou 19:15
- Exceção: IES explícito no SD tira o médico de RMT
- PSIQ: fora da divisão regular, almoço fixo 12:30, descanso 18:00
- CP (a critério): sai da fila, aparece como "a critério"
- Ramais remotos não consomem vagas da distribuição regular

### Estados

Um estado por data operacional + modo, persistido em `telegram_bot_notices`.

### Cobrança da pessoa da vez

- A pessoa da vez recebe uma cobrança curta após 90 segundos sem resposta.
- Quando a chegada/continuidade aceita do turno liga o `doctorId` da pessoa ao
  `senderTelegramId`, o bot resolve o `@username` via `getChatMember` e marca o
  próprio profissional em todas as cobranças. A identificação usa o vínculo
  operacional da ocupação, nunca inferência por semelhança de nome. A menção
  visual `@username` usa `tg://user?id=...`, garantindo a entidade de menção
  mesmo quando o username contém `_`.
- Na segunda cobrança, o bot marca `@chefe2031` e pede contato telefônico.
- Da terceira em diante, o bot pode marcar até 6 usuários recentes do mesmo grupo.
- Um usuário só é elegível para a cobrança coletiva quando registrou uma chegada
  ou continuidade aceita em `REGULATION`, vinculada a uma ocupação de ramal, no
  turno operacional atual. Chegadas em bases de intervenção não são elegíveis.
- ADMINs/chefes e o médico que está sendo aguardado são excluídos.
- O `@username` é resolvido via `getChatMember`; ausência de username ou falha da
  API degrada para o nome em negrito e, na chamada coletiva, para uma chamada
  genérica ao pessoal da regulação.
- As cobranças permanecem em uma linha, preservam o teclado e sempre exibem o
  nome da pessoa aguardada em negrito.
- O worker consulta pendências a cada 30 segundos para sustentar a cadência de 90 segundos.

**Arquivo de testes**: [tests/telegram-meal-breaks.test.ts](tests/telegram-meal-breaks.test.ts)

---

## 13. Desativação de postos/bases

### Regulação

**Arquivo**: [modules/regulation/service.ts](modules/regulation/service.ts)
- `deactivateRegulationPost(input)` → cria registro em `regulationPostDeactivations`, fecha ocupações abertas, sincroniza bank hours
- `reactivateRegulationPost(input)` → seta `reactivatedAt`
- Desativação é scoped por shift; `isRegulationPostDeactivationActive` verifica

### Intervenção

**Arquivo**: [modules/intervention/service.ts](modules/intervention/service.ts)
- `deactivateInterventionBase(input)` → mesmo padrão, mas expiry retorna `9999-12-31` (efetivamente infinita)
- `reactivateInterventionBase(input)` → seta `reactivatedAt`
- Bases desativadas aparecem como "DSV" no quadro
- Bases desativadas o turno inteiro são excluídas do cálculo de pagamento

---

## 14. Lembretes automáticos

**Arquivo fonte**: [modules/telegram/reminders.ts](modules/telegram/reminders.ts)

| Janela | Tipo | Conteúdo |
|--------|------|----------|
| 06:50-06:59 / 18:50-18:59 | Instrução pré-turno | Molde curto para o turno seguinte |
| 07:00-07:59 / 19:00-19:59 | Snapshot a cada 10 min | Cobertura confirmada vs pendente |
| 08:00-08:09 / 20:00-20:09 | Checkpoint público | Nomes completos confirmados + pendências |
| 12:00-12:09 / 00:00-00:09 | Checkpoint pagamento | Alvo, nome, chegada, turno |

**Worker**: [scripts/telegram-reminder-worker.ts](scripts/telegram-reminder-worker.ts)

**Arquivo de testes**: [tests/telegram-reminders.test.ts](tests/telegram-reminders.test.ts)

---

## 15. Bugs recorrentes — padrões perigosos

### Padrão 1: shiftLabel null (29% das ocupações de regulação)

Médicos frequentemente NÃO dizem SD/SN. Qualquer código que faça `if (shiftLabel === "SD")` sem tratar `null` tem risco alto.

**Mitigação**: sempre usar `boardStartedAt` como fallback temporal para classificar o turno.

**Última ocorrência**: `/plantao` mostrava "pendente por herança" falso para médicos sem shiftLabel.

### Padrão 2: P-shift cruzando virada de turno

P-shifts abrangem dois turnos. Qualquer lógica de shift boundary que não considere P gera gaps ou duplicatas.

**Última ocorrência**: 6 médicos sem alocação de pagamento por boundary tolerance.

### Padrão 3: Overlap de ocupações

Abrir ocupação nova sem fechar a antiga → dados corrompidos.

**Última ocorrência**: 19 overlaps históricos em regulação (trocas de ramal sem fechamento).

### Padrão 4: Read-model chamando mutations

`board.service.ts` chama `expireInterventionBaseDeactivations()` e `expireStaleRegulationOccupancies()` dentro de funções de leitura.

**Impacto**: Side-effects inesperados durante consultas "inocentes".

### Padrão 5: Pending state engolindo mensagem operacional

Se o bot espera justificativa e o médico manda uma chegada nova, a mensagem pode ser perdida se as funções `shouldDefer*ToFreshParsing()` não detectarem corretamente.

**Arquivo detalhado**: [docs/bug-hotspots.md](docs/bug-hotspots.md)

---

## 16. Parser — pontos de melhoria

### Limitações conhecidas

| Problema | Exemplo real | Impacto | Dificuldade |
|----------|-------------|---------|-------------|
| **CRU/COI sem ramal** | "Ananda CRU SD 07:00" | Parser não reconhece CRU como destino; cai em `no_operational_match` | Média — precisa de mapping local→ramais |
| **Nomes curtos ambíguos** | "Lucas 1366 SD" | Múltiplos "Lucas" no diretório → `pending_name_selection` | Baixa — resolvido por fallback mas gera atrito |
| **"desde" contaminando nome** | "Ana desde 07:00" | "DESDE" vira parte do nome extraído | ✅ Corrigido — adicionado a NAME_NOISE_TOKENS |
| **24H interpretado como nome** | "Vagner 1366 24H" | "24H" passava como token de nome | ✅ Corrigido — regex extra em extractNames |
| **Acento e variação fonética** | "Rayssa" vs "Raissa" | Pode não bater no diretório | ✅ Resolvido — matching fonético em name-resolution.ts |
| **Setor inferido por número nu** | "01" → SM01 | Pode falhar se "01" aparecer em contexto numérico não-base | Baixa — ABBREVIATION_MAP cobre casos comuns |
| **Mensagens multioperacionais** | "Vagner 1366 e Ana 1367 SD 07:00" | Parsing multi-line funciona, mas se tudo estiver na mesma linha sem separador reconhecido, pode perder a segunda entrada | Média |
| **Horário 24:00** | "24:00" | Ignorado (considerado duração de plantão) | OK — decisão de design |

### O que o parser NÃO faz

O parser é **puro** — sem DB, sem side-effects. Ele NÃO:
- Resolve nomes de médicos (isso é `name-resolution.ts`)
- Valida se o ramal/base existe (isso é `service.ts`)
- Detecta conflitos de ocupação (isso é `regulation/service.ts` e `intervention/service.ts`)
- Decide se é continuidade baseado no estado atual do quadro (isso é `shouldTreatTelegramArrivalAsContinuation`)

### Evolução possível do parser

1. **Mapping CRU/COI → ramais**: adicionar regra que detecte "CRU" ou "COI" e peça ao remetente qual ramal específico. Hoje já existe `detectLocationWithoutRamal()` e `buildLocationWithoutRamalReply()` em [service.ts](modules/telegram/service.ts) que cobrem isso, mas no nível do service, não do parser.

2. **Melhor separação de múltiplas entradas na mesma linha**: `parseMessageMulti` já divide por `\n` e `.!?;` mas não detecta padrões como "Vagner 1366 e Ana 1367". Possível melhoria: split por conjunção + detecção de novo nome.

3. **Confiança granular**: o campo `confidence` existe (HIGH/MEDIUM/LOW) mas é pouco usado. Poderia ser expandido para guiar decisões downstream (ex: LOW confidence → pedir confirmação antes de aplicar).

4. **Saídas com destino**: "Vagner saindo 1366 para 1367" hoje não é reconhecido como transferência. Poderia gerar `isDeparture + targetTransfer`.

5. **Horários relativos**: "há 10 minutos" ou "agora" não são parseados. Todos os horários devem ser HH:MM.

---

## 17. Checklist para alterações

Antes de modificar qualquer regra:

1. ✅ **Identifique o relógio**: quadro, lembrete, ou banco de horas?
2. ✅ **Declare o domínio**: regulação, intervenção, ou ambos?
3. ✅ **Registre exemplos de borda** em horários reais (07:14, 07:15, 19:00, etc.)
4. ✅ **Atualize testes de regressão** correspondentes
5. ✅ **Atualize esta documentação** se mudar constantes, tolerâncias, ou fluxos
6. ✅ **Rode o suite de testes completo**: `npx tsx --test tests/*.test.ts`
7. ✅ **Verifique shiftLabel null**: sua mudança trata o caso de shiftLabel === null?
8. ✅ **Verifique P-shift**: sua mudança funciona quando a ocupação cruza virada de turno?

---

## Documentação Complementar

| Documento | Conteúdo |
|-----------|----------|
| [OPERATIONAL_RULES.md](OPERATIONAL_RULES.md) | Regras formais do quadro, banco de horas, e lembretes |
| [docs/domain-map.md](docs/domain-map.md) | Mapa de contextos delimitados (bounded contexts) |
| [docs/bug-hotspots.md](docs/bug-hotspots.md) | Análise de risco priorizada por hotspot |
| [docs/agent-architecture-review.md](docs/agent-architecture-review.md) | Revisão arquitetural para agentes |
| [docs/refactor-plan-for-agents.md](docs/refactor-plan-for-agents.md) | Plano de refatoração (parcialmente executado) |
| [docs/adr/](docs/adr/) | Architecture Decision Records (5 ADRs) |
| [modules/telegram/README.md](modules/telegram/README.md) | Arquitetura do módulo Telegram |
| [modules/operational/README.md](modules/operational/README.md) | Módulo operacional |
| [modules/bank-hours/README.md](modules/bank-hours/README.md) | Módulo de banco de horas |
| [services/README.md](services/README.md) | Camada de serviços |
