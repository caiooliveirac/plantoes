# Auditoria de banco e performance — fechamento de pagamento e banco de horas (set/2026)

Análise **estática** do repositório (schema, migrations, services e rotas), sem
tocar produção: este ambiente não tem acesso SSH ao servidor. Tudo que depende
do estado real do Postgres (versão, volumes, `pg_stat_statements`, autovacuum,
roles) está listado na §1 como checklist, com o script read-only
[`scripts/db-inspect-prod.sql`](../../scripts/db-inspect-prod.sql) pronto para
rodar do Mac pelo túnel com o role `plantoes_ro`.

**Nada foi alterado no schema nem nos dados.** As mudanças propostas estão na
§5 e §6, cada uma com problema, SQL, lock, impacto, compatibilidade, rollback e
validação, para decisão antes de virar migration.

---

## 0. Resumo executivo

A lentidão das abas **Fechamento de pagamento** e **Banco de horas** não é,
principalmente, falta de índice. É **recomputação repetida e sem janela** na
camada de aplicação, que multiplica consultas já indexadas e CPU:

| Sintoma | Causa raiz | Onde |
|---|---|---|
| `/admin/payment-closing` lento e piora a cada mês | O saldo contratual reapura **todos os meses desde a abertura mais antiga** (≥ mai/2025, ou `cycle_start` de 2024 em contratos sem abertura) a cada carregamento: N meses × (6 queries + ~60 quadros de 12h montados em CPU), em série. Depois refaz o mesmo cálculo pela semente antiga `doctor_contracts`. | `services/contract-balance.service.ts` → `loadMonthlyApuracao`; `services/payable-shifts.service.ts` → `getChiefPayableShiftsBoard` |
| A mesma tela ainda carrega o histórico inteiro do banco de horas | O saldo efetivo por médico (`getDoctorBankHoursEffectiveBalances`) lê a view `bank_hours_history_shifts` **sem filtro** (toda ocupação desde o início, 5 joins por linha) e monta o modelo completo só para somar minutos. | `services/bank-hours-history.service.ts` |
| `/admin/bank-hours` lento | Mesma view sem filtro + `audit_logs` inteira via `EXISTS` + todas as justificativas do bot; o filtro de mês existe só no cliente. | `app/admin/bank-hours/page.tsx`, `getBankHoursHistory()` |
| "O app inteiro fica lento" quando alguém abre o fechamento | Pool `max: 5` por processo. Um único carregamento ocupa até 5 conexões em paralelo (bloco financeiro) e mantém uma ocupada por minutos no loop de meses; o webhook do Telegram e o quadro ao vivo esperam na fila. | `db/index.ts` |
| Cada ação (atestar, salvar NF, acerto) refaz tudo | `router.refresh()` + `force-dynamic` recarregam o read model completo. | `chief-payment-view-client.tsx` |

Índices existentes cobrem bem as consultas por mês (`*_started_idx`), por
ocupação (`bank_hours_entries_*_idx` únicos) e a trilha de auditoria
(`audit_logs_entity_idx`). Criar mais índices **não** resolve um loop de 17 a 30
iterações; o ganho está em (a) apurar o intervalo inteiro de uma vez, (b) somar
saldos em SQL em vez de montar o modelo inteiro, (c) limitar janela e (d) cache
por mês fechado. Só depois disso vale medir e decidir índices (§6).

Fora da performance, há **três pontos de risco de dados/concorrência** (§4):
acerto de banco de horas sem trava contra duplo clique (dinheiro), ausência de
`statement_timeout`/`idle_in_transaction_session_timeout` na conexão do app
(o incidente de 03/08 durou 13 min por isso) e backup só no deploy com
`--run-migrations`, sem rotina diária nem teste de restore documentado.

---

## 1. O que precisa ser inspecionado em produção antes de qualquer mudança

Rodar do Mac, pelo túnel (`docs/agent-operations.md §3`), **como `plantoes_ro`**:

