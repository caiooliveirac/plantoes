# Continuation Bug — Levantamento de vítimas (Fase 2, revisado)

> **Auditoria refeita após feedback operacional do usuário** que apontou três
> erros sérios na primeira passada:
>
> 1. Tratei snapshots **stale** como verdade — vários foram gerados ANTES do
>    record-bug e por isso mostram a vítima correta, mas vão **materializar
>    o erro na próxima regeneração**.
> 2. Não detectei que **o próprio suspeito também é vítima** — quando o
>    `usedDoctorIds` o consome no slot do ghost record, ele perde o slot
>    real de origem.
> 3. Não simulei a evolução: vários slots ainda **nem têm snapshot**; quando
>    forem gerados, materializarão o bug.
>
> Janela: últimos 60 dias contados de 2026-05-08. Auditoria somente de leitura.

## Quadro consolidado (severidade real, pós-simulação)

Ordenado por gravidade.

| nº | op_date | turno | alvo bug | suspeito | vítima primária | gap até trunc. (min) | filtrada como micro? | snapshot state | impacto (após regeneração ou já materializado) |
|---|---|---|---|---|---|---|---|---|---|
| 1 | **2026-04-26** | SD | **PR03** | Caio Oliveira do Carmo | Taiane Pinto Menezes | **4,3** | **sim** | **materializado** (gerado 04/05 07:13) | Caio em PR03 SD `ready_for_payment`. Taiane some. **2153 SD** vira `needs_review` (Caio displaced). |
| 2 | **2026-04-21** | SD | **2154** | Briang Aaron Seguir Ibarra | Angelo Vinicius Sposito | 12,9 | sim | **materializado** | Briang em 2154 SD `ready_for_payment`. Angelo some. **2153 SD** afetado (Briang displaced). |
| 3 | **2026-05-05** | SD | **PM04** | Angelo Vinicius Sposito | Mariana Lacerda Bahia Menardo | **28,6** | **sim** | **STALE** (gerado 13:54, bug criado 20:01) | Snapshot atual mostra Mariana ✓, mas é **enganoso**. Em qualquer regeneração: PM04 SD vira Angelo OU vazio; Mariana **perde tudo**; 1321 SD fica vazio. |
| 4 | **2026-05-03** | SN | **2153** | Felipe Carneiro | Livia Alves Andrade (vítima SD) + **Felipe (vítima SN)** | -12,3 | sim (do próprio Felipe) | **SN nunca gerado**; SD gerado e correto | Quando 03/05 SN rolar: 2153 SN fica vazio. Felipe **perde o SN** que ele realmente cobriu. Livia mantém SD. |
| 5 | **2026-04-28** | SD | **1362** | Uenderson Araujo Barbosa | Edberig Almeida de Araujo | **17,0** | **sim** | **sem snapshot** | Quando rolar: Edberig filtrada, Uenderson assume 1362 SD; SM01 SD (origem) fica vazio. |
| 6 | **2026-04-25** | SD | **PM40** | Matheus Quezado Cordeiro | Ikaro Macena Fritella | 26,9 | sim | **materializado**, contornado via manual_assign | Ikaro está atestado via correção manual da chefia; sem o contorno, Matheus ficaria com PM40 SD. |
| 7 | **2026-04-23** | SN | **PM40** | Vaner Paulo Pinheiro | Marcella Marques Machado | 6,4 | sim | **materializado**, contornado | Idem — Marcella atestada manualmente. |
| 8 | **2026-04-25** | SN | **PM04** | Guilherme Rabelo Mota | Leonardo Cabanelas Ribeiro | -12,7 | sim (Guilherme filtrado) | **materializado** | Leonardo ganhou normalmente. Mas Guilherme **perdeu IT30 SD** (origem) por displacement. |
| 9 | **2026-05-06** | SD/SN | **CB02** | Emmanuelle Gouveia | Taiane (SD) + **Emmanuelle (SN)** | 57,7 | não (Taiane sobrevive) | **sem snapshot** | Em projeção: cascata de 3 turnos. PP20 SD = Emmanuelle ✓, CB02 SD = Taiane ✓ (graças à priority loop), CB02 SN = Emmanuelle (atribuição correta mas com `needs_review`/score baixo). Mais sensível à ordem de regeneração. |
| 10 | **2026-04-26** | SN | **PM04** | Leo Marins Morais | Francisco José Liberato | 47,0 | não | **materializado**, contornado | Francisco está via correção manual. |
| 11 | **2026-05-05** | SD | **1367** | Uenderson Araujo Barbosa | Marcela Arimateia Cabral | 86,0 | não | **STALE** | Em regeneração: Marcela ainda vence ranking, mas com score reduzido. Médio risco. |
| 12 | **2026-04-25** | SN | **CN10** | Leonardo Cabanelas Ribeiro | Vagner Barroso de Oliveira | 736,7 (atípico) | não | **materializado**, contornado | Bug com gap atípico (12h). Vagner via manual_assign. |
| 13 | 2026-04-22 | SD | 2154 | José Roberto Sousa | Ronaldo Henrique de Souza | n/d | n/d | **sem snapshot** | Vítima não identificada por padrão simples — investigar manualmente. |
| 14 | 2026-04-16 | SD | 2151 | Gerardson Macedo Souza | Maria Augusta Amaral | 169 | não | **sem snapshot** | Cadeia tripla SD→SN→SD. Maria sobrevive como candidata mas precisa revisão. |

