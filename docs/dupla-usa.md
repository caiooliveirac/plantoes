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
| pagamento | linha do alvo | linha extra ("presença sem titularidade") |

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

- **Titular sai** (saída, Retirar, remanejo): a dupla mais antiga assume o quadro e
  perde o marcador — dupla antes de sombra (`pickInterventionBoardReplacement`,
  `reconcileInterventionBoardState`). Base que já tem titular não promove ninguém.
- **Dupla esquecida**: vence no `scheduled_end_at`, como sombra
  (`resolveStaleShadowInterventionEndedAt`). Saída tardia avisada depois ainda ajusta o
  registro fechado.
- **"Continua" fora do quadro** com outro titular na base mantém board nulo.

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

## Em aberto

- Pagamento: titular + dupla no mesmo alvo/turno ainda recebem o aviso "Conflito entre
  medicos titulares no mesmo alvo/turno" (vão para revisão, os dois pagáveis). Tirar o
  aviso para `[DUPLA]` é decisão financeira — ler ADR-006 antes.
- Regulação não tem dupla: ramal é um telefone. Lá vale deslocar.
