# Declaração de chegada — regras, cenários e defeitos conhecidos

Leitura obrigatória antes de mexer em qualquer caminho que grave ou leia a chegada de
um médico: parser do bot, `applyParsedEntry`, `start*Occupancy`, tomada/deslocado,
remanejo, continuação, correção pela tela, quadro. Última revisão: 23/09/2026.

Este arquivo descreve **regras**, não código. Aponta para **nomes de função**
(estáveis), nunca para número de linha (apodrece). Para achar: `grep -n nomeDaFuncao`.

---

## 1. Os cinco princípios (não negociáveis)

1. **A chegada é soberana.** Médico que avisa que chegou TEM que aparecer no quadro.
   O bot nunca responde "aceito" deixando o médico fora do quadro sem dizer por quê.
   Se há conflito (outro no posto), o bot pergunta; não engole.
2. **Vale a primeira mensagem.** A hora de chegada de um turno é a do PRIMEIRO aviso
   daquele médico naquele turno. Reenvio, correção de digitação, troca de ramal,
   continuação, reassumir após deslocamento: nada disso pode empurrar a chegada para
   frente. A regra é "só recua, nunca avança".
3. **Vale a hora do aviso, não a hora escrita** (desde `ARRIVAL_TIME_CUTOFF`,
   01/06/2026, "fase 2"). "Cheguei 07:00" enviado às 07:40 grava 07:40. Exceções:
   saída, continuação, remanejo e PIAM (este sempre 07:00/19:00).
4. **Quem chega nunca encerra cobertura vigente do mesmo turno.** Ocupante do mesmo
   turno vira *deslocado* (fora do quadro, plantão aberto, pago). Só o ocupante do
   turno ANTERIOR é rendido (encerrado). Na USA, quem chega vira *dupla*.
5. **O livro guarda fatos; o quadro reconstrói o turno.** O remanejo grava no destino
   a hora da troca ("livro não herda chegada"); quem mostra a 1ª chegada do turno é a
   leitura (`turnoArrivalSql` em `services/board.service.ts`, que pega o menor
   `started_at` do mesmo médico + grupo de continuidade + rótulo, em 12h). Qualquer
   tela nova que mostre chegada deve usar essa projeção, nunca `started_at` cru.

---

## 2. Vocabulário

| Termo | Significado | Como se detecta |
|---|---|---|
| Ocupação | Um registro de presença num ramal (regulação) ou base (intervenção) | tabelas `regulation_occupancies` / `intervention_occupancies` |
| `started_at` | Chegada real gravada | coluna |
| `board_started_at` | Desde quando detém o quadro. **Nulo = fora do quadro** (sombra, deslocado, dupla) | coluna; índice único "1 board ativo por alvo" ignora nulos |
| Janela | `scheduled_start_at`/`scheduled_end_at`, inferida do rótulo SD/SN/P e do posto | `infer*CoverageWindow` |
| Turno | SD 07–19, SN 19–07; regulação termina 07:15/19:15; núcleo SD às 08:00 | `resolveOperationalShiftWindow` |
| Grupo de continuidade | `continuity_group_id`: ocupações contíguas do mesmo médico = uma corrida | — |
| Sombra | Acompanha o titular sem assumir; nunca pega o quadro | marcador `[telegram sombra]`/`[sombra]` nas notas |
| Deslocado | Perdeu o quadro numa tomada; segue no plantão e é pago | marcador `[DESLOCADO] <iso> por X` nas notas |
| Dupla | Segundo médico na mesma USA | marcador `[DUPLA]`; ver `docs/dupla-usa.md` |
| Tomada | Chegada num posto ocupado por outro do mesmo turno | status `pending_takeover_confirmation` |
| Fase 2 | Regra "vale a hora do aviso" | `resolveArrivalPhase` |

Estado por **marcador nas notas**, não por coluna. Toda reescrita de notas precisa
preservar ou remover o marcador de propósito (`preserveRegulationDisplacedMarker`,
`resolveRearrivalNotes`).

---

## 3. O caminho de uma chegada

```
webhook → pendências abertas (tomada, nome, turno, PIAM…) → filtro almoço/descanso
→ parse (alvo, nome, SD/SN/P, sombra, continuação, remanejo)
→ portão F6: chegada precisa de nome E turno (senão pergunta com botões)
→ resolve médico (fuzzy por nome; sem vínculo telegram_id↔médico)
→ hora do evento (fase 2 + primeira tentativa)
→ portão de tomada (só regulação) → retroativa desloca ocupante anterior
→ applyParsedEntry: PIAM | remanejo implícito | cross-turno | continuação | chegada nova
→ start*Occupancy: re-chegada do mesmo médico (in-place) | stale | junção | INSERT
→ resposta do bot → quadro (turnoArrivalSql) → banco de horas (menor started_at do grupo)
```

Hub: `processTelegramUpdate` e `applyParsedEntry` em `modules/telegram/service.ts`.
Gravação: `startRegulationOccupancy` / `startInterventionOccupancy`.

---

## 4. De onde vem a hora

