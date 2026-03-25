# Regras operacionais do quadro

Este documento descreve as regras que hoje governam o quadro operacional, os lembretes de Telegram e o calculo de banco de horas. O objetivo e separar claramente o que afeta visibilidade no board, o que afeta cobranca de confirmacao e o que afeta apuracao financeira.

## Fontes de verdade

- quadro operacional: `modules/operational/board-rules.ts`
- encerramento previsto da regulacao e interpretacao de horario declarado: `modules/operational/rules.ts`
- lembretes automáticos do Telegram: `modules/telegram/reminders.ts`
- calculo de banco de horas: `modules/bank-hours/calculator.ts`
- cobertura de regressao: `tests/operational-rules.test.ts`, `tests/telegram-reminders.test.ts`, `tests/bank-hours.test.ts`

## Regra-mestra

Ha tres relogios independentes no sistema:

1. Relogio do quadro: decide quem aparece, quem some e quem entra em destaque de verificacao.
2. Relogio de lembrete: decide quando o bot cobra chegada ou saida ainda nao confirmada.
3. Relogio de banco de horas: decide tolerancia financeira e credito de excedente.

Esses relogios nao devem ser confundidos. Uma mesma pessoa pode:

- continuar visivel no quadro
- nao receber lembrete naquele minuto
- e ainda assim ter apuracao diferente no banco de horas

## Conceitos basicos

- turno operacional do quadro:
  - `SD`: de 07:00 ate 18:59
  - `SN`: de 19:00 ate 06:59
- tolerancia de chegada antecipada para o quadro: 60 minutos antes da virada de turno
- janela de verificacao visual do quadro: 30 minutos apos a virada relevante
- tolerancia financeira de banco de horas: 15 minutos apos o horario previsto de inicio
- `P`: ocupacao prolongada ou continuidade declarada

## Quadro de intervencao

### Regra de permanencia

- uma linha ativa de intervencao permanece no quadro ate haver saida, correcao manual ou substituicao
- a tabela de intervencao nao remove automaticamente o medico antigo na virada

### Regra de verificacao

- a linha recebe destaque `Verificar` quando a ocupacao ativa começou antes do inicio do turno atual, descontada a tolerancia de 60 minutos
- em outras palavras:
  - na virada para 07:00, tudo que começou antes de 06:00 passa a ser considerado plantao anterior
  - na virada para 19:00, tudo que começou antes de 18:00 passa a ser considerado plantao anterior
- chegadas dentro da hora anterior ao novo turno nao entram em alerta visual
- se a chefia confirmar `Continuar`, a ocupacao passa a carregar `P` e o alerta some ate a proxima expiracao dessa continuidade
- essa confirmacao nao inventa horario de saida nem reescreve chegada; ela apenas sinaliza continuidade operacional persistida
- a confirmacao de `Continuar` deve ser registrada com auditoria propria, separada de uma correcao generica, para manter rastreabilidade operacional
- quando a chefia optar por `Informar saida` nesse mesmo contexto, a saida deve passar por fluxo proprio de auditoria operacional, separado do encerramento generico
- a partir de `07:15` ou `19:15`, `Continuar` e `Informar saida` exigem justificativa por escrito tanto no site quanto no Telegram

### Efeito pratico por momento

| Momento em relacao a 07:00 ou 19:00 | Intervencao |
| --- | --- |
| antes de `-60 min` | ocupacao conta como plantao anterior |
| entre `-60 min` e `0` | ocupacao pode representar chegada antecipada valida do novo turno |
| entre `0` e `+30 min` | ocupacoes antigas seguem visiveis, mas entram em `Verificar` |
| depois de `+30 min` | ocupacoes antigas continuam visiveis e seguem exigindo acao operacional enquanto nao houver confirmacao de troca |
| apos acao `Continuar` | o alerta some, a continuidade fica persistida e a proxima cobranca so volta na expiracao dessa continuidade |

## Quadro de regulacao

### Regra de permanencia

- a filtragem da regulacao ocorre no servidor
- uma linha ativa permanece visivel se tiver comeco dentro do turno atual ou dentro da tolerancia de chegada antecipada de 60 minutos
- quando a ocupacao pertence ao turno anterior, a regra muda conforme o tipo declarado

### Diferenca principal em relacao a intervencao

- intervencao: medico antigo continua visivel e entra em destaque para verificacao
- regulacao: medico antigo sai do quadro automaticamente, salvo quando houver `P`

### Regra para ocupacao antiga

- sem `P`: some assim que a virada torna a ocupacao inequivocamente antiga
- com `P`: continua visivel ate a expiracao da continuidade

### Expiracao atual da continuidade `P`

- a continuidade fica valida ate o primeiro `07:00` posterior ao `startedAt`, com mais 30 minutos de graca visual
- isso significa, no comportamento atual:
  - `P` iniciado em turno diurno pode atravessar a noite e seguir visivel ate `07:30` do dia seguinte
  - `P` iniciado em turno noturno pode seguir visivel ate `07:30` da manha seguinte

### Badge de continuidade

- o badge `Continua as HH:mm` so aparece para `P`
- ele aparece apenas na primeira janela de verificacao apos o inicio daquela ocupacao
- exemplos:
  - `startedAt = 07:00` com `P`: badge visivel entre `19:00` e `19:29`
  - `startedAt = 19:00` com `P`: badge visivel entre `07:00` e `07:29`
