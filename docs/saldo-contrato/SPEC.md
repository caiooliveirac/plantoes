# Feature Spec — Controle de Saldo de Contrato (Plantonistas PJ)

> **Como usar este documento**
> Este é o briefing mestre para implementação assistida por agentes (Claude Code).
> Rode as fases na ordem (§10). **Nenhum agente avança de fase sem o checkpoint aprovado.**
> Qualquer premissa marcada `⚠️ CONFIRMAR` deve virar pergunta ao usuário antes de virar código.

---

## 1. Problema

Cada plantonista PJ tem um **teto anual de emissão de notas fiscais** vinculado ao contrato.
O teto é renovado na data de aniversário do contrato (coluna `DATA ADMISSÃO`). Entre uma
renovação e outra, cada nota emitida consome saldo.

O risco operacional real: o médico consome rápido demais, **zera o saldo meses antes do fim do
ciclo** e fica impedido de plantonar. O gestor descobre tarde e precisa contratar alguém às
pressas para cobrir a escala.

Isso **já acontece hoje** — na planilha de maio/2026 há saldos negativos:

| Médico | Teto do ciclo | Saldo em 31/05 | Situação |
|---|---:|---:|---|
| Karen Seifarth Miranda (36h) | R$ 248.598,00 | **−R$ 89.762,24** | zerou em ~15/03/2026, 5 meses antes do fim do ciclo |
| Francisco Isensee de Macedo (36h) | R$ 248.598,00 | **−R$ 46.778,94** | estourado |
| Leonardo Copque Magalhães (24h) | R$ 165.732,00 | **−R$ 33.141,77** | resolvido com contrato novo (184/2026) |
| Gabriel Vitor do Amor Divino (24h) | R$ 165.732,00 | **−R$ 27.368,34** | estourado no 2º mês de contrato |
| João Pedro Miguez Pinto (24h) | R$ 165.732,00 | **−R$ 25.277,89** | estourado |

**Objetivo da feature:** transformar o saldo de um número reativo (só se descobre no fechamento)
em um **indicador antecipatório** — "o Dr. X, no ritmo atual, fica sem saldo em 05/12/2026, e o
ciclo dele só termina em 03/01/2027".

**Anti-objetivo:** não é um bloqueio rígido. O médico *pode* pegar extras. O sistema precisa
mostrar o custo dessa decisão no momento em que ela é tomada, não impedir.

---

## 2. Glossário

| Termo | Definição |
|---|---|
| **Contrato** | Vínculo PJ entre a empresa do médico (CNPJ) e o SAMU. Tem nº, empresa, CH e teto. |
| **Ciclo** | Janela de 12 meses entre dois aniversários do contrato. `[aniversário, aniversário+1ano)`. |
| **Teto (valor do contrato)** | Valor máximo faturável dentro do ciclo. |
| **Consumo** | Soma das notas emitidas dentro do ciclo. |
| **Saldo** | `teto − consumo`. Pode ser negativo (estouro). |
| **Pace esperado** | Consumo linear teórico: `teto × (dias decorridos / dias do ciclo)`. |
| **Burn rate** | Consumo médio mensal efetivo do médico no ciclo vigente. |
| **Runway** | Quantos meses o saldo ainda cobre no burn rate atual. |
| **Folga** | `runway − meses restantes do ciclo`. Negativa = vai estourar. |
| **IR (Índice de Ritmo)** | `consumo / pace esperado`. 1,00 = exatamente no ritmo. |
| **Fechamento (payment closing)** | Tela onde se registram os plantões do mês, a nota fiscal e o valor faturado. |

---

## 3. Regras de negócio

### 3.1 Ciclo e renovação

- `anniversary` = dia/mês da `DATA ADMISSÃO` do contrato.
- `cycleStart` = último aniversário **≤ hoje**; `cycleEnd` = `cycleStart + 1 ano` (exclusivo).
- Na virada do ciclo o saldo **reseta para o teto integral** — não há carry-over.
  Confirmado na planilha: Alexandre de Campos Farias (admissão 10-fev) tinha
  R$ 45.073,61 em jan/2026 e R$ 165.732,00 em fev/2026.
- **DECIDIDO:** saldo negativo **não** é descontado do ciclo seguinte. O ciclo novo abre
  com `openingBalance = ceilingAmount`, sempre. O estouro do ciclo anterior é registrado
  como **pendência sem conduta** (§3.5): aparece em lista, não gera desconto, não bloqueia,
  não notifica além do registro.