```bash
psql "$PLANTOES_RO_URL" -f scripts/db-inspect-prod.sql > /tmp/db-inspect-$(date +%F).txt
```

O script é 100% `SELECT` sobre catálogos e views de estatística. Ele responde:

1. **Versão do PostgreSQL** (`server_version`). Define: `CREATE INDEX CONCURRENTLY`
   (todas), `REINDEX CONCURRENTLY` (≥12), skip scan em índice composto (≥18 — hoje
   uma busca só por `continuity_group_id` **não** usa
   `regulation_occupancies_continuity_idx`, que começa por `doctor_id`).
2. **Volume por tabela** (`pg_stat_user_tables` + `pg_total_relation_size`): sem
   isso não dá para dizer se seq scan em `payment_closing_attestations` (filtrada
   só por `month_key`) importa ou é irrelevante. Palpite pelo domínio: ocupações
   na casa de dezenas de milhares; `telegram_ingested_messages` é a maior.
3. **Índices existentes vs. uso** (`pg_stat_user_indexes.idx_scan = 0` → índice
   que só custa escrita) e **índices duplicados** (`regulation_occupancies_doctor_idx`
   é prefixo de `regulation_occupancies_continuity_idx`; idem intervenção —
   candidatos a remoção *depois* de confirmar `idx_scan`).
4. **Dead tuples, último autovacuum/analyze** por tabela. Estatística velha em
   `regulation_occupancies` muda plano do `UNION ALL` mensal.
5. **`pg_stat_statements`** — se a extensão estiver instalada, o script lista as
   20 queries de maior tempo total e as de maior tempo médio. Se não estiver, é a
   primeira ação operacional a pedir (exige `shared_preload_libraries` e restart
   do Postgres: **coordenar janela**, afeta os ~10 projetos do host).
6. **Conexões e transações longas** (`pg_stat_activity`): quantas do role
   `plantoes`, `idle in transaction`, `xact_start` antigo, `wait_event`.
7. **Bloqueios** (`pg_locks` + `pg_blocking_pids()`): blocker → blocked.
8. **Roles**: o app conecta como owner das tabelas (`plantoes`)? É superuser?
   `rolbypassrls`? Timeouts setados em `pg_db_role_setting`? Não há multi-tenant
   nem RLS neste sistema (um serviço, uma operação), então RLS não se aplica; mas
   o app **não pode** ser superuser.
9. **Configuração relevante** (`work_mem`, `shared_buffers`, `max_connections`,
   `autovacuum_*`, `statement_timeout`, `idle_in_transaction_session_timeout`,
   `log_min_duration_statement`).
10. **Planos das duas leituras críticas** com `EXPLAIN (ANALYZE, BUFFERS)` — são
    `SELECT` puros (view do banco de horas sem filtro; `UNION ALL` mensal do
    fechamento), seguros de executar de verdade com `plantoes_ro`. O script os
    deixa **comentados** para você decidir a hora (a view sem filtro lê tudo).

Enquanto esses números não existirem, tudo abaixo é hipótese fundamentada em
código — priorizada, mas hipótese.

---

## 2. Mapa do schema relevante (do repositório)

Schema `operations_v2`, migrations `0000`→`0042` aplicadas via
`scripts/apply-migrations.ts` (uma transação por arquivo — ver §6.0). Duas views
SQL: `bank_hours_history_shifts` (0036/0039) e `contract_balance` (0038).
O `CLAUDE.md` está desatualizado nestes dois pontos e no pool (`max: 1` → hoje
`max: 5`, `idle_timeout: 30`, `prepare: false`).

### Tabelas quentes para as duas telas

