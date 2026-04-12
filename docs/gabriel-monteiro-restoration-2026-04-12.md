# Ajuste de Ocupações de Gabriel Monteiro - CB02 (12/04/2026)

## Contexto

Foi solicitado consolidar o registro de Gabriel Monteiro em **CB02** no dia **11/04/2026** como:

- **SD** (07:00-19:00)
- **SN** (19:00-09:37)
- saída do SN às **09:37** por **ocorrência**
- apuração de banco de horas com **crédito dobrado (bônus)**

## Ajuste aplicado

### Ocupações finais (CB02, 11/04)

**Gabriel Carvalho Monteiro** (ID: `9a3ab624-93f7-49b7-8939-3f8f578ce588`) em **CB02** (ID base: 2)

| Ocupação | ID | Shift | Início SP | Fim SP | Fonte | Estado |
|----------|----|----|---------|---------|--------|---------|
| 1 | `e424c8fc-1cf3-4390-b5b8-973073067303` | SD | 11/04 07:00 | 11/04 19:00 | telegram | ✅ Mantido |
| 2 | `e423c8fc-1cf3-4390-b5b8-973073067302` | SN | 11/04 19:00 | 12/04 09:37 | telegram | ✅ Ajustado (ocorrência) |

- O registro em `P` foi removido para manter apenas SD/SN no fechamento deste dia.

### Timeline final de CB02

```
10/04 07:55 ─────────────── Vagner Barroso (SD) ─────────────── 19:18
10/04 19:18 ──────────────────── Carolina Restrepo (SN) ──────────────────── 11/04 06:56
11/04 07:00 ──────────────────── Gabriel Monteiro (SD) ──────────────────── 19:00
11/04 19:00 ──────────────────── Gabriel Monteiro (SN) ──────────────────── 12/04 09:37 (ocorrência)
12/04 06:56 ──────────────────── Vitor Martínez (SD) ──────────────────── (aberto)
```

### Banco de horas

- `rule_code`: `ON_TIME_DOUBLE_OVERTIME`
- `arrival_delay_minutes`: `0`
- `overtime_minutes`: `157`
- `credited_overtime_minutes`: `314`
- `balance_minutes`: `314`
- Explicação: bônus em dobro aplicado e saída considerada às 09:37 por ocorrência.

## Impacto

- ✅ Gabriel aparece no payment closing de 11/04 com **SD + SN** em `CB02`
- ✅ SN ficou com saída às **09:37** com motivo **ocorrência**
- ✅ Banco de horas com **crédito dobrado + bônus** refletido no snapshot

## Validação

```sql
-- Confirmar que restaram apenas SD e SN no dia 11/04
SELECT shift_label,
       started_at AT TIME ZONE 'America/Sao_Paulo' AS started_sp,
       actual_ended_at AT TIME ZONE 'America/Sao_Paulo' AS actual_ended_sp
FROM operations_v2.intervention_occupancies
WHERE doctor_id = '9a3ab624-93f7-49b7-8939-3f8f578ce588'
  AND base_id = 2
  AND DATE(started_at AT TIME ZONE 'America/Sao_Paulo') = DATE '2026-04-11'
ORDER BY started_at;

-- Resultado esperado: SD e SN, com SN encerrando 12/04 09:37
```

## Notas

- O fechamento financeiro foi alinhado para o cenário pedido: SD + SN no dia 11/04.
- A saída estendida de SN foi registrada como ocorrência e refletida no banco de horas.