- 29/02: aniversário em 29/02 em ano não bissexto → normaliza para 28/02.

### 3.2 Tabela de valores (já existente no app — apenas validar)

| Categoria | Dia de semana | Fim de semana |
|---|---:|---:|
| Generalista | R$ 1.244,87 | R$ 1.381,10 |
| Especialista | R$ 1.329,66 | R$ 1.457,15 |
| Psiquiatria | R$ 1.299,82 | R$ 1.411,47 |

- Quantidade de plantões é **decimal em passos de 0,5** (a planilha registra "11,5" e "0,5";
  R$ 622,44 = meio plantão de semana). O schema não pode usar `integer`.
- **DECIDIDO:** feriado é cobrado com a **mesma tarifa de fim de semana**. Não existe terceira
  tarifa. O módulo de pagamento já resolve essa classificação — **reusar a função existente**,
  não reimplementar calendário de feriados nesta feature.

### 3.3 Teto do contrato

**DECIDIDO:** `ceilingAmount` é **campo do contrato, editável por admin** (§6). O sistema
**nunca** deriva teto a partir da CH.

- Valor a carregar no backfill = o teto vigente de cada linha da planilha.
- Referência habitual (só para pré-preencher o formulário de cadastro):

| CH | Generalista | Especialista |
|---|---:|---:|
| 24h | R$ 165.732,00 | R$ 174.858,00 |
| 36h | R$ 248.598,00 | — |
| 48h | R$ 331.464,00 | R$ 349.716,00 |

- Existem exceções com teto maior por concessão administrativa (ex.: Luana Bordoni, 48h,
  R$ 558.584,52). **Não modelar a regra da concessão** — o admin digita o valor.
- **A CH é informativa.** Nenhum cálculo desta feature depende dela: a tradução em plantões
  usa apenas `saldo ÷ tarifa`, que independe da carga horária contratada.

### 3.4 Casos de borda obrigatórios

1. **Vários médicos no mesmo nº de contrato/empresa** — ex.: contrato 99/2025 (Costa Pinto
   Sapucaia) cobre Gabriel Sapucaia, Karla Santos Pinto e Sadja Carolina.
   **DECIDIDO: fora de escopo.** O saldo é **por médico** (uma linha da planilha = um saldo).
   Não existe teto agregado por empresa, não existe compensação entre sócios, não existe
   alerta cruzado. O alerta é sempre sobre a linha do próprio médico.
2. **Médico com dois contratos simultâneos** — ex.: Ana Beatriz D'Almeida (471/2024 + 455/2025,
   duas datas de admissão). O fechamento precisa saber **contra qual contrato** a nota corre.
3. **Troca de CH ou de teto no meio do ciclo** — **DECIDIDO: não acontece pelo sistema.**
   O teto é imutável dentro do ciclo. Se precisar mudar, o chefe **renova/substitui o contrato
   manualmente** (novo registro em `contracts`, com `supersededByContractId` apontando para o
   anterior). O ciclo antigo é encerrado na data informada e o novo abre com o teto novo.
4. **Contrato substituto após estouro** — Leonardo Copque encerrou o 247/2025 negativo e recebeu
   o 184/2026. Mesmo mecanismo do item 3. O saldo negativo do contrato antigo permanece
   registrado como pendência (§3.5) e **não** é transportado.
5. **Contrato iniciado no meio do mês** — o primeiro ciclo é proporcional em dias, não em meses.
6. **Plantão dobrado / desconto de CH** — anotações do tipo `(+12h)`, `(−12h)` na planilha viram
   ajustes manuais no ledger, não regra automática.

### 3.5 Pendências (estouro registrado, sem conduta)

Quando um ciclo é encerrado (por virada de aniversário, por substituição de contrato ou por
término) com `balance < 0`, o sistema grava uma **pendência**:

```
contract_pendencies (
  id, cycle_id, contract_id, doctor_id,
  amount            numeric,   -- valor absoluto do estouro
  detected_at       date,      -- data de encerramento do ciclo
  status            enum('open','acknowledged','archived') default 'open',
  acknowledged_by   uuid null, acknowledged_at timestamp null,
  notes             text null
)
```

Regras explícitas — **não implementar nada além disto**:
- Não desconta do ciclo novo.
- Não bloqueia fechamento, escala ou cadastro.
- Não dispara alerta próprio (só entra no digest como contagem).
- Só aparece numa aba **"Pendências"** do painel do gestor, com botão *Marcar como ciente*
  (muda para `acknowledged`) e *Arquivar* — ambos restritos a admin.
