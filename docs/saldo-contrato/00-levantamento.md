# Fase 0 — Levantamento (read-only)

> Base: `docs/saldo-contrato/SPEC.md` confrontado com o código real do `plantoes`
> em 2026-07-31, branch `chore/remove-escala-trocas-orfaos` (working tree sujo:
> `CLAUDE.md`, `next.config.ts`). Nenhuma linha de código foi escrita nesta fase.

---

## 1. O que já existe e serve

### 1.1 Saldo contratual — JÁ EXISTE uma implementação parcial

Esta é a descoberta mais importante da fase. O SPEC trata a feature como greenfield;
ela **já está em produção**, em versão simplificada, desde a migration `0026`.

| Peça | Arquivo | O que faz |
|---|---|---|
| Tabela `doctor_contracts` | [db/migrations/0026_payment_closing_financials.sql](../../db/migrations/0026_payment_closing_financials.sql) | 1 linha por médico: `ceiling_brl numeric(12,2)`, `seed_month varchar(7)`, `created_by_user_id`. Unique em `doctor_id`. |
| Schema Drizzle | [db/schema.ts](../../db/schema.ts) | `doctorContracts` |
| Serviço | [services/doctor-contracts.service.ts](../../services/doctor-contracts.service.ts) | `loadDoctorContracts()` / `setDoctorContract()` (upsert) |
| Rota | [app/api/admin/payment-closing/contract/route.ts](../../app/api/admin/payment-closing/contract/route.ts) | `POST`, Zod, `requireAuthenticatedSession(["admin"])`, grava `auditLogs` |
| Cálculo do saldo | [services/payable-shifts.service.ts:567-587](../../services/payable-shifts.service.ts#L567) | `saldo = teto − Σ pagamentos de seed_month até o mês corrente` |
| Soma do consumo | [services/payable-shifts.service.ts:456](../../services/payable-shifts.service.ts#L456) `getDoctorMonthlyPayableTotals()` | recalcula todos os meses desde a semente mais antiga, a cada carga da tela |
| UI | [app/admin/payment-attestation/chief-payment-view-client.tsx:2285-2325](../../app/admin/payment-attestation/chief-payment-view-client.tsx#L2285) | bloco "Saldo contratual" dentro do modal do médico; negativo em vermelho; rótulo "Teto X desde AAAA-MM · calculado" |
| Testes | [tests/payment-closing-financials.test.ts](../../tests/payment-closing-financials.test.ts) | cobrem a camada financeira do fechamento |

**Consequência para o SPEC:** a Fase 1 não é "criar do zero", é **substituir** um
mecanismo vivo (`doctor_contracts` semente+dedução) pelo ledger append-only. Isso exige
plano de migração de dados e de UI que o SPEC não prevê.

### 1.2 Feriado / fim de semana — a função a reusar (decisão travada #2)

[modules/operational/holidays.ts](../../modules/operational/holidays.ts):

```ts
isPremiumRateDate(operationalDate: string): boolean  // sábado, domingo OU feriado SAMU
```

Já é exatamente a regra do SPEC §3.2 (feriado = tarifa de fim de semana). É a função
usada por [modules/reporting/payable-shifts.ts:325](../../modules/reporting/payable-shifts.ts#L325)
(`isWeekendOperationalDate` é só um alias local) e por
[services/bank-hours-settlements.service.ts](../../services/bank-hours-settlements.service.ts).
**Reusar `isPremiumRateDate`. Não criar calendário próprio.**

Ressalva: `SAMU_HOLIDAYS` é um `Set` hardcoded com 6 datas, só de 2026 (abr–jul). Não é
mantido por banco nem por cadastro. Datas fora dessa janela caem como dia útil.

### 1.3 Tarifas (SPEC §3.2) — conferem

[modules/reporting/payable-shifts.ts:18-28](../../modules/reporting/payable-shifts.ts#L18):

| Perfil | Semana | FDS |
|---|---:|---:|
| generalist | 1.244,87 | 1.381,10 |
| specialist | 1.329,66 | 1.457,15 |
| psychiatry | 1.299,82 | 1.411,47 |

Batem 1:1 com o SPEC. O cálculo real roda em **centavos inteiros**
(`DOCTOR_PAYMENT_RATE_CENTS`, `Math.round`), não em float — o repo já cumpre a regra de
qualidade "nada de dinheiro em float". A meia unidade existe (`paymentUnit` decimal,
`unitMilli`), atendendo o passo de 0,5 do SPEC.

Perfil vem de `doctors.metadata` via `resolveDoctorPaymentProfile()`
([payable-shifts.ts:336](../../modules/reporting/payable-shifts.ts#L336)): `PSIQ` →
psychiatry, `PIAM` → specialist, flag `isPaymentSpecialist` → specialist, senão
generalist. Existe também `employmentType` (`estatutario` paga 0).

### 1.4 Autorização

- [lib/auth/server.ts](../../lib/auth/server.ts) → `requireAuthenticatedSession(roles?)`,
  chamada explicitamente em cada page/route (não há `middleware.ts`).
- Enum real ([db/schema.ts:47](../../db/schema.ts#L47)):
  `["admin", "chief", "doctor", "payment_closing_limited"]`.
- `/admin/payment-closing` aceita `["admin", "payment_closing_limited"]`; as escritas
  (`contract`, `attestation`, `meta`, `extra-shift`) exigem `["admin"]` e retornam o
  status do `AuthError` (403 para autenticado sem papel). Padrão já é o que o SPEC pede.

### 1.5 Payment closing — onde entra o lançamento

- Página: [app/admin/payment-closing/page.tsx](../../app/admin/payment-closing/page.tsx)
  (Server Component) → `getChiefPayableShiftsBoard(month)` →
  `ChiefPaymentViewClient` (o mesmo cliente de `/admin/payment-attestation`,
  ~2,3k linhas).
- **Ponto de confirmação:** `POST /api/admin/payment-closing/attestation`
  (`setDoctorMonthAttestation`, tabela `paymentClosingAttestations`, uma assinatura por
  médico/mês, reversível). É aqui que o `invoice` no ledger deve entrar na mesma
  transação — e é aqui que o "desassinar" precisa gerar `invoice_reversal`.
- Nota fiscal e nº do processo já existem por médico/mês em `payment_closing_meta`
  ([app/api/admin/payment-closing/meta/route.ts](../../app/api/admin/payment-closing/meta/route.ts)) —
  o SPEC os quer no ledger; são a mesma informação em dois lugares.

### 1.6 Componentes reusáveis

`components/ui`, `components/board/*`, `components/doctors/*`,
`components/admin-global-navigation-links.tsx`. Não há biblioteca de UI/gráficos
instalada — CSS próprio. Export XLSX já existe em
[modules/reporting/monthly-report-xlsx.ts](../../modules/reporting/monthly-report-xlsx.ts)
(reusar para o export do painel, SPEC §7.2).

---

## 2. O que falta

- Ciclo de 12 meses por aniversário: **não existe nada**. Hoje há só `seed_month` (mês
  único, sem renovação, sem virada, sem histórico).
- Ledger append-only, pendências, métricas de ritmo (IR, burn rate, runway, folga,
  projeção), classificação de risco, painel do gestor, alertas, job diário: nada disso
  existe.
- Cadastro de contrato: falta nº do contrato, empresa, CNPJ, categoria, CH, data de
  admissão do contrato, status, substituição.
- Nenhuma view SQL no banco (CLAUDE.md: "nenhuma view SQL"). A `contract_cycle_balance`
  do SPEC §4.2 seria a primeira.

---

## 3. DIVERGÊNCIAS entre o SPEC e o código real

| # | SPEC diz | Código real | Gravidade |
|---|---|---|---|
| D1 | Feature nova, greenfield | `doctor_contracts` + saldo calculado já rodam em produção no modal do fechamento (§1.1) | **Alta** — Fase 1 vira migração, não criação |
| D2 | "NextAuth v5 + tabela de usuários" (§6.1) | Auth **própria** (JWT + cookie HMAC, `lib/auth/*`). `next-auth` está no `package.json` mas não é usado | **Alta** — texto do SPEC induz ao erro |
| D3 | Papéis: admin / gestor de setor / médico (§6.1, §7.2, §7.3) | Enum real: `admin`, `chief`, `doctor`, `payment_closing_limited`. Não existe "gestor de setor" | **Alta** — decidir o mapa de papéis antes da Fase 3 |
| D4 | Admins por e-mail seed `tom@/dora@/caio@/ivan@samu.local` (decisão travada #7) | Papéis vêm de `userRoles` (`userId+role`); não conferi se esses e-mails existem em produção | Média — precisa checar no banco antes da Fase 3 |
| D5 | Drizzle gera migrations; migration "roda e reverte limpa" (Fase 1) | Migrations são **SQL numerado escrito à mão** (`db/migrations/00NN_*.sql`), aplicadas por `npm run db:migrate`. **Não há mecanismo de `down`/rollback no repo** | **Alta** — o checkpoint "up/down limpo" da Fase 1 não é executável como escrito |
| D6 | Testes em **Vitest** (Fase 2) | `node:test` + `tsx` (`npm test`). Vitest não está instalado | Média — usar `node:test`, não instalar Vitest |
| D7 | Tabela `payment_closings` com `contractId`/`ledgerEntryId` (§4.1) | Não existe `payment_closings`. O equivalente é `payment_closing_attestations` (médico+mês) + `payment_closing_meta` | Média — remapear o vínculo |
| D8 | `contracts.doctorId` referencia `doctors.id` | OK — `doctors` existe com `normalizedName` único e `admittedAt` (nullable, "antiguidade") | Baixa — mas `admittedAt` **não é** a data de admissão do contrato PJ; não usar como aniversário sem conferir |
| D9 | Categoria do contrato é campo (`generalista/especialista/psiquiatria`) | Categoria hoje é derivada de `doctors.metadata` (`preferredOperationalRole`, `isPaymentSpecialist`). Duas fontes de verdade se o campo do contrato for criado | Média — decidir qual manda no cálculo da tarifa |
| D10 | Médico com 2 contratos ativos escolhe no fechamento (§3.4.2) | `doctor_contracts` tem **unique em `doctor_id`** — hoje é fisicamente impossível | Média — a migration precisa derrubar esse unique |
| D11 | Backfill a partir da planilha (§9), tolerância R$ 0,05 | **A planilha não está no repo nem no pacote** (`docs/saldo-contrato/` só tem SPEC e KICKOFF). Não achei `.xlsx` de `MEDICOS PJ` / maio 2026 | **Alta — bloqueia a Fase 1** |
| D12 | Consumo = notas emitidas | Consumo hoje = valor **calculado** dos plantões pagáveis do mês (`getDoctorMonthlyPayableTotals`), não o valor da nota fiscal digitada. Se os dois divergirem, o backfill contra a planilha não fecha | **Alta** — precisa de definição antes da Fase 1 |
| D13 | `numeric`/Decimal ponta a ponta | Banco usa `numeric`, mas o serviço converte para `number` JS (`Number(row.ceilingBrl)`) e o cálculo de plantão roda em **centavos inteiros**. Não há Decimal.js no repo | Baixa — centavos inteiros satisfazem a intenção; alinhar antes de escrever a Fase 2 |
| D14 | Feriado resolvido pelo módulo de pagamento | OK (`isPremiumRateDate`) — porém a lista de feriados é hardcoded e só cobre abr–jul/2026 | Média — ciclos de 12 meses vão cair fora da lista |

---

## 4. Riscos de migração

1. **Convivência das duas verdades.** Enquanto `doctor_contracts` e o ledger existirem
   juntos, o modal pode mostrar dois saldos diferentes para o mesmo médico. Precisa de
   uma virada única (a UI antiga lê a view nova) ou de um período com o número velho
   escondido.
2. **Custo do recálculo.** `getDoctorMonthlyPayableTotals` já recalcula todos os meses
   desde a semente mais antiga a cada abertura da tela. Com ciclos de 12 meses e ~130
   médicos isso piora. O ledger resolve — desde que a leitura passe a ser a view, não o
   recálculo.
3. **Sem rollback de migration** (D5). Toda migration desta feature precisa ser
   aditiva e testada em base local; e o `.sql` de reversão, se exigido, terá que ser
   escrito à mão como arquivo separado.
4. **Migrations em produção são manuais** e **exigem aprovação explícita do usuário**
   (CLAUDE.md §Ambientes). Nada de `--run-migrations` sem autorização.
5. **`doctors.admittedAt` ≠ aniversário do contrato** (D8). Usar essa coluna como base
   do ciclo produziria renovações na data errada, silenciosamente.
6. **Reconciliação impossível sem a planilha** (D11) e ambígua enquanto D12 não for
   decidido.
7. `ChiefPaymentViewClient` tem ~2,3k linhas e é compartilhado por
   `/admin/payment-closing` e `/admin/payment-attestation`. Mexer nele afeta as duas
   telas.

---

## 5. Respostas do usuário (2026-07-31) — decisões desta fase

| # | Questão | Decisão |
|---|---|---|
| 1 | Planilha (D11) | Google Sheets **"2026 CHAMAMENTO 004"** (id `19WNOfPhZx6rnT8tfrGR5DY0SlNlbKHDBVrMkxgoS8P0`, dono `tomcarneirodecampos@gmail.com`, compartilhada). O backfill lê um **export `.xlsx` em disco**, não a API do Drive. |
| 2 | Consumo do ciclo (D12) | **Valor calculado dos plantões** — o app já é fonte de verdade disso (`getDoctorMonthlyPayableTotals`). Nota fiscal segue como metadado (nº), não como valor. |
| 3 | Auth (D2) | Manter a auth própria do repo (`lib/auth/*`). Ignorar a menção a NextAuth no SPEC §6.1. |
| 4 | "Gestor" (D3/D4) | **É o `admin` atual**: tom, dora, ivan, caio. Papéis novos e mais restritos podem vir depois; nesta feature gestor = admin. |
| 5 | Migrations (D5) | **Decisão minha:** manter o padrão do repo (SQL numerado à mão, `npm run db:migrate`) + um `NNNN_*_down.sql` pareado por migration desta feature, aplicado à mão em base local. Torna o checkpoint "up/down limpo" executável sem introduzir drizzle-kit. |
| 6 | Testes (D6) | **Decisão minha:** `node:test` + `tsx`, como o resto do repo. Vitest não entra. |
| 7 | Dois contratos (D10) | **Confirmado como requisito.** Derrubar o unique de `doctor_contracts(doctor_id)`. Atribuição plantão→contrato é **por data** (janela `started_at`/`ended_at`); seletor manual só desempata sobreposição. |
| 8 | Destino do `doctor_contracts` (D1) | **Decisão minha (não perguntada de novo):** vira **semente do backfill** — o teto já digitado por admin entra como `contracts.ceiling_amount` — e depois é aposentado. Não é descartado, não fica convivendo. |

---

## 6. Revisão de escopo (2026-07-31, depois de ler a planilha)

O usuário reduziu o escopo. O que vale agora, e **sobrepõe o SPEC onde conflita**:

| Tema | Decisão |
|---|---|
| O que o backfill importa | **Um número por contrato**: o saldo de maio/2026. De junho em diante o consumo vem do fechamento assinado pelo coordenador no próprio sistema. |
| Renovação de ciclo | **Ato manual do chefe.** Ele cria o contrato novo já com o saldo de abertura que decidiu. Não há rollover automático. |
| Estouro do ciclo anterior | **Não existe no sistema.** Na renovação o chefe já resolve ao digitar o saldo. Cai a tabela `contract_pendencies`, cai a aba "Pendências" da Fase 5, cai o item 1 das decisões travadas do SPEC §12. |
| Ciclo como entidade | **Cai a tabela `contract_cycles`.** A janela vira `cycle_start` / `cycle_end` no próprio contrato. |
| Médico sem número confiável | Campo de saldo **em branco**, o coordenador digita. Vale para quem foi contratado depois de maio, para quem a planilha nunca carregou o teto e para quem já está em ciclo novo. |
| Onde aparece | `/admin/payment-closing` — a tabela HTML que o chefe usa para acompanhar os pagamentos (`ChiefPaymentViewClient`). |

Consequência: o modelo caiu de 4 tabelas para 2 (`contracts` + `contract_ledger`, mais a
view `contract_balance`), e o backfill deixou de reconstruir 4 meses de razão.

## 7. Checkpoint

Fase 0 concluída e revisada. Divergências mapeadas, decisões das §5 e §6 registradas.
