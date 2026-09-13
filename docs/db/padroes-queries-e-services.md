# Padrões para queries, services e endpoints — antes/depois deste repositório

Catálogo prático. Cada padrão nasce de um trecho real do código (citado pelo
nome da função, não por linha, para não envelhecer) e mostra a forma alvo.
Leia junto com [regras-dados-telas.md](regras-dados-telas.md).

Convenções do repo que valem para tudo abaixo: Drizzle sobre postgres.js,
pool `max: 5` por processo, SQL cru via `db.execute(sql\`...\`)` para leituras
compostas, Drizzle query builder para CRUD simples, `services/` monta read
models e `modules/` tem regra pura testável.

---

## 1. Waterfall escondido em loop: N chamadas de "mês inteiro"

**Antes** (`loadMonthlyApuracao` em `services/contract-balance.service.ts`):

```ts
for (const mesChave of meses) {                       // 17–30 meses
    const range = resolveMonthlyReportRange(mesChave);
    const breakdown = await getDoctorMonthlyPayableBreakdown(range.start, range.end); // 6 queries + 60 quadros
    ...
}
```

Cada iteração é uma função que por dentro faz 6 queries e monta ~60 quadros.
Em série. O custo é 6×N queries e cresce um mês por mês.

**Depois** — a função já agrupa por `monthKey`; peça o intervalo inteiro uma vez:

```ts
const primeiro = resolveMonthlyReportRange(meses[0]).start;
const ultimo = resolveMonthlyReportRange(meses.at(-1)!).end;
const breakdown = await getDoctorMonthlyPayableBreakdown(primeiro, ultimo);   // 6 queries, uma vez
for (const mesChave of meses) {
    apuracao.set(mesChave, new Map(
        [...breakdown].flatMap(([doctorId, porMes]) => {
            const valor = porMes.get(mesChave);
            return valor ? [[doctorId, valor] as const] : [];
        }),
    ));
}
```

Regra: **se uma função "monta o período inteiro", nunca a chame dentro de um
loop de períodos.** Validação obrigatória: snapshot idêntico com
`perf-baseline-payment-closing.ts` (o contexto de candidatos passa a ver ±1 dia
a mais nas bordas dos meses; provar que o resultado não muda).

---

## 2. Paralelismo limitado pelo pool

**Bom** (bloco 1 de `getChiefPayableShiftsBoard`): 6 loaders independentes em
`Promise.all`.

**Armadilha**: `Promise.all` com mais promessas do que conexões vira fila, e
enquanto isso o webhook do Telegram e `GET /api/board` esperam. O bloco
financeiro dispara 5 loaders num pool de 5 — um único page view esgota o
processo web.

**Depois** — dois níveis:

```ts
// nível request: o que é barato roda junto; o pesado roda depois, sozinho
const [meta, contracts, settlements] = await Promise.all([
    loadPaymentClosingMetaForMonth(month), loadDoctorContracts(), loadBankHoursSettlementsForMonth(month),
]);
const bankBalances = await getDoctorBankHoursEffectiveBalances();   // pesado: não disputa o pool
const contractBalances = await loadContractBalances({ excludeMonthKey: month });
```

Se precisar de N tarefas com concorrência limitada, escreva um `mapLimit`
pequeno (sem dependência nova) e use limite 2 — deixe 3 conexões para o resto
do processo. Nunca `Promise.all(medicos.map(m => queryPorMedico(m)))` com 150
médicos: isso é N+1 disfarçado; agrupe em uma query com `WHERE doctor_id = ANY($1)`
ou `GROUP BY doctor_id`.

---

## 3. Postgres agrega, Node não

**Antes** (`getDoctorBankHoursEffectiveBalances`): lê a view inteira
(`select * from bank_hours_history_shifts`, todas as ocupações desde 2025, 5
joins por linha), monta o modelo completo com `buildBankHoursHistoryModel` e no
fim usa um número por médico.

**Depois** — soma no banco, regra pura em Node só sobre o agregado:

```sql
with saldo_app as (
    -- uma linha por grupo de continuidade: override manual vence a soma das entradas
    select o.doctor_id, o.continuity_group_id,
           coalesce(ov.balance_minutes, sum(bhe.balance_minutes)) as minutos
    from operations_v2.bank_hours_entries bhe
    join lateral (
        select doctor_id, continuity_group_id from operations_v2.regulation_occupancies where id = bhe.regulation_occupancy_id
        union all
        select doctor_id, continuity_group_id from operations_v2.intervention_occupancies where id = bhe.intervention_occupancy_id
    ) o on true
    left join operations_v2.bank_hours_balance_overrides ov on ov.continuity_group_id = o.continuity_group_id
    group by o.doctor_id, o.continuity_group_id, ov.balance_minutes
)
select doctor_id, sum(minutos) as application_balance_minutes
from saldo_app group by doctor_id;
```