- Nenhuma regra de negócio lê esta tabela. Ela é puramente informativa.

---

## 4. Modelo de dados (Drizzle / PostgreSQL)

Princípio: **o saldo nunca é um campo mutável**. É a soma de um razão append-only.
Isso dá auditoria, reversão e reprocessamento grátis.

```ts
// db/schema/contracts.ts

export const contractCategory = pgEnum('contract_category', [
  'generalista', 'especialista', 'psiquiatria',
]);

export const contractStatus = pgEnum('contract_status', [
  'active', 'suspended', 'terminated',
]);

export const contracts = pgTable('contracts', {
  id: uuid('id').primaryKey().defaultRandom(),
  doctorId: uuid('doctor_id').notNull().references(() => doctors.id),

  contractNumber: text('contract_number').notNull(),      // "903/2024"
  companyName: text('company_name').notNull(),
  companyTaxId: text('company_tax_id'),                    // CNPJ

  category: contractCategory('category').notNull(),
  weeklyHours: numeric('weekly_hours', { precision: 5, scale: 1 }).notNull(), // 12/24/36/48/72

  ceilingAmount: numeric('ceiling_amount', { precision: 14, scale: 2 }).notNull(),
  anniversaryDate: date('anniversary_date').notNull(),     // base da renovação
  startedAt: date('started_at').notNull(),
  endedAt: date('ended_at'),

  status: contractStatus('status').notNull().default('active'),
  supersededByContractId: uuid('superseded_by_contract_id'),
  notes: text('notes'),
  ...timestamps,
}, (t) => ({
  doctorIdx: index().on(t.doctorId),
  activeIdx: index().on(t.status, t.doctorId),
  uniqueActive: uniqueIndex()
    .on(t.doctorId, t.contractNumber)
    .where(sql`status = 'active'`),
}));

export const contractCycles = pgTable('contract_cycles', {
  id: uuid('id').primaryKey().defaultRandom(),
  contractId: uuid('contract_id').notNull().references(() => contracts.id),

  cycleStart: date('cycle_start').notNull(),
  cycleEnd: date('cycle_end').notNull(),                   // exclusivo
  sequence: integer('sequence').notNull(),                 // 1, 2, 3...

  ceilingAmount: numeric('ceiling_amount', { precision: 14, scale: 2 }).notNull(), // snapshot
  openingBalance: numeric('opening_balance', { precision: 14, scale: 2 }).notNull(),

  closedAt: timestamp('closed_at'),
  ...timestamps,
}, (t) => ({
  uniqueSeq: uniqueIndex().on(t.contractId, t.sequence),
  rangeIdx: index().on(t.contractId, t.cycleStart, t.cycleEnd),
}));

export const ledgerEntryType = pgEnum('ledger_entry_type', [
  'opening',            // crédito inicial do ciclo (= openingBalance)
  'invoice',            // consumo vindo de um fechamento
  'invoice_reversal',   // estorno de fechamento
  'manual_adjustment',  // ajuste do gestor (glosa, acerto, dobra)
]);

export const contractLedger = pgTable('contract_ledger', {
  id: uuid('id').primaryKey().defaultRandom(),
  cycleId: uuid('cycle_id').notNull().references(() => contractCycles.id),

  entryDate: date('entry_date').notNull(),                 // competência
  type: ledgerEntryType('type').notNull(),

  // sinal: positivo credita saldo, negativo consome
  amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),

  // decomposição do consumo — alimenta a tradução em plantões
  weekdayShifts: numeric('weekday_shifts', { precision: 6, scale: 1 }).default('0'),
  weekendShifts: numeric('weekend_shifts', { precision: 6, scale: 1 }).default('0'),

  sourceType: text('source_type'),        // 'payment_closing'
  sourceId: uuid('source_id'),            // FK lógica p/ o fechamento
  invoiceNumber: text('invoice_number'),  // nº da nota fiscal
  processNumber: text('process_number'),  // nº do processo SEI

  description: text('description'),
  createdBy: uuid('created_by').references(() => users.id),
  ...timestamps,
}, (t) => ({
  cycleIdx: index().on(t.cycleId, t.entryDate),
  sourceIdx: uniqueIndex().on(t.sourceType, t.sourceId)
    .where(sql`source_id is not null and type = 'invoice'`),
}));
```