| Tabela | Índices hoje | Como as telas usam |
|---|---|---|
| `regulation_occupancies` / `intervention_occupancies` | PK; `(doctor_id)`; `(doctor_id, continuity_group_id, started_at)`; `(post_id|base_id)`; `(post_id|base_id, board_started_at)`; `(ended_at)`; `(started_at)` | Fechamento: janela `started_at ∈ [mês−1d, mês+1d)` → `started_idx` serve. Banco de horas: **sem filtro**. Bank-hours override e `syncBankHoursByContinuityGroup`: `WHERE continuity_group_id = ?` **sem `doctor_id`** → não usa índice composto (PG<18). |
| `bank_hours_entries` | `(doctor_id, scheduled_start_at)`; únicos `(regulation_occupancy_id)`, `(intervention_occupancy_id)` | LEFT JOIN 1:1 por ocupação → ok. |
| `bank_hours_balance_overrides` | único `(continuity_group_id)`; `(doctor_id, updated_at)` | Carregada inteira (pequena). ok. |
| `bank_hours_settlements` | `(doctor_id, month_key)` | `loadBankHoursSettlementsForMonth(month)` filtra **só `month_key`** → seq scan (tabela pequena; irrelevante hoje). |
| `payment_closing_attestations`, `payment_closing_meta` | únicos `(doctor_id, month_key)` | Idem: filtro só por mês → seq scan em tabela pequena. |
| `admin_extra_shifts` | `(doctor_id)`; `(operational_date)` | Janela por data → ok. |
| `contracts` | `(doctor_id)`; `(status, doctor_id)`; `(doctor_id, started_at, ended_at)`; único parcial `(doctor_id, contract_number) WHERE status='active'` | ok. |
| `contract_ledger` | `(contract_id, entry_date)`; único parcial `(source_type, source_key, source_revision) WHERE source_key IS NOT NULL` | `WHERE source_type='payment_closing_attestation'` usa o parcial. `contract_id = ANY(array)` usa o composto. ok. |
| `audit_logs` | `(action, created_at)`; `(entity_type, entity_id)` | Banco de horas: `EXISTS (… ro.id::text = al.entity_id)` — o cast impede usar a PK das ocupações no lado interno; vira hash semi-join sobre **todas** as ocupações. Custo cresce com o histórico. |
| `telegram_ingested_messages` | único `(chat_id, telegram_message_id)`; `(status, created_at)`; parcial `(related_occupancy_id) WHERE related_occupancy_id IS NOT NULL AND resolution_data ? 'matchedReasonCode'` | Banco de horas: só as justificativas (parcial serve). Bot: `WHERE chat_id = ? ORDER BY created_at DESC` (service.ts:4244, meal-breaks) **não** tem índice `(chat_id, created_at)` — é a tabela que mais cresce. Latência do bot, não das telas. |
| `doctors` | único `normalized_name`; `(is_active)` | Carregada **inteira** várias vezes por request (`loadDoctorPaymentSettings`, `loadResidenteDoctorIds`, `loadEmploymentTypesByDoctor`, `allDoctorRows`) — pequena, mas repetida N vezes no loop de meses. |

FKs sem índice (Postgres não cria automaticamente; lista confirmada rodando a
§3d do script num Postgres 16 local com as 43 migrations aplicadas): 31 no total,
27 delas `*_by_user_id`/`actor_user_id` (só importam se um `users` for apagado —
não acontece). As quatro que valem registro: `bank_hours_settlements.admin_extra_shift_id`
(`ON DELETE SET NULL` → cada delete em `admin_extra_shifts` varre settlements),
`contracts.superseded_by_contract_id`, `chief_access_requests.invite_id`,
`doctor_base_preferences.base_id`. Todas em tabelas pequenas; registrar, não agir.

---

## 3. Anatomia de um carregamento de `/admin/payment-closing`

`getChiefPayableShiftsBoard(M)` (`services/payable-shifts.service.ts`):

1. **Bloco 1** (paralelo, 6 queries, todas com janela do mês): alvos, janelas
   de desativação, `loadRawRows` (UNION ALL das duas tabelas de ocupação com
   `bank_hours_entries`), extras do admin, atestações, médicos ativos. Depois
   CPU: ~60 quadros de 12h (`buildPaymentAllocationBoardModel`) — o contexto de
   candidatos já é pré-computado uma vez (`preparePaymentAllocationCandidateContext`).
   **Isto é o que a tela precisa. É barato.**