Depois em Node: `+ legado + acertos`, regra de estatutário, régua de ±12h —
tudo sobre ~150 linhas. **Antes de trocar**, extraia a soma atual para uma
função pura e prove com o `bank-balances.json` do baseline que os números batem
(o modelo aplica filtros como `isTrueZeroDurationPhantom` que o SQL precisa
reproduzir ou provar irrelevantes para o saldo).

Regra geral: se o Node recebe milhares de linhas para devolver dezenas, a
agregação está na camada errada.

---

## 4. View larga sempre com janela

`bank_hours_history_shifts` é conveniente e perigosa: sem `WHERE` lê tudo.

```ts
// antes
db.execute(sql`select * from operations_v2.bank_hours_history_shifts`);

// depois — a view expõe "startedAt"; o predicado desce para regulation_occupancies_started_idx
db.execute(sql`
    select "occupancyId", "doctorId", "startedAt", "balanceMinutes", ...   -- colunas explícitas
    from operations_v2.bank_hours_history_shifts
    where "startedAt" >= ${inicio}::timestamptz and "startedAt" < ${fim}::timestamptz
`);
```

Confirme com `EXPLAIN` que o predicado foi empurrado para dentro do `UNION ALL`
(o Postgres faz isso para views simples; se aparecer `Subquery Scan` com filtro
por cima, a view precisa ser reescrita ou substituída por CTE no service).

---

## 5. Read model por caso de uso, não "tudo da entidade"

**Antes**: `ChiefPayableBoardModel` carrega grade + `payableShifts` +
`attestationSegments` + por médico `contractBalances[].statement` e
`metricsInput`. O modal usa o financeiro; a grade não.

**Depois** — dois read models e um endpoint sob demanda:

```
getChiefPayableBoardCore(month)            → page.tsx (crítico; bloco 1)
getDoctorClosingFinancials(doctorId, month) → GET /api/admin/payment-closing/doctor/[id]/financials?month=
```

No cliente, o modal busca ao abrir (`fetch` + `useTransition`, padrão já usado
no arquivo). Com `<Suspense>` dá para transmitir o bloco agregado (saldos) sem
travar a grade:

```tsx
// app/admin/payment-closing/page.tsx (Server Component, force-dynamic)
const core = await getChiefPayableBoardCore(month);          // rápido
return (
  <ChiefPaymentViewClient board={core}>
    <Suspense fallback={<FinanceirosSkeleton />}>
      <Financeiros promise={loadClosingFinancials(month)} />  {/* Server Component async */}
    </Suspense>
  </ChiefPaymentViewClient>
);
```

Regra para desenhar endpoints: o nome diz o que a tela mostra
(`/closures/2026-09/summary`, `/closures/2026-09/shifts?cursor=&limit=`), a
resposta tem só os campos daquela visão, e listas que crescem com o tempo têm
`limit` + cursor (`(startedAt, occupancyId)`), não `page=974`.

---

## 6. Mesma tabela carregada várias vezes no request

`doctors` inteira é lida por `loadDoctorPaymentSettings`, `loadResidenteDoctorIds`,
`loadEmploymentTypesByDoctor` e `allDoctorRows` — em cada iteração do padrão 1.

**Depois**: carregue uma vez no topo do request e injete por parâmetro
(`getDoctorMonthlyPayableBreakdown(range, { doctorSettings })`). Funções de
service aceitam dependências pré-carregadas como opcionais e mantêm o
comportamento antigo quando ausentes — assim os chamadores existentes não quebram.

---

## 7. Transação curta; apuração fora dela

O padrão certo já existe em `services/contract-ledger.service.ts`:

```ts
const consumoDoMes = await loadMonthConsumption(doctorId, monthKey);   // pesado, fora da tx
await getDb().transaction(async (tx) => {
    await setDoctorMonthAttestation({ ..., tx });
    await syncContractLedgerForMonth({ ..., precomputed: consumoDoMes, tx });  // lança se faltar precomputed
});
```