### 4.1 Vínculo com o fechamento existente

Adicionar em `payment_closings` (ou equivalente):

```ts
contractId: uuid('contract_id').references(() => contracts.id),  // qual contrato consome
ledgerEntryId: uuid('ledger_entry_id'),                          // preenchido ao confirmar
```

**Regra:** o lançamento no ledger acontece na **confirmação/aprovação** do fechamento,
dentro da mesma transação. Rascunho não consome saldo — mas a UI mostra a *projeção*.

### 4.2 View de métricas

```sql
CREATE OR REPLACE VIEW contract_cycle_balance AS
SELECT
  c.id                          AS cycle_id,
  c.contract_id,
  ct.doctor_id,
  c.cycle_start,
  c.cycle_end,
  c.ceiling_amount::numeric     AS ceiling,
  COALESCE(SUM(l.amount) FILTER (WHERE l.type <> 'opening'), 0) AS net_movement,
  c.opening_balance + COALESCE(SUM(l.amount) FILTER (WHERE l.type <> 'opening'), 0) AS balance,
  COALESCE(-SUM(l.amount) FILTER (WHERE l.type IN ('invoice','invoice_reversal')), 0) AS consumed,
  COALESCE(SUM(l.weekday_shifts), 0) AS weekday_shifts,
  COALESCE(SUM(l.weekend_shifts), 0) AS weekend_shifts,
  MAX(l.entry_date)             AS last_entry_date
FROM contract_cycles c
JOIN contracts ct ON ct.id = c.contract_id
LEFT JOIN contract_ledger l ON l.cycle_id = c.id
GROUP BY c.id, ct.doctor_id;
```

> Se a lista de médicos ficar lenta, materialize e refresque no commit do fechamento.
> Comece com view simples — o volume é de ~130 médicos × 12 lançamentos/ano.

---

## 5. Motor de cálculo

Módulo puro, **sem I/O**, 100% testável: `lib/contracts/balance-metrics.ts`.

```ts
export interface CycleMetricsInput {
  ceiling: number;
  openingBalance: number;
  consumed: number;             // acumulado no ciclo
  cycleStart: Date;
  cycleEnd: Date;               // exclusivo
  asOf: Date;                   // hoje ou data de referência
  weekdayRate: number;
  weekendRate: number;
  weekdayShifts: number;        // acumulado no ciclo (para mix real)
  weekendShifts: number;
}

export interface CycleMetrics {
  balance: number;              // saldo restante
  consumedPct: number;          // 0..1+
  elapsedDays: number;
  totalDays: number;
  elapsedPct: number;
  remainingMonths: number;      // fracionário

  expectedConsumption: number;  // pace linear
  paceIndex: number;            // IR = consumed / expected
  paceDelta: number;            // consumed - expected (R$)

  burnRateMonthly: number;      // consumo médio mensal efetivo
  healthyMonthlyBudget: number; // saldo / meses restantes
  runwayMonths: number;         // saldo / burnRate
  slackMonths: number;          // runway - remainingMonths
  projectedDepletionDate: Date | null;
  projectedOverrun: number;     // R$ que estouraria se mantiver o ritmo até o fim

  // tradução em plantões
  avgShiftCost: number;         // custo médio real do mix do médico
  remainingWeekdayShifts: number;
  remainingWeekendShifts: number;
  remainingShiftsAtOwnMix: number;
  monthlyWeekdayShifts: number;
  monthlyWeekendShifts: number;
  monthlyShiftsAtOwnMix: number;

  riskLevel: 'safe' | 'watch' | 'warning' | 'critical' | 'depleted';
}
```

### 5.1 Fórmulas