| Caminho | Hora gravada |
|---|---|
| Chegada genuína (fase 2) | `message.date` do aviso; HH:mm escrito é ignorado e a resposta avisa |
| Chegada que só passou num reenvio | a da 1ª tentativa (`resolveFirstArrivalAttemptAt`): mesmo remetente, mesmo nome, mesmo alvo, status `error` ou `pending_takeover_confirmation`, até 2h, mesmo turno |
| Pendência respondida depois (nome, turno, ramal) | hora da mensagem original guardada na pendência |
| Botão de tomada | hora da mensagem pendente (1ª tentativa) |
| Re-chegada do mesmo médico no mesmo alvo, mesmo turno | `min(existente, nova)` — só recua |
| Deslocado/sombra que reassume o quadro livre | chegada original; `board_started_at` = `started_at` do deslocado |
| Junção com plantão recém-fechado | `resolveArrivalIdentity`: se a chegada cai em `[início − 60min, fim − 30min]`, junta e só recua |
| Remanejo | destino grava a hora da troca; o quadro mostra a 1ª do turno |
| Continuação | âncora da cadeia no `board_started_at`; bloco novo começa na virada |
| PIAM | 07:00 / 19:00 fixos |
| Correção pela tela | `redirectTurnoArrivalEdit` manda a correção para a ocupação de ORIGEM do turno |

Banco de horas: atraso = menor `started_at` do grupo − início da janela do carrier;
até 15 min é zero.

---

## 5. Cenários da prática

| Situação | O que o sistema faz | Por quê |
|---|---|---|
| Posto vazio | Cria ocupação, assume o quadro | — |
| Posto com outro médico do MESMO turno (regulação) | Avisa quem está e pede confirmação (botão, "confirmo NNNN" ou reenvio exato em 30 min). Confirmado: ocupante vira deslocado | Trocar de ramal é rotina; tirar alguém do quadro sem querer derruba refeição/saída dele |
| Posto com médico do turno ANTERIOR | Rende: encerra o anterior na hora da chegada (regulação: saída 07:15/19:15 salvo declaração) | Passagem de plantão normal |
| Base (USA) com titular vigente | Quem chega entra como dupla, sem portão | USA comporta dois médicos |
| Mesmo médico reenvia no mesmo turno | Atualiza no lugar; chegada só recua; notas acumulam | Reenvio por insegurança é comum |
| Deslocado reenvia no mesmo alvo, quadro livre | Reassume o quadro com a 1ª chegada; linha `[DESLOCADO]` sai | Princípio 1 (caso José Roberto, 2153, 23/09) |
| Deslocado reenvia com outro titular no quadro | Passa pelo portão de tomada | Princípio 4 |
| Deslocado declara OUTRO alvo | Vira remanejo, preserva chegada | — |
| Sombra reenvia sem a palavra "sombra", quadro livre | Vira titular | Assumiu de fato |
| Chega 06:50 dizendo SD | É SD (janela antecipada de 3h) | "Mesmo turno" nunca é "início da janela" |
| Troca de ramal dentro do turno | Remanejo; destino ocupado por titular vigente barra (ou vira dupla na USA) | — |
| Troca de ramal depois do fim do turno de origem | Vira chegada do turno atual (`resolveCrossTurnoMoveShift`) | Senão o noturno herdava rótulo SD e não era pago |
| SD → SN seguido (mesmo médico) | Continuação: estende a ocupação ou abre bloco novo no mesmo grupo | Uma corrida, duas unidades de pagamento |
| Meio plantão (11:10–17:00, só regulação) | Aviso sem hora nessa faixa assume meio plantão, fim 17:00 | — |
| PIAM | Roteado ao ramal PIAM com 07:00/19:00 | — |
| Posto desativado | A chegada reativa o posto | Chegada é soberana |
| Nome não resolvido | Pergunta com candidatos | Sem vínculo formal telegram↔médico |
| Mensagem de almoço/descanso | Descartada com dica de `/almoco` | — |
| Mensagem EDITADA no Telegram | **Ignorada** (não há handler de `edited_message`) | ver D8 |

---

## 6. Limiares com nome

"Mesmo turno" hoje tem **três réguas diferentes**. Quem mexer deve saber qual usa:

| Régua | Valor | Onde (símbolo) | Usada para |
|---|---|---|---|
| Janela antecipada | 3h antes do turno | `rules.ts`, `board-rules.ts` (duplicada) | rótulo de quem chega cedo |
| Tolerância pré-turno | 60 min | `board-rules.ts`, `turno.ts`, stale da regulação e da intervenção | âncora "vencida", grupo de turno |
| Teto de mesmo turno | 13h | `isSameTurnoOccupant` | tomada × rendição |

Outros: 1ª tentativa 2h · confirmação de tomada 30 min · grace da ocupação ativa 3h ·
junção −60/−30 min · `turnoArrivalSql` 12h · duplicata de pagamento 60 min · atraso
tolerado 15 min · meio plantão 11:10/11:30/17:00 · chegada "no futuro" > 4h vira ontem
(fase 1).