2. **Bloco 2 "financeiro"** (paralelo, até 5 conexões):
   - `getDoctorBankHoursEffectiveBalances()` → `getBankHoursHistory({balancesOnly})`
     → `SELECT * FROM bank_hours_history_shifts` **sem WHERE** + todos os
     settlements + legados + overrides + `doctors` → `buildBankHoursHistoryModel`
     sobre o histórico completo, para no fim usar só `applicationBalanceMinutes`
     por médico. Custo: O(todas as ocupações desde o início), e cresce todo dia.
   - `loadContractBalances({excludeMonthKey: M})` → `loadMonthlyApuracao(meses)`:
     `meses` vai da **abertura mais antiga** (ou `cycle_start`, quando não há
     lançamento `opening`) até o mês corrente. Para **cada** mês, em série:
     `getDoctorMonthlyPayableBreakdown` = `loadTargets` + `loadTargetDeactivationIntervals`
     + `loadRawRows` + `loadResidenteDoctorIds` + `loadDoctorPaymentSettings` +
     `loadAdminExtraShiftsForRange` (6 queries) + montar ~60 quadros. Com
     aberturas em mai/2025 são ≥17 iterações; contratos sem `opening` e
     `cycle_start` em 2024 esticam para 25–30. Nada disso muda entre dois
     carregamentos (meses fechados são imutáveis salvo correção do admin).
3. **Semente antiga** (`doctor_contracts`, tabela da 0026): se houver linhas,
   `getDoctorMonthlyPayableTotals(seedMaisAntigo, fimDoMês)` refaz a apuração do
   intervalo inteiro **de novo**, numa só passada (uma query grande + N×60 quadros).
4. `buildChiefPayableBoard` e serialização RSC (o script `perf-measure` já mede
   o tamanho do payload).

Estimativa de ordem de grandeza para um mês com 17 meses de contrato:
~6 + 6×17 + 6 + 5 ≈ **120 queries** e ~(1 + 17 + 17) × 60 ≈ **2.100 quadros**
montados em CPU por page view — e por `router.refresh()` após cada atestação.
Cada query isolada está indexada; o problema é o multiplicador.

Os mesmos read models são chamados pelo bot (`/pagamento`, digest, dentro do
webhook — resposta síncrona ao Telegram), pela folha de ponto, pela página do
médico, pelo briefing e pelas varreduras das 08:00 (`loadContractBalances`).
Cada um desses paga o loop inteiro.

### `/admin/bank-hours`

`getBankHoursHistory()` sem opções: view completa + `loadAuditTrailByOccupancy()`
(toda `audit_logs` de ocupações, `ORDER BY created_at DESC`) + todas as
justificativas do bot + todos os settlements + overrides + `doctors`. Depois
`buildBankHoursHistoryModel` com provas textuais para **todas** as ocupações. A
página recebe `?month=` mas usa só para o foco inicial do cliente — o servidor
sempre manda a vida inteira (payload RSC grande, hidratação lenta).

---

## 4. Transações, concorrência e integridade — o que está bom e o que falta

**Bom:**
- Atestação: apuração **antes** da transação e guard que lança erro se
  `syncContractLedgerForMonth` for chamado dentro de `tx` sem `precomputed`
  (lição do incidente de 03/08). Assinatura + lançamento no razão são atômicos.
- Razão append-only com único parcial `(source_type, source_key, source_revision)`:
  duas atestações concorrentes perdem a corrida no índice, não duplicam.
- Estorno de acerto: `SELECT … FOR UPDATE` na linha original + checagem de
  estorno existente **dentro** da transação — idempotente.
- Avisos do bot/worker: `telegram_bot_notices.notice_key` único +
  `onConflictDoNothing` → jobs idempotentes. Um único worker no PM2.