```
elapsedDays        = clamp(asOf − cycleStart, 0, totalDays)
totalDays          = cycleEnd − cycleStart
elapsedPct         = elapsedDays / totalDays
remainingMonths    = (totalDays − elapsedDays) / totalDays × 12

balance            = openingBalance − consumed
expectedConsumption= ceiling × elapsedPct
paceIndex          = expectedConsumption > 0 ? consumed / expectedConsumption : 0
paceDelta          = consumed − expectedConsumption

dailyBurn          = elapsedDays > 0 ? consumed / elapsedDays : 0
burnRateMonthly    = dailyBurn × (totalDays / 12)
runwayMonths       = dailyBurn > 0 ? (balance / dailyBurn) / (totalDays/12) : ∞
slackMonths        = runwayMonths − remainingMonths
projectedDepletion = dailyBurn > 0 && balance > 0 ? asOf + (balance/dailyBurn) dias : null
projectedOverrun   = max(0, dailyBurn × (totalDays − elapsedDays) − balance)

healthyMonthlyBudget = remainingMonths > 0 ? balance / remainingMonths : 0

avgShiftCost       = totalShifts > 0 ? consumed / totalShifts
                                     : (weekdayRate + weekendRate) / 2
remainingWeekdayShifts = floor2(balance / weekdayRate)   // 0,5 em 0,5
remainingWeekendShifts = floor2(balance / weekendRate)
remainingShiftsAtOwnMix= floor2(balance / avgShiftCost)
monthly*               = idem, mas sobre healthyMonthlyBudget
```

> `floor2(x)` arredonda para baixo em múltiplos de 0,5 (plantão meio contabilizado).

### 5.2 Classificação de risco

Baseada em **folga** (a métrica que responde a pergunta do chefe), com o IR como desempate:

```
balance <= 0                         → 'depleted'   (preto)
slackMonths < -1.0                   → 'critical'   (vermelho)  zera >1 mês antes do fim
slackMonths < -0.25                  → 'warning'    (laranja)   zera pouco antes do fim
slackMonths < 0.5 || paceIndex > 1.15→ 'watch'      (amarelo)   margem apertada
senão                                → 'safe'       (verde)
```

**Amortecedor obrigatório:** nos primeiros **45 dias** do ciclo o burn rate é ruidoso
(um mês pesado distorce a projeção). Nesse período force `riskLevel = 'safe' | 'watch'` no
máximo e exiba o rótulo *"amostra insuficiente"* em vez da data de exaustão.

### 5.3 Exemplo trabalhado (validado contra a planilha)

**Caio Oliveira do Carmo** — 48h, contrato 903/2024, admissão 03/01, teto R$ 331.464,00.
Ciclo 03/01/2026 → 03/01/2027. Referência: 31/05/2026.

| Mês | Faturado |
|---|---:|
| jan | R$ 22.816,35 |
| fev | R$ 36.277,38 |
| mar | R$ 26.473,45 |
| abr | R$ 35.382,48 |
| mai | R$ 24.878,60 |
| **Total** | **R$ 145.828,26** |

Saldo calculado: **R$ 185.635,74** — a planilha traz R$ 185.635,75 (1 centavo de
arredondamento). O motor está aderente.

```
elapsedDays = 148 / 365            → 40,5% do ciclo
expectedConsumption = 134.401,84
paceIndex = 1,085                  → 8,5% acima do ritmo
burnRateMonthly = 29.970,33
runwayMonths = 6,19  |  remainingMonths = 7,13
slackMonths = −0,94                → 'warning'
projectedDepletionDate = 05/12/2026 (ciclo termina 03/01/2027)
projectedOverrun ≈ R$ 28.000
healthyMonthlyBudget = 26.020,37
   ≈ 20,9 plantões de semana/mês  ou  18,8 de fim de semana/mês
saldo restante ≈ 149 plantões de semana  ou  134 de fim de semana
```

Frase para a UI:
> **Caio Oliveira do Carmo** — mantendo o ritmo atual, o saldo acaba em **05/12/2026**,
> **1 mês antes** do fim do ciclo. Para chegar inteiro, precisa cair de
> R$ 29.970 para **R$ 26.020/mês** (≈ 21 plantões de semana).

**Karen Seifarth Miranda** (caso extremo, para teste de regressão):
36h, teto R$ 248.598,00, admissão 16/08. Consumo até 31/05 = R$ 338.360,24 →
IR = **1,725**, saldo −R$ 89.762,24, zerou em **15/03/2026** com 5 meses de ciclo restantes.

---

## 6. API (App Router / Route Handlers)