## Reclassificação dos três casos apontados pelo usuário

### 1. **05/05 PM04 — Mariana** (re-classificação: alta, não baixa)

A primeira passada disse "vítima venceu o ranking". **Errado**. Cronologia:

```
05/05 06:45  Mariana CB02 SD started  ← legítimo
05/05 07:14  Angelo  PM04 P  started  ← BUG (anchor da regulação 1321)
05/05 13:54  snapshot 05/05 SD gerado ← Angelo ainda nem existia em DB
05/05 19:31  Mariana saiu
05/05 20:01  Angelo PM04 P INSERIDO   ← bug record materializa
```

O snapshot atual mostra Mariana porque foi gerado com 6h de antecedência ao
INSERT do bug. Ele está **stale**. Em qualquer regeneração:

```
PM04 SD candidatos:
  - Mariana: started 06:45, sucessor Angelo 07:14 → effectiveEndedAt = 07:14
            duration = 28,6 min < 45 min → isMicroCoverage TRUE → FILTRADA
  - Angelo:  started 07:14, P, cobre slot. Sole candidate.
1321 SD candidatos:
  - Angelo P (legítimo neste alvo, single record).
```

Priority loop com mesmo médico em dois alvos:
- Top score 1321 SD ≈ Top score PM04 SD (ambos só Angelo, mesma base).
- Quem for processado primeiro pega Angelo. O outro fica `displacedByDoctorConflict`.

Resultado: **um dos dois slots fica vazio. Em ambos os casos, Mariana não recebe.**
A descrição do usuário ("Mariana fez todo o SD e perdeu tudo") está correta.

### 2. **06/05 CB02 — cascata Taiane → Emmanuelle → 07/05** (alta)

Cronologia:
```
05/05 07:46  Leo Morais CB02 P  legítimo (cobre 24h)
06/05 07:20  Taiane    CB02 SD legítimo
06/05 07:38  Leo saiu
06/05 08:18  Emmanuelle PP20 SD legítimo + Emmanuelle CB02 P (BUG)
06/05 19:16  Taiane saiu
06/05 19:49  Emmanuelle saiu PP20
06/05 20:42  msg "Emmanuelle Gouveia sn na 02" — DISPARA o bug:
             cria CB02 P com started=08:18 (anchor da PP20)
07/05 07:07  Emmanuelle saiu CB02
07/05 07:43  Joilson CB02 P
```

Snapshot 06/05 e 07/05 **ainda não foram gerados**. Quando rolarem, simulação:

