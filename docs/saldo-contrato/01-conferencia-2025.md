# Conferência contra a planilha de 2025

> Fonte: `2025 CHAMAMENTO NOVO.xlsx` (12 meses) encadeada com `2026 CHAMAMENTO 004.xlsx`
> (5 meses). 17 meses de série por médico. Feito em 2026-07-31, depois do backfill.

Com só 5 meses de 2026 não dava para separar "estourou" de "o ciclo virou e ninguém
resetou". Com 17 meses dá — e o resultado desmonta o caso mais citado do SPEC.

## 1. Francisco Isensee de Macedo não estourou

Admissão 06/12/2024, contrato 797/2024, 36h. O ciclo dele vira em **dezembro**.

```
2025-01   abre 229.535,06                     (ciclo 06/12/2024, já consumido em dez)
...        deduções normais mês a mês
2025-11   abre  79.657,51   gasta 30.966,72
2025-12   abre  48.690,79   gasta 14.919,64   <- deveria ter RESETADO para 248.598
2026-02   abre  24.239,68
2026-05   fecha -46.778,94
```

A planilha nunca aplicou a virada de dezembro/2025. O saldo negativo de maio é a
continuação de um ciclo que já tinha terminado cinco meses antes.

**Saldo real dele em 31/05/2026: +R$ 168.047,91** (teto 248.598 menos R$ 80.550,09
consumidos de janeiro a maio). Não é caso de risco — é erro de controle da planilha.

## 2. Karen Seifarth Miranda estourou, mas em R$ 6,9 mil, não R$ 89,8 mil

Aqui a planilha **resetou** certo, em agosto/2025, no aniversário (16/08). O problema
foi o valor: resetou para **165.732,00**, que é o teto de 24h. Karen é **36h em todos os
17 meses da série** — o teto dela é 248.598,00.

```
2025-07   fecha -60.679,31
2025-08   abre 165.732,00   <- reset com o teto errado (faltam 82.866,00)
2026-05   fecha -89.762,24
```

Consumo do ciclo vigente (16/08/2025 até 31/05/2026): R$ 255.494,24.

| | valor |
|---|---:|
| Saldo pela planilha | −R$ 89.762,24 |
| Saldo com o teto correto (248.598) | **−R$ 6.896,24** |
| Diferença | R$ 82.866,00 — exatamente 248.598 − 165.732 |

Ela estourou de verdade, mas o tamanho do estouro está inflado em doze vezes.

## 3. Os outros sete com a mesma falha de renovação

Aniversário passou dentro da série e a planilha não resetou. "Saldo real" = teto de
referência menos o consumo desde a virada.

| Médico | CH | Virada ignorada | Teto | Consumo desde | Saldo real | Planilha diz |
|---|---:|---|---:|---:|---:|---:|
| Acacio Junio de Almeida | 24 | 03/2026 | 165.732,00 | 0,00 | **165.732,00** | 11.931,84 |
| Enrico Biscarde | 24 | 12/2025 | 165.732,00 | 8.568,46 | **157.163,54** | 8.202,00 |
| Francisco Isensee de Macedo | 36 | 12/2025 | 248.598,00 | 80.550,09 | **168.047,91** | −46.778,94 |
| Gabriel Ribeiro Sampaio Cruz | 24 | 08/2025 | 165.732,00 | 35.636,14 | **130.095,86** | 123.326,59 |
| João Gustavo dos Anjos Morais Oliveira | 24 | 03/2026 | 165.732,00 | 0,00 | **165.732,00** | 21.780,46 |
| Karla Santos Pinto | 24 | 02/2026 | 165.732,00 | 37.735,99 | **127.996,01** | 275.482,45 |
| Renê Requião Paim | 24 | 12/2025 | 165.732,00 | 24.606,14 | **141.125,86** | 101.853,74 |
| Venandra Ribeiro e Andrade | 36 | 10/2025 | 248.598,00 | 79.906,54 | **168.691,46** | 173.670,94 |
| Vinicius Santos Moura de Jesus | 24 | 09/2025 | 165.732,00 | 129.856,37 | **35.875,63** | 33.385,89 |

Karla Santos Pinto chama atenção no sentido contrário: a planilha mostra R$ 275.482,45,
**acima** do teto de 24h. Algum crédito entrou lá sem virada de ciclo.

## 4. Trinta e um saltos para cima que não são virada de ciclo

Fora dos casos acima, a série tem 31 aumentos de saldo que não caem em nenhum teto da
tabela nem no mês de aniversário — de R$ 108.179,04 (Victor Vilas Boas, 04/2026) a
R$ 544.754,72 (Luana Franco Bordoni, 02/2026). São correções manuais no meio do ciclo.
Não dá para saber a razão de cada uma pela planilha; só o coordenador sabe.

É exatamente o que o razão append-only resolve: cada ajuste vira um lançamento com
autor, data e justificativa, em vez de um número que muda e não deixa rastro.

## 5. O que isso muda no backfill

O backfill classificou 13 contratos como "renovação pendente" olhando só fev–mai/2026.
Com 17 meses o diagnóstico fica mais firme e o conjunto muda: **9 casos confirmados**,
com o saldo correto calculável.

Nenhum deles deve entrar com o número da planilha. Duas opções, e é decisão do
coordenador:

1. O coordenador digita o saldo real da tabela da §3 no campo em branco — é o fluxo
   que já existe;
2. ou o backfill passa a usar o saldo recalculado para esses 9. Isso exige código novo
   e depende de o teto de referência estar certo para cada um, o que a Karen mostra que
   nem sempre está.

**Recomendo a opção 1.** São 9 médicos, uma sentada, e cada número passa pelo olho de
quem conhece o contrato. Automatizar aqui é assumir que a tabela de tetos está certa —
e a Karen é a prova de que não está.

## 6. Correção obrigatória, independente da opção

O teto de **Karen Seifarth Miranda** precisa ser 248.598,00 (36h), não 165.732,00.
Sem isso ela entra no sistema com um estouro doze vezes maior que o real, e vira o
primeiro alerta crítico que o chefe vê.