| Método | Rota | Uso |
|---|---|---|
| `GET` | `/api/contracts/balances` | Lista de todos os contratos ativos com métricas + risco. Filtros: `?risk=`, `?category=`, `?q=`, `?sort=slack`. |
| `GET` | `/api/contracts/:id/balance` | Métricas do ciclo vigente + série mensal do ciclo. |
| `GET` | `/api/contracts/:id/history` | Todos os ciclos + ledger paginado. |
| `POST` | `/api/contracts/:id/simulate` | Body `{ weekdayShifts, weekendShifts, amount? }` → métricas **antes/depois**. Não persiste. |
| `POST` | `/api/contracts/:id/adjustments` | **admin** — ajuste manual no ledger + justificativa obrigatória. |
| `PATCH` | `/api/contracts/:id` | **admin** — editar teto, aniversário, CH, status. |
| `POST` | `/api/contracts/:id/supersede` | **admin** — encerra o contrato e cria o substituto. |
| `POST` | `/api/contracts/:id/cycles/rollover` | Força abertura do próximo ciclo (idempotente). |
| `GET` | `/api/contracts/pendencies` | Lista de estouros de ciclos encerrados. |
| `PATCH` | `/api/contracts/pendencies/:id` | **admin** — `acknowledged` / `archived`. |
| `GET` | `/api/contracts/balances/export` | CSV/XLSX no layout da planilha atual (transição). |

Todas as respostas de métrica devolvem `asOf` e `computedAt` — sem isso, comparar prints
com a planilha vira discussão.

### 6.1 Autorização

**DECIDIDO: qualquer escrita que altere saldo, teto ou pendência é restrita a admin.**

Contas admin iniciais (seed):

```
tom@samu.local
dora@samu.local
caio@samu.local
ivan@samu.local
```

- Reusar o mecanismo de papéis já existente no app (NextAuth v5 + tabela de usuários).
  **Não criar um segundo sistema de permissão.** Se já houver um enum de papéis,
  a checagem é `role === 'admin'`; a lista acima entra só como seed/backfill de papel.
- Gestor de setor e médico têm acesso **somente leitura** às telas de saldo.
- Toda escrita grava `createdBy` e fica visível no histórico do ledger.
- Endpoints de escrita devem retornar 403 (não 404) para não-admin autenticado.

**Job diário** (cron/PM2): abre ciclos vencidos, recalcula caches e dispara alertas (§8).

---

## 7. UI

### 7.1 Dentro do Payment Closing (prioridade 1)

Um bloco fixo no topo da tela de fechamento, **acima da tabela de plantões**:

```
┌─ SALDO DE CONTRATO ────────────────── ciclo 03/01/2026 – 02/01/2027 ─┐
│                                                                      │
│  ████████████████░░░░░░░░░░░░░░░░░░░░░░  44,0% consumido            │
│  ▲ ritmo esperado hoje: 40,5%                     ⚠ 8,5% acima      │
│                                                                      │
│  Saldo hoje        R$ 185.635,74                                     │
│  Este fechamento  −R$  24.878,60                                     │
│  Saldo depois      R$ 160.757,14   ← destaque                        │
│                                                                      │
│  Sobra p/ 7,1 meses:  R$ 26.020/mês  ≈ 21 plantões de semana         │
│  Projeção: acaba em 05/12/2026 (1 mês antes do fim)     ● WARNING    │
└──────────────────────────────────────────────────────────────────────┘
```

Comportamento:
- A barra tem **duas camadas**: consumido (preenchimento) e pace esperado (marcador vertical).
  É a leitura de 1 segundo que o chefe quer.
- Os valores recalculam **ao vivo** conforme os plantões são marcados (chama `/simulate`
  com debounce, ou calcula no cliente com o mesmo módulo puro — preferir o segundo).
- Se o fechamento levar o saldo a negativo: banner vermelho + checkbox
  *"Ciente de que este fechamento estoura o teto do contrato"* obrigatório para salvar,
  com o motivo gravado em `contractLedger.description`. **Aviso, não bloqueio.**
- Se o médico tiver mais de um contrato ativo, um seletor de contrato aparece no bloco.

### 7.2 Painel do gestor — "Saldos de Contrato" (prioridade 2)

**Faixa de resumo** (4 cartões):
- Médicos em risco (`critical` + `depleted`) — número grande + delta vs. mês anterior
- Saldo total comprometido no ritmo atual
- Estouro projetado agregado (R$)
- Próxima exaustão prevista (médico + data)

**Tabela ranqueada por `slackMonths` crescente** (o pior primeiro):

| ● | Médico | CH | Ciclo | Teto | Consumido | Saldo | IR | Acaba em | Folga | Sobra/mês |
|---|---|---|---|---|---|---|---|---|---|---|
| 🔴 | Karen Seifarth | 36h | ago–ago | 248.598 | 338.360 | −89.762 | 1,73 | 15/03/26 | −5,0 m | — |
| 🟠 | Caio Oliveira | 48h | jan–jan | 331.464 | 145.828 | 185.636 | 1,09 | 05/12/26 | −0,9 m | 26.020 |

