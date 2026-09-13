---
name: db-performance
description: Investigar lentidão ou propor melhoria de banco/query/service/endpoint neste repo (plantoes). Use quando alguém relatar tela lenta, timeout, pool esgotado, pedir índice, revisar queries, paralelização, waterfalls, transações ou mudança de schema no PostgreSQL. Segue o método de docs/db e trata o banco como infraestrutura crítica de produção.
---

# db-performance — investigar e melhorar dados neste repositório

Você está no repo `plantoes` (Next.js 16 App Router + Drizzle + postgres.js,
PostgreSQL `operations_v2`, pool `max: 5` por processo, dois processos PM2).
O banco é produção crítica: **nunca** altere schema ou dados fora de migration
versionada; **nunca** `EXPLAIN ANALYZE` em escrita; **nunca** desenvolva no servidor.

## Antes de tudo, leia (nesta ordem)

1. `docs/db/README.md` — método em 8 passos e regras invioláveis.
2. `docs/db/regras-dados-telas.md` — as 12 regras e o relatório obrigatório.
3. `docs/db/padroes-queries-e-services.md` — antes/depois dos padrões.
4. `docs/db/auditoria-performance-2026-09.md` — o que já foi diagnosticado e
   decidido; não refaça o diagnóstico do fechamento/banco de horas, continue dele.
5. Se tocar contrato/teto/saldo: `docs/saldo-contrato/README.md`.

## Procedimento

### Passo 1 — Árvore de chamadas com contagem de queries
Do `page.tsx`/route até cada SQL. Para cada nó: quantas queries, qual janela
(`WHERE` por período? por médico? nenhuma?), roda em loop? roda em `Promise.all`?
Comando útil:
```bash
grep -n "await \|Promise.all\|db.execute\|\.select(\|\.from(\|for (const\|export async function" services/<arquivo>.service.ts
```
Escreva a árvore no seu raciocínio antes de propor qualquer coisa.

### Passo 2 — Multiplicadores
Procure, nesta ordem: (a) função de período chamada dentro de loop de períodos;
(b) leitura sem janela (`select * from <view>`, `from(doctors)` repetido);
(c) mesma tabela carregada várias vezes no request; (d) `Promise.all` maior que o
pool; (e) agregação feita em Node sobre milhares de linhas. Um índice não resolve
nenhum desses.

### Passo 3 — Custo × histórico
Classifique cada query: proporcional ao mês, ao nº de médicos (limitado) ou a
todo o histórico. A terceira é defeito de arquitetura: redesenhe antes de otimizar.

### Passo 4 — Estado real do Postgres (se tiver acesso via túnel)
```bash
psql "$PLANTOES_RO_URL" -f scripts/db-inspect-prod.sql > docs/db/inspecao-$(date +%F).txt
```
Só role `plantoes_ro`. Leia: versão, volumes, índices e `idx_scan`, dead tuples,
`pg_stat_statements` (se houver), `pg_stat_activity`, locks. Sem acesso, diga
explicitamente que a análise é estática e deixe o comando pronto para o usuário.

### Passo 5 — Plano de execução, só de SELECT
`EXPLAIN (ANALYZE, BUFFERS)` com `plantoes_ro`. Diferencie: query lenta ×
falta de índice × estatística velha × lock × pool saturado × I/O. Seq scan em
tabela pequena é correto.

### Passo 6 — Corrija na camada certa (prioridade)
janela/agregação no SQL → uma passada em vez de N → crítico vs. secundário na
tela (`<Suspense>`, endpoint sob demanda) → agregação persistida para períodos
fechados → índice (`CONCURRENTLY` + marcador `-- migrate: no-transaction`,
auditoria §6.0) → parâmetros do Postgres.

### Passo 7 — Mudança de schema? Explique antes, no PR e no doc
Problema; SQL/migration; lock esperado; bloqueia leitura ou escrita?; impacto em
tabela grande; compatibilidade com a versão em produção (expand-and-contract:
nunca remover/renomear o que produção ainda usa); rollback; validação pós-deploy.
Uma migration por mudança. Nunca aplicar à mão.

### Passo 8 — Concorrência e transações
Estado financeiro (saldo, elegibilidade, contador): checagem e escrita na mesma
transação com `FOR UPDATE` / unique / upsert / `pg_advisory_xact_lock`. Nenhuma
transação aberta durante apuração pesada, HTTP ou espera humana — apure antes e
passe `precomputed` (padrão em `services/contract-ledger.service.ts`). Jobs
concorrentes idempotentes.

### Passo 9 — Prove equivalência
Snapshot com `scripts/perf-baseline-payment-closing.ts` antes/depois (diff vazio);
tempos com `PAYMENT_CLOSING_PERF=1 scripts/perf-measure-payment-closing.ts`.
`npm run typecheck` e `npm run test:deploy` verdes.

### Passo 10 — Relate
Preencha o relatório de `docs/db/regras-dados-telas.md`: requests até a primeira
renderização, queries executadas, linhas lidas vs. devolvidas, payload, série vs.
paralelo, cache/materialização e chave, invalidação após mutation, e **como o
custo cresce quando o histórico dobra**. Atualize a tabela "Estado das
propostas" em `docs/db/README.md`.

## O que não fazer
- Materializar view como atalho para tela financeira (dado defasado, lock no refresh).
- `Promise.all` de N queries por médico/mês (N+1 disfarçado).
- Índice "por precaução" sem `pg_stat_statements`/`EXPLAIN`.
- `VACUUM FULL`/`REINDEX` bloqueante automático.
- Relaxar `tests/payment-duplicate-guard.test.ts` ou a regra do ADR 006.
