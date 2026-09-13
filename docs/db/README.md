# docs/db — banco de dados, performance e como olhar para eles

Ponto de entrada para qualquer agente ou pessoa que vá investigar lentidão,
escrever ou refatorar queries, services e endpoints, ou propor mudança no
PostgreSQL deste repositório. Comece aqui; não precisa reconstruir o raciocínio.

## Ordem de leitura

| Se você vai… | Leia | Tempo |
|---|---|---|
| Mexer em qualquer tela/endpoint que lê dados | [regras-dados-telas.md](regras-dados-telas.md) — as 12 regras e o relatório obrigatório | 10 min |
| Refatorar service/query/endpoint (waterfall, paralelismo, agregação, fragmentação de API, async, transação) | [padroes-queries-e-services.md](padroes-queries-e-services.md) — antes/depois tirados deste código | 20 min |
| Entender por que o fechamento e o banco de horas estão lentos e o que já foi decidido | [auditoria-performance-2026-09.md](auditoria-performance-2026-09.md) — diagnóstico, riscos, plano em fases, propostas de schema com lock/rollback | 30 min |
| Olhar o Postgres de produção | [`scripts/db-inspect-prod.sql`](../../scripts/db-inspect-prod.sql) (read-only) + [agent-operations.md §3](../agent-operations.md) para o túnel | 5 min para rodar |
| Executar a investigação passo a passo | skill `/db-performance` ([.claude/skills/db-performance/SKILL.md](../../.claude/skills/db-performance/SKILL.md)) | — |
| Mexer em contrato/teto/saldo | [../saldo-contrato/README.md](../saldo-contrato/README.md) — armadilhas de dado | obrigatório |

## O método: como olhar o banco atrás de melhorias

Sempre nesta ordem. Pular etapa é como se chegou ao loop de 17 meses.

1. **Sintoma → caminho de código.** Da tela ou comando lento até o `page.tsx`/route,
   o service, cada função `load*`/`get*` chamada e o SQL que cada uma executa.
   Desenhe a árvore de chamadas com contagem de queries por nó. Ferramenta:
   `grep -n "await \|Promise.all\|db.execute\|\.select(\|for (const" services/<x>.service.ts`.
2. **Multiplicadores antes de índices.** Procure loops que chamam funções que
   fazem query (`for (const mes of meses) await apurar(mes)`), funções que
   carregam "tudo" sem `WHERE` de janela, e o mesmo dado carregado várias vezes
   no mesmo request. Um índice não conserta um ×17.
3. **Como o custo cresce com o histórico?** Para cada query da árvore: é
   proporcional ao mês, ao número de médicos (limitado) ou a todas as ocupações
   desde 2025? Só a última categoria é defeito de arquitetura.
4. **Estado real do Postgres.** Só agora `scripts/db-inspect-prod.sql`: volumes,
   índices e uso, dead tuples, `pg_stat_statements`, atividade, locks. Compare o
   que o código faz com o que o banco vê. Nunca `EXPLAIN ANALYZE` em escrita.
5. **Plano da query, se ainda fizer sentido.** `EXPLAIN (ANALYZE, BUFFERS)` de
   `SELECT` com `plantoes_ro`. Seq scan em tabela pequena é o plano certo;
   seq scan em `regulation_occupancies` sem janela é o sintoma da etapa 2.
6. **Corrija na camada certa, nesta prioridade:** janela e agregação no SQL →
   uma passada em vez de N → crítico vs. secundário na tela → agregação
   persistida para períodos fechados → índice (com `CONCURRENTLY`, ver §6.0 da
   auditoria) → parâmetros do Postgres.
7. **Valide por equivalência, não por sensação.** `scripts/perf-baseline-payment-closing.ts`
   gera snapshots; refactor de performance só passa com snapshot idêntico.
   `scripts/perf-measure-payment-closing.ts` mede fases e payload.
8. **Relate** com o checklist do fim de `regras-dados-telas.md`.

## Regras invioláveis (resumo; detalhes na auditoria §4 e §6)

- Nenhuma alteração de schema ou dados fora de migration versionada; nunca à mão
  em produção. Explicar antes: problema, SQL, lock, bloqueio de leitura/escrita,
  impacto em tabela grande, compatibilidade com a versão em produção, rollback,
  validação pós-deploy.
- Expand-and-contract: adicionar compatível → backfill → trocar a aplicação →
  remover o antigo em migration posterior.
- Índice em tabela com escrita concorrente: `CREATE INDEX CONCURRENTLY`, que
  exige o marcador `-- migrate: no-transaction` no runner (proposta na auditoria
  §6.0; ainda não implementada).
- Transação nunca fica aberta durante apuração pesada, HTTP externo ou espera
  humana. Apure antes, passe `precomputed` (padrão em `contract-ledger.service.ts`).
- Estado financeiro concorrente (saldo, elegibilidade, contador): checagem e
  escrita na mesma transação com `FOR UPDATE`, unique index, upsert ou
  `pg_advisory_xact_lock`. Nunca read-then-write ingênuo.
- Jobs que podem rodar em paralelo são idempotentes (`telegram_bot_notices.notice_key`).
- `VACUUM FULL`/`REINDEX` bloqueante: nunca automático em produção.

## Estado das propostas

| Item | Status |
|---|---|
| Inspeção de produção (§1 da auditoria) | pendente — rodar do Mac e anexar saída como `inspecao-AAAA-MM-DD.txt` |
| Timeouts de sessão + trava do acerto (§5.6, §5.7) | proposto, sem PR |
| Apuração em uma passada (§5.1, §5.2, §5.8) | proposto, sem PR |
| Saldo do banco de horas em SQL (§5.4) e janela no servidor (§5.5) | proposto |
| Read model dividido crítico/secundário (§5b) | proposto |
| Apuração mensal persistida (§6.4) | proposto, depende dos anteriores |
| Índices (§6.1–6.3) | aguardando números da inspeção |
| Runner com `-- migrate: no-transaction` (§6.0) | proposto |

Atualize esta tabela ao abrir/mergear cada PR.