- Override do banco de horas: upsert por `continuity_group_id`.
- Webhook: `(chat_id, telegram_message_id)` único → retry do Telegram não
  reprocessa.

**Falta / risco:**

1. **Acerto de banco de horas é read-then-write sem trava** (financeiro).
   `POST /api/admin/payment-closing/bank-hours-settlement` calcula o saldo
   (varrendo o histórico inteiro — segundos), decide elegibilidade e só então
   `settleBankHours` insere `admin_extra_shifts` + `bank_hours_settlements`.
   Dois cliques (ou duas abas) dentro dessa janela passam ambos na checagem e
   geram **dois bônus de +12h** (dois plantões verdes pagos). Correção sem
   schema: dentro da transação de `settleBankHours`,
   `SELECT pg_advisory_xact_lock(hashtext('bank-hours-settlement:' || doctorId))`
   e **repetir a checagem de elegibilidade** com os settlements lidos na mesma
   transação (ou, se a regra de negócio permitir "um acerto por médico/mês/tipo",
   um índice único parcial — decisão de negócio, ver §6.3).
2. **Sem `statement_timeout`, `lock_timeout` e `idle_in_transaction_session_timeout`**
   na conexão do app (`db/index.ts`) nem no role (a verificar em
   `pg_db_role_setting`). O incidente de 03/08 (13 min idle in transaction com o
   app inteiro parado) teria sido cortado em segundos por
   `idle_in_transaction_session_timeout`. Proposta (só código, sem schema):
   ```ts
   postgres(url, {
     max: 5, idle_timeout: 30, prepare: false,
     connection: {
       statement_timeout: 60_000,                    // acima da leitura mais lenta hoje; baixar depois da §5
       idle_in_transaction_session_timeout: 15_000,
       lock_timeout: 5_000,
       application_name: process.env.PM2_APP_NAME ?? "plantoes",
     },
   })
   ```
   Cuidado: o `apply-migrations.ts` usa cliente próprio (não herda) — e **deve**
   continuar assim, porque migração com backfill pode legitimamente passar de 60 s.
   `application_name` separa web e worker no `pg_stat_activity`.
3. **Pool de 5 com leitura de minutos**: enquanto a §5 não reduzir o custo, a
   tela do fechamento pode esgotar o pool do processo web. Mitigação imediata e
   barata: **serializar** o bloco financeiro (não rodar `loadContractBalances`
   em `Promise.all` com o resto) ou limitar a concorrência interna dos loaders,
   deixando conexões livres para o quadro ao vivo e o webhook.
4. **Duplicidade de plantão** (ADR 006): o guard `findSameDayOccupancies` é
   pré-checagem na aplicação, não constraint. Duas chegadas simultâneas (bot +
   manual) ainda podem criar duas ocupações no mesmo turno; o pagamento se
   protege depois em `suppressSameDoctorDuplicateRows`. Uma constraint única não
   é expressável direto (transferência e continuidade geram legitimamente várias
   linhas com o mesmo grupo). Opção proporcional: `pg_advisory_xact_lock(hashtext(doctor_id))`
   na transação de criação de ocupação, serializando chegadas do mesmo médico.
   Não é urgente; registrar.
5. **Comandos pesados dentro do webhook**: `/pagamento` e o digest montam o
   board completo na requisição do Telegram. Com a §5 isso cai para segundos;
   sem ela, é uma fonte de timeout/retry do Telegram (idempotente, mas ocupa
   conexão duas vezes).

---

## 5. Melhorias de aplicação (sem mudança de schema) — a ordem que dá resultado

Cada item é validável com os scripts que já existem no repo:
`scripts/perf-baseline-payment-closing.ts` (snapshot JSON dos boards e saldos
contra um dump de produção restaurado localmente) e
`scripts/perf-measure-payment-closing.ts` (`PAYMENT_CLOSING_PERF=1`). Regra:
**snapshot antes = snapshot depois, byte a byte**, para 4 meses.