Motivo histórico: 03/08/2026, transação segurando a única conexão enquanto a
apuração pedia outra → 13 min de `idle in transaction`, app inteiro parado.
Complementos pendentes (auditoria §5.6): `statement_timeout`,
`idle_in_transaction_session_timeout` e `lock_timeout` na conexão do app, e
`application_name` distinto para web e worker.

---

## 8. Read-then-write em estado financeiro → trava na mesma transação

**Antes** (`POST .../bank-hours-settlement`): calcula saldo (segundos), checa
elegibilidade, depois `settleBankHours` insere. Dois cliques na janela =
dois bônus.

**Depois**:

```ts
return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'bank-hours-settlement:' + doctorId}))`);
    const jaLancado = await tx.select(...).from(bankHoursSettlements)
        .where(and(eq(bankHoursSettlements.doctorId, doctorId), eq(bankHoursSettlements.monthKey, monthKey), eq(bankHoursSettlements.kind, kind)));
    if (jaLancado.length > 0 && !permiteMaisDeUm) throw new Error("Acerto já lançado neste mês.");
    // inserts...
});
```

Escolha por semântica: `FOR UPDATE` quando existe a linha a proteger (estorno,
já feito em `reverseBankHoursSettlement`); unique index quando a regra é
"no máximo um"; upsert quando "o último vence" (override do banco de horas);
advisory lock quando a invariante é calculada e não há linha para travar.

---

## 9. Períodos fechados vêm de agregação persistida

Já existe no repo: `bank_hours_entries` (recalculada por grupo de continuidade
em `syncBankHoursByContinuityGroup` a cada escrita), `payment_attestation_slots`
(snapshot por turno), `contract_ledger` (meses assinados). Falta a apuração
mensal do pagável — desenho na auditoria §6.4. Princípios:

- a escrita marca o período sujo (`UPDATE ... SET dirty = true WHERE month_key = $1`);
- a leitura usa o snapshot quando limpo e recalcula só o sujo/corrente;
- gravação idempotente (`ON CONFLICT DO UPDATE`), `pg_try_advisory_xact_lock`
  para não calcular duas vezes;
- neste domínio **não há cascata** entre meses: a apuração de um mês não depende
  dos anteriores; saldo contratual e banco de horas são somas.

---

## 10. Índice novo em produção: sempre `CONCURRENTLY`, sempre com evidência

Antes de propor: `pg_stat_statements` mostra a query? `pg_stat_user_indexes`
mostra que os índices atuais não a atendem? `EXPLAIN` confirma seq scan em
tabela que não é pequena? Se sim, migration própria:

```sql
-- migrate: no-transaction
create index concurrently if not exists <tabela>_<colunas>_idx
    on operations_v2.<tabela> (<colunas>);
```

O runner atual roda cada arquivo em transação e **rejeita** `CONCURRENTLY`
(erro 25001); a auditoria §6.0 propõe o marcador acima. Rollback: `drop index
concurrently if exists ...` (também para índice `INVALID` de criação falhada).
Lembre: PG < 18 não usa índice composto quando falta a coluna líder
(`WHERE continuity_group_id = ?` não usa `(doctor_id, continuity_group_id, started_at)`);
antes de criar índice, veja se o chamador pode passar `doctor_id` junto.

---

## 11. Async em rotas e worker

- Route Handler não faz trabalho pesado síncrono para quem tem timeout curto
  (webhook do Telegram): responda rápido e delegue ao worker via tabela/fila
  idempotente, ou garanta que o comando custa milissegundos (padrões 1–5).
- Worker: um job por vez por chave (`notice_key` único já faz isso para avisos);
  para tarefas que não podem concorrer, `pg_try_advisory_lock` no início.
- `revalidatePath` da página inteira é o mínimo; o alvo é invalidar o read
  model do (médico, mês) e nada mais.

---

## 12. Como provar que a refatoração não mudou o resultado

1. Restaure um dump de produção localmente (`agent-operations.md §3`).
2. `DATABASE_URL=... npx tsx scripts/perf-baseline-payment-closing.ts /tmp/antes 2026-05 2026-06 2026-07 2026-08`
3. Aplique a mudança.
4. Mesmo comando para `/tmp/depois`; `diff -r /tmp/antes /tmp/depois` vazio.
5. `PAYMENT_CLOSING_PERF=1 npx tsx scripts/perf-measure-payment-closing.ts 2026-08` antes e depois, e cole os dois no PR.
6. Preencha o relatório do fim de `regras-dados-telas.md` (requests, queries, linhas lidas/devolvidas, payload, série vs. paralelo, cache e invalidação, **custo × histórico**).
