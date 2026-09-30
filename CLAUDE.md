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

**Toda tarefa termina no LIVE** (regra global desde 29/09/2026): terminou uma
mudança, levar à `main` (PR+merge ou push direto — o hook só barra force-push)
sem perguntar e sem o usuário precisar dizer "deploy"; conferir o
`release-deploy.yml` e `/api/health` depois. Não deployar só quando ele disser
("não sobe", "só local", "testa no LAB"). Voltar atrás = revert na `main`.
Migration continua manual e antes do merge; destrutiva exige autorização.

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
- Autenticação própria (JWT + cookie), sem NextAuth/Auth.js.
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
                        #   docs/saldo-contrato/README.md — leitura obrigatória
                        #   antes de mexer em contrato/teto/saldo
```

**Páginas principais** (`app/`): `/` é a mesa operacional ao vivo (quadro de
regulação/intervenção); `/historico-operacional` e `/historico/turno-anterior` são
visões de auditoria; `/folha-ponto/[medicoId]/[ano]/[mes]` é o extrato individual
(acessível também sem login via token assinado, ver Autenticação); `/admin/*` reúne
telas de admin — `payment-closing` (+`/pendencias-contrato`), `bank-hours`,
`acessos`, `extrator-caso` (caso desidentificado de um médico/mês para colar em
sessão de IA — [docs/extrator-caso.md](docs/extrator-caso.md)). Alocação, atesto diário, auditorias (slots, atesto, relatório mensal),
gestão de médicos e acesso de chefia saíram em 29/09/2026 (ninguém usava); os dados
ficaram no banco.

**API routes** (`app/api/`, todas sob Route Handlers, sem `middleware.ts`):
- `auth/*` — login, session, logout, change-password, password-reset
- `board/*` — `GET /api/board` (estado ao vivo), `board/stream` (Server-Sent Events),
  `board/history`, `board/meal-breaks/priorities/[ramal]`
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
  bases de ambulância). Base comporta dois médicos ("dupla"): quem chega nunca encerra
  titular vigente — ver [docs/dupla-usa.md](docs/dupla-usa.md).
- **Declaração de chegada** (parser → tomada/deslocado → `start*Occupancy` → quadro):
  princípios, cenários e registro de defeitos em [docs/chegada.md](docs/chegada.md).
  **Leia antes de mexer** — regra dura: vale a primeira mensagem, chegada nunca avança.
- **Madrugada** ("Nome 2266 madrugada"): cobre o horário de outro médico na noite —
  aparece no quadro e fica de plantão, mas fora do pagamento e do banco de horas;
  o coberto some do quadro sem perder nada. Ramais eventuais 2266–2270. Regras e
  onde a exclusão está aplicada em [docs/madrugada.md](docs/madrugada.md).
- **Retirar** (quadro): a chefia escolhe sem saldo / banco / meio / inteiro; a
  régua de saída antecipada só sugere. Limites e leitores do desfecho em
  [docs/retirar.md](docs/retirar.md).
- **Remanejo e hora de chegada**: a hora prevista de chegada do turno é a do
  posto onde o médico CHEGOU (só o NUCLEO abre às 08:00). Remanejar para a CRU
  ou uma base não a muda; toda reinferência de janela passa por
  `modules/operational/posto-de-chegada.ts`. Defeito, backfill do banco de horas
  e runbook em [docs/remanejamento-nucleo-banco-horas.md](docs/remanejamento-nucleo-banco-horas.md).
- **Saídas a confirmar**: três classes; rotina confirma sozinha na virada,
  sugestão aplicada em 24h, decisão humana escala ao admin; chefia desfaz.
  Regras, flag `SAIDAS_AUTONOMAS` e marca da confirmação em
  [docs/saidas-a-confirmar.md](docs/saidas-a-confirmar.md).
- **Passagem de ocorrências** no almoço/descanso (quem sai passa para quem, faixa
  acima do quadro + bot): regras e janela em [docs/passagem-ocorrencias.md](docs/passagem-ocorrencias.md).
- `modules/bank-hours/` — cálculo de banco de horas (atraso, hora extra, continuidade)
- `lib/contracts/` (puro) + `services/contract-balance.service.ts` + as varreduras de
  `modules/telegram/contract-balance-alerts.ts` — saldo de contrato: métricas do ciclo,
  read model e os avisos que saem às 8h para os admins. Domínio com armadilhas de dado
  documentadas — ver [docs/saldo-contrato/README.md](docs/saldo-contrato/README.md).
- `modules/reporting/` — turnos pagáveis, histórico de banco de horas, relatório mensal
  (inclui exportação XLSX)
  > ⚠️ **Risco financeiro.** Um médico recebe no máximo um plantão por slot de 12h,
  > mesmo registrado em dois alvos (`suppressSameDoctorDuplicateRows` em
  > `services/board.service.ts`). Regra e cenários em
  > [docs/adr/006-one-payment-per-doctor-slot.md](docs/adr/006-one-payment-per-doctor-slot.md);
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
> `/upas`. Ver [docs/upas-restritas.md](docs/upas-restritas.md).

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
  (assinatura do admin por médico/mês).
- **Saldo contratual** — `contracts` (um por vínculo: `ceilingAmount` nullable,
  janela `cycleStart`/`cycleEnd`, `supersededByContractId` para renovação) e
  `contractLedger` (razão append-only: `opening`, `invoice`, `invoice_reversal`,
  `manual_adjustment`). **O saldo não é armazenado** — é a soma do razão, pela única
  view SQL do repo, `operations_v2.contract_balance` (migration `0038`). A tabela
  antiga `doctorContracts` (teto + mês semente) foi substituída por este modelo.

  > ⚠️ **Leia [docs/saldo-contrato/README.md](docs/saldo-contrato/README.md) antes de
  > mexer em qualquer coisa de contrato, teto ou saldo.** Os dados vieram de uma
  > planilha editada à mão e as armadilhas não se enxergam pelo código: saldo negativo
  > que é consumo acumulado, célula vazia que não é zero, coluna CH que discorda do teto
  > real. Já produziu uma lista de alertas falsos enviada à chefia. O README traz o
  > registro de quem ainda está sem teto vigiado e os defeitos de carga em aberto.
- **Payment attestation slots** — o que alimenta o atesto por turno (hoje editado
  no modal do fechamento e pelo bot): `paymentAttestationSlots`
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

- **Sessão**: cookie HTTP-only `operations_v2_session`, TTL 30 dias deslizante
  (`proxy.ts`), `secure` só em produção. Token é JWT simplificado
  (`{ typ: "session", sub: userId, exp, sv }`) assinado com HMAC-SHA256
  usando `AUTH_SECRET`, verificação timing-safe. Implementação em
  [lib/auth/token.ts](lib/auth/token.ts) e [lib/auth/server.ts](lib/auth/server.ts).
  `sv` tem que bater com `users.session_version`: toda gravação de senha sobe a coluna
  e derruba os cookies antigos (teste-guarda em `tests/sessao-revogavel.test.ts`).
  Login: 10 falhas/15 min por IP e por e-mail → 429 (`modules/auth/login-rate-limit.ts`).
- **Monitor de acessos** (`/admin/acessos`): cada login é uma sessão (`sid` no cookie,
  tabela `auth_sessions`) e cada pedido autenticado é registrado depois da resposta
  (`after()` em `readAuthenticatedSession`) para provar uso simultâneo da mesma conta
  em lugares diferentes. Heurística só avisa; Mesa e Tabela só de plantão (admin e Central à parte) e 4+ lugares ao mesmo tempo troca a senha sozinho. Critérios, alertas e limites em
  [docs/monitor-acessos.md](docs/monitor-acessos.md).
- **Presença na Mesa**: uma tela da Mesa por conta (lease por aparelho, cookie
  `plantoes_aparelho`; 423 no outro) e bloqueio por ociosidade com senha. Vale no
  `requireMesaSession`; admin isento; `MESA_PRESENCA` sombra/1/0. Regras em
  [docs/presenca-mesa.md](docs/presenca-mesa.md).
- **Login**: `POST /api/auth/login` (email+senha, bcrypt) em
  [app/api/auth/login/route.ts](app/api/auth/login/route.ts), lógica em
  [services/auth.service.ts](services/auth.service.ts). Trata contas inativas, sem
  role atribuída, e o fluxo de `chiefAccessRequests` pendente/rejeitado.
- **Papéis**: `admin`, `chief`, `doctor`, `payment_closing_limited`, `portal`,
  `radio_operador` e `tarm` (operadores da Central: Mesa só leitura, só na
  Central, isentos da presença — ver docs/presenca-mesa.md) (enum
  `userRoleEnum`, tabela `userRoles`, many-to-many; lista em
  [modules/auth/contracts.ts](modules/auth/contracts.ts)). `portal` só vale no
  `POST /api/auth/verificar-escala` (login do mnrs.com.br): no app, conta só com
  ele é tratada como sem papel (`rolesDoPlantoes`/`temAcessoAoPlantoes`). Nasce
  por `POST /api/servicos/contas-portal` (x-portal-token = `PORTAL_CONTAS_TOKEN`). Controle mais granular é
  feito por checagem manual em cada rota, não por um role dedicado.
- **Controle de acesso**: **não há `middleware.ts`**. Cada Server Component/Route
  Handler chama `requireAuthenticatedSession(requiredRoles?)` explicitamente (ex.:
  `requireAuthenticatedSession(["admin"])` nas rotas `/admin/*` e `/api/chief/*`). Rota
  sem sessão só entrando na lista pública de
  [tests/route-auth-guard-coverage.test.ts](tests/route-auth-guard-coverage.test.ts).
- **Quadro fechado**: `/`, `/api/board`, `/api/board/stream` e a passagem de
  ocorrências exigem sessão (qualquer papel). Sem sessão, `/` vai ao login único do
  portal (mnrs.com.br → porteiro → `/api/auth/sso`); `/entrar` é a porta de
  emergência local. Regra em [lib/auth/portao.ts](lib/auth/portao.ts).
- **Exceção**: a folha de ponto individual (`/folha-ponto/[medicoId]/[ano]/[mes]`)
  aceita acesso **sem login** via token assinado com validade de 7 dias
  ([lib/folha-ponto/token.ts](lib/folha-ponto/token.ts)), enviado ao médico no
  privado do bot do Telegram.
- **Telegram ↔ usuário**: sem vínculo formal no banco. Operacional (chegada/saída) é
  resolvido por nome (fuzzy match); admin/chief no bot são reconhecidos por
  `TELEGRAM_ADMIN_IDS`/`TELEGRAM_CHIEF_IDS` no `.env`; acesso a pagamento usa
  codinome com HMAC (`doctorPaymentAccess`), não o ID do Telegram.
- Webhook do bot ([app/api/telegram/webhook/route.ts](app/api/telegram/webhook/route.ts))
  valida `x-telegram-bot-api-secret-token` contra `TELEGRAM_WEBHOOK_SECRET` (tempo
  constante; sem a variável responde 503 — nunca cai para `AUTH_SECRET`).

## Comandos (rodar no LOCAL)

```bash
npm install            # Node >= 20
npm run dev            # Next dev server
npm test               # suíte completa (node --test + tsx)
npm run test:deploy    # gate de deploy (scripts/test-gate.sh; exclui meal-breaks)
# test-gate: arquivos que citam getDb(/DATABASE_URL rodam um de cada vez (dividem o
# mesmo banco); o resto em paralelo e sem DATABASE_URL. Teste novo de banco tem de
# citar um dos dois no arquivo, senão roda sem banco.
npm run build          # build de produção (faça LOCAL, não no servidor)
npm run telegram:worker   # roda o worker de lembretes localmente (loop contínuo)
npm run db:migrate        # aplica migrations SQL pendentes
```

Notas de teste conhecidas: `tests/telegram-meal-breaks.test.ts` trava sob isolamento;
rode-o com `--test-isolation=none` (Node 23+; no Node 22 do CI a flag chama
`--experimental-test-isolation=none`). Detalhes na memória do projeto.

Sem ESLint/Prettier configurados no repo — a única verificação estática automatizada
é `npm run typecheck` (`next typegen` + `tsc --noEmit -p tsconfig.json`, TypeScript
`strict: true`, cobre produção **e** `tests/`), rodado no CI.

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
- **CI de PR** ([.github/workflows/ci-pr.yml](.github/workflows/ci-pr.yml)): dois
  jobs em paralelo — `build` (`typecheck` → `npm run build`, sem banco) e `tests`
  (Postgres 16: `db:migrate` → [scripts/test-gate.sh](scripts/test-gate.sh)
  `--com-meal-breaks`). Passando os dois, `tested-tree` grava o hash da árvore
  testada como artefato. ~2min.
- **Deploy** ([.github/workflows/release-deploy.yml](.github/workflows/release-deploy.yml)),
  em push a `main`: job `check` procura a árvore do commit nos artefatos do CI de PR;
  achou (merge de PR com a `main` parada) → pula o `validate`; não achou (push
  direto, `main` andou) → `validate` (typecheck + `test:deploy`). Depois o job
  `deploy`, que executa
  [scripts/deploy-magalu.sh](scripts/deploy-magalu.sh) **no servidor via SSH** — o
  `next build` de produção acontece lá (build atômico com `.next.prev` para
  rollback, guard de memória, cache do compilador herdado do build no ar e sem
  rechecar tipos — `NEXT_SKIP_TYPECHECK`, ver `next.config.ts`), com restart dos dois processos PM2 (`plantoes`,
  `plantoes-telegram-worker`) e healthcheck de `/api/health`.
- **Migrations em produção são manuais**: aplicar `db/migrations/NNNN_*.sql` no
  servidor **antes** do merge (via `npm run db:migrate` com `.env.production`), não
  fazem parte do pipeline de deploy automático.

## Produção (resumo — runbook completo em docs/agent-operations.md)

- App em `~/plantoes` no servidor **magalu** (`ssh magalu`); porta `3004`; URL
  pública `https://plantoes.mnrs.com.br`.
- Banco: PostgreSQL do host em `localhost:5432` db `plantoes` (só loopback → acesso
  remoto via túnel SSH).
- Observabilidade e DB de produção são acessíveis **read-only do Mac via SSH**, sem
  rodar carga no servidor. Veja o runbook.
- O deploy ainda compila no servidor (guard de memória + build atômico com rollback
  já protegem contra OOM). Meta futura: compilar fora da produção e enviar só o
  artefato.