| # | Mudança | Efeito esperado | Risco |
|---|---|---|---|
| 5.1 | `loadMonthlyApuracao`: **uma** chamada `getDoctorMonthlyPayableBreakdown(inícioDoPrimeiroMês, fimDoMêsAtual)` em vez de N chamadas mensais. A função já agrupa por `monthKey`, e `getDoctorMonthlyPayableTotals` já usa o intervalo inteiro para a semente antiga. | 6×N queries → 6 queries; CPU igual (mesmos quadros). Maior ganho isolado. | Equivalência nos limites de mês (o contexto de candidatos vê ±1 dia a mais). Validar com o snapshot. |
| 5.2 | Reaproveitar a apuração da 5.1 para a semente antiga (`doctor_contracts`) em vez de `getDoctorMonthlyPayableTotals` separado — ou aposentar a semente antiga, já que a 0038 a substituiu. | Corta a segunda passada inteira. | Verificar se ainda há linhas em `doctor_contracts` (script §1). |
| 5.3 | **Cache por mês fechado** da apuração (`Map<monthKey, breakdown>` em memória do processo, invalidada por `revalidatePath`/escrita em ocupação/extra/settlement daquele mês, ou por TTL curto). Meses passados só mudam por ação do admin, que já passa pelas rotas que podem invalidar. | Page view típico volta a custar só o mês corrente. | Dois processos (web e worker) têm caches independentes — aceitável, worker lê às 08:00. Persistir em tabela é a versão robusta (§6.4). |
| 5.4 | `getDoctorBankHoursEffectiveBalances`: somar saldo em SQL (`bank_hours_entries.balance_minutes` por `continuity_group_id`, substituído pelo override quando existe, + settlements + legado) em vez de carregar a view inteira e montar o modelo. | Elimina a leitura sem janela mais pesada da tela do fechamento. | O modelo aplica regras (estatutário, grupos, `isTrueZeroDurationPhantom`…). Extrair a soma para uma função pura testada contra `buildBankHoursHistoryModel` com os mesmos dados; comparar `bank-balances.json` do baseline. |
| 5.5 | `/admin/bank-hours`: filtrar no servidor pela janela do `?month=` (a view aceita `WHERE "startedAt" >= … AND < …` e usa `*_started_idx`); "vida inteira" vira opção explícita, paginada ou sem provas textuais. `loadAuditTrailByOccupancy` recebe a mesma janela. | Payload e CPU proporcionais ao mês, não ao histórico. | O cálculo de saldo acumulado precisa do histórico anterior: manter `balancesOnly` para o saldo e janela para as linhas. |
| 5.6 | Timeouts de sessão e `application_name` (§4.2). | Corta o próximo idle-in-transaction em 15 s em vez de 13 min. | Escolher `statement_timeout` acima da leitura mais lenta medida (script §1). |
| 5.7 | Trava do acerto de banco de horas (§4.1). | Fecha a janela de bônus duplicado. | Nenhum (advisory lock transacional). |
| 5.8 | Não recarregar `doctors` 3× por iteração (passar `profiles/employmentTypes/residentes` já carregados para dentro do loop). | Pequeno; vem de graça com a 5.1. | — |

Ordem sugerida: 5.6 e 5.7 (segurança, uma tarde) → 5.1 + 5.2 + 5.8 (um PR,
validado por snapshot) → 5.4 → 5.5 → 5.3.

---

## 6. Propostas de mudança no PostgreSQL — só depois da §1, uma por migration

### 6.0 Pré-requisito: o runner precisa suportar `CREATE INDEX CONCURRENTLY`

`scripts/apply-migrations.ts` executa cada arquivo dentro de `sql.begin(...)`.
`CREATE INDEX CONCURRENTLY` **não roda em bloco de transação** (erro 25001).
Hoje, portanto, qualquer índice novo em produção é criado com `CREATE INDEX`
normal → lock `SHARE` na tabela: **leituras seguem, escritas bloqueiam** até o
índice terminar. Em `regulation_occupancies` isso é segundos (tabela pequena),
mas o bot escreve o tempo todo e a mesa ao vivo também.