---

## 7. Defeitos conhecidos (registro)

Status: **VERIFICADO** = visto em produção ou reproduzido; **SUSPEITO** = só leitura de
código. Ao corrigir um, mude o status aqui e cite o PR.

| # | Status | Defeito | Evidência |
|---|---|---|---|
| D1 | VERIFICADO | **Reenvio no fim do turno abre plantão novo com a hora da noite.** `shouldReopenStaleSameDoctorRegulationOccupancy` mede "vencida" contra o turno da MENSAGEM NOVA, não contra a janela da ocupação existente. SD que chegou 06:47 e reenvia às 19:11 (ocupação ainda aberta até 19:15) → fecha o SD e cria SD com chegada 19:11. Viola o princípio 2. | Livia Andrade, 2153, 13/09/2026 |
| D2 | VERIFICADO | **Correção de rótulo em segundos vira continuação.** "2034 sd" às 19:08:05 e "2034 sn" às 19:08:15 (corrigindo a digitação) → gravado como SD estendido até 07:15 do dia seguinte (padrão de continuação SD→SN), rótulo SD, janela começando 07:00. A chefia tentou corrigir 3× pela tela (remanejando entre ramais) e não conseguiu. | Emily Thays, 2034, 07/09/2026 (audit_logs) |
| D3 | SUSPEITO | Reenvio com HH:mm escrito desliga a recuperação da 1ª tentativa (guarda `!arrivalTime`); vale a hora do reenvio | código |
| D4 | SUSPEITO | 1ª tentativa só conta status `error`/`pending_takeover_confirmation` e só do MESMO remetente. Colega que avisa pelo médico, ou aviso que caiu em "ignorado"/"nome não resolvido", perde a hora | código; José Roberto 23/09 teve avisos de 3 remetentes |
| D5 | VERIFICADO | **Resposta do bot diz "desde <hora deste aviso>" mesmo quando o banco preservou a 1ª chegada.** O médico lê que perdeu o horário e reenvia — o que alimenta D1. | `buildArrivalRuleReply` usa a hora da mensagem, ignora `replyTimeAt` |
| D6 | SUSPEITO | Reenvio "SD" entre 11:10 e 17:00 de quem já está no plantão pode virar meio plantão (fim 17:00) — `shouldAssumeTelegramHalfShift` ignora `effectiveShiftType` | código; não reproduzido |
| D7 | VERIFICADO | "SD" declarado às 18:35 em outro ramal grava rótulo SD com janela SN (19:00) — rótulo e janela discordam | Gerardson, 2152, 03/09/2026 |
| D8 | VERIFICADO | Mensagem editada no Telegram é ignorada; quem corrige a digitação editando não é ouvido | grep: nenhum handler de `edited_message` |
| D9 | SUSPEITO | Intervenção: reenvio com âncora "vencida" move `board_started_at` e a janela para a hora nova (`resolveSameDoctorBoardStartedAt`) | código |
| D10 | ABERTO | Quando quem tomou o posto é remanejado ou sai, o deslocado NÃO reassume sozinho; precisa reenviar | pedido do dono, 18/09 |
| D11 | CORRIGIDO | Deslocado que reenviava no mesmo alvo nunca voltava ao quadro | PR #295, 23/09/2026 |

### Débito que atrapalha achar esses bugs

- `modules/telegram/service.ts` tem ~14,6k linhas. A decisão "que tipo de chegada é
  esta" está espalhada entre `applyParsedEntry`, o portão de tomada no handler e
  `start*Occupancy`. Não existe uma função pura "classificar chegada" testável.
- Regulação e intervenção implementam a re-chegada de jeitos diferentes: a regulação
  fecha e recria (stale), a intervenção move o board. Detecção de sombra, marcador
  `[DESLOCADO]`, `resolveTurnoContinuityGroupId` e a janela de 3h existem em cópias.
- Três réguas de "mesmo turno" (seção 6).
- Estado por marcador de texto nas notas: qualquer código que reescreva notas pode
  apagar um estado.

---

## 8. Antes de mexer

1. Qual princípio da seção 1 a mudança toca? Se viola algum, pare e pergunte ao dono.
2. A mudança vale para regulação E intervenção? Procure a cópia.
3. Reenvio, digitação corrigida e aviso por outro remetente continuam dando a MESMA
   hora de chegada? Escreva o teste do cenário com a hora da 1ª mensagem.
4. Rode `npm run test:deploy` e os testes da área: `telegram-arrival-time-rule`,
   `telegram-displaced`, `operational-shadow-marker`, `regulation-stale-occupancy`,
   `occupancy-identity`, `turno`, `telegram-reassignment-conflict`,
   `telegram-half-shift-no-time`, `undeclared-continuation`.
5. Para investigar um caso real: `telegram_ingested_messages` (texto, status,
   `resolution_data`) + ocupações do médico no dia + `audit_logs` da ocupação.
   Leitura em produção via `ssh magalu` (ver `docs/agent-operations.md`).
6. Corrigiu um defeito da seção 7? Atualize o registro.
