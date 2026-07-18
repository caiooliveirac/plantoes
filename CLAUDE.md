# CLAUDE.md — Guia para agentes de IA neste repositório

Este arquivo é carregado automaticamente pelo Claude Code. Leia-o antes de agir.
O runbook operacional completo (acesso a logs/DB de produção, deploy) está em
[docs/agent-operations.md](docs/agent-operations.md).

## O modelo: desenvolva local, produção só recebe o commit final

**Regra de ouro: NÃO desenvolva dentro do servidor de produção.**

O `plantoes` roda no servidor **magalu** (x86_64, 15GB RAM) **compartilhado com
~10 outros projetos + bancos + containers**. O `next build` do deploy automatizado
roda lá com segurança (via `scripts/deploy-magalu.sh`, sempre ANTES do restart),
mas o servidor não é lugar de desenvolvimento: nada de editor, experimentos ou
working tree sujo (o deploy usa `git reset --hard`). O incidente histórico de OOM
no EC2 antigo está registrado em `docs/agent-operations.md`.

Fluxo correto:

1. **Editar e testar no macOS local** (muito mais RAM). É aqui que um agente Claude
   Code deve fazer mudanças, rodar testes e validar.
2. **Commitar em feature branch** e abrir PR. O working tree de produção deve ficar
   **sempre limpo** (sem experimentos não commitados rodando ao vivo).
3. **Deploy**: merge na `main` dispara o workflow que valida e aplica o commit
   final no servidor (git reset + build + pm2). Detalhes em [DEPLOY.md](DEPLOY.md).

Um agente rodando **no Mac** pode fazer quase tudo sem tocar no servidor: alterar código,
rodar a suíte de testes, e até **consultar logs e banco de produção remotamente**
(read-only via túnel SSH) — ver o runbook.

## Stack

- **Next.js 16.2** (App Router) + **React 19.2** + TypeScript 5.9 (`strict: true`).
- **Drizzle ORM 0.45** sobre PostgreSQL, driver `postgres` (postgres.js). Conexão em
  [db/index.ts](db/index.ts); schema único em [db/schema.ts](db/schema.ts) (~620 linhas,
  18 tabelas no schema Postgres `operations_v2`).
- Bot de Telegram para registro de plantões médicos (chegada/saída/continuação/meal
  breaks/pagamento). Worker de lembretes roda como processo PM2 separado.
- Autenticação própria (JWT + cookie), sem NextAuth/Auth.js apesar da dependência
  `next-auth` estar no `package.json` (não é usada no fluxo de auth atual).
- Runtime de produção: **PM2** com dois processos: `plantoes` (web, porta `3004`) e
  `plantoes-telegram-worker` (worker).

## Estrutura de pastas

```
app/                    # Next.js App Router — páginas (Server Components) + app/api/*
components/             # Componentes React (maioria em components/board/*)
modules/                # Lógica de domínio pura, por área de negócio
services/               # Camada de aplicação: monta read models, orquestra modules + DB
lib/                    # Utilidades (auth, tempo/timezone, board-live/SSE, folha de ponto)
db/                     # schema.ts, index.ts (conexão), migrations/ (SQL numerado)
scripts/                # CLIs: migrations, imports, repair scripts, worker do Telegram
tests/                  # node:test + tsx, um arquivo por área
docs/                   # Runbooks, regras de negócio, ADRs, auditorias
```

**Páginas principais** (`app/`): `/` é a mesa operacional ao vivo (quadro de
regulação/intervenção); `/historico-operacional` e `/historico/turno-anterior` são
visões de auditoria; `/folha-ponto/[medicoId]/[ano]/[mes]` é o extrato individual
(acessível também sem login via token assinado, ver Autenticação); `/admin/*` reúne
telas de admin — `payment-allocation`, `payment-attestation` (+`/audit`),
`payment-closing`, `reports`, `bank-hours`, `chief-access`, `slot-audit`.

**API routes** (`app/api/`, todas sob Route Handlers, sem `middleware.ts`):
- `auth/*` — login, session, logout, change-password, password-reset
- `board/*` — `GET /api/board` (estado ao vivo), `board/stream` (Server-Sent Events),
  `board/history`, `board/payment-allocation`, `board/meal-breaks/priorities/[ramal]`
- `regulation/occupancies/*`, `intervention/occupancies/*`,
  `intervention/bases/[id]/state`, `regulation/posts/[id]/state` — CRUD de plantões e
  ativação/desativação de postos/bases
- `operational/*` — transferências e sistema de undo (`undo`, `undoable-actions`)
- `admin/*` — payment-closing (contracts, attestations, extra-shifts, bank-hours,
  meta), payment-attestation/slot, reports/export
- `chief/*` — invites, requests, review, bootstrap (onboarding de chefes)
- `telegram/webhook` — único ponto de entrada do bot
- `doctors/import`, `health`

