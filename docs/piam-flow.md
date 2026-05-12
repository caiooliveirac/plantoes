# PIAM — Fluxo de cardiologistas

> Documento dirigido a agentes que estao depurando ou evoluindo o fluxo PIAM.
> Use junto com `OPERATIONAL_RULES.md` (regras de turno) e `RULES.md` (lista de ramais).

## Resumo de uma linha

Medicos marcados com `metadata.preferredOperationalRole = "PIAM"` tem o plantao **lancado automaticamente no ramal PIAM, com hora fixa 07:00-19:00 (SD) ou 19:00-07:00 (SN), ja fechado**, sem banco de horas, e remunerados como **especialista**.

## Quem dispara o fluxo

| Entrada do usuario | Resultado |
| --- | --- |
| `/piam Nome` (admin, privado) | Marca `preferredOperationalRole=PIAM` |
| `/piam remover Nome` (admin) | Limpa a marca |
| `/piam listar` (admin) | Lista os marcados |
| Mensagem `Aline SD` / `Aline dia` no grupo (medico PIAM) | Cria + fecha occupancy no ramal `PIAM`, 07:00-19:00 |
| Mensagem `Aline SN` / `Aline noite` (medico PIAM) | Cria + fecha occupancy no ramal `PIAM`, 19:00-07:00 do dia seguinte |
| Mensagem `Aline chegou` sem SD/SN (medico PIAM) | Bot **recusa** e pede confirmacao explicita do turno |

A mensagem pode citar qualquer ramal (`2151`, `PR03`, etc) — o roteador PIAM sobrescreve `sector` e `baseCode` antes de criar a occupancy.

## Mapa de arquivos

| Arquivo | Responsabilidade |
| --- | --- |
| `modules/telegram/piam-commands.ts` | Parser do `/piam` (assign/unassign/list) |
| `modules/doctors/service.ts` → `setDoctorPreferredOperationalRole`, `listDoctorsByPreferredOperationalRole` | Mutacao do metadata + audit log `doctor.preferred_operational_role_updated` |
| `modules/telegram/service.ts` | Wiring do `/piam`, `maybeApplyPiamRouting`, `handlePiamAutoArrival`, `resolvePiamShiftBounds`, sentinel `TELEGRAM_PIAM_SHIFT_REQUIRED_ERROR` |
| `modules/bank-hours/service.ts` → `syncBankHoursByContinuityGroup` | Bypass: doctors PIAM tem entries deletadas e nao recebem novas |
| `modules/reporting/payable-shifts.ts` → `resolveDoctorPaymentProfile` | `PIAM → "specialist"` (mesma tarifa de especialista) |
| `services/payment-attestation.service.ts` → `resolveDoctorPaymentProfileFromMetadata` | Idem, para o snapshot de fechamento |
| `modules/doctors/importer.ts` | CSV com sufixo `(PIAM)` no nome ja seta a role no import |
| `modules/operational/roles.ts` | `PIAM` listado em `STANDARD_OPERATIONAL_ROLE_CODES` e em `getOperationalRoleTone` |
| `tests/piam-flow.test.ts` | Testes unitarios do parser, das janelas de turno e do mapeamento de pagamento |

## Como o auto-rota e disparado dentro de `applyParsedEntry`

```
applyParsedEntry(parsed, resolvedDoctor, eventAt, …)
  └─ maybeApplyPiamRouting(parsed, doctorId)
       ├─ doctor nao tem role PIAM → no-op, fluxo segue normal
       ├─ doctor PIAM + parsed.shiftType NOT in {SD, SN}
       │    └─ throw Error(TELEGRAM_PIAM_SHIFT_REQUIRED_ERROR)
       └─ doctor PIAM + SD/SN → muta parsed.sector="REGULATION", parsed.baseCode="PIAM"
  └─ se piamRouting.applied:
       handlePiamAutoArrival({ parsed, doctorId, shiftLabel, eventAt, … })
         ├─ resolvePiamShiftBounds(eventAt, shiftLabel) → { scheduledStartAt, scheduledEndAt }
         ├─ startRegulationOccupancy(...)    # startedAt = scheduledStartAt
         └─ endRegulationOccupancy(reg.id, { endedAt: scheduledEndAt, actualEndedAt: scheduledEndAt })
       (retorna { piamAutoAllocated: true, … }; nao passa pelo restante do fluxo)
```

O sentinel `TELEGRAM_PIAM_SHIFT_REQUIRED_ERROR` e interceptado no handler principal do webhook (perto do `isTelegramJustificationRequiredError`), respondendo `🩺 Nome esta marcado como PIAM. Me confirma o turno: SD/dia para 07:00-19:00, SN/noite para 19:00-07:00.`

## Calculo de `scheduledStartAt` / `scheduledEndAt`

`resolvePiamShiftBounds(eventAt, shiftLabel)`:

