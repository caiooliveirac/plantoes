# Kickoff — Saldo Contratual (colar no Claude Code)

## Como usar

1. Salve `SALDO-CONTRATO-SPEC.md` no repo em `docs/saldo-contrato/SPEC.md`.
2. Salve este arquivo em `docs/saldo-contrato/KICKOFF.md`.
3. Abra o Claude Code na raiz do repo e cole o **PROMPT 0** abaixo.
4. Só avance para o PROMPT seguinte depois de aprovar o checkpoint do anterior.

---

## Regras que valem para TODAS as fases

Cole este bloco no `CLAUDE.md` do repo (ou deixe o agente ler daqui em toda fase):

```
REGRAS DO PROJETO — FEATURE SALDO CONTRATUAL

ESPECIFICAÇÃO
- A fonte de verdade é docs/saldo-contrato/SPEC.md. Leia inteiro antes de agir.
- A seção 12 (Decisões travadas) NÃO se reabre. Se algo no código contradiz
  uma decisão travada, pare e reporte — não decida sozinho.
- O "Escopo negativo explícito" da seção 12 é proibição, não sugestão.

PROCESSO
- Trabalhe em UMA fase por vez. Não toque em arquivo fora do escopo da fase corrente.
- Antes de editar qualquer arquivo: liste os arquivos que pretende criar/alterar,
  com uma linha de justificativa cada, e ESPERE aprovação explícita.
- Validate-before-apply: mudança de schema roda migration em base local e é revertida
  antes de ser considerada pronta. Cálculo novo tem teste antes da UI que o consome.
- Ao terminar a fase, produza o entregável do checkpoint e PARE. Não comece a próxima.

QUALIDADE
- Nada de `any`. Nada de valor monetário em float — numeric/Decimal ponta a ponta.
- Nada de lógica de negócio dentro de componente React.
- Reusar o que já existe (papéis, tarifas, classificação de feriado, componentes de tabela).
  Se for reimplementar algo que já existe no repo, justifique antes.
- Toda função exportada do motor de cálculo tem teste.

COMUNICAÇÃO
- Português técnico. Sem reescrever o que eu disse com outras palavras.
- Se uma premissa do SPEC não bater com o código real, isso é um ACHADO: reporte,
  não contorne silenciosamente.
```

---

## PROMPT 0 — Levantamento (read-only)

```
Leia docs/saldo-contrato/SPEC.md e docs/saldo-contrato/KICKOFF.md inteiros.

FASE 0 — LEVANTAMENTO. Você está em modo somente leitura. Não crie, não edite,
não rode migration. Nenhuma exceção.

Mapeie no repo:
1. Schema atual: médicos/profissionais, plantões, payment closing, tabela de valores
   de plantão, usuários e papéis. Cite arquivo e linha.
2. Como o módulo de pagamento classifica dia de semana x fim de semana x feriado, e
   qual função eu devo reusar (a decisão 2 do SPEC depende disso).
3. Como a autorização funciona hoje (NextAuth v5): onde fica o papel do usuário, como
   uma rota protegida verifica admin.
4. Onde fica a view de payment closing (rota, componentes, como carrega os dados) e
   qual o ponto exato em que um fechamento é confirmado/aprovado — é ali que o
   lançamento no ledger vai entrar, na mesma transação.
5. Componentes de tabela/cartão/gráfico já existentes que eu devo reusar no painel.

Entregue docs/saldo-contrato/00-levantamento.md com:
- O que já existe e serve
- O que falta
- DIVERGÊNCIAS entre o SPEC e o código real (esta seção é a mais importante)
- Riscos de migração que você enxergou

Depois PARE e me mostre o resumo das divergências. Não avance.
```

---

## PROMPT 1 — Banco (DBA rigoroso)

```
FASE 1 — BANCO. Escopo: apenas schema Drizzle, migrations, view e script de backfill.
Não escreva rota, componente ou lógica de UI.

Implemente as seções 4 e 3.5 do SPEC:
- contracts, contract_cycles, contract_ledger, contract_pendencies
- a view contract_cycle_balance
- ligação com payment_closings (contractId + ledgerEntryId)

Exigências:
- numeric com precisão explícita para dinheiro; passos de 0,5 para plantões.
- Índices e unique constraints como no SPEC, incluindo o unique parcial que impede
  dois lançamentos 'invoice' para o mesmo fechamento.
- Migration reversível. Rode up e down em base local e me mostre a saída.

Script de backfill (scripts/backfill-saldo-contrato.ts):
- Importa contratos e o consumo mensal a partir da planilha (seção 9 do SPEC).
- Normalização de nomes conforme 9.5. NADA de fuzzy match automático: os não-casados
  vão para um relatório de revisão manual.
- Ignora linhas com #VALUE! — não converte para zero.
- VALIDAÇÃO OBRIGATÓRIA: o saldo calculado pelo ledger tem que bater com a coluna
  SALDO CONTRATO de maio/2026 com tolerância de R$ 0,05. Gere
  docs/saldo-contrato/backfill-report.md com os divergentes nominalmente.

Antes de escrever qualquer arquivo, me liste o que vai criar/alterar e espere aprovação.

CHECKPOINT: migration up/down limpa + relatório de backfill. Depois PARE.
```

