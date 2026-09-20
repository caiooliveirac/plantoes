# Dupla — dois médicos na mesma USA

Regra do dono (20/09/2026): **quem avisou chegada para o turno não sai da base por
comando de outro médico.** Base de intervenção comporta dois (ou mais) médicos até o
fim do plantão, sem ninguém precisar escrever "sombra".

## Modelo

O índice único `intervention_occupancies_one_active_board_per_base_idx` continua
valendo: **um titular por base**. A dupla cabe nele porque entra fora do quadro:

| | titular | dupla |
|---|---|---|
| `board_started_at` | preenchido | `NULL` |
| nota | — | `[DUPLA] <iso>` |
| painel | linha principal | sub-linha `+ Nome`, clicável, com **Retirar** |
| pagamento | linha do alvo | linha extra, **sem aviso de conflito** |

Helpers em `modules/intervention/service.ts`: `shouldJoinInterventionBaseAsCompanion`,
`appendInterventionCompanionMarker`, `stripInterventionCompanionMarker`,
`pickInterventionBoardReplacement`.

## Quando vira dupla, quando é rendição

`shouldJoinInterventionBaseAsCompanion` reusa `shouldDisplaceInsteadOfRelieve`
(`modules/operational/board-rules.ts`):

- titular do **mesmo turno**, ou P/continuidade com cobertura que segue → quem chega
  entra como **dupla**; o titular não é tocado;
- titular no **fim do turno anterior** (SD às 18:50, SN às 07:05) → rendição normal;
- chegada declarada como sombra continua sombra.

A regra mora em `startInterventionOccupancy`, então vale para **todo** caminho: bot,
botões, chegada manual da chefia, scripts. O bot não pede mais confirmação de tomada
para base (`findActiveSameTurnoBoardCarrierOnTarget` devolve `null` em intervenção) e o
balão avisa: "CZ50 está com 2 médicos: A + B. Ninguém foi retirado".

## Ciclo de vida

- **Titular sai** (saída, Retirar, remanejo): a dupla mais antiga assume o quadro —
  dupla antes de sombra (`pickInterventionBoardReplacement`,
  `reconcileInterventionBoardState`). Base que já tem titular não promove ninguém.
  O `[DUPLA]` **fica** nas notas: é o registro de como ela entrou e é o que o pagamento
  lê. Em quem tem board o marcador é inerte para painel e varredura (os dois exigem
  board nulo). Só o remanejo para OUTRO alvo tira o marcador, e só da ocupação nova.
- **Dupla esquecida**: vence no `scheduled_end_at`, como sombra
  (`resolveStaleShadowInterventionEndedAt`). Saída tardia avisada depois ainda ajusta o
  registro fechado.
- **"Continua" fora do quadro** com outro titular na base mantém board nulo.
- **Notas reescritas** ("continua", correção pela tela) nunca apagam o marcador:
  `preserveInterventionOffBoardMarkers` (fora do quadro: `[DUPLA]` + `[DESLOCADO]`) e
  `preserveInterventionCompanionMarker` (com board: só `[DUPLA]`). Board nulo com
  marcador apagado = médico aberto que ninguém vê nem retira.

## Remanejo pelo painel (`transferOperationalOccupancy`)

`resolveTransferDestinationDecision` trata **todo** titular aberto do destino — o filtro
antigo por janela de turno deixava o de turno anterior escapar e o insert morria com
23505 cru ("erro enorme em SQL").

| destino tem titular… | sem escolha da chefia | com escolha |
|---|---|---|
| cobertura vencida (fantasma) | rendido no fim da cobertura | — |
| fim do turno anterior | rendido no horário do remanejo | — |
| cobertura vigente | erro em português pedindo decisão | aplica a escolha |

Escolhas (`conflictResolution.strategy`): `share_destination` (só intervenção, padrão
da tela para USA), `displace_destination` (padrão para ramal: `[DESLOCADO]`, segue no
plantão), `move_destination`, `remove_destination`. **O padrão nunca é retirar.**
"Entrar como sombra" não resolve conflito nenhum — sombra coexiste.

Erro de banco nunca chega cru à tela: `describeOperationalError`.

## Pagamento (`services/board.service.ts`)

Decisão do dono (20/09/2026): **os dois são pagos.**

- **USA com dupla**: `isCompanion` (nota `[DUPLA]`) não conta como titular concorrente
  em `hasDoctorOverlapConflict` → sem "Conflito entre medicos titulares", linha
  `ready_for_payment`.
- **Ramal com deslocado**: o aviso de conflito **fica** (é erro de não ter remanejado),
  e a linha é paga do mesmo jeito. `needs_review` avisa, **não bloqueia**: o total do
  fechamento soma todo plantão pagável, qualquer que seja o status.
- **Elegibilidade**: a base descartava toda presença sem board vinda do bot
  (`lacksInterventionBoardTitularity` em `isEligiblePresenceCandidate`). Dupla e
  deslocado são fora-do-quadro POR REGISTRO, não ruído — `isDeclaredOffBoardPresence`
  os mantém na folha. Sem isso quem dividia a USA, ou era deslocado dela, não recebia.
- ADR-006 intacto (um médico, um plantão por slot): aqui são médicos diferentes no
  mesmo alvo. `tests/payment-dupla.test.ts` cobre os dois casos e o invariante.

## Limites

- Regulação não tem dupla: ramal é um telefone. Lá vale deslocar.
- Dupla não aparece no "Plantão Anterior" como titular (mesmo tratamento da sombra).
