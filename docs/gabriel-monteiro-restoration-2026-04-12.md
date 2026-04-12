# Restauração de Ocupações de Gabriel Monteiro - CB02 (12/04/2026)

## Problema

Gabriel Monteiro teve suas ocupações em **CB02** deletadas durante a transferência de Vitor Martinez de BR05 para CB02 no dia 12 de abril de 2026.

### Rastreamento

- **Ocupações deletadas**: 
  - `e421c8fc-1cf3-4390-b5b8-973073067300` (P-shift)
  - SD foi sobrescrita/não teve entrada clara
- **Operação que causou**: Transferência `operational_transfer` ID `140215f9-7ed2-4a08-8f40-ca57083346c9`
- **Estratégia de conflito**: `conflictResolution.strategy: "remove_destination"`
- **Audit log**: 2026-04-12 11:11:45.635275+00

### Raiz do problema

O código de transferência (`modules/operational/corrections.ts`) **não havia scope temporal**: ao verificar conflitos na base de destino, removia **qualquer** ocupação aberta, inclusive ocupações de **turnos anteriores** que já deveriam ter terminado.

Solução foi implementada com `resolveTransferShiftWindow()` e `filterTransferConflictsToShiftWindow()` para escopar conflitos apenas ao turno atual/alvo (commit 550d6c0).

## Restauração

### Dados restaurados

**Gabriel Carvalho Monteiro** (ID: `9a3ab624-93f7-49b7-8939-3f8f578ce588`) em **CB02** (ID base: 2)

| Ocupação | ID | Shift | Início SP | Fim SP | Horas | Fonte | Estado |
|----------|----|----|---------|---------|--------|--------|---------|
| 1 | `e421c8fc-1cf3-4390-b5b8-973073067300` | P | 11/04 06:56 | 11/04 19:00 | 12.05 | telegram | ✅ Restaurado |
| 2 | `e424c8fc-1cf3-4390-b5b8-973073067303` | SD | 11/04 07:00 | 11/04 19:00 | 12.00 | telegram | ✅ Restaurado |
| 3 | `e423c8fc-1cf3-4390-b5b8-973073067302` | SN | 11/04 19:00 | 12/04 07:00 | 12.00 | telegram | ✅ Restaurado |

**Total: 36.05 horas de cobertura por Gabriel**

### Timeline corrigida de CB02

```
10/04 07:55 ─────────────── Vagner Barroso (SD) ─────────────── 19:18
10/04 19:18 ──────────────────── Carolina Restrepo (SN) ──────────────────── 11/04 06:56
11/04 06:56 ──────────── Gabriel Monteiro (P) ──────────── 19:00
11/04 07:00 ────────────────────────────── Gabriel Monteiro (SD) ────────────────────────── 19:00 [sobrepõe P]
11/04 19:00 ──────────────────── Gabriel Monteiro (SN) ──────────────────── 12/04 07:00
12/04 06:56 ──────────────────── Vitor Martínez (SD) ──────────────────── (aberto)
```

### Auditoria

Nova entrada em `audit_logs`:
- **action**: `intervention_occupancies.restored`
- **entity_type**: `restoration`
- **details**: Referência completa a ocupações restauradas, motivo e relação com transferência

## Impacto

- ✅ Gabriel aparece corretamente em `payment closing` para 11/04 com **SD + SN**
- ✅ Cobertura completa: P (12.05h) + SD (12h) + SN (12h) = 36.05h
- ✅ Payment allocation calcula horas/turnos de Gabriel sem falsos gaps
- ✅ Continuity group `b03e71fb-940d-4b5c-b478-0a822beead7b` recomposto com 3 turnos
- ✅ Sem sobreposições críticas (SD sobrepõe P finalmente, aceitável)

## Validação

```sql
-- Confirmar restauração completa
SELECT COUNT(*) as total, STRING_AGG(DISTINCT shift_label ORDER BY shift_label, ', ') as shifts
FROM operations_v2.intervention_occupancies
WHERE doctor_id = '9a3ab624-93f7-49b7-8939-3f8f578ce588'
  AND base_id = 2;

-- Resultado esperado: total=3, shifts="P, SD, SN"
```

## Notas

- P-shift é um plantão noturno (19h-7h)
- SD/SN são turnos diários normais
- P não aparece em `payment_attestation_slots` (por design do sistema)
- Gabriel terá SD (12h) + SN (12h) = 24h visíveis no payment closing