**Lógica de negócio central** (`modules/`, o que mais importa para novas features):
- `modules/operational/` — regras de turno/horário SP, correções administrativas
  (`corrections.ts`), sistema de undo com journaling (`undo.ts`), feriados
- `modules/regulation/` e `modules/intervention/` — operações de criar/encerrar/corrigir
  ocupações nos dois domínios paralelos (regulação = ramais telefônicos; intervenção =
  bases de ambulância)
- `modules/bank-hours/` — cálculo de banco de horas (atraso, hora extra, continuidade)
- `modules/reporting/` — turnos pagáveis, histórico de banco de horas, relatório mensal
  (inclui exportação XLSX)
- `modules/telegram/` — o maior módulo do repo; `service.ts` é um "god module" de
  ~12k linhas que roteia toda a lógica do bot (parsing, comandos, meal breaks,
  lembretes, pagamento). Está fragmentado em vários arquivos auxiliares
  (`parser.ts`, `meal-breaks.ts`, `departure-flow.ts`, `reminders.ts`, etc.) mas
  `service.ts` continua sendo o hub.

**`services/`** é a camada que monta read models para as páginas/API a partir dos
`modules/` + queries diretas ao banco — ex.: `board.service.ts` monta o estado do
quadro ao vivo; `payment-attestation.service.ts` e `payment-closing-*.service.ts`
cuidam do fechamento mensal.

## Banco de dados

**ORM:** Drizzle ORM sobre `postgres.js`. Conexão singleton em
[db/index.ts](db/index.ts): `getDb()` cria um `postgres.Sql` com **pool `max: 1`** e
`prepare: false`, cacheado no módulo. Requer `DATABASE_URL` (schema alvo:
`operations_v2`, setado via `?options=-csearch_path%3Doperations_v2` na connection
string — ver `.env.example`).

**Schema** ([db/schema.ts](db/schema.ts)): schema Postgres dedicado `operations_v2`,
18 tabelas. Nenhuma view SQL (materializada ou não) — leituras complexas são feitas
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
  (assinatura do admin por médico/mês), `doctorContracts` (teto em R$ + mês semente
  — saldo contratual é calculado, não armazenado).
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

**Migrations**: SQL numerado manualmente em `db/migrations/` (27 arquivos,
`0000_initial.sql` → `0026_payment_closing_financials.sql`), aplicado via
`npm run db:migrate` ([scripts/apply-migrations.ts](scripts/apply-migrations.ts)).
**Não são gerados automaticamente por `drizzle-kit`** apesar de `drizzle-kit` estar
nas devDependencies — o padrão observado é escrever a migration a mão e rodá-la
manualmente no servidor **antes** do merge/deploy (zero-downtime). Veja
`docs/agent-operations.md` para o procedimento remoto.

## Autenticação e papéis

Autenticação **customizada**, não usa NextAuth apesar da dependência estar instalada:

- **Sessão**: cookie HTTP-only `operations_v2_session`, TTL padrão 12h, `secure` só
  em produção. Token é JWT simplificado (`{ sub: userId, exp }`) assinado com HMAC-SHA256
  usando `AUTH_SECRET`, verificação timing-safe. Implementação em
  [lib/auth/token.ts](lib/auth/token.ts) e [lib/auth/server.ts](lib/auth/server.ts).
- **Login**: `POST /api/auth/login` (email+senha, bcrypt) em
  [app/api/auth/login/route.ts](app/api/auth/login/route.ts), lógica em
  [services/auth.service.ts](services/auth.service.ts). Trata contas inativas, sem
  role atribuída, e o fluxo de `chiefAccessRequests` pendente/rejeitado.
- **Papéis**: apenas dois — `admin` e `chief` (enum `userRoleEnum`, tabela
  `userRoles`, many-to-many). Não há role "médico comum" nem "coordenador" como
  conceito formal do sistema — controle mais granular é feito por checagem manual em
  cada rota, não por um role dedicado.
- **Controle de acesso**: **não há `middleware.ts`**. Cada Server Component/Route
  Handler chama `requireAuthenticatedSession(requiredRoles?)` explicitamente (ex.:
  `requireAuthenticatedSession(["admin"])` nas rotas `/admin/*` e `/api/chief/*`).
- **Exceção**: a folha de ponto individual (`/folha-ponto/[medicoId]/[ano]/[mes]`)
  aceita acesso **sem login** via token assinado com validade de 7 dias
  ([lib/folha-ponto/token.ts](lib/folha-ponto/token.ts)), enviado ao médico no
  privado do bot do Telegram.
- **Telegram ↔ usuário**: sem vínculo formal no banco. Operacional (chegada/saída) é
  resolvido por nome (fuzzy match); admin/chief no bot são reconhecidos por
  `TELEGRAM_ADMIN_IDS`/`TELEGRAM_CHIEF_IDS` no `.env`; acesso a pagamento usa
  codinome com HMAC (`doctorPaymentAccess`), não o ID do Telegram.
