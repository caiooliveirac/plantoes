# Como falar com o robô do plantão

Guia rápido para o médico. O robô **não usa adivinhação**: ele lê a mensagem
procurando informações exatas. Se elas estiverem na mensagem, ele registra na
hora. Se faltar uma, ele devolve uma pergunta — e o plantão fica pendente até
você responder.

---

## A regra de ouro

Toda chegada precisa de **3 coisas, na mesma mensagem**:

> **NOME e sobrenome  +  LOCAL (base ou ramal)  +  HORÁRIO**

```
Vagner Damasceno  PM04  07:00
```

Pronto. Pode mandar tudo na ordem que quiser ("PM04 Vagner Damasceno 07:00"
também funciona). O robô responde **✅ Chegada entendida** quando deu certo.

---

## Como dizer cada coisa

### 1. O NOME — sempre com sobrenome

- ✅ `Vagner Damasceno`
- ❌ `Vagner` (só o primeiro nome)

Só o primeiro nome costuma bater com vários médicos. Quando isso acontece o robô
responde **"Escolha 1, 2 ou 3"** ou **"redigite com nome e sobrenome"** — e
nada é registrado até você confirmar. Mandar o nome completo de primeira evita
essa ida e volta.

### 2. O LOCAL — use o código real

**Bases de intervenção** (duas letras + dois números):

```
SM01  CB02  PR03  PM04  BR05  CN10
PP20  IT30  PM40  CZ50  BR60  CC70
```

**Ramais de regulação** (quatro números):

```
1321–1329   1361–1368   1476
2031–2035   2151–2154   2377   (e NUCLEO / PIAM pelo nome)
```

> ⚠️ Nos exemplos do `/ajuda` aparece "USB-01" — isso é **só um modelo de
> formato**. Troque pelo seu código real (PM04, 1363, etc.). "USB-01" não é
> uma base de verdade e não será reconhecida.

### 3. O HORÁRIO — formatos que o robô entende

- ✅ `07:00`, `8:00`, `19:30`
- ✅ `07h`, `8h30`, `19h00`
- ✅ `às 7`, `as 19:00`, `às 7 horas`

> ❌ **Não use "24h" como horário.** Para o robô, "24h" significa
> **plantão P (24 horas)**, não meia-noite. Se for plantão P, escreva a letra
> `P`: `Vagner PM04 07:00 P`.

---

## As outras ações (sempre nome + local na mesma mensagem)

| Quero… | Escreva assim |
|--------|---------------|
| **Saída** | `Vagner saindo PR03 19:20` (precisa do verbo + local + hora) |
| **Continuar** (emendar o próximo turno) | `Vagner continuo PM04` |
| **Trocar de base/ramal** | mande uma **nova chegada**: `Vagner PM04 08:30` — ou `Vagner mudando para PM04` |
| **Plantão P (24h)** | `Vagner PM04 07:00 P` |

Para saída o robô aceita vários jeitos de dizer ("saindo", "saiu", "encerrando",
"fui rendido", "indo embora", "fim de plantão") e até perdoa pequenos erros de
digitação. Mas **precisa do local e do horário junto** — só "saída" não basta.

---

## O que NÃO dizer ao robô — e por que dá errado

Estes são os erros que mais têm acontecido (levantados na auditoria das
mensagens reais do grupo):

### ❌ Mandar só "bom dia / cheguei" sem o resto
`Bom dia, cheguei!`
→ O robô trata saudação como conversa (responde "Bom plantão por aí") e **não
registra nada**. Saudação não é informação. Mande nome + local + horário.

### ❌ Começar com "Informo / Aviso / Comunico" e esquecer o nome
`Bom dia, informo saída da BR60`
→ Sem o seu nome, o robô não sabe **quem** saiu. (Num caso real ele chegou a
tentar usar "informo" como se fosse o nome do médico.) Escreva:
`Vagner Damasceno saindo BR60 19:20`.

### ❌ Quebrar a informação em várias mensagens
`Vagner Damasceno` … *(outra mensagem)* … `saída PM04`
→ Cada mensagem é lida sozinha. A primeira não tem ação nem local; a segunda
não tem nome. Junte tudo numa mensagem só.

### ❌ Usar "1367 12:30" para avisar almoço/jantar
`1367 ALMOÇO 12:30`
→ Esse formato "ramal + horário" é o **botão da divisão de almoço**, não uma
chegada. Para refeição use os comandos **`/almoco`** (diurno) ou **`/jantar`**
(noturno) e clique no horário que o robô oferecer.

### ❌ Mandar saída com horário antes da chegada
`Vagner saindo PM04 06:00` (mas a chegada foi 07:00)
→ O robô recusa: **"esse horário ficou antes da chegada registrada"**. Confira
a hora e reenvie.

### ❌ Saída tardia depois de já ter chegado o rendido — sem justificar
Se outro médico já assumiu o seu posto e você lança uma saída mais tarde, o robô
**pede o motivo** dos minutos extras. Ele só credita automaticamente dois casos:

- 🚑 **ocorrência** — ex.: `estava em ocorrência 0729`
- 🧼 **higienização** — ex.: `estava higienizando a viatura`

Responda só com o motivo. Sem isso, fica registrado para a coordenação, mas o
extra só entra se a chefia lançar.

---

## Detalhe importante: ramais que mandam na função

Alguns ramais **definem a função sozinhos** — não adianta escrever outra:

- **2031** → sempre **CP** (chefia)
- **1367 e 1368** → sempre **COI**

Se você lançar nesses ramais, o robô já grava a função certa automaticamente.
A única exceção é **meio plantão**: se você avisar "meio plantão" / "MP" / "MT",
isso prevalece.

---

## Quando algo der errado

- O robô **sempre responde**. Se a resposta começar com **❓, ⚠️ ou ⛔**, é
  porque faltou alguma coisa — leia a mensagem, ela diz exatamente o que ajustar
  e mostra um exemplo do formato certo.
- **`/ajuda`** → guia rápido de chegada, saída, continuação e troca.
- **`/comandos`** → tutorial completo, com todos os comandos e exemplos.

---

### Resumo de bolso

> ✅ **Chegada:** `Nome Sobrenome  LOCAL  HORÁRIO`
> ✅ **Saída:** `Nome Sobrenome saindo LOCAL HORÁRIO`
> ✅ **Plantão P:** acrescente `P` no fim
> ❌ Sem nome completo · sem local · sem horário · em mensagens separadas · "24h" como hora · "ramal HH:MM" para almoço
