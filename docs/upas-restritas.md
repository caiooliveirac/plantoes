# UPAs restritas — o que este app faz (e o que NÃO faz)

## Os dois bots — a confusão nº 1

Existem **dois bots de Telegram** no ecossistema, em grupos diferentes:

| | **Bot Plantões SAMU** (este repo) | **Bot regulador** (repo `tabela`) |
|---|---|---|
| Grupo | grupo da **escala** (`TELEGRAM_GROUP_CHAT_ID`) | grupo dos **reguladores** |
| Transporte | webhook (`app/api/telegram/webhook`) | long-polling, dentro da API do `tabela` (`api/src/bot/chefiaBot.ts`) + `tabela-notifier` (só envia) |
| Assunto | chegada, saída, refeição, banco de horas, pagamento | vagas de leito, casos aceitos/vaga zero, restrições de UPA |
| Papel na restrição de UPA | **só lê** e mostra | é quem publica e repete os avisos |

Consequência prática: o **aviso periódico** de UPA restrita **não sai daqui**. Ele
é gerado pela API do `tabela` (a cada 2h, ancorado em 07:00/19:00). Se alguém
pedir "o bot não avisou a restrição", o log a olhar é o do `tabela`, não o do
`plantoes-telegram-worker`.

## O que este app faz

1. **Chegada do regulador** — quem assume ramal de regulação recebe, junto da
   confirmação, a lista de UPAs restritas e até quando. O intervencionista
   **não** recebe (ele recebe a chave do checklist): a decisão de para onde o
   paciente vai é de quem regula.
2. **`/upas`** — qualquer um no grupo consulta a lista atual.

Fonte única: `GET {TABELA_API_URL}/upas/restrictions`. A chefia restringe a
célula da UPA no painel `mnrs.com.br/tabela` (aba UPAs) com o PIN da chefia — o
fluxo completo está em `docs/upa-restricoes.md` **no repo `tabela`**.

## Configuração

```
TABELA_API_URL=http://127.0.0.1:3001/tabela/api
```

Ausente ou fora do ar → a chegada é confirmada **sem** o bloco de UPAs, e o
`/upas` responde que não conseguiu consultar. Mesmo contrato fail-soft do
checklist (`modules/telegram/checklist-key.ts`): serviço acessório nunca
bloqueia registro de plantão.

## Formato da resposta consumida

```json
{
  "ok": true,
  "restrictions": [
    { "unitName": "UPA Brotas", "untilLabel": "hoje 19:00", "until": "2026-07-30T22:00:00.000Z" }
  ]
}
```

Usamos `untilLabel` (já formatado no fuso de Salvador pelo `tabela`) para que
painel e os dois bots digam exatamente a mesma frase. `until` fica disponível
para quem precisar calcular.
