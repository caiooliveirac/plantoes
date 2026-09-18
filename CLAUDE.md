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
  [db/index.ts](db/index.ts); schema único em [db/schema.ts](db/schema.ts) (schema Postgres `operations_v2`).
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
                        #   docs/saldo-contrato/README.md — leitura obrigatória
                        #   antes de mexer em contrato/teto/saldo
```

## Onde está o detalhe (leia só o que a tarefa pede)

Este arquivo é índice e regra dura. O detalhe mora em `CLAUDE.md` dentro das
pastas — eles só entram no contexto quando um arquivo daquela pasta é lido. **Se a
tarefa toca o assunto mas você ainda não abriu nada da pasta, leia o guia antes.**

| Vou mexer em… | Leio antes |
|---|---|
| tabela, coluna, ocupação, migration, query SQL | [db/CLAUDE.md](db/CLAUDE.md) |
| regra de negócio, bot, banco de horas, `services/` | [modules/CLAUDE.md](modules/CLAUDE.md) |
| página, rota de API | [app/CLAUDE.md](app/CLAUDE.md) |
| login, sessão, papéis, token da folha de ponto | [lib/auth/CLAUDE.md](lib/auth/CLAUDE.md) |
| CI, workflow, script de deploy | [.github/CLAUDE.md](.github/CLAUDE.md), [DEPLOY.md](DEPLOY.md) |
| logs/banco de produção, runbook | [docs/agent-operations.md](docs/agent-operations.md) |
| contrato, teto, saldo | [docs/saldo-contrato/README.md](docs/saldo-contrato/README.md) — **obrigatório** |
| UPA restrita | [docs/upas-restritas.md](docs/upas-restritas.md) |

## Armadilhas que valem em qualquer tarefa

- **Risco financeiro.** Um médico recebe no máximo um plantão por slot de 12h, mesmo
  registrado em dois alvos (`suppressSameDoctorDuplicateRows` em
  `services/board.service.ts`). Regra em
  [docs/adr/006-one-payment-per-doctor-slot.md](docs/adr/006-one-payment-per-doctor-slot.md);
  `tests/payment-duplicate-guard.test.ts` é o guarda no CI — não relaxe sem ler o ADR.
- **Saldo de contrato tem armadilhas de dado** que não se enxergam pelo código (já
  gerou alerta falso enviado à chefia). Leia o README de `docs/saldo-contrato/` antes.
- **Migrations em produção são manuais**: aplicar `db/migrations/NNNN_*.sql` no
  servidor **antes** do merge (`npm run db:migrate` com `.env.production`). O deploy
  não roda migration.
- **Todos os timestamps são UTC**; conversão para São Paulo é da aplicação (`lib/time.ts`).
- **Dois bots, não um.** O bot deste repo cuida de chegada/saída; o "bot regulador"
  (vagas, UPA restrita) é outro token e outro repo (`tabela`).
- **Sem `middleware.ts`**: cada rota chama `requireAuthenticatedSession(roles?)`
  explicitamente. Papéis: só `admin` e `chief`.
- `modules/telegram/service.ts` é um god module de ~12k linhas — nunca leia inteiro;
  busque o símbolo.

## Comandos (rodar no LOCAL)

```bash
npm install            # Node >= 20
npm run dev            # Next dev server
npm test               # suíte completa (node --test + tsx)
npm run test:deploy    # suíte de gate de deploy (exclui meal-breaks, que trava sob isolamento)
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

## Deploy e produção (resumo)

- Merge na `main` dispara [release-deploy.yml](.github/workflows/release-deploy.yml):
  valida e roda [scripts/deploy-magalu.sh](scripts/deploy-magalu.sh) no servidor via
  SSH (build atômico com rollback, restart dos dois processos PM2, healthcheck).
  **Qualquer merge deploya, inclusive só de documentação.**
- App em `~/plantoes` no **magalu** (`ssh magalu`), porta `3004`,
  `https://plantoes.mnrs.com.br`. Banco: PostgreSQL do host, `localhost:5432`, db
  `plantoes` (só loopback → acesso remoto read-only via túnel SSH).
- CI de PR e detalhes do pipeline: [.github/CLAUDE.md](.github/CLAUDE.md). Runbook:
  [docs/agent-operations.md](docs/agent-operations.md).