---

## PROMPT 2 — Motor de cálculo

```
FASE 2 — MOTOR DE CÁLCULO. Escopo: lib/contracts/balance-metrics.ts e seus testes.
Módulo PURO: zero import de banco, de Next, de React. Recebe números, devolve números.

Implemente exatamente as fórmulas da seção 5 do SPEC, incluindo:
- o amortecedor de 45 dias (sem projeção de exaustão em ciclo recém-aberto)
- floor2() em múltiplos de 0,5
- riskLevel pela folga, com paceIndex como desempate

Testes (Vitest) obrigatórios:
- Caio Oliveira do Carmo: consumo 145.828,26 em 148/365 dias, teto 331.464,00
  -> saldo 185.635,74 | paceIndex ~1,085 | slackMonths ~-0,94 | risco 'warning'
  -> projectedDepletionDate = 2026-12-05
- Karen Seifarth: teto 248.598,00, consumo 338.360,24 em 288/365
  -> paceIndex ~1,725 | saldo -89.762,24 | risco 'depleted'
- ciclo bissexto (aniversário 29/02)
- ciclo com 20 dias de vida -> sem projectedDepletionDate, risco no máximo 'watch'
- consumo zero -> runway infinito, risco 'safe', sem divisão por zero
- saldo exatamente zero -> 'depleted'

CHECKPOINT: suíte verde + cobertura das funções exportadas. Depois PARE.
```

---

## PROMPT 3 — API

```
FASE 3 — API. Escopo: route handlers, validação Zod, autorização, testes de integração.
Não mexa em UI.

Implemente a seção 6 do SPEC.

Autorização (seção 6.1):
- Reusar o mecanismo de papéis existente que você mapeou na Fase 0. NÃO crie outro.
- Escrita de saldo, teto, contrato e pendência: só admin. 403 para autenticado sem papel.
- Seed dos admins: tom@samu.local, dora@samu.local, caio@samu.local, ivan@samu.local
- Leitura: gestor e médico (médico só o próprio).

Pontos de atenção:
- POST /simulate NÃO persiste nada. Teste isso explicitamente.
- O lançamento 'invoice' acontece na confirmação do fechamento, na MESMA transação.
  Rascunho não consome saldo.
- Toda resposta de métrica devolve asOf e computedAt.

CHECKPOINT: testes de integração cobrindo 403 por papel, idempotência do rollover e
não-persistência do simulate. Depois PARE.
```

---

## PROMPT 4 — UI do Payment Closing

```
FASE 4 — UI DO FECHAMENTO. Escopo: só a tela de payment closing.

Implemente o bloco da seção 7.1 do SPEC:
- barra de duas camadas (consumido + marcador de pace)
- saldo hoje / este fechamento / saldo depois, recalculando ao vivo
- use o módulo puro da Fase 2 no cliente para o recálculo (sem round-trip por tecla)
- estouro: banner + checkbox de ciência obrigatório, motivo gravado no ledger. AVISO,
  NUNCA BLOQUEIO.
- seletor de contrato quando o médico tem mais de um ativo

Reuse os componentes que você mapeou na Fase 0. Não introduza biblioteca de UI nova.

CHECKPOINT: screenshots dos três estados (safe, warning, depleted) com dados reais
de backfill. Depois PARE.
```

---

## PROMPT 5 — Painel do gestor

```
FASE 5 — PAINEL. Escopo: nova tela "Saldos de Contrato" + aba "Pendências".

Implemente as seções 7.2 e 3.5 do SPEC.
- tabela ranqueada por slackMonths crescente
- 4 cartões de resumo
- linha expansível com consumo mês a mês vs linha de pace
- filtros e export no layout da planilha
- aba Pendências: listar, marcar ciente, arquivar (só admin). Nenhuma ação altera saldo.

Antes de codar gráfico: risco nunca é comunicado só por cor — cor + ícone + texto.
Sem gráfico de pizza. Moeda com Intl.NumberFormat('pt-BR'). asOf sempre visível.

CHECKPOINT: conferir na tela 10 médicos sorteados contra a planilha de maio. Depois PARE.
```

---

## PROMPT 6 — Alertas e job diário

```
FASE 6 — ALERTAS. Escopo: job diário + notificações.

Implemente a seção 8 do SPEC.
- abrir ciclos vencidos (idempotente), gerar pendência quando o ciclo fecha negativo
- alertas com deduplicação de 7 dias
- digest semanal com top-10 de risco
- reusar o canal de notificação já existente no app

Pendência NÃO dispara alerta próprio — entra só como contagem no digest.

CHECKPOINT: dry-run de 30 dias simulados, sem alerta duplicado e sem ciclo aberto em
duplicidade. Depois PARE.
```
