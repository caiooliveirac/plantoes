# Saldo contratual — leia isto antes de mexer

> **Se você é um agente e caiu aqui vindo de um comentário no código: era essa a
> intenção.** Este domínio tem um histórico de erros que não se enxergam olhando só o
> código, porque a causa deles está nos dados de origem — uma planilha editada à mão.

O saldo de contrato de cada médico foi carregado de uma planilha externa
(`2026 CHAMAMENTO 004`, encadeada com `2025 CHAMAMENTO NOVO`). Ela é a fonte de
verdade do que veio antes de junho/2026; de junho em diante quem manda é o
fechamento assinado no próprio sistema.

**A regra que resume tudo: um número negativo na coluna `SALDO CONTRATO` da planilha
quase nunca é estouro de contrato.** Na maior parte das vezes é consumo acumulado com
o sinal trocado, num contrato que nunca teve teto lançado. Já custou uma lista inteira
de alertas falsos enviada à chefia.

## Por onde começar

| Documento | Para quê |
|---|---|
| [SPEC.md](SPEC.md) | A especificação da feature. Escrita antes do código; nem tudo virou realidade. |
| [00-levantamento.md](00-levantamento.md) | O que já existia no código quando a feature começou. |
| [01-conferencia-2025.md](01-conferencia-2025.md) | Primeira conferência contra a planilha. Onde a regra do ciclo por mês foi estabelecida. |
| [02-pendencias-pos-deploy.md](02-pendencias-pos-deploy.md) | O que sobrou para o admin fazer na tela depois da carga. |
| [03-validacao-alertas-08-2026.md](03-validacao-alertas-08-2026.md) | **O mais útil.** Validação dos alertas contra a planilha, os quatro defeitos encontrados e o que foi lançado. |
| [backfill-report.md](backfill-report.md) | Saída da carga inicial. **Está desatualizado** — ver "Armadilhas" abaixo. |

Dados versionados: [saldo-overrides.json](saldo-overrides.json),
[tetos-pendentes.json](tetos-pendentes.json),
[aberturas-a-corrigir.json](aberturas-a-corrigir.json),
[maio-2026-planilha.json](maio-2026-planilha.json),
[name-aliases.json](name-aliases.json).

## Armadilhas conhecidas

1. **`backfill-report.md` é anterior aos overrides.** Ele foi gerado no commit
   `9ad2951`; `saldo-overrides.json` só entrou no `a7a69c6`. Os números dele para
   Karen, Acacio, Karla, Renê e Venandra **não** são o que o override manda. Não use o
   relatório como estado atual do banco.

2. **A planilha existe em mais de uma versão.** A carga de produção rodou sobre um
   arquivo anterior à correção de dezembro/2025 do Francisco Isensee. Antes de comparar
   qualquer número com "a planilha", confirme de qual versão ele veio.

3. **Célula vazia não é zero.** Vários meses trazem fórmula sem resultado em cache, e o
   total sai como vazio ou `R$ 0,00` mesmo com os dias marcados na linha do médico.
   Tratar isso como zero produz saldo **otimista** — a favor de deixar o médico gastar
   mais do que pode. Confira os dias marcados antes de aceitar um mês zerado (SPEC §9.4).

4. **A cadeia da planilha quebra em silêncio.** Quando o fechamento de um mês fica
   vazio, o mês seguinte reabre do zero e o consumo anterior some. Aconteceu com
   Ketherynne (perdeu fev/2026) e Bruno Mota (perdeu abr/2026).

5. **A coluna CH mente.** Karla Santos Pinto e Leonardo Copque aparecem como 24h mas os
   contratos resetam em 331.464 e 349.716 (48h). Quando a coluna CH e o valor de reset
   discordam, **o valor de reset é que vale** — foi ele que a administração usou.

