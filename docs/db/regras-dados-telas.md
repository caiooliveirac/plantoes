# Regras para telas com dados — React → Next.js → services → PostgreSQL

Regra arquitetural para qualquer agente ou pessoa que crie ou altere uma tela
que lê dados neste repositório. Nasceu da auditoria do fechamento de pagamento
([auditoria-performance-2026-09.md](auditoria-performance-2026-09.md)), onde
abrir um mês recalculava todo o histórico desde 2025. A pergunta que teria
pegado o problema antes de produção é a última desta página: **como o custo da
tela cresce com o histórico?**

Princípio: **a tela nunca pede ao backend mais trabalho do que aquilo que vai
mostrar naquele instante.**

## Pipeline alvo

```
PostgreSQL
  dado transacional bruto (ocupações, extras, acertos, razão)
  + agregações persistidas por período (bank_hours_entries, payment_attestation_slots,
    contract_ledger; a apurar: apuração mensal do pagável)
      ↓
services/  — queries específicas por caso de uso, janela e colunas explícitas
      ↓
Server Component — carga inicial com o essencial, direto no service (sem HTTP interno)
      ↓
<Suspense> / streaming — dados secundários chegam depois, sem travar a página
      ↓
Client Component — só interação: filtros, refresh, mutations, via endpoints mínimos
```

## As regras

1. **Analise o fluxo completo antes de mexer.** Para a tela em questão, liste:
   componente → service → SQL → tabelas/índices. Se não souber o que uma função
   do service faz por dentro (quantas queries, qual janela), leia antes de chamar.

2. **Janela e subconjunto, sempre.** Busque só campos, registros, período e
   agregações necessários ao estado visível. Uma tela mensal lê um mês (com a
   margem técnica de ±1 dia que o domínio exige), não "desde o início".
   Exceção explícita e documentada: saldos acumulados — e mesmo esses se somam
   em SQL ou vêm de agregação persistida, não de carregar o histórico em memória.

3. **Carga inicial pelo Server Component, direto no service.** Não faça Server
   Component chamar Route Handler próprio (`fetch("/api/...")`) para acessar o
   mesmo banco: é uma requisição HTTP a mais, serialização a mais, nada a menos.
   Route Handlers servem Client Components, o bot e integrações.

4. **Separe crítico de secundário.** O que o usuário precisa ver ao entrar vem
   no primeiro HTML. O resto (extrato de contrato, trilha de auditoria, provas
   textuais, histórico) carrega em `<Suspense>` com streaming, ou sob demanda
   quando o usuário abre o modal/aba correspondente.

5. **Paralelize o independente; não paralelize sem limite.** Consultas
   independentes começam juntas (`Promise.all`); nada de `await` em cascata sem
   dependência real. Mas o pool é de **5 conexões por processo** (`db/index.ts`):
   um `Promise.all` de 20 queries não é paralelismo, é fila. Nunca coloque uma
   apuração de mês inteiro dentro de um loop de meses ou de médicos — apure o
   intervalo de uma vez e agrupe.

6. **Postgres seleciona e agrega; React exibe.** Nunca devolva a coleção inteira
   para o browser filtrar ou somar quando um `WHERE`/`GROUP BY` faz isso. Filtrar
   no cliente é aceitável quando o conjunto é pequeno e limitado por natureza
   (ex.: o quadro de um mês — ~150 médicos × 31 dias); não quando o conjunto
   cresce com o histórico (ex.: todas as ocupações, toda a `audit_logs`).

7. **Sem `SELECT *` em endpoints de tela sem justificativa.** Colunas explícitas.
   Views largas (como `bank_hours_history_shifts`) precisam de `WHERE` de janela.

8. **Agregações históricas frequentes são pré-calculadas.** Um período fechado
   é imutável até alguém o corrigir. Abrir uma tela **nunca** dispara a
   reconstrução de períodos passados. Quem muda o passado (correção, extra,
   acerto, undo) marca aquele período como sujo e recalcula só ele — e o que
   depende dele em cascata, se houver dependência real. Neste domínio a apuração
   do pagável de um mês **não** depende dos meses anteriores (só o saldo
   contratual e o banco de horas são somas — e essas somas vêm do razão e de
   `bank_hours_entries`, já incrementais).

9. **Cache só com semântica de invalidação definida.** Chave por entidade e
   período (`apuracao:2026-08`, `fechamento:<doctorId>:2026-08`), nunca "limpa
   tudo". Lembre que web e worker são **processos separados** (PM2): cache em
   memória do Next não chega ao worker das 08:00. O cache durável e compartilhado
   é uma tabela no Postgres; `use cache`/`cacheTag` do Next é camada opcional por
   cima, e exige `cacheComponents` que hoje não está habilitado.

10. **Depois de uma mutation, invalide só o afetado.** `revalidatePath` da
    página inteira é o mínimo aceitável hoje; o alvo é invalidar/recalcular o
    read model do (médico, mês) tocado.

11. **Listas grandes: busca, filtro e paginação no servidor.** Endpoints
    específicos com filtros, ordenação e `limit` + cursor. Vale para o que cresce
    com o tempo (histórico do banco de horas "vida inteira", trilha de auditoria,
    mensagens do bot). Não vale para grades limitadas por natureza (o quadro
    mensal), onde paginação só atrapalha.

12. **Escrita concorrente não é read-then-write ingênuo.** Saldo, elegibilidade,
    contadores: checagem e escrita na mesma transação, com `FOR UPDATE`, unique
    index, upsert ou `pg_advisory_xact_lock` conforme a semântica. Nunca segure
    transação aberta durante apuração pesada, HTTP externo ou espera humana
    (ver o guard em `services/contract-ledger.service.ts`).

## Relatório obrigatório antes de dar a implementação por concluída

Para a tela/endpoint alterado, escreva no PR (ou no commit):

- número de requests até a primeira renderização útil;
- queries SQL executadas (quais, não quantas "aproximadamente");
- linhas lidas vs. linhas devolvidas, por query, em ordem de grandeza;
- tamanho aproximado da resposta/payload RSC (o `scripts/perf-measure-payment-closing.ts` mede);
- o que roda em paralelo e o que roda em série, e por quê;
- o que é materializado ou cacheado, e com que chave;
- a regra de invalidação após cada mutation que toca esses dados;
- **como o custo da tela cresce quando o histórico dobra.**

Se o custo cresce proporcionalmente ao histórico total sem necessidade
funcional explícita, isso é um defeito de arquitetura: redesenhe antes de
concluir, não "otimize depois".

## Ferramentas que já existem para validar

- `scripts/perf-baseline-payment-closing.ts` — snapshot JSON dos boards e saldos
  contra um dump de produção restaurado localmente; refactor de performance só
  passa se o snapshot for idêntico.
- `scripts/perf-measure-payment-closing.ts` com `PAYMENT_CLOSING_PERF=1` —
  tempo por fase e tamanho do payload.
- `scripts/db-inspect-prod.sql` — estado real do Postgres (read-only, role `plantoes_ro`).