- Linha expansível: mini gráfico de barras do consumo mês a mês do ciclo + linha de pace,
  mix semana/fds, e os últimos lançamentos do ledger.
- Filtros: risco, categoria, CH, mês de aniversário, busca por nome/empresa.
- Export para o layout da planilha atual (permite rodar em paralelo durante a transição).

**Aba "Pendências"** — lista de ciclos encerrados com saldo negativo (§3.5). Colunas: médico,
contrato, ciclo, valor do estouro, data de detecção, status. Ações *Marcar como ciente* e
*Arquivar*, só para admin. Sem nenhuma ação que altere saldo.

**Diretrizes de visualização** (leia a skill `dataviz` antes de codar os gráficos):
- Nunca use só cor para o risco — sempre cor + ícone + texto.
- Barra de progresso com marcador de pace é obrigatória; gráfico de pizza é proibido.
- Valores em R$ com `Intl.NumberFormat('pt-BR')`, sempre com o `asOf` visível.

### 7.3 Tela do médico (prioridade 3)

Versão simplificada e não punitiva do mesmo cartão: saldo, quantos plantões ainda cabem
neste mês e no ciclo, sem semáforo de risco (evita constrangimento e disputa).

---

## 8. Alertas

Dispara no job diário, **com deduplicação** (não repetir o mesmo alerta em < 7 dias):

| Gatilho | Destino | Mensagem |
|---|---|---|
| `slackMonths` cruza abaixo de 0 | gestor | "Dr. X passou a projetar exaustão antes do fim do ciclo (dd/mm)." |
| `consumedPct` cruza 50% / 75% / 90% | gestor | marco de consumo + comparação com o pace |
| `balance <= 0` | gestor + admin | estouro efetivo |
| Faltam 60 dias para o fim do ciclo | gestor | resumo de renovação + saldo não utilizado |
| Fechamento salvo com estouro | gestor | notificação imediata com a justificativa |

Canais: reuso do que já existe no app (e-mail e/ou WhatsApp). Um digest semanal com o
top-10 de risco costuma ser mais lido que alertas avulsos.

---

## 9. Migração e backfill

1. **Importar contratos** da aba `MEDICOS PJ` (nome, CH, empresa, nº contrato, data admissão).
   O `SALDO CONTRATO` dessa aba é o saldo *atual* — não o teto. O teto vem da tabela §3.3
   ou do primeiro mês do ciclo.
2. **Importar consumo mensal** das abas `<MÊS> -GENERALISTAS` e `<MÊS> -ESPECIALISTAS`:
   por médico/mês, gravar um lançamento `invoice` com `weekdayShifts`, `weekendShifts`,
   `amount = -TOTAL`, `invoiceNumber` = coluna NOTA FISCAL, `processNumber` = coluna PROCESSO.
3. **Validação obrigatória do backfill:** para cada médico, o saldo calculado pelo ledger
   deve bater com a coluna `SALDO CONTRATO` de maio/2026 com tolerância de **R$ 0,05**.
   Gerar relatório de divergências — não silenciar.
4. Linhas com `#VALUE!` na planilha (janeiro) devem ser **ignoradas**, não convertidas em zero.
5. Nomes são a única chave de junção entre abas e vêm com espaços duplos, sufixos
   (`+ UPA`, `(+12h)`, `(PSIQUIATRIA)`) e erros de digitação (`GULHERME`, `SEWRVIÇOS`).
   Normalizar (trim, colapsar espaços, remover parênteses, uppercase sem acento) e
   **exigir revisão manual dos não-casados** — não fazer fuzzy match automático.

---

## 10. Fases e checkpoints

> Um agente por fase, **em sequência**. Cada fase termina com um checkpoint que o usuário
> aprova antes de a próxima começar. Nenhum agente escreve fora do escopo da sua fase.

### Fase 0 — Levantamento (read-only)
Mapear o schema atual (médicos, plantões, payment closing, tabela de valores, papéis/permissões),
os componentes de UI reusáveis e o padrão de rotas.
**Entrega:** `docs/saldo-contrato/00-levantamento.md` com o que existe, o que falta e as
divergências entre este spec e o código real.
**Checkpoint:** nenhuma linha de código escrita. Usuário confirma o mapeamento.