6. **Psiquiatria não tem coluna própria na tabela de tetos.** `REFERENCE_CEILINGS`
   ([backfill-saldo-contrato.ts:91](../../scripts/backfill-saldo-contrato.ts#L91)) tem
   só `generalista` e `especialista`, e o código joga psiquiatria em `generalista`
   ([linha 321](../../scripts/backfill-saldo-contrato.ts#L321)). Caio decidiu em
   2026-08-04 que psiquiatria usa a coluna **especialista** (12h 87.429,00 · 24h
   174.858,00), e é assim que `tetos-pendentes.json` está montado. **O código e os
   dados divergem de propósito** — se for unificar, mexa nos dois.

## Quem ainda pode dar problema

Estado em 2026-08-04, depois do dossiê §03. Nada aqui dispara alerta falso (o
`awaitingOpeningBalance` foi consertado), mas nada aqui tem teto vigiado.

| Quem | Situação | O que falta |
|---|---|---|
| Thiago Borghi Petrus Costa | Saldo calculado (163.159,62), ciclo **assumido** a partir da 1ª aparição | Data de admissão real. Só entra com `--permitir-ciclo-assumido`. |
| Stephane Izabor de Oliveira Costa | Saldo confiável (160.752,52), ciclo **assumido** | Idem. |
| Vinicius Pereira de Carvalho | Linha em branco na planilha, sem nº de contrato | Cadastro completo: contrato, ciclo e saldo. |
| Lucyane Santana Teixeira · Giulia Santos dos Reis Souza · Gabriela Alves Costa · Isabella Pereira da Nóbrega · Antonio Elcio Santos Silva · Larissa Osthues Revert Silva · Victor Vilas Boas Mangabeira | Plantonando e sendo pagos, **sem contrato nenhum** no sistema (grupo C de [02-pendencias](02-pendencias-pos-deploy.md)) | Cadastro completo. São os que mais doem: produzem sem nenhum controle de teto. |
| Caroline Luane Rabelo da Silva | CH "72" fora da tabela de referência | Teto definido à mão. |
| Leonardo Copque Magalhães (247/2025) | Contrato antigo, substituído pelo 184/2026 | Encerramento — já previsto em `tetos-pendentes.json`. |

Os **estatutários** (36 médicos, grupo D de [02-pendencias](02-pendencias-pos-deploy.md))
não têm teto PJ e **não devem** receber saldo. Se algum aparecer pedindo cadastro na
tela, o errado é o `employmentType` dele, não a falta de contrato.

## Defeitos do backfill ainda não corrigidos

O backfill já rodou; consertá-lo não muda produção. Mas a próxima carga repete os erros.
Lista completa em [03-validacao-alertas-08-2026.md §7](03-validacao-alertas-08-2026.md).

- O detector de "teto não carregado" só reconhece abertura **exatamente** `0,00`; nos
  psiquiatras a célula nasce vazia e reaparece já negativa.
- `sawReset` só compara com o mês anterior, então não vê o reset quando ele está na
  **primeira** linha do contrato no arquivo — o caso de todo contrato aberto dentro da
  janela lida. A regra que falta: *a primeira abertura legível é igual ao teto de
  referência*.
- A inferência de ano da `DATA ADMISSÃO` erra quando a célula não traz o ano, e isso faz
  `isFirstCycle` dar `false` num contrato que está no primeiro ciclo.

## Scripts

Todos são dry-run por padrão e idempotentes. Rodam **no servidor**, por workflow manual
— o banco só escuta em loopback.

| Script | npm | O que faz |
|---|---|---|
| `backfill-saldo-contrato.ts` | `saldo:backfill` | Carga inicial da planilha. **Já rodou**; não rode de novo sem ler o §7 do dossiê. |
| `repair-ciclos-2026.ts` | — | Conserta os 7 ciclos projetados no futuro por erro de ano na admissão. |
| `repair-maio-extrato.ts` | `saldo:repair-maio` | Divide a abertura de 31/05 em 01/05 + gasto do mês, para o extrato. |
| `lancar-tetos-pendentes.ts` | `saldo:lancar-tetos` | Lança teto + consumo dos 19 contratos que ficaram sem abertura. |
| `corrigir-aberturas-seed.ts` | `saldo:corrigir-aberturas` | Corrige as aberturas semeadas de Francisco e Karen. |

**A ordem importa** quando se roda mais de um: `repair-ciclos` → `repair-maio` →
`corrigir-aberturas` → `repair-maio` de novo. Está codificada nos workflows
`.github/workflows/saldo-*.yml`.
