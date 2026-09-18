# db/ — banco de dados

> Carregado sob demanda: só entra no contexto quando um arquivo desta pasta é lido. Índice na raiz: [CLAUDE.md](../CLAUDE.md)


**ORM:** Drizzle ORM sobre `postgres.js`. Conexão singleton em
[db/index.ts](index.ts): `getDb()` cria um `postgres.Sql` com **pool `max: 1`** e
`prepare: false`, cacheado no módulo. Requer `DATABASE_URL` (schema alvo:
`operations_v2`, setado via `?options=-csearch_path%3Doperations_v2` na connection
string — ver `.env.example`).

**Schema** ([db/schema.ts](schema.ts)): schema Postgres dedicado `operations_v2`.
Uma única view SQL (`contract_balance`, ver Saldo contratual) — leituras complexas são feitas
com `db.execute(sql\`...\`)` (CTEs ad-hoc) direto em `services/*.service.ts`
(destaque: `payable-shifts.service.ts`, `board.service.ts`,
`bank-hours-history.service.ts`), não há camada de view no banco.

Tabelas por domínio:

- **Auth**: `doctors` (cadastro de médicos — `id`, `fullName`, `normalizedName`
  único, `isActive`, `metadata` jsonb), `users` (login — `email` único,
  `passwordHash`, `doctorId` opcional, `mustChangePassword`), `userRoles` (PK
  composta `userId+role`, enum `admin`/`chief`), `passwordResetTokens`,
  `chiefInvites`, `chiefAccessRequests` (fluxo de aprovação com selfie/KYC para
  novos chefes).
- **Postos/bases**: `regulationPosts` (ramais da regulação) e `interventionBases`
  (bases de ambulância) — cada um com `code` único e `isActive`; suas respectivas
  tabelas de histórico `regulationPostDeactivations` /
  `interventionBaseDeactivations` guardam janelas `deactivatedAt`/`reactivatedAt`.
- **Ocupações (plantões/check-ins)**: `regulationOccupancies` e
  `interventionOccupancies` são o coração do sistema. Colunas-chave: `doctorId`,
  `continuityGroupId` (agrupa ocupações contíguas do mesmo médico — "uma corrida de
  plantões"), `postId`/`baseId`, `scheduledStartAt`/`scheduledEndAt` (programado),
  `startedAt` (chegada real), `boardStartedAt` (nullable — null = ocupação "sombra"
  sem titularidade no quadro), `endedAt` (handoff programado) vs `actualEndedAt`
  (saída real), `source` (`manual`/`telegram`/`import`/`admin_correction`),
  `departureConfirmedAt/By/Note` (confirmação da chefia). `interventionOccupancies`
  ainda tem `lateArrivalAcknowledgedAt/By/Note`. **Invariante do schema:** todos os
  timestamps são UTC; conversão para fuso de São Paulo é responsabilidade da
  aplicação (`lib/time.ts`).
- **Banco de horas**: `bankHoursEntries` (um registro por ocupação, com
  `arrivalDelayMinutes`, `overtimeMinutes`, `balanceMinutes`, `ruleCode`,
  `explanation` textual — auditável), `bankHoursBalanceOverrides` (correção manual
  por `continuityGroupId`), `bankHoursSettlements` (acerto lançado no fechamento
  mensal, `deltaMinutes` + `kind` bonus/penalty, casado a um `adminExtraShifts`).
- **Payment closing (fechamento de pagamento)** — o que alimenta
  `/admin/payment-closing`: `adminExtraShifts` (plantões extra/bônus/penalidade
  lançados manualmente pelo admin, não são ocupações reais), `paymentClosingMeta`
  (nota fiscal/nº processo por médico/mês, upsert), `paymentClosingAttestations`
  (assinatura do admin por médico/mês).
- **Saldo contratual** — `contracts` (um por vínculo: `ceilingAmount` nullable,
  janela `cycleStart`/`cycleEnd`, `supersededByContractId` para renovação) e
  `contractLedger` (razão append-only: `opening`, `invoice`, `invoice_reversal`,
  `manual_adjustment`). **O saldo não é armazenado** — é a soma do razão, pela única
  view SQL do repo, `operations_v2.contract_balance` (migration `0038`). A tabela
  antiga `doctorContracts` (teto + mês semente) foi substituída por este modelo.

  > ⚠️ **Leia [docs/saldo-contrato/README.md](../docs/saldo-contrato/README.md) antes de
  > mexer em qualquer coisa de contrato, teto ou saldo.** Os dados vieram de uma
  > planilha editada à mão e as armadilhas não se enxergam pelo código: saldo negativo
  > que é consumo acumulado, célula vazia que não é zero, coluna CH que discorda do teto
  > real. Já produziu uma lista de alertas falsos enviada à chefia. O README traz o
  > registro de quem ainda está sem teto vigiado e os defeitos de carga em aberto.
- **Payment attestation slots** — o que alimenta a auditoria de presença por turno
  (`/admin/payment-attestation`, `/admin/slot-audit`): `paymentAttestationSlots`
  (snapshot de um turno num dia — `operationalDate`+`shiftLabel` únicos, status
  `draft`/`approved`) e `paymentAttestationSlotEntries` (uma linha por ramal/base
  dentro do slot, com ocupante, métricas de banco de horas e `issues` jsonb).
- **Telegram**: `telegramIngestedMessages` (log de toda mensagem recebida —
  `senderTelegramId`, `rawText`, campos `parsed*`, `status`, `resolutionData`
  jsonb — é o que alimenta a auditoria/histórico operacional de origem Telegram),
  `telegramBotNotices` (avisos/lembretes já disparados, idempotência via
  `noticeKey` único), `doctorPaymentAccess` (codinome de autoatendimento — só o
  HMAC é obrigatório, `codename` em claro é opcional/recente),
  `telegramPaymentAccessAttempts` (rate limit de tentativas erradas de codinome).
  **Não existe tabela de vínculo `telegram_id ↔ doctor_id`**: a associação é por
  fuzzy-match de nome (`modules/telegram/name-resolution.ts`); admin/chief via
  Telegram são reconhecidos por listas de ID em variáveis de ambiente
  (`TELEGRAM_ADMIN_IDS`, `TELEGRAM_CHIEF_IDS`), não pelo banco.
- **Auditoria**: `shiftEvents` (event log com `domain` enum, `payload` jsonb) e
  `auditLogs` (log mais simples de ações administrativas).

**Migrations**: SQL numerado manualmente em `db/migrations/` (de `0000_initial.sql` em diante; conte com `ls`, não por este texto), aplicado via
`npm run db:migrate` ([scripts/apply-migrations.ts](../scripts/apply-migrations.ts)).
**Não são gerados automaticamente por `drizzle-kit`** apesar de `drizzle-kit` estar
nas devDependencies — o padrão observado é escrever a migration a mão e rodá-la
manualmente no servidor **antes** do merge/deploy (zero-downtime). Veja
`docs/agent-operations.md` para o procedimento remoto.