| slot | candidatos efetivos | vencedor |
|---|---|---|
| 06/05 SD CB02 | Taiane (truncada para 58min) + Emmanuelle (P) + Leo (P bleed do 05/05) | Emmanuelle vence raw, mas no priority loop é puxada pelo PP20 SD primeiro → CB02 cai pra Taiane (segunda). Taiane sobrevive **por sorte** (58min > 45min). |
| 06/05 SN CB02 | Emmanuelle CB02 P sole candidate via P bleed | Emmanuelle (correto) |
| 07/05 SD CB02 | Joilson SD + Emmanuelle CB02 P (cobre só os 7 min iniciais) | Joilson (correto) |
| 06/05 SD PP20 | Emmanuelle SD legítimo | Emmanuelle (correto) |

**Conclusão**: para CB02 **a engenharia salva por margem de 13 minutos** (Taiane
duration 58 vs threshold 45). Se Emmanuelle tivesse mandado a mensagem do PP20
chegada às 06:30 ao invés de 08:18, Taiane teria duração de 70 min ainda OK,
mas se entre 07:00 e 07:23 (28-50 min) Taiane ficaria filtrada e perderia tudo
— exatamente o que aconteceu com Mariana no caso PM04. **A "engenharia" é
acidental, depende do timing dos médicos**.

### 3. **03/05 2153 — Felipe perdeu SN** (alta)

Cronologia:
```
03/05 07:10:46  Felipe SM01 P inserted (started 07:10 SD, will cover 24h)
03/05 07:23:03  Livia 2153 SD legítimo
03/05 19:54:54  Felipe SM01 P closed; ao mesmo tempo "Felipe continua 2153" 
                cria 2153 P com started=07:10 (anchor da SM01)
04/05 23:30     snapshot 03/05 SD gerado: SM01 SD = Felipe ✓, 2153 SD = Livia ✓
```

Snapshot 03/05 SN **nunca foi gerado**. Quando rolar:

```
2153 SN candidatos:
  - Felipe 2153 P (started 07:10, sucessor = Livia 07:23)
    effectiveEndedAt = 07:23 → duration 12,3 min → micro → FILTRADO
  - (sem outros candidatos no SN — ninguém mais cobriu 2153 SN aquele dia)

→ 2153 SN slot fica VAZIO/needs_review.
```

Felipe está atestado em SM01 SD (correto pelo SD que ele cobriu) mas **não
está atestado em 2153 SN onde realmente esteve à noite**. A descrição do
usuário é precisa: "ele não retirou Livia ao informar o SN, mas por alguma
razão não aparece". A "razão" é o filtro `isMicroCoverage` no projetor de
slots (`board.service.ts:1122-1127`), disparado pelo `started_at` colapsado.

## Critérios de detecção (refinados pós-feedback)

A primeira lista usou só dois sinais (cross-target origin, vítima plausível).
Agora cruzo cinco dimensões:

| Dimensão | Indicador no DB | O que captura |
|---|---|---|
| **(D1)** Backdating temporal | `created_at - started_at > 6h` | Filtra `/corrigir` curto e auto-arrival do mesmo turno. |
| **(D2)** Source = telegram | `source = 'telegram'` | Exclui correções administrativas. |
| **(D3)** Shift label inflado | `shift_label = 'P'` | Marca exata do INSERT-bug (`effectiveShiftType="P"` no service.ts). |
| **(D4)** Cross-target continuity | Outro registro do mesmo médico com mesmo `continuity_group_id` em alvo diferente, dentro do turno backdated | Filtra plantões P legítimos no MESMO alvo. |
| **(D5)** Vítima identificável | Outro médico no mesmo alvo, started no turno backdated, dur ≥ 4h | Filtra coberturas curtas/sombras. |

E DEPOIS classifico cada caso por:

| Sinal de gravidade | Ação |
|---|---|
| `gap_min_até_truncação < 45` | Vítima cai no `isMicroCoverage` → **alta**. |
| `snapshot.generated_at < bug.created_at` (stale) | Snapshot **enganoso**: regenerar dispara o erro. |
| `snapshot inexistente` para o turno | Erro **latente** que vai disparar quando a chefia abrir o turno. |
| `issues ~ 'Correcao manual'` | Operadores **já contornaram**, evidência cruzada do bug. |
| `payment_status = ready_for_payment` para o suspeito | Pagamento incorreto pendente de aprovação. |