- a visibilidade do badge nao controla sozinha a permanencia da linha; a permanencia segue a regra de expiracao do `P`

### Efeito pratico por momento

| Momento em relacao a 07:00 ou 19:00 | Regulacao |
| --- | --- |
| antes de `-60 min` | ocupacao conta como plantao anterior |
| entre `-60 min` e `0` | ocupacao pode representar chegada antecipada valida do novo turno |
| logo apos `0` | ocupacao antiga sem `P` deixa de aparecer |
| entre `0` e `+30 min` | ocupacao `P` pode exibir badge de continuidade |
| ate `07:30` da expiracao | ocupacao `P` segue visivel |

## Encerramento previsto da regulacao

O encerramento previsto e usado para fechamento e lembretes, nao como unico criterio de visibilidade do board.

- `SD` sem horario explicito de fim: encerra em `19:15`
- `SN` sem horario explicito de fim: encerra em `07:15` do dia local correto

Esse relogio de `:15` e diferente da regra de virada do quadro, que ocorre em `07:00` e `19:00`.

## Lembretes automáticos do Telegram

Os lembretes operam sobre `scheduledStartAt` e `scheduledEndAt`, nao sobre a cor visual do quadro.

### Greeting

- enviado quando a entrada prevista vai acontecer nos proximos 10 minutos
- so considera turnos ainda sem chegada confirmada

### Nudge

- exige inatividade no chat por pelo menos 5 minutos
- cobra chegada ou saida quando o evento esta entre 10 minutos antes e 5 minutos depois do horario previsto

### Escalation

- exige inatividade no chat por pelo menos 5 minutos
- cobra confirmacao quando chegada ou saida esta atrasada entre 10 minutos e 2 horas

## Banco de horas

Banco de horas nao deve reutilizar automaticamente a regra visual do board.

### Regra atual

- atraso na chegada so conta quando ultrapassa 15 minutos do horario previsto
- se a chegada ficou dentro da tolerancia, eventual excedente na saida e creditado em dobro
- se a tolerancia foi rompida, o excedente passa a ser simples
- sair antes nao cria debito extra na regra atual
- por isso, chegada registrada e saida registrada precisam continuar sendo tratadas como dados de alta confiabilidade; `Continuar` nao substitui nenhuma delas
- no caso de intervencao em `Aguardando noticias`, o registro de saida precisa carregar trilha semantica propria para diferenciar "encerramento comum" de "saida informada apos alerta de virada"

### Continuidade e banco de horas

- quando a chefia confirma `Continuar`, o calculo continua preso a uma unica faixa temporal:
  - chegada real do primeiro plantao
  - saida real do plantao de continuidade
- a continuidade nao zera a chegada e nao cria um segundo calculo solto no meio
- para a regra de tolerancia:
  - chegou ate `07:15` ou `19:15`: atraso perdoado, sem punicao, e eventual excedente segue dobrado
  - chegou a partir de `07:16` ou `19:16`: atraso entra integralmente no calculo e o excedente deixa de ser dobrado
- para a regra de justificativa operacional:
  - `07:15` ou `19:15` em diante: justificativa escrita obrigatoria para liberar continuidade ou registrar a saida nesse contexto sensivel
  - isso nao muda a matematica do banco de horas; muda a exigencia de trilha operacional para o excedente
- exemplos de referencia:
  - `07:14 -> 19:14`: gera `28 min` de credito
  - `07:16 -> 19:16`: gera `0 min` de saldo
  - chegar antes do horario oficial nao gera bonus por si so
  - sair antes do horario final nao gera beneficio

### Diferenca critica para o board

- quadro usa tolerancia de 60 minutos antes da virada para interpretar chegada antecipada do novo turno
- banco de horas usa tolerancia de 15 minutos depois do horario previsto para decidir debito ou credito

Essas duas tolerancias existem por motivos diferentes e nao devem ser fundidas sem revisao de negocio.

## Invariantes para evolucao

Toda mudanca futura deve preservar estas invariantes:

1. Regras de visibilidade do quadro ficam centralizadas e testadas.
2. Regras financeiras ficam separadas das regras visuais.
3. Mudancas em janelas de tempo exigem atualizar testes e este documento na mesma entrega.
4. Qualquer nova excecao operacional deve dizer explicitamente se vale para intervencao, regulacao ou ambas.

## Casos de referencia

- chegada `18:10` para turno das `19:00`: aceita como chegada antecipada valida do novo turno
- chegada `17:50` para turno das `19:00`: ainda conta como ocupacao antiga para fins de virada
- medico da intervencao ainda ativo as `19:05` com inicio `08:18`: permanece no quadro e recebe `Verificar`
- medico da regulacao ainda ativo as `19:01` com inicio `08:18` e sem `P`: sai do quadro
- medico da regulacao com `P` iniciado as `19:00`: pode seguir visivel ate `07:30` do dia seguinte

## Checklist de alteracao de regra

Antes de mudar qualquer janela ou excecao:

1. identificar qual relogio esta sendo alterado: quadro, lembrete ou banco de horas
2. declarar se a regra vale para intervencao, regulacao ou ambos
3. registrar exemplos de borda em horarios reais
4. atualizar os testes de regressao correspondentes
5. atualizar este documento