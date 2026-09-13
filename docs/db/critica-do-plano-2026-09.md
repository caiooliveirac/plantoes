# Crítica ao plano de implementação — o que ele acerta, onde é tímido e o que falta

Leitura crítica do plano em [auditoria-performance-2026-09.md](auditoria-performance-2026-09.md)
(§5, §5b, §6). Escrita para quem vai implementar: não é para descartar o plano,
é para não executá-lo cegamente.

## 1. O plano otimiza a frequência do cálculo, não a natureza dele

Todo o custo da tela nasce de um fato: "quem recebe pelo slot X" só é conhecido
depois de rodar `buildPaymentAllocationBoardModel` em Node sobre ocupações cruas
(~60 slots por mês). As melhorias 5.1–5.5 reduzem **quantas vezes** isso roda.
Nenhuma muda o fato de que a tela precisa rodar isso para existir.

O sistema já tem o modelo certo em outro lugar: `bank_hours_entries` deriva o
banco de horas **na escrita**, por grupo de continuidade, e a leitura é um
`SELECT`. A apuração do pagável deveria seguir o mesmo caminho: o fato derivado
"plantão pagável de (médico, slot)" persistido quando a ocupação muda, não
recalculado quando alguém abre a tela. A §6.4 chega perto disso, mas está
posicionada como última etapa e "talvez desnecessária". **Como crítico: ela é a
arquitetura alvo, e as etapas anteriores são o caminho até ela.** Sem ela, o
saldo contratual continua O(histórico) mesmo com a apuração em uma passada — a
5.1 corta 17× as queries, mas o CPU dos ~1.000 quadros desde 2025 fica.

## 2. Não há números-alvo, então não há como saber quando parou de doer

O plano manda medir (`perf-measure`) mas não fixa orçamento. Sem orçamento,
cada PR "melhorou" e a tela continua lenta. Proposta de orçamento para
`/admin/payment-closing`, medido com `PAYMENT_CLOSING_PERF=1` no dump de produção:

| Métrica | Hoje (estimado) | Alvo |
|---|---|---|
| Queries até a primeira renderização | ~120 | ≤ 10 |
| Quadros de 12h montados em CPU por page view | ~2.100 | ≤ 62 (o mês, +1 dia de cada lado) |
| Linhas de ocupação lidas | todo o histórico | só o mês ±1 dia |
| Payload RSC (`JSON.stringify(board)`) | medir | ≤ 250 KiB na carga inicial |
| Conexões do pool ocupadas simultaneamente | 5 | ≤ 2 |
| Tempo de servidor p95 (dump de prod) | medir | ≤ 800 ms |
| Custo quando o histórico dobra | dobra | constante |

Se um PR não move uma dessas linhas, ele não é de performance.

## 3. Metade do problema é no cliente, e o plano quase não fala dele

`chief-payment-view-client.tsx` tem 3.216 linhas, ~30 `useState`, recebe o
`board` inteiro como prop e refaz `router.refresh()` (= Server Component
completo) após cada mutation. Mesmo com queries instantâneas, serializar,
transferir e hidratar esse objeto custa — e é o que o usuário sente como
"pesado". O plano trata isso em uma linha (§5b). Faltam:

- **Grade como Server Component** com HTML já pronto e ilhas cliente pequenas
  (célula clicável, modal, filtros). Hoje tudo é `"use client"`.
- **Server Actions** para atestar, salvar NF, lançar acerto, com `useOptimistic`
  e retorno da linha atualizada — em vez de `fetch` + `router.refresh()`. O
  próprio arquivo já diz "fonte da verdade passa a ser a resposta do servidor";
  falta tirar o refresh.
- **Invalidação por chave** (`revalidateTag`/`updateTag` do Next 16) em vez de
  `revalidatePath` da página inteira.
- **Quebra do componente** em módulos (grade, modal financeiro, painel de
  alvos, filtros). Sem isso, qualquer `<Suspense>` interno é difícil.

## 4. O plano evita a modernidade do Next por um motivo errado

A auditoria descarta `use cache`/`cacheTag` porque "não alcança o worker". O
worker não precisa do cache do Next; precisa do snapshot no banco. As duas
camadas coexistem: **snapshot no Postgres é a fonte durável; `use cache` é o
memo por processo com invalidação por tag**. O motivo válido para adiar é outro:
habilitar `cacheComponents` muda o modelo de renderização do app inteiro (todo
dado dinâmico precisa de fronteira `Suspense`), e fazer isso com um cliente
monolítico de 3k linhas é arriscado. Decisão deliberada, não descarte.
Sequência sensata: §3 acima primeiro (quebrar o cliente), depois avaliar
`cacheComponents` por rota.

## 5. Oito outros chamadores usam o mesmo read model — e são financeiros

