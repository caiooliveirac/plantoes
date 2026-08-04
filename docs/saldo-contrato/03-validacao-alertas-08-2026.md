# Validação dos alertas de saldo de contrato — agosto/2026

> Conferência dos nomes que o bot manda às 08:00 contra as planilhas de origem
> (`2026 CHAMAMENTO 004` e `2025 CHAMAMENTO NOVO`, versões enviadas em 2026-08-04).
> Feito em modo leitura: nenhuma linha do banco foi tocada.

**Resultado curto: a maior parte da lista de "estourou o contrato" é falso positivo.**
Só um médico da lista estourou de verdade, e o valor dele está inflado em treze vezes.

---

## 1. A causa raiz — o `awaitingOpeningBalance` morre no primeiro plantão

O backfill deixa o saldo de abertura **em branco** de propósito quando a planilha não
dá um número confiável (18 contratos, ver [backfill-report.md](backfill-report.md)).
Chutar seria pior. O alerta sabe disso e tem uma guarda
([contract-balance-alerts.ts:118](../../modules/telegram/contract-balance-alerts.ts#L118)):

```ts
if (row.awaitingOpeningBalance) continue;
```

Só que a flag é calculada assim
([contract-balance.service.ts:393](../../services/contract-balance.service.ts#L393)):

```ts
awaitingOpeningBalance: openingCents === 0 && settledConsumedCents === 0 && emAberto.amountCents === 0
```

Ela exige **consumo zero**. No dia em que o médico bate o primeiro plantão depois da
carga, `emAberto` deixa de ser zero, a flag vira `false`, e o saldo passa a ser
`0 − consumo` — negativo. O alerta `depleted` dispara e anuncia como "saldo de contrato
zerado" um contrato que na verdade **nunca teve teto lançado**.

O valor que o bot mostra não é estouro: é a soma do que o médico produziu desde junho.

## 2. O detector de "teto não carregado" só pega quem abre exatamente em R$ 0,00

Segundo defeito, no backfill
([backfill-saldo-contrato.ts:356](../../scripts/backfill-saldo-contrato.ts#L356)):

```ts
const firstLegible = ordered.find(({ row }) => row!.openingBalance != null)?.row ?? null;
if (firstLegible && Math.abs(firstLegible.openingBalance!) <= TOLERANCE && (firstLegible.total ?? 0) > 0) {
```

`firstLegible` é o primeiro mês com célula **preenchida**. Nos psiquiatras a célula
nasce **vazia** (não zero) e só aparece um mês depois, já negativa — aí
`Math.abs(...) <= TOLERANCE` falha e o detector não reconhece o padrão. Por isso
Ketherynne, Luan e Bruno Mota foram importados como "estouro real" quando são
exatamente o mesmo caso de João Miguez e Gabriel Vitor.

Conferido na planilha, coluna `SALDO CONTRATO`, mês a mês:

| Médico | jan | fev | mar | abr | mai (abre) | mai (fecha) |
|---|---|---|---|---|---|---|
| João Pedro Miguez Pinto | — | — | em branco | R$ 0,00 | −11.466,89 | **−25.277,89** |
| Gabriel Vitor do Amor Divino de Jesus | — | — | em branco | R$ 0,00 | −9.958,96 | **−27.368,34** |
| Ketherynne Cabral F. de Oliveira | — | em branco | em branco | −7.798,92 | −10.510,21 | **−18.755,73** |
| Luan Sampaio Evangelista Santos | — | — | em branco | −3.899,46 | −6.499,10 | **−9.098,74** |
| Thiago Borghi Petrus Costa | — | — | — | em branco | −6.499,10 | **−11.698,38** |
| Bruno Mota de Almeida | — | — | — | em branco | em branco | **−1.411,47** |

Em todos, o fechamento de maio é exatamente a abertura menos o TOTAL do mês. É um
contador de consumo com sinal trocado, não um saldo. Nenhum deles chegou perto do teto
(165.732,00 para 24h; 82.866,00 para os psiquiatras de 12h).

## 3. Karen Seifarth Miranda — estourou, mas em R$ 6,9 mil

Único caso real da lista. O erro aqui é de tamanho, não de existência.

Verificado direto na planilha de 2025:

```
2025-07  abre −R$ 44.223,54   CH 36h   contrato 518/2024   admissão 16-ago
2025-08  abre  R$ 165.732,00  CH 36h   <- reset com o teto de 24h
```

A coluna CH diz **36h** nos 17 meses da série — o teto dela é **248.598,00**, não
165.732,00. Faltaram R$ 82.866,00 no reset.

| | valor |
|---|---:|
| Planilha / alerta | −R$ 89.762,24 |
| Real | **−R$ 6.896,24** |

## 4. Francisco Isensee de Macedo — não estourou, e a planilha já foi corrigida

A planilha enviada agora traz a correção de dezembro/2025 aplicada:

```
2026-01 abre 233.678,36 → 02 224.146,89 → 03 205.356,41 → 04 185.321,06
2026-05 abre 169.156,55  gasta 16.028,28  fecha  +153.128,27
```

Mas [backfill-report.md](backfill-report.md) registra a importação de **−46.778,94**,
porque rodou sobre a versão antiga do arquivo. **Se o razão ainda tiver esse número, é
um falso positivo de ~R$ 200 mil.** Conferir na tela antes de repassar qualquer coisa.

## 5. Os 13 com renovação pendente — e a maioria não era renovação pendente

Todos fecham maio com saldo **alto e positivo** — nenhum é candidato legítimo a
"saldo zerado". Mas conferindo mês a mês (2026-08-04) apareceu outra coisa: **oito
deles a planilha RESETOU direito**. A primeira linha de cada um abre exatamente em
R$ 165.732,00. Quem não enxergou o reset foi o backfill.

O detector procura o reset comparando a abertura de um mês com o fechamento do mês
anterior ([backfill-saldo-contrato.ts:371](../../scripts/backfill-saldo-contrato.ts#L371)):

```ts
const sawReset = ordered.some(({ row }, index) => index > 0 && ...)
```

São contratos de 2026 cuja **primeira linha no arquivo é justamente o mês da virada**.
Não existe mês anterior para comparar, então `sawReset` nasce `false`. O reset estava
visível o tempo todo, na forma mais óbvia: a primeira abertura é o próprio teto.

Só **quatro** não foram resetados de verdade — 190/2025, 111/2026, 110/2026 e 157/2026.
Caio confirmou em 2026-08-04 que é erro de edição: "não se viu ali onde colocar saldo
novo".

| Médico | Contrato | Fecha maio |
|---|---|---:|
| Acacio Junio de Almeida | 190/2025 | 11.931,84 |
| Alexandre Curi Quinteiro | 111/2026 | 67.511,79 |
| André Victor Cardoso Codeceira | 061/2026 | 138.654,92 |
| Bruno Santana Alencar | 048/2026 | 135.329,00 |
| Gustavo Fernandes Vieira | 158/2026 | 159.507,65 |
| Leonardo Prado Faben | 110/2026 | 57.541,11 |
| Leonardo Santana Cabanelas Ribeiro | 80/2026 | 137.255,02 |
| Maiana Santos Oliveira Cardoso | 085/2026 | 153.633,28 |
| Maria Clara Coppieters Gusmão | 157/2026 | 103.798,56 |
| Vitor Luiz Valverde Martinez | 079/2026 | 144.724,24 |
| Yngra Maria Pimentel Novais | 188/2026 | 165.732,00 |
| Stephane Izabor de Oliveira Costa | 156/2026 | 160.752,52 (sem data de admissão) |
| Vinicius Pereira de Carvalho | sem número | linha sem valores |

Leonardo Copque Magalhães aparece duas vezes: o 247/2025 fecha maio em −33.141,77 e é
o contrato **antigo**; o vigente é o 184/2026, com **+340.025,91**.

## 5.1 Leonardo Copque — o teto do contrato novo está errado no razão

O 184/2026 abre maio na planilha em **R$ 349.716,00**, que é o teto de **48h
especialista**. O backfill leu a coluna CH como 24h e gravou **174.858,00** — metade.
É o mesmo erro da Karen, do outro lado: teto deduzido de uma coluna CH que não bate
com o valor de reset que a própria planilha usou.

A cadeia de maio fecha certinho: `349.716,00 − 9.690,09 = 340.025,91`.

## 5.2 Duas linhas onde a própria planilha subestima o consumo

Quando a célula de fechamento de um mês fica vazia, o mês seguinte reabre do zero e a
cadeia perde o que veio antes. Acontece em dois dos contratos sem teto:

| Médico | Planilha diz | Consumo real do ciclo | Mês perdido |
|---|---:|---:|---|
| Ketherynne Cabral F. de Oliveira | 18.755,73 | **22.655,19** | fev/2026 (3.899,46) |
| Bruno Mota de Almeida | 1.411,47 | **4.234,41** | abr/2026 (2.822,94) |

Importar o número da planilha aqui daria ao médico um saldo maior do que ele tem. Os
valores lançados são os reconstruídos mês a mês, não os da coluna.

## 6. O que foi lançado (2026-08-04, autorizado por Caio)

`scripts/lancar-tetos-pendentes.ts` + `docs/saldo-contrato/tetos-pendentes.json`.
Para cada contrato: `opening` com o teto integral na data de início do ciclo, mais um
`invoice` por mês de consumo já ocorrido até 31/05/2026.

Psiquiatria entra na coluna **especialista** da tabela de referência (12h 87.429,00 ·
24h 174.858,00) — decisão de Caio. O código hoje
([backfill-saldo-contrato.ts:301](../../scripts/backfill-saldo-contrato.ts#L301)) joga
psiquiatria na coluna generalista; a divergência fica registrada aqui.

| Médico | CH | Ciclo desde | Teto | Consumo | Saldo |
|---|---|---|---:|---:|---:|
| João Pedro Miguez Pinto | 24h ger | 2026-03-10 | 165.732,00 | 25.277,89 | **140.454,11** |
| Gabriel Vitor do Amor Divino de Jesus | 24h ger | 2026-03-25 | 165.732,00 | 27.368,34 | **138.363,66** |
| Ketherynne Cabral F. de Oliveira | 12h psiq | 2026-02-06 | 87.429,00 | 22.655,19 | **64.773,81** |
| Luan Sampaio Evangelista Santos | 12h psiq | 2025-12-01 | 87.429,00 | 9.098,74 | **78.330,26** |
| Bruno Mota de Almeida | 12h psiq | 2025-12-01 | 87.429,00 | 4.234,41 | **83.194,59** |
| Thiago Borghi Petrus Costa | 24h psiq | 2026-04-01 ⚠️ | 174.858,00 | 11.698,38 | **163.159,62** |
| Leonardo Copque Magalhães (184/2026) | 48h esp | 2026-05-26 | 349.716,00 | 9.690,09 | **340.025,91** |

E os 12 da §5, todos 24h generalista, teto 165.732,00. Os oito de reset limpo têm o
saldo **conferido contra o fechamento de maio da própria planilha** — a reconstrução
mês a mês reproduz o número dela ao centavo, o que é a prova de que o reset existia:

| Médico | Ciclo desde | Consumo | Saldo | Planilha fecha maio em |
|---|---|---:|---:|---:|
| André Victor Cardoso Codeceira | 2026-03-13 | 27.077,08 | **138.654,92** | 138.654,92 ✓ |
| Bruno Santana Alencar | 2026-03-03 | 30.403,00 | **135.329,00** | 135.329,00 ✓ |
| Leonardo Santana Cabanelas Ribeiro | 2026-03-20 | 28.476,98 | **137.255,02** | 137.255,02 ✓ |
| Vitor Luiz Valverde Martinez | 2026-03-20 | 21.007,76 | **144.724,24** | 144.724,24 ✓ |
| Gustavo Fernandes Vieira | 2026-04-30 | 6.224,35 | **159.507,65** | 159.507,65 ✓ |
| Yngra Maria Pimentel Novais | 2026-05-29 | 0,00 | **165.732,00** | 165.732,00 ✓ |
| Maiana Santos Oliveira Cardoso | 2026-03-26 | 12.098,73 | **153.633,27** | 153.633,28 ⁽¹⁾ |
| Stephane Izabor de Oliveira Costa | 2026-04-01 ⚠️ | 4.979,48 | **160.752,52** | 160.752,52 ✓ |

⁽¹⁾ 1 centavo: 4,5 plantões de semana em maio dão 5.601,915 e a planilha arredonda na
exibição. Vale o valor aritmético, que é o que o razão soma.

Os quatro que a planilha realmente não resetou — aqui o saldo **não** está na planilha,
é o teto menos o consumo desde a virada:

| Médico | Ciclo desde | Consumo | Saldo | Planilha mostra |
|---|---|---:|---:|---:|
| Acacio Junio de Almeida | 2026-03-18 | 24.897,40 | **140.834,60** | 11.931,84 |
| Alexandre Curi Quinteiro | 2026-04-09 | 13.266,08 | **152.465,92** | 67.511,79 |
| Leonardo Prado Faben | 2026-04-10 | 20.871,53 | **144.860,47** | 57.541,11 |
| Maria Clara Coppieters Gusmão | 2026-04-29 | 12.993,62 | **152.738,38** | 103.798,56 |

Acacio chega ao mesmo número do override já aprovado em
[saldo-overrides.json](saldo-overrides.json). Abril e maio dele vêm do sistema, não da
planilha: a planilha traz fórmula sem resultado nesses dois meses, mas **os dias dele
estão marcados** — tratar como zero daria saldo otimista, que é o erro que o SPEC §9.4
manda evitar.

Fora da lista: **Vinicius Pereira de Carvalho** — linha em branco na planilha, sem
número de contrato e sem valores. Não há de onde tirar número; precisa de cadastro.

⚠️ O ciclo do Thiago é **assumido** (a planilha não traz DATA ADMISSÃO nem número de
contrato). Ele só entra com `--permitir-ciclo-assumido`.

O 247/2025 do Leonardo é encerrado (`terminated`, 25/05/2026, substituído pelo
184/2026): sem isso ele fica pedindo saldo para sempre.

Luan e Bruno Mota têm ciclo desde dez/2025, mas **não aparecem em nenhuma página das
duas planilhas antes de mar/2026 e abr/2026** — busca por nome nos 86 pdf-pages de 2025
e nos 5 meses de 2026: zero ocorrências. O consumo do ciclo começa onde a linha começa.

## 7. O que ainda corrigir no código

1. ~~**`awaitingOpeningBalance` não pode depender de consumo.**~~ **Feito em 2026-08-04.**
   A flag passou a ser `ledger.openingDate == null` — existe lançamento de abertura no
   razão, sim ou não. O sinal já estava carregado em `loadLedgerBreakdown`, então não
   custou query nem migration. Enquanto não houver abertura, o contrato fica fora de
   todo alerta de saldo e aparece só na contagem "aguardando o saldo de abertura" do
   digest. Cobre os 13 de renovação pendente, que continuam sem abertura.
   Regressão em [tests/contract-balance-alerts.test.ts](../../tests/contract-balance-alerts.test.ts).
2. **Detector de teto não carregado**: aceitar célula vazia seguida de série
   monotonicamente decrescente e negativa, não só o `0,00` exato.
3. **Detector de reset** (§5): `sawReset` só compara com o mês anterior, e por isso não
   reconhece o reset quando ele está na PRIMEIRA linha do contrato no arquivo — o caso
   de todo contrato aberto dentro da janela lida. Regra que faltava, e que teria pego
   os oito: *a primeira abertura legível é igual ao teto de referência*. Vale também
   olhar a inferência de ano da DATA ADMISSÃO, que é o que faz `isFirstCycle` dar
   `false` num contrato que está no primeiro ciclo.
3. ~~**Reimportar Francisco**~~ e ~~**Karen**~~ — **Feito em 2026-08-04.**
   `scripts/corrigir-aberturas-seed.ts` + [aberturas-a-corrigir.json](aberturas-a-corrigir.json).
   Francisco: −46.778,94 → **+153.128,27** (diferença de R$ 199.907,21 escondida no
   razão). Karen: **+82.866,00**, chegando a −6.896,24 — o override de
   [saldo-overrides.json](saldo-overrides.json) nunca alcançou produção porque o
   backfill rodou antes de o arquivo existir.

   A correção é no lançamento de **abertura**, não `manual_adjustment`: nos dois casos
   o errado é o saldo de partida, e a view calcula
   `consumed = -sum(amount) filter (type <> 'opening')` — um ajuste manual mexeria no
   consumo e no percentual do teto. Mesmo padrão e mesma justificativa do
   `repair-maio-extrato.ts`: a abertura do backfill é carga de dados, não ato de negócio.

   Como o reparo de maio pode ou não ter movido a abertura de 31/05 para 01/05, cada
   correção declara as **duas variantes** e o script casa por data + valor exato. A
   ordem no workflow é reparo → correção → reparo, para que os dois fiquem com o
   extrato de maio completo além do saldo certo.
4. **Piso de sanidade no alerta**: saldo negativo cujo módulo é menor que o consumo
   observado no ciclo é aritmeticamente impossível num contrato com teto lançado. É a
   assinatura exata desse bug e dá para barrar o aviso na origem.
