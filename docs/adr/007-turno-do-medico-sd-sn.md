# ADR-007: O turno do médico (SD/SN) é a unidade; posição é detalhe

## Status
Proposto (2026-09-15). Aguarda decisão sobre as três perguntas em aberto no fim.

## Contexto

O sistema registra **ocupações**: um médico num ramal ou base, com chegada e
saída. Pagamento, banco de horas e a fila de saídas do chefe leem ocupações. Mas
o que o SAMU paga é um **turno**: Fulana fez o SN de 14/09. Se ela trocou de
base às 02:00 para cobrir um furo, continua sendo um SN.

Toda vez que uma posição muda, o sistema fecha uma ocupação e abre outra, e
cada fechamento **presume uma saída** com hora gravada (`actual_ended_at`).
Essa presunção é a raiz dos incidentes de setembro (IT30, 2152) e do ruído na
fila do chefe. Este ADR mede o tamanho do problema em produção e propõe fazer
SD/SN existirem de fato na aplicação.

### O que os dados de produção dizem (90 dias, 2026-06-17 a 2026-09-15)

Ocupações com fim registrado: 3 792. Turnos médico-slot (médico × janela de 12h): ~3 700.

**Movimentos do próprio médico no meio do turno** (fechou aqui, chegou em outro
alvo no mesmo minuto): **70**.
- 61 mantiveram o grupo de continuidade; **9 quebraram** (todos em travessia
  de virada: "continua na SM01 SN", "P invertido", saída ajustada). Quebrar o
  grupo é o que faz o banco de horas ver duas chegadas.
- 25 aconteceram menos de 60 min após a chegada (chegou no lugar errado e
  corrigiu). 14 no meio do turno (2h+ feitas, 2h+ restando): cobertura de furo.
  14 cruzaram domínio (regulação ⇄ intervenção).
- **Nenhum** movimento gravou desfecho de pagamento (`bank_only`/`half_shift`)
  na ocupação de origem. O movimento em si não corta pagamento hoje. O dano vem
  por outros dois caminhos, abaixo.

**Ocupações encerradas pela chegada de outro médico no mesmo alvo** ("expulso",
sem aviso de saída do ocupante): **1 067**. É o mecanismo normal da virada
(07:00/19:00): o sucessor chega, o antecessor é encerrado naquela hora. Só
**13** tinham menos de 6h feitas, e são quase todas chegada antecipada no ramal
errado às 06:4x expulsa às 07:1x. Duas receberam desfecho `bank_only`/`half`.

**Turnos fragmentados** (médico com 2+ ocupações no mesmo slot): **145**.
- 135 somam 10h ou mais de presença: turno inteiro, só que em pedaços.
- **4 desses 135 têm um pedaço com desfecho `bank_only`/`half_shift`**. É o
  dano de pagamento concreto: o médico esteve 10h+ e um pedaço curto foi
  julgado como saída antecipada.
  - 13/08 Maria, BR05, P 06:58→19:41 `bank_only` (o caso que criou o "NÃO SAIU");
  - 03/09 Vaner, 2152 07:13→19:15 + 2154 18:36→19:13 `bank_only` (cobriu 37 min
    no 2154 e o pedaço virou "só banco");
  - 14/09 João, PM40 07:08→19:30 + PM40 07:08→08:39 (duplicata) + CB02
    08:39→08:42 `bank_only` (3 minutos);
  - 15/09 Kêmylla, 2154 07:15→07:16 `bank_only` (1 minuto) + 2152 07:40→19:13.
- 69 têm **dois ou mais grupos de continuidade**. Nesses, cada pedaço tem
  banco de horas próprio.

**Banco de horas nos pedaços não-primeiros**: 167 pedaços, 74 com lançamento;
**16 com atraso de chegada > 15 min** — atraso falso, porque a "chegada" é a
hora do remanejo. Soma: **−708 min** debitados indevidamente em 90 dias.

**Erros do bot** (telegram_ingested_messages, 90 dias): 281 `error`.
- `No active … occupancy found for this doctor/base|post`: **52**. O médico
  avisa saída citando o alvo, mas a ocupação dele está em outro alvo (foi
  remanejado ou expulso). O aviso se perde e a saída fica presumida.
- `db_update_failed`: 69, dos quais 9 no dia do incidente IT30 e os demais
  concentrados em mensagens de "aguardando rendição" / "saída" em dias de
  virada. Falhas de escrita na hora da troca de turno.
- `takeover_confirmation_required`: 36 (tomada de ramal, por desenho).

### O que a suíte de testes fixa hoje (1 336 testes)

A régua de saída antecipada é bem coberta e pensada **por ocupação**: bordas de
6h/10h, `bank_only` credita horas trabalhadas, SN 19–07 com retirada às 23:30 é
`bank_only`. O banco de horas tem a noção de **span por grupo de continuidade**
(`buildContinuityBankHoursSpan`, "collapses a continuity chain into one
bank-hours row"). O pagamento tem a guarda de um pagamento por médico por slot
(ADR-006), que **age depois** do dado errado. Nada na suíte afirma "um turno é
uma coisa só"; a ideia existe em pedaços (ADR-005 para o P, ADR-006 para
duplicata), nunca como regra de entrada.