`getChiefPayableShiftsBoard` alimenta bot (`/pagamento`, digest), folha de
ponto, página do médico, autoatendimento, briefing. Dividir o read model em
"core" e "financeiro" cria dois caminhos que precisam devolver o mesmo dinheiro.
O plano não lista a migração desses chamadores nem como impedir divergência.
Exigência: uma única função de apuração por (médico, mês) que **todos** usam;
o read model da tela é composição sobre ela, nunca um segundo cálculo. O teste
`payment-duplicate-guard` protege um caminho; precisa proteger a função única.

## 6. Validação financeira só no Mac de uma pessoa não é validação

O snapshot com `perf-baseline` depende de um dump de produção restaurado
localmente. Não roda no CI. Refatoração de código que decide pagamento
merece:

- **Fixtures douradas anonimizadas** commitadas (3–4 meses de ocupações
  sintéticas com os casos do ADR 006, continuidade, sombra, P, extras, acertos)
  e um teste que compara apuração antiga × nova sobre elas — no CI.
- **Shadow mode em produção**: por algumas semanas, calcular pelos dois
  caminhos, servir o antigo, logar a diferença por (médico, mês). Só trocar
  quando a diferença for zero por N dias. Isso é o que torna a §6.4 segura.
- **Teste de concorrência** para a trava do acerto (duas requisições
  simultâneas → um acerto). O CI tem Postgres de serviço e os testes hoje não o
  usam — é a hora de um `tests/integration/` pequeno.

## 7. Observabilidade está na seção "ops", deveria ser passo zero

Sem `pg_stat_statements`, `application_name` por processo e
`log_min_duration_statement`, todo "antes/depois" em produção é anedota. E sem
tempo por fase no log do servidor (o `perfEvents` só existe sob flag), ninguém
vai saber que a tela voltou a degradar daqui a seis meses. Passo zero: habilitar
a extensão (janela combinada, restart do Postgres do host), setar
`application_name`, e logar `procMs` por rota como o webhook já faz.

## 8. Riscos que o plano subestima

- **Memória**: ~2.100 quadros por request num host compartilhado de 15 GB. O
  guard de OOM existe para o build, não para o runtime. Meça RSS por request.
- **Timeout sem UX**: `statement_timeout` de 60 s sem `error.tsx`/fronteira de
  erro no `Suspense` vira tela branca. Cada fronteira precisa de fallback de erro.
- **Sobrefragmentação de API**: "endpoint por tela" vira cinco requests em
  cascata ao abrir um modal. Um endpoint por **visão** (`financials?month=`),
  não por campo.
- **`doctor_contracts` legado**: duas fontes de saldo contratual coexistindo
  dobram a lógica. Aposentar via expand-and-contract deveria ter data, não
  "reusar ou aposentar".
- **Overengineering**: React Query, cursor, PPR — para ~150 médicos e poucos
  admins simultâneos, as três mudanças mais baratas (uma passada, janela, soma
  em SQL) provavelmente entregam a maior parte. A métrica decide, não a moda.

## 9. O plano revisado pelo crítico

| Ordem | Entrega | Critério de pronto |
|---|---|---|
| 0 | Inspeção read-only + `pg_stat_statements` + `application_name` + fixtures douradas no CI | números de base registrados em `docs/db/` |
| 1 | Timeouts de sessão; advisory lock no acerto; teste de concorrência | incidente de 03/08 impossível de repetir; teste vermelho→verde |
| 2 | Função única de apuração por (médico, mês) com janela; uma passada; `doctors` uma vez | queries ≤ 10; quadros ≤ 62 para o mês corrente; snapshot idêntico |
| 3 | Saldo do banco de horas em SQL; banco de horas com janela no servidor | linhas lidas ∝ mês; `bank-balances.json` idêntico |
| 4 | Apuração mensal persistida com `dirty` por mês, em **shadow mode** | diferença zero por 14 dias; então virar a chave |
| 5 | Cliente: quebrar em módulos; grade como Server Component; Server Actions + `useOptimistic`; `revalidateTag` | payload ≤ 250 KiB; nenhum `router.refresh()` após mutation |
| 6 | Avaliar `cacheComponents` + `use cache` por rota | decisão registrada em ADR, com medição |
| 7 | Índices só com `pg_stat_statements` apontando; `CONCURRENTLY` via runner | `idx_scan` crescendo; plano antes/depois no PR |
| 8 | Aposentar `doctor_contracts` (expand-and-contract) | migration de remoção após duas versões sem leitura |

O que muda em relação ao plano original: a apuração persistida sobe de "talvez"
para meta; o cliente entra como fase própria; observabilidade e fixtures vêm
antes de qualquer refactor; tudo tem critério numérico de pronto.