## Casos críticos que precisam ação ANTES da próxima geração de snapshot

1. **05/05 PM04** (Mariana) — snapshot atual está **enganosamente correto**. Não regenerar 05/05 sem antes desabilitar o registro `2c5013a6-975f-4a6b-b536-aa0210f6f994` (Angelo PM04 P) ou ajustar manualmente o `started_at` para o horário real (≈ 19:00).
2. **03/05 2153 SN** — gerar o snapshot SN enquanto o registro `c805909d-9c33-4abe-9bb8-9802627ecc07` estiver com `started_at=07:10` vai resultar em 2153 SN vazio e Felipe sem pagamento. Corrigir antes de gerar.
3. **28/04 1362** (Edberig) — sem snapshot, vai disparar quando rolar. Mesmo plano.
4. **06/05 CB02** — sobrevive por **13 minutos** de margem. Se Taiane tivesse saído mais cedo do CB02 SD, a cascata explodiria. **Sintoma de fragilidade estrutural**, não de segurança.
5. **22/04 2154** e **16/04 2151** — sem snapshot e vítima não trivial; precisa revisão manual.

## Casos já materializados aguardando reversão na chefia

1. **26/04 PR03 SD** — Caio atestado, Taiane sumiu. (Caso de validação.)
2. **21/04 2154 SD** — Briang atestado, Angelo sumiu.

E quatro casos foram **silenciosamente corrigidos via `manual_assign`** pelos
operadores (PM04 26/04 SN, CN10 25/04 SN, PM40 25/04 SD, PM40 23/04 SN). Esses
quatro são prova viva de que a chefia já está pagando o custo humano do bug
contornando-o caso a caso.

## Apêndice A — Queries SQL

(As queries da seção `A.1`-`A.4` da versão anterior continuam válidas. As
queries adicionais usadas nesta revisão estão abaixo.)

### A.5 — Simulação por caso: stale snapshot, truncação da vítima, micro-filter

```sql
SET search_path = operations_v2;

WITH cases(suspect_id, op_date, shift, target_code, sus_doctor, victim_doctor) AS (
  VALUES (...) -- linha por caso da tabela principal
),
sus_data AS (
  SELECT c.*,
         COALESCE(io.started_at, ro.started_at) AS sus_started,
         COALESCE(io.created_at, ro.created_at) AS sus_created
  FROM cases c
  LEFT JOIN intervention_occupancies io ON io.id = c.suspect_id
  LEFT JOIN regulation_occupancies ro ON ro.id = c.suspect_id
),
victim_starts AS (
  SELECT s.suspect_id,
         (SELECT MIN(started_at) FROM (
            SELECT io.started_at FROM intervention_occupancies io
            JOIN doctors d ON d.id = io.doctor_id
            JOIN intervention_bases ib ON ib.id = io.base_id
            WHERE ib.code = s.target_code
              AND d.full_name ILIKE '%' || s.victim_doctor || '%'
              AND io.started_at >= (s.op_date::text || ' 06:00')::timestamp AT TIME ZONE 'America/Sao_Paulo'
              AND io.started_at <  ((s.op_date+1)::text || ' 12:00')::timestamp AT TIME ZONE 'America/Sao_Paulo'
            UNION ALL
            SELECT ro.started_at FROM regulation_occupancies ro
            JOIN doctors d ON d.id = ro.doctor_id
            JOIN regulation_posts rp ON rp.id = ro.post_id
            WHERE rp.code = s.target_code
              AND d.full_name ILIKE '%' || s.victim_doctor || '%'
              AND ro.started_at >= (s.op_date::text || ' 06:00')::timestamp AT TIME ZONE 'America/Sao_Paulo'
              AND ro.started_at <  ((s.op_date+1)::text || ' 12:00')::timestamp AT TIME ZONE 'America/Sao_Paulo'
         ) v) AS victim_started
  FROM sus_data s
)
SELECT s.op_date, s.shift, s.target_code, s.sus_doctor, s.victim_doctor,
       s.sus_started, pas.snapshot_generated_at,
       CASE
         WHEN pas.snapshot_generated_at IS NULL THEN 'sem snapshot'
         WHEN pas.snapshot_generated_at < s.sus_created THEN 'STALE'
         ELSE 'materializado'
       END AS snapshot_state,
       EXTRACT(EPOCH FROM (s.sus_started - vs.victim_started))/60 AS gap_min,
       CASE WHEN EXTRACT(EPOCH FROM (s.sus_started - vs.victim_started))/60 < 45
            THEN 'micro' ELSE 'sobrevive' END AS micro_filter
FROM sus_data s
LEFT JOIN victim_starts vs ON vs.suspect_id = s.suspect_id
LEFT JOIN payment_attestation_slots pas
  ON pas.operational_date::date = s.op_date AND pas.shift_label = s.shift
ORDER BY s.op_date DESC, s.target_code;
```

