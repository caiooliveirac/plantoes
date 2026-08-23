# Sombra: plano de correção (caso Vaner Paulo / Felipe Carvalho, 23/08/2026)

## 1. O que aconteceu hoje, na ordem

Fonte: `telegram_ingested_messages` e `regulation_occupancies` de produção (leitura).

| Hora | Mensagem | Resultado real |
|---|---|---|
| 07:47:52 | `Vaner Sombra SD` (chefia, 2031) | `ignored / no_operational_match` — bot respondeu o balão genérico "não entendi" com exemplo de chegada + exemplo de saída + "🔍 Detectei: … faltou a *base ou ramal*" |
| 07:48:37 | `Vaner Sombra SD 2031` | `accepted`. Ocupação `ea3fd78d` criada com marcador `[telegram sombra]` — **e com `board_started_at` preenchido**, porque a 2031 estava vazia (Luiz Eduardo encerrou 07:15). Resposta do bot: "🫥 Cobertura *sombra* — titular atual mantido no quadro" — **frase falsa: não havia titular; a sombra virou o titular** |
| 07:49:13 | `Felipe Carvalho P 2031` | `pending_takeover_confirmation`. Bot disparou `🚨🚨 *ATENÇÃO — POSTO OCUPADO*` dizendo que **VANER SERÁ RETIRADO(A) DO QUADRO**, com botões |
| 07:49:42 | `Felipe Carvalho P 2031` (reenvio/botão) | `takeover_confirmed`. Vaner recebeu `[DESLOCADO] … por Felipe Carvalho`, `board_started_at` zerado, e saiu o **aviso de deslocamento no grupo e para a coordenação** (PR #221) |

Estado final no banco (2031, 23/08):

```
Vaner  | board=NULL | notes=[telegram sombra] Vaner Sombra SD 2031
                             [DESLOCADO] 2026-08-23T10:49:42Z por Felipe Carvalho
Felipe | board=07:49 | titular
```

O resultado final é **acidentalmente correto** (Felipe titular, Vaner fora do quadro),
mas o caminho até ele foi: uma recusa, um alarme vermelho, uma pergunta de confirmação,
um deslocamento e um aviso público — tudo para registrar uma sombra, que por definição
**não disputa nada com ninguém**.

## 2. Os quatro defeitos, com o código

### D1 — Sombra rouba o quadro quando o posto está vazio
`modules/regulation/service.ts:310` (`resolveRegulationArrivalBoardPolicy`) e o gêmeo
`modules/intervention/service.ts:356`:

```ts
shouldTakeBoardImmediately: params.source !== "import"
    && (!params.isShadow || !params.hasCurrentBoardCarrier),
```

"Sombra sozinha assume o quadro". A partir daí ela é titular para todo o resto do
sistema — inclusive para o portão de tomada. É a origem de tudo que veio depois.

### D2 — O portão de tomada não sabe o que é sombra
`modules/telegram/service.ts:8566` (`findActiveSameTurnoBoardCarrierOnTarget`) filtra
só por `board_started_at is not null`. Não olha o marcador de sombra. O domínio já tem
a regra certa em `shouldCloseRegulationOccupantOnArrival` ("uma chegada real NUNCA
desloca uma sombra") — o portão do Telegram não a consulta.

### D3 — O parser exige o código, e ninguém escreve o código
Das 47 mensagens com "sombra" em 90 dias, **14 não foram aceitas** (30%). O padrão real
de escrita nunca traz ramal:

```
Yngra Novais SOMBRA SD
GIULIA SOMBRA COM TAIARA
Larissa Osthues - sombra psiquiatria 07:07
POLLIANNA RORIZ SOMBRA PUAM SD
Sombra PIAM
Vaner Sombra SD
```

Existe fluxo pronto para exatamente esse problema — `detectLocationWithoutRamal` →
`pending_cru_coi_ramal` (service.ts:13123): o bot pergunta **só o código**, o usuário
responde `2031`, o texto é reconstruído e reprocessado. Sombra não usa esse caminho.

### D4 — Texto demais, e texto que mente
- Recusa (07:47): balão genérico com dois exemplos completos. Ninguém lê.
- Confirmação de sombra: `"🫥 Cobertura *sombra* — titular atual mantido no quadro"`
  (service.ts:9991) é impresso **sempre**, mesmo sem titular.
- Balão de tomada (service.ts:8530): 6 linhas, dois blocos de emoji, três formas de
  confirmar. Disparado contra uma sombra, é ruído puro.

## 3. Correções

Ordem de valor: **F1 e F2 sozinhas eliminam o incidente de hoje inteiro.**

### F1 — Sombra nunca assume o quadro
`resolveRegulationArrivalBoardPolicy` e `resolveInterventionArrivalBoardPolicy`:

```ts
shouldTakeBoardImmediately: params.source !== "import" && !params.isShadow,
```

Sombra passa a ser sempre `board_started_at = NULL`, com ou sem titular — a única
definição que se sustenta. O painel já renderiza sombra por marcador de nota
independente de board (`board.service.ts:834`, `renderShadowOccupantLines`), então
posto vazio com sombra continua aparecendo. Pagamento também não depende de board
(`board.service.ts:3559`: "Sombra declarada OU presença sem titularidade: as duas pagam").

Verificar: card de posto **sem titular** renderiza a sub-linha de sombra.

### F2 — Portão de tomada ignora sombra
Em `findActiveSameTurnoBoardCarrierOnTarget`, excluir ocupações com marcador de sombra
(`isRegulationShadowOccupancyNotes` / `isInterventionShadowOccupancyNotes`), nos dois
domínios. Defesa em profundidade: mesmo que algo volte a gravar board numa sombra,
a chegada do titular vira chegada normal — sem alarme, sem pergunta, sem deslocamento,
sem aviso no grupo.

Efeito na sequência de hoje: 07:49 vira uma chegada comum de Felipe. Vaner segue sombra.
Zero mensagens extras.

### F3 — "Sombra" sem código vira uma pergunta de uma linha
Estender o fluxo de pendência que já existe:

- `detectLocationWithoutRamal` passa a reconhecer `SOMBRA` sem código como terceiro
  caso (`location: "SOMBRA"`), quando há nome e/ou turno.
- Na reconstrução (`service.ts:10967`), para `SOMBRA` o código é **anexado**, não
  substituído — `"Vaner Sombra SD"` + `2031` = `"Vaner Sombra SD 2031"`, preservando
  a palavra que liga o marcador.
- Resposta única, sem exemplos: `🫥 Sombra de qual ramal/base? Responda só o código.`

Fica de fora (YAGNI): resolver `SOMBRA COM <nome>` pelo posto do acompanhado. A pergunta
de uma linha já resolve, e o "com fulano" costuma vir junto do turno.

### F4 — Promoção de sombra a titular
Com F1, sombra nunca herda o quadro; falta o caminho de saída quando ela de fato assume.
Hoje redeclarar o mesmo médico no mesmo posto sem "sombra" cai no guarda de duplicata e
não faz nada.

Regra: **mesmo médico + mesmo posto + sombra aberta + chegada sem marcador de sombra
= promover no lugar** — grava `board_started_at`, remove o marcador das notas
(`clearShadowMarker` já existe em `corrections.ts:570`), preserva `started_at`. Não cria
ocupação nova. Resposta: uma linha (`✅ Fulano assumiu 2031 — chegada 07:48 preservada.`).

### F5 — Enxugar a copy
- Confirmação de sombra, condicional e verdadeira:
  - com titular: `🫥 Sombra de <Titular> em <código> — fora do quadro.`
  - sem titular: `🫥 Sombra em <código> — o ramal segue sem titular.`
- Recusa de mensagem que contém "sombra": nunca o balão genérico — só a pergunta de F3.
- Balão de tomada: manter alto (é decisão destrutiva), cortar para 3 linhas — quem
  ocupa, o que acontece se confirmar, os botões. Tirar os fallbacks textuais do corpo.

## 4. Saneamento de dados

`[DESLOCADO]` sobre uma sombra é estado impossível. Em 90 dias: **2 ocorrências**,
sendo uma a de hoje (`ea3fd78d-5b97-4c77-a0bc-9257b6219a67`).

Script de reparo pontual: remover a linha `[DESLOCADO]` das notas onde as notas também
têm marcador de sombra, mantendo `board_started_at` nulo e a chegada intacta. Rodar
depois de F1/F2, com autorização explícita (escrita em produção).

## 5. Testes

- `tests/regulation-shadow.test.ts`: sombra em posto vazio **não** assume o quadro.
- Novo caso, a sequência de hoje ponta a ponta: sombra em posto vazio → chegada de
  titular → uma única ocupação com board, sombra intacta, nenhuma pendência de tomada.
- Parser: `"Vaner Sombra SD"` → pendência de código; resposta `2031` reconstrói
  `"Vaner Sombra SD 2031"` com `isShadow = true`.
- Promoção: sombra aberta + chegada sem marcador = uma ocupação, board gravado,
  marcador removido, `started_at` preservado.

## 6. Ordem de entrega

1. **PR 1 (F1 + F2 + testes)** — mata o incidente. Sem migration.
2. **PR 2 (F3 + F5)** — a parte de UX: uma pergunta, uma linha de resposta.
3. **PR 3 (F4)** — promoção a titular.
4. **Script de saneamento** — depois do PR 1 em produção, com autorização.
