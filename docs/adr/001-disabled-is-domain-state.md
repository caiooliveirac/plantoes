# ADR-001: isActive/disabled is Domain State, Not Soft Delete

## Status
Accepted

## Context
The system has `isActive` flags on `doctors`, `regulationPosts`, and `interventionBases`.
Early assumptions treated these as soft deletes, but they represent real operational state.

## Decision
- `isActive = false` on a **doctor** means the doctor is no longer part of the active roster.
  They may still have historical occupancies and bank-hours entries.
- `isActive = false` on a **post/base** means that position is temporarily deactivated
  (e.g., CRU-1366 deactivated for the night shift). It appears on the board as "DSV"
  (desativada) and affects payment allocation.
- Deactivations are tracked in `regulationPostDeactivations` / `interventionBaseDeactivations`
  with start/end timestamps and shift scope.

## Escopo por turno (atualizado 2026-07-23)
Uma desativação vale **até a virada do turno em que foi feita** (07:00/19:00 SP).
`resolve{Intervention,Regulation}…DeactivationExpiresAt` = `resolveOperationalShiftWindow(deactivatedAt).nextBoundaryAt`,
e `is…DeactivationActive` retorna `false` a partir dessa fronteira. Um "reaper"
(`expire…Deactivations`, chamado a cada montagem do quadro) fecha as janelas vencidas
gravando `reactivatedAt = fronteira`. Passada a virada, a base/posto volta a `waiting`
(→ "AGUARDANDO" o próximo escalado) **sem** reativação manual nem chegada de médico.

Motivação: uma base vazia deve mostrar o próximo plantão escalado na virada; a
desativação não pode escurecê-la indefinidamente. **Consequência aceita:** uma base
genuinamente fora de serviço por mais de um turno precisa ser **redesativada** a cada
turno — o turno em que foi desativada continua "coberto" no pagamento, mas os seguintes
voltam a contar como vaga descoberta (nenhum médico é pago a mais/a menos; muda só a
marcação de cobertura). Histórico anterior: a expiração já foi indefinida (stub ano
9999) por um período; esta revisão volta ao escopo por turno do desenho original.

## Consequences
- Never filter out `isActive = false` records from queries that need historical data
- Disabled posts/bases MUST appear on the operational board (as "DSV")
- Payment allocation treats disabled slots as explicitly covered (no vacancy)
  **apenas dentro do turno da desativação** — ver "Escopo por turno" acima
- Reactivation must check for stale deactivation records and clean them up