### A.6 — Conferência de mensagens telegram em torno do evento (validação)

```sql
SELECT tim.created_at AT TIME ZONE 'America/Sao_Paulo' AS ts,
       tim.sender_name, tim.parsed_action, tim.parsed_target_code,
       tim.parsed_doctor_name, LEFT(tim.raw_text, 120) AS raw
FROM telegram_ingested_messages tim
WHERE tim.created_at >= '<dia início>'::date
  AND tim.created_at <  '<dia fim>'::date
  AND (tim.parsed_target_code = '<TARGET>' OR tim.raw_text ILIKE '%<TARGET>%')
ORDER BY tim.created_at;
```

## Apêndice B — Casos previamente classificados como falso-positivo descartado

Sem alteração — `B.1` (16/04 2151 cadeia tripla) e `B.2` (25/04 PM04 boundary
SN) seguem na lista. A diferença é que ambos foram reclassificados nesta
revisão pelo critério gap-até-truncação:

- B.1: gap 169 min (Maria Augusta sobrevive ao filtro micro mas com
  ranking degradado).
- B.2: gap -12,7 min (Guilherme é filtrado por seu próprio sucessor
  Leonardo; o problema do caso é Guilherme **perder o IT30 SD** que era
  seu plantão real).

## Apêndice C — Quatro `manual_assign` em aberto (chefia já corrigiu)

Sem alteração da versão anterior. Esses casos NÃO precisam de ação imediata —
a chefia já contornou. Eles importam para a Fase 3 porque mostram que **a
chefia gasta tempo humano contornando um bug do bot** que poderia ser
corrigido na origem.

## Limites desta auditoria (atualizado)

- Não considerei ocupâncias > 60 dias atrás.
- Para casos onde o suspeito recebe corretamente em outro alvo (ex.: 25/04
  PM04 — Guilherme em IT30, 26/04 SN PM04 — Leo em 2034), não verifiquei
  exaustivamente se o pagamento ao alvo de origem está intacto. Pode haver
  casos onde o alvo de origem também ficou "displaced".
- Não considerei interações com `bank_hours_entries`, `bank_hours_balance_overrides`
  nem com a folha de ponto institucional (`monthly-report.service.ts`). O
  bug pode propagar via `continuity_group_id` para esses módulos.
- A estimativa de "gap_min_até_truncação" usa o `started_at` da vítima como
  referência. Se a vítima também foi ela mesma vítima de outro bug-record
  numa cadeia, o cálculo subestima a gravidade.

Aguardando aprovação para Fase 3 (plano de correção). A correção precisa
abordar **três pontos simultaneamente**:

1. **No INSERT** (origem): não escrever `started_at` retroativo para alvo
   diferente. Usar `boardStartedAt` para anchor de continuidade, `startedAt
   = eventAt`.
2. **Na projeção** (defensa em profundidade): `resolveSuccessorStartMap` não
   deveria considerar como sucessor um registro com **mesmo** `continuity_group_id`
   ou cujo `started_at` é claramente backdated por mais de N min em relação
   ao `created_at`.
3. **Saneamento dos 14 registros existentes**: estratégia event-sourced para
   neutralizar os ghosts sem deletar (que violaria o append-only). Provável
   solução: novo evento compensatório que ajusta o `started_at` para o
   `created_at` real.