Proposta (mudança no runner, sem schema): reconhecer um marcador na primeira
linha do arquivo, `-- migrate: no-transaction`, e nesse caso executar o arquivo
fora de transação, statement a statement, registrando em `schema_migrations` só
ao final. Um arquivo assim contém **apenas** `CREATE INDEX CONCURRENTLY IF NOT
EXISTS` (idempotente por natureza: se falhar no meio, fica um índice `INVALID`
que o rollback abaixo remove e o rerun recria). Validação no CI: o workflow já
roda `db:migrate` num Postgres limpo.

### 6.1 Índice `(chat_id, created_at)` em `telegram_ingested_messages`

- **Problema**: consultas do bot "últimas mensagens deste chat" (`service.ts:4244`,
  `meal-breaks.ts`) ordenam por `created_at` filtrando `chat_id`; o único índice
  com `chat_id` termina em `telegram_message_id`. É a tabela que mais cresce.
- **Confirmar antes**: `pg_stat_statements` mostra essas queries no topo? Volume
  da tabela? Plano atual usa `telegram_ingested_messages_msg_idx` + sort?
- **SQL**:
  ```sql
  -- migrate: no-transaction
  create index concurrently if not exists telegram_ingested_messages_chat_created_idx
      on operations_v2.telegram_ingested_messages (chat_id, created_at desc);
  ```
- **Lock**: `SHARE UPDATE EXCLUSIVE` (CONCURRENTLY) — não bloqueia leitura nem
  escrita; duas varreduras da tabela; espera transações abertas terminarem.
- **Impacto**: I/O proporcional ao tamanho da tabela (medir); espaço extra de um
  índice btree sobre duas colunas.
- **Compatibilidade**: nenhuma mudança de código; a versão atual só ganha o plano.
- **Rollback**: `drop index concurrently if exists operations_v2.telegram_ingested_messages_chat_created_idx;`
  (também para índice `INVALID` se a criação falhar).
- **Validação**: `EXPLAIN (ANALYZE, BUFFERS)` da query do bot antes/depois;
  `pg_stat_user_indexes.idx_scan` crescendo; `pg_indexes` mostrando `valid`.

### 6.2 Índice `(continuity_group_id)` nas duas tabelas de ocupação

- **Problema**: `listContinuityGroupOccupancies` (override do banco de horas,
  `syncBankHoursByContinuityGroup`) filtra só por `continuity_group_id`. O índice
  composto começa por `doctor_id` → seq scan (PG < 18).
- **Confirmar antes**: só vale se a tabela já passou de algumas dezenas de
  milhares de linhas **e** o plano mostra seq scan com tempo relevante. Em
  tabela pequena o seq scan é mais barato que manter o índice. Alternativa sem
  índice: passar `doctor_id` junto (o chamador sempre o tem) — preferível.
- **SQL / lock / rollback**: mesmo padrão da 6.1, um arquivo com os dois
  `create index concurrently if not exists <tabela>_continuity_group_idx on … (continuity_group_id)`.

### 6.3 Unicidade de acerto de banco de horas por (médico, mês, tipo) — decisão de negócio

- **Problema**: duplo clique gera dois bônus (§4.1). O advisory lock resolve; um
  índice único parcial resolveria também **se** a regra for "no máximo um bônus e
  uma punição por médico por mês" e se o estorno (`notes like 'reversal:%'`)
  ficar fora da unicidade.
- **SQL (só se a regra existir)**:
  ```sql
  -- migrate: no-transaction
  create unique index concurrently if not exists bank_hours_settlements_doctor_month_kind_idx
      on operations_v2.bank_hours_settlements (doctor_id, month_key, kind)
      where notes not like 'reversal:%';
  ```
- **Risco**: dados atuais podem já violar (dois acertos legítimos no mesmo mês).
  O script §1 traz a contagem. Se violar, fica só o advisory lock.