- Webhook do bot ([app/api/telegram/webhook/route.ts](app/api/telegram/webhook/route.ts))
  valida `x-telegram-bot-api-secret-token` contra `TELEGRAM_WEBHOOK_SECRET` (fallback
  `AUTH_SECRET`).

## Comandos (rodar no LOCAL)

```bash
npm install            # Node >= 20
npm run dev            # Next dev server
npm test               # suíte completa (node --test + tsx)
npm run test:deploy    # suíte de gate de deploy (exclui meal-breaks, que trava sob isolamento)
npm run build          # build de produção (faça LOCAL, não no EC2)
npm run telegram:worker   # roda o worker de lembretes localmente (loop contínuo)
npm run db:migrate        # aplica migrations SQL pendentes
```

Notas de teste conhecidas: `tests/telegram-meal-breaks.test.ts` trava sob isolamento;
use `--test-isolation=none` quando precisar rodá-lo. Detalhes na memória do projeto.

Sem ESLint/Prettier configurados no repo — a única verificação estática automatizada
é `tsc --noEmit` (TypeScript `strict: true`) + `next typegen`, rodados no CI.

## Convenções de código observadas

- Arquivos em `kebab-case.ts`; módulos de domínio em pastas `kebab-case` dentro de
  `modules/`; tipos/interfaces em `PascalCase`; funções/variáveis em `camelCase`.
- Alias de import `@/*` apontando para a raiz (`tsconfig.json`).
- Separação em camadas: `modules/` (regras de negócio puras, testáveis) →
  `services/` (monta read models, toca o banco) → `app/api/*` (route handlers finos,
  checam auth e chamam services) → `app/**/page.tsx` (Server Components).
- Testes em `tests/`, um arquivo por área de domínio, usando `node:test` +
  `node:assert/strict`, executados via `tsx`.
- Comentários em português nas partes de regra de negócio mais sutis do schema
  (ex.: por que `boardStartedAt` é nullable, o que cada `kind` de
  `adminExtraShifts` significa) — vale ler antes de mexer nessas tabelas.

## Segredos — nunca commitar

- `.env`, `.env.local`, `.env.production` estão no `.gitignore`. **Mantenha assim.**
- As chaves esperadas estão em [.env.example](.env.example) (sem valores):
  `DATABASE_URL`, `AUTH_SECRET`, `AUTH_URL`, `TELEGRAM_BOT_TOKEN`,
  `TELEGRAM_GROUP_CHAT_ID`, `TELEGRAM_ALLOWED_CHAT_IDS`, `TELEGRAM_ADMIN_IDS`,
  `TELEGRAM_PRIVATE_CONTROL_USER_IDS`, `TELEGRAM_CHIEF_IDS`,
  `TELEGRAM_WEBHOOK_SECRET`, `ARRIVAL_TIME_CUTOFF`.
- Esses valores vivem **apenas** no `.env.production` do servidor. Nunca cole
  valores reais em código, docs, commits ou mensagens.

## Dev, CI e deploy

- **Dev local**: `npm run dev`. `.env.local` para apontar num Postgres local (schema
  `operations_v2`, ver connection string de exemplo em `.env.example`).
- **CI** ([.github/workflows/deploy.yml](.github/workflows/deploy.yml)), roda no
  self-hosted runner (o próprio EC2, mas só como executor de CI, não como ambiente
  de dev): todo push/PR roda `test_smoke` (`npm run test:deploy` + `tsc --noEmit` +
  `next typegen`); PRs também rodam `test_regression` (`npm run test:full`,
  `continue-on-error`, inclui os testes flaky de meal-breaks). Deploy só dispara em
  push a `main` após `test_smoke` passar, e valida que o commit veio de um PR
  mergeado.
- **Deploy**: [scripts/deploy-production.sh](scripts/deploy-production.sh) builda
  **em cima do working tree de produção** (sem `git pull`) com build atômico
  (`.next` anterior preservado em `.next.prev` para rollback), guard de memória
  (falha se `< 3GB` livres) e `NODE_OPTIONS="--max-old-space-size=2048"`. Depois
  reinicia os dois processos PM2 (`plantoes`, `plantoes-telegram-worker`) e valida
  `/api/health` + `/api/board`.
- **Migrations em produção são manuais**: aplicar `db/migrations/NNNN_*.sql` no
  servidor **antes** do merge (via `npm run db:migrate` com `.env.production`), não
  fazem parte do pipeline de deploy automático.

## Produção (resumo — runbook completo em docs/agent-operations.md)

- App em `~/plantoes` no EC2; porta `3004`; URL pública `https://plantoes.mnrs.com.br`.
- Banco: PostgreSQL do host em `localhost:5432` db `plantoes` (só loopback → acesso
  remoto via túnel SSH).
- Observabilidade e DB de produção são acessíveis **read-only do Mac via SSH**, sem
  rodar carga no EC2. Veja o runbook.
- O deploy ainda compila no EC2 (guard de memória + build atômico com rollback já
  protegem contra OOM). Meta futura: compilar fora da produção e enviar só o artefato.
