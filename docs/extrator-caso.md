# Extrator de caso

`/admin/extrator-caso` — pagamento e banco de horas de **um médico em um mês**, num
texto sem dado identificável, para colar numa sessão de IA que só enxerga o
repositório. Decisão do responsável em 29/09/2026.

## Para que serve

Pergunta do tipo "por que fulano recebeu assim?" ou "por que o banco de horas dele
mudou naquele dia?" precisa do dado real. A sessão de IA em nuvem não acessa o
banco de produção, e não deve. O extrator leva só o caso, mascarado, e quem
atravessa a fronteira é o admin, copiando e colando.

## Regras

1. **Só `admin`.** Página e rota chamam `requireAuthenticatedSession(["admin"])`.
   `payment_closing_limited` e `chief` não entram.
2. **Só leitura**, fora uma linha em `audit_logs` por extração
   (`action = admin.extrator_caso.extrair`, `entity_type = extrator_caso`,
   `entity_id` = médico, `details` = mês e se incluiu textos).
3. **Lista branca.** Só sai o campo escrito em `modules/extrator-caso/caso.ts`.
   Campo novo no read model não vaza sozinho.
4. **A legenda não sai do servidor junto do texto.** Ela vem na mesma resposta,
   mas a tela mostra separada e o botão Copiar só pega o texto.
5. **O segredo dos pseudônimos nunca sai do servidor**: HMAC-SHA256 com
   `AUTH_SECRET` e o prefixo `extrator-caso:v1`. Trocar `AUTH_SECRET` troca todos
   os pseudônimos.

## O que vira o quê

| No banco | No texto |
|---|---|
| médico | `MED-` + 8 hex (estável entre extrações) |
| nome que não é médico cadastrado, vindo em campo próprio | `PESSOA-` + 8 hex |
| e-mail de quem registrou | `CONTA-` + 8 hex |
| ramal da regulação | `REG-` + 8 hex; chefia = `REG-CHEFIA`; eventual da madrugada = `REG-EVENTUAL-` + 4 hex |
| base de ambulância | `USA-` + 8 hex |
| id de ocupação, grupo, contrato, acerto | `ID-1`, `ID-2`… (só valem dentro do caso) |
| instante | `D+03 ter 19:04` — dias desde o dia 1 do mês do caso, relógio UTC-3 |
| mês | `M0`, `M-1`, `M+2` |
| nota fiscal, processo, nº de ocorrência | só "informado: sim/não" |
| CNPJ, razão social, nome na planilha legada | não saem |
| valores em dinheiro e minutos | saem como estão |

Texto livre passa por `Mascara.texto`: e-mail, UUID, datas (`AAAA-MM-DD`,
`dd/mm/aaaa`, `dd/mm`), rótulo e código de ramal/base, nome e sobrenome de todo
médico cadastrado (sem depender de acento ou caixa) e sequência longa de dígitos.

## Limites — leia antes de confiar

- **É desidentificação, não anonimização.** Dia da semana, horário e valor
  continuam lá; quem conhece a escala pode reconhecer o padrão. O texto vai para
  onde o admin decidir colar, e só para lá. Não commitar, não anexar em issue.
- **Nome de quem não é médico cadastrado, citado só em texto livre, passa.** A
  máscara conhece os nomes do cadastro e os que vêm em campo próprio do caso. Por
  isso a tela manda ler antes de colar, e existe a opção de omitir as anotações
  escritas à mão.
- Sobrenome que também é palavra comum ("Dias", "Costa") só é mascarado com
  inicial maiúscula ou colado em outro nome.
- O dia 1 do mês ancora as datas: o dia da semana de `D+00` restringe quais meses
  são possíveis.

## Onde está

- `modules/extrator-caso/mascara.ts` — pseudônimos, datas relativas, texto livre (puro).
- `modules/extrator-caso/caso.ts` — lista branca dos campos (puro).
- `services/extrator-caso.service.ts` — junta `getBankHoursHistory` e
  `getChiefPayableShiftsBoard`, registra a extração.
- `app/api/admin/extrator-caso/route.ts`, `app/admin/extrator-caso/`.
- `tests/extrator-caso.test.ts` — guarda de vazamento com dados inventados.

Caso novo descoberto por aqui vira teste com dado **inventado**, nunca com o texto
extraído.