## Decisão proposta

**O turno do médico (médico × slot SD/SN) é a unidade de pagamento e de banco
de horas. Ramal, base e função são posições dentro do turno. Mudar de posição
nunca é saída.**

Na prática, o `continuity_group_id` já é quase esse identificador (61 de 70
movimentos o preservam). As regras abaixo o completam.

### R1. Toda chegada do médico dentro do turno entra no grupo aberto dele
Qualquer alvo, qualquer domínio, qualquer função. Hoje a herança falha em
travessia de virada com troca de alvo e em alguns cruzamentos de domínio (os 9
casos). Tolerância: a mesma que o P usa na virada (30 min) mais a hora antes do
slot que a chegada antecipada já aceita.

### R2. Fechar posição por movimento não grava saída
`ended_at` = hora da chegada nova; `actual_ended_at` fica **nulo**; nasce
confirmado (já feito em PR #274 para a confirmação; falta zerar
`actual_ended_at`). Nada entra na fila do chefe, nada é "saída verbalizada".

### R3. Banco de horas lê o turno
Atraso = primeira chegada do grupo contra o início do slot. Excedente = último
fim do grupo contra o fim do slot. Pedaços intermediários não geram lançamento.
Já é o desenho do span; R1 é o que o faz valer nos 69 turnos partidos. Resolve
os −708 min.

### R4. Desfecho de pagamento é do turno, não do pedaço
`early_departure_outcome` passa a ser calculado sobre a presença somada do
grupo no slot (≥10h inteiro, 6–10h meio, <6h banco), e só é **gravado** por
saída explícita: aviso do médico, decisão do chefe ou vencimento da janela.
Um pedaço de 1, 3 ou 37 minutos deixa de existir como decisão. Zera os 4 casos.
A posição usada no fechamento (qual ramal/base "paga") é a que cobriu mais
tempo do slot; o total por médico não muda.

### R5. Aviso de saída resolve pelo médico, não pelo alvo citado
"Fulano saindo da 2154" com Fulano remanejado para 2152 fecha o turno de
Fulano. O alvo citado vira nota. Elimina os 52 "No active occupancy" e a saída
presumida que eles deixam para trás.

### R6. Rendição continua fechando a posição, não o turno
Chegada de outro médico no alvo fecha a **posição** do ocupante (`ended_at` =
chegada, sem `actual_ended_at`). O turno do ocupante fica aberto **fora do
quadro** até: aviso dele (R5), decisão do chefe, ou vencimento da janela.
Ver pergunta 1 abaixo sobre o que a janela presume.

### R7. Função é da posição
COI/CP/MRV/meio plantão continuam gravados na posição. O turno herda a função
da posição que cobriu mais tempo; ramais de papel fixo (memória: 1367/1368
forçam COI) seguem valendo no read-time.

## Consequências
- Remanejo para cobrir furo deixa de ter qualquer efeito em pagamento ou
  banco: é só uma posição a mais no turno.
- Fila do chefe encolhe para o que alguém disse ou o que venceu (PR #274 já
  mostra a origem; com R2 e R6 os itens sintéticos somem de vez).
- ADR-006 passa a ser consequência: um turno, um pagamento.
- Relatórios que hoje listam por ocupação (folha de ponto, XLSX, slot-audit)
  precisam agrupar por turno. Memória `punicao-banco-horas-tres-superficies`
  já registra que essas superfícies divergem; este ADR é a chance de alinhar.

## Perguntas em aberto (decisão do usuário)

1. **Turno aberto por rendição no meio do turno, sem aviso e sem chefe: o que a
   janela presume ao vencer?** (a) presença até o fim da janela → paga inteiro;
   (b) presença só do tempo **posicionado** (soma dos pedaços) → régua sobre
   isso. São 13 casos em 90 dias. Recomendo (b): é a inversa da presunção
   atual e não paga o que ninguém viu.
2. **Chegada antecipada no ramal errado às 06:4x** (o padrão dos "expulsos
   curtos"): tratar como posição do turno SD que começa às 07:00 (R1 com
   tolerância de 1h) ou como pedaço SN? Recomendo SD: é o que a pessoa veio
   fazer.
3. **Ordem de entrega.** Recomendo R2 → R5 → R1 → R3/R4 → R6 → R7. Cada etapa
   fecha um buraco medido acima e é reversível sozinha. R4 é a que mexe em
   dinheiro e merece um mês de sombra: calcular o desfecho por turno em
   paralelo e comparar com o gravado antes de trocar.

## Como verificar depois
Rodar de novo as contagens deste ADR (movimentos, grupos quebrados, pedaços
não-primeiros com atraso falso, turnos ≥10h com desfecho de corte, "No active
occupancy"). Todas devem tender a zero; a de rendições (1 067) não muda, porque
rendição é normal.