- **Rollback**: `drop index concurrently …`.

### 6.4 Snapshot persistido da apuração mensal (expand-only)

- **Problema**: a 5.3 em memória se perde no restart e não é compartilhada entre
  web e worker. Uma tabela `payable_month_snapshots (month_key pk, computed_at,
  source_max_updated_at, breakdown jsonb)` guarda a apuração de meses fechados;
  invalidação por comparação de `max(updated_at)` das ocupações/extras/settlements
  do mês.
- **Lock**: `CREATE TABLE` novo — `ACCESS EXCLUSIVE` só na tabela nova, nada
  existente é tocado. Backward compatible por construção (a versão antiga não
  sabe que ela existe). Rollback: `drop table`.
- **Só depois** da 5.1–5.4 — pode nem ser necessária.

### 6.5 O que **não** fazer agora

- Materializar `bank_hours_history_shifts` ou `contract_balance`: resolve sintoma,
  cria problema de refresh (lock `ACCESS EXCLUSIVE` sem `CONCURRENTLY`, e com
  `CONCURRENTLY` exige índice único) e dado defasado numa tela financeira. A
  5.4/5.5 resolvem na origem.
- Índices por `month_key` em `payment_closing_*`/`bank_hours_settlements`:
  tabelas de poucas linhas; seq scan é o plano certo.
- Remover `regulation_occupancies_doctor_idx`/`intervention_occupancies_doctor_idx`
  (prefixos redundantes) antes de ver `idx_scan` — e mesmo depois, o ganho é só
  de escrita.
- `VACUUM FULL`/`REINDEX` bloqueante em produção. Se o script mostrar bloat,
  `REINDEX INDEX CONCURRENTLY` (PG ≥ 12) em janela.

---

## 7. Operação: backup, restore e observabilidade

- **Backup hoje**: `pg_dump | gzip` só quando o deploy roda com
  `--run-migrations`, mantendo os últimos 5 em `/home/ubuntu/backups/plantoes-predeploy/`.
  Não há no repo rotina diária, retenção definida nem registro de teste de
  restore. Recomendação: cron diário `pg_dump -Fc` com retenção (ex.: 14 diários
  + 3 mensais), cópia para fora do host, e **um restore de teste documentado**
  (`pg_restore` num Postgres local + `npm run db:migrate` + smoke do `/api/board`)
  — o `scripts/perf-baseline` já depende exatamente desse dump restaurado, então
  o teste de restore vira parte do fluxo de validação de performance.
- **`pg_stat_statements`**: sem ele, toda análise de lentidão é por dedução.
  Pedir a habilitação (restart do Postgres do host; janela combinada com os
  outros projetos).
- **`log_min_duration_statement`** (ex.: 2 s) no role `plantoes` via
  `ALTER ROLE plantoes SET log_min_duration_statement = '2s'` — sem restart,
  vale para conexões novas. Não é schema; ainda assim registrar como migration
  ou no runbook para não virar configuração invisível.
- **Rotina mensal** (todos read-only, estão no script): dead tuples e último
  autovacuum, crescimento de tabelas/índices, índices sem uso, transações longas,
  conexões por `application_name`.

---

## 8. Próximos passos propostos

1. Rodar `scripts/db-inspect-prod.sql` do Mac e anexar a saída neste diretório
   (`docs/db/inspecao-AAAA-MM-DD.txt`, sem dados pessoais — o script não lista
   nomes de médicos).
2. PR de segurança (§5.6 + §5.7): timeouts de sessão e trava do acerto.
3. PR de performance (§5.1, §5.2, §5.8), validado por snapshot com
   `perf-baseline-payment-closing.ts` contra o dump restaurado.
4. Reavaliar com `perf-measure`; então §5.4 e §5.5.
5. Só com números em mão, decidir os índices da §6 — cada um com a própria
   migration `-- migrate: no-transaction`, após o ajuste do runner (§6.0).