### Fase 1 — Banco (DBA rigoroso)
Schema Drizzle + migrations + view + seeds. Constraints e índices explícitos.
Script de backfill com o relatório de validação da §9.3.
**Checkpoint:** migration roda e reverte limpa em base local; backfill fecha em R$ 0,05
para 100% dos médicos ou lista nominalmente as exceções.

### Fase 2 — Motor de cálculo
`lib/contracts/balance-metrics.ts` puro + testes unitários (Vitest).
**Checkpoint:** testes cobrindo os casos de Caio e Karen (§5.3), ciclo bissexto, ciclo
recém-aberto (< 45 dias), saldo negativo, consumo zero, e divisão por zero.
Nenhuma dependência de banco no módulo.

### Fase 3 — API
Route handlers + validação Zod + autorização por papel + testes de integração.
**Checkpoint:** contratos de resposta estáveis e documentados; `/simulate` não persiste nada.

### Fase 4 — UI do Payment Closing
Bloco de saldo, simulação ao vivo, confirmação de estouro.
**Checkpoint:** revisão visual com dados reais de 3 médicos (verde, amarelo, vermelho).

### Fase 5 — Painel do gestor
Tabela ranqueada, resumo, expansão por linha, filtros, export.
**Checkpoint:** o número que aparece na tela bate com a planilha de maio para 10 médicos
sorteados.

### Fase 6 — Alertas e job diário
Cron, deduplicação, digest semanal.
**Checkpoint:** dry-run de 30 dias simulados sem alerta duplicado.

---

## 11. Critérios de aceite

- [ ] O saldo de qualquer médico é reproduzível somando o ledger — nenhum campo mutável.
- [ ] Backfill reconcilia com maio/2026 dentro de R$ 0,05 (ou divergências listadas e aceitas).
- [ ] O fechamento mostra saldo antes/depois **antes** de salvar.
- [ ] Estouro é permitido, mas exige ciência explícita e fica registrado com autor e motivo.
- [ ] O painel responde em < 1s para ~150 contratos ativos.
- [ ] A renovação abre o ciclo novo automaticamente na data de aniversário, sem intervenção.
- [ ] A projeção de exaustão não aparece nos primeiros 45 dias do ciclo.
- [ ] Médico com 2 contratos ativos escolhe o contrato no fechamento; o outro não é afetado.
- [ ] Todo valor exibido carrega a data de referência (`asOf`).
- [ ] Ciclo encerrado no negativo abre o próximo com teto integral e gera uma pendência.
- [ ] Nenhuma rota de escrita de saldo/teto/pendência responde 2xx para usuário não-admin.
- [ ] O teto só muda por ação explícita de admin, nunca por rotina automática.
- [ ] Feriado é precificado pela mesma função já usada no módulo de pagamento (sem duplicação).

---

## 12. Decisões travadas (não reabrir sem o usuário)

| # | Questão | Decisão |
|---|---|---|
| 1 | Estouro do ciclo anterior | **Não desconta.** Ciclo novo abre com teto integral. Estouro vira pendência informativa (§3.5), sem conduta automática. |
| 2 | Feriado | **Mesma tarifa de fim de semana.** Reusar a classificação já existente no módulo de pagamento. |
| 3 | Teto no meio do ciclo | **Imutável.** Mudança só via renovação/substituição manual de contrato pelo admin. |
| 4 | Teto por CH | **Não derivar.** `ceilingAmount` é campo editável por admin; usar o valor da planilha no backfill. Exceções por concessão são digitadas, não modeladas. |
| 5 | CH no cálculo | **Irrelevante.** Toda tradução em plantões é `saldo ÷ tarifa`. CH fica como dado cadastral. |
| 6 | Médicos na mesma empresa | **Fora de escopo.** Saldo por médico. Sem teto agregado, sem compensação, sem alerta cruzado. |
| 7 | Quem ajusta | **Só admin.** Seed: `tom@samu.local`, `dora@samu.local`, `caio@samu.local`, `ivan@samu.local`. |

### Escopo negativo explícito

Não implementar nesta feature, mesmo que pareça natural:

- Bloqueio de escala, de fechamento ou de emissão de nota por falta de saldo.
- Qualquer transferência, rateio ou compensação de saldo entre médicos.
- Cálculo automático de teto a partir de CH, categoria ou tempo de contrato.
- Calendário próprio de feriados.
- Regra de negócio que leia `contract_pendencies`.
- Ajuste automático de saldo por qualquer rotina que não seja o fechamento ou um lançamento
  manual de admin.