1. Calcula a janela operacional que contem `eventAt` via `resolveOperationalShiftWindow`.
2. Se essa janela ja e do turno declarado, retorna `{ startedAt, nextBoundaryAt }`.
3. Caso contrario, retorna a janela seguinte (ou seja, o turno declarado e **o proximo**).

Casos cobertos:

| eventAt (BRT) | shiftLabel | scheduledStartAt | scheduledEndAt |
| --- | --- | --- | --- |
| 12:30 (em SD) | SD | hoje 07:00 | hoje 19:00 |
| 20:30 (em SN) | SN | hoje 19:00 | amanha 07:00 |
| 04:00 (em SN) | SD | hoje 07:00 | hoje 19:00 |
| 18:00 (em SD) | SN | hoje 19:00 | amanha 07:00 |

## Banco de horas

`syncBankHoursByContinuityGroup` (`modules/bank-hours/service.ts`) faz:

1. Sempre apaga entries existentes do grupo.
2. **Antes de recalcular**, checa se *todos* os doctors do grupo sao PIAM (via `extractDoctorPreferredOperationalRole`).
3. Se sim, retorna `null` sem inserir entry nova.

Consequencia: chegadas/saidas do ramal PIAM nao geram debito nem credito, e qualquer override manual antigo e descartado.

## Pagamento

`resolveDoctorPaymentProfile` (em `modules/reporting/payable-shifts.ts`) e o gemeo `resolveDoctorPaymentProfileFromMetadata` (em `services/payment-attestation.service.ts`) tratam `preferredOperationalRole === "PIAM"` antes do flag `paymentProfile.isSpecialist`. Resultado: profile = `specialist`, tarifa atual (modules/reporting/payable-shifts.ts):

- semana: R$ 1.329,66
- fim de semana: R$ 1.457,15

## Persistencia / formato do doctor

```json
{
  "metadata": {
    "preferredOperationalRole": "PIAM",
    "aliases": [...]
  }
}
```

Sempre via `mergeDoctorDirectoryMetadata` para preservar outros campos.

Audit log: action `doctor.preferred_operational_role_updated`, com `previousRole` e `nextRole` em `details`.

## Checklist de debug

Quando um plantao PIAM nao aparecer correto no fechamento:

1. `select metadata from operations_v2.doctors where id = '<id>'` — confirme `preferredOperationalRole=PIAM`.
2. `select id, started_at, ended_at, actual_ended_at, scheduled_start_at, scheduled_end_at, shift_label, role_label, ramal_label from operations_v2.regulation_occupancies where doctor_id = '<id>' order by started_at desc limit 5` — confirme que `started_at = scheduled_start_at = 07:00 ou 19:00 BRT` e `actual_ended_at = scheduled_end_at`.
3. `select * from operations_v2.bank_hours_entries where doctor_id = '<id>'` — deve estar **vazio** para periodos PIAM.
4. No fechamento (`/admin/payment-attestation`), a linha deve mostrar tarifa de **especialista**.
5. Se o medico esta marcado mas o anuncio nao caiu em PIAM, verifique no log do Telegram (`telegram_message_logs`) o `parsedAction`, `parsedTargetCode` e `errorMessage`. `telegram_piam_shift_required` significa que ele anunciou sem SD/SN/dia/noite e o bot pediu confirmacao.
6. Sentinel para detectar o caso de "shift faltando": `isTelegramPiamShiftRequiredError(errorMessage)`.

## Invariantes

1. PIAM nunca gera entry em `bank_hours_entries`. Se aparecer, ou a doctor.metadata perdeu a role, ou alguem chamou `syncBankHoursByContinuityGroup` antes do guard.
2. PIAM occupancy nasce ja fechada (`endedAt != null` desde o insert seguido do `endRegulationOccupancy`). O quadro operacional nao vai mostrar PIAM como "ativo" — isso e intencional.
3. PIAM occupancy sempre tem `role_label = "PIAM"` e `ramal_label = "PIAM"`, independente do que o medico digitou.
4. Sem turno explicito, o bot recusa — `eventAt` nao deve ser usado para inferir SD/SN no caso PIAM.
5. Correcao manual (`/corrigir`, `/remover`, edicao no site) e permitida normalmente. O auto-close nao bloqueia ajuste posterior.

## Pontos de extensao conhecidos

- Adicionar uma outra role com perfil de pagamento de especialista: replicar o padrao em `resolveDoctorPaymentProfile` e `resolveDoctorPaymentProfileFromMetadata`.
- Adicionar uma role com auto-rota (como PIAM): replicar o par `maybeApplyXRouting` + `handleXAutoArrival` em `modules/telegram/service.ts` e o early-return em `applyParsedEntry`.
- Mudar a janela fixa (ex: meio-plantao PIAM): trocar `resolvePiamShiftBounds` por uma resolver que aceite duracao customizada.
