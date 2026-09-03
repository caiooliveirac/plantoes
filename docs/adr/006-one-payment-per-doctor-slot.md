# ADR-006: Um médico, um pagamento por slot (guarda contra pagamento em dobro)

## Status
Accepted (2026-09-03)

## Context
O fechamento paga por posição: cada alvo (ramal ou base) × slot de 12h (SD/SN)
escolhe um ocupante (ADR-004). Nada, historicamente, perguntava se o **mesmo
médico** já estava sendo pago em **outro alvo do mesmo slot**. Um médico não
está em dois lugares ao mesmo tempo; duas linhas pagáveis dele no mesmo slot
são sempre erro de dado, e o erro custa dinheiro.

Como o dado errado nasce, na prática (37 casos em 120 dias, auditados em
2026-09-03 via `audit_logs`): o médico faz SD no alvo A e à noite manda
"continuando na 2032". O bot cria a ocupação noturna certa (P, 19:00→07:15).
Minutos depois a chefia usa a correção do quadro e retroage a chegada dessa
ocupação para 07:00, com notas como "Continua", "ESTAVANOPLANTAO", "VEIODAINT".
`correctRegulationOccupancy` recalcula a janela programada a partir do novo
horário, e a ocupação vira 07:00→07:15 do dia seguinte no alvo B, coexistindo
com o SD real no alvo A.

O PR #221 já impedia o mesmo médico de ser **titular** de dois alvos no slot
(`usedDoctorIds` em `resolvePaymentAllocationTargetChoices` e
`doctorsWithChosenRow` nas linhas extra). O furo era a linha extra de
sombra/visibilidade: Matheus Rocha Libório, 26/08/2026, sombra no 2154 (titular
Kêmylla) + P retroagido no 2032 (titular Ana Luiza) → dois SD pagos. O
fechamento real de agosto/2026 tinha só esse caso, mas a porta estava aberta.

## Decision
1. **A correção de horário continua livre.** A chefia precisa poder consertar
   chegada errada; bloquear a edição só empurraria o problema para outro canal.
2. **O corte é no pagamento, e só quando há duplicata de verdade.** Em
   `buildPaymentAllocationBoardModel` (`suppressSameDoctorDuplicateRows`,
   `services/board.service.ts`), passe final sobre todas as linhas do slot,
   titulares e extras:
   - agrupa linhas pagáveis por `doctorId`;
   - só age se as janelas de presença dentro do slot se sobrepõem por
     **≥ 60 min** (remanejo real no meio do turno, janelas encostadas, não é
     tocado);
   - vence a presença que começou primeiro (empate: ordem do alvo). A vencedora
     recebe o aviso `Tambem consta em <alvo> neste turno; pago so aqui.` e vai
     para `needs_review`;
   - a perdedora **não vai para o pagamento**: some da lista se o alvo já tem
     outro ocupante, ou vira alvo vazio com
     `Duplicado: <médico> ja e pago em <alvo> neste turno. Nao pago aqui.`
3. **Invariante coberto pelo CI**: `tests/payment-duplicate-guard.test.ts`
   afirma, sobre `buildPayableShiftsFromBoards`, que nenhum médico tem mais de
   um plantão pagável por slot nos cenários titular+titular, sombra+titular
   retroagido (caso Matheus), intervenção+regulação, sombra+sombra; e que P de
   24h (SD+SN), sombra legítima de outro médico e remanejo sem sobreposição
   **não** são cortados. `tests/payment-allocation.test.ts` cobre o mesmo caso
   na visão por alvo. Os dois rodam em `npm run test:deploy`.

## Consequences
- Pagamento em dobro por médico deixa de depender de revisão humana; o valor
  fica certo mesmo sem ninguém abrir a tela.
- O aviso na linha vencedora e o `needs_review` mantêm o caso visível para a
  chefia corrigir o horário de origem.
- Quem vence é decidido pelo horário de chegada registrado, não por "qual
  registro é verdadeiro". No caso Matheus o SD pago ficou no 2032 (o registro
  retroagido) e não no 2154 (a sombra real). O valor é o mesmo, um SD; o rótulo
  se conserta corrigindo o horário.
- Qualquer mudança em `suppressSameDoctorDuplicateRows`, no ranking do ADR-004
  ou nas linhas extra de sombra deve manter `payment-duplicate-guard.test.ts`
  verde. Relaxar essas asserções é decisão financeira, não técnica.
- `source` da ocupação continua `telegram` depois de uma correção. Para
  encontrar retroações use `audit_logs` (`previousStartedAt − startedAt ≥ 6h`),
  não `source`.

## Como verificar em produção (somente leitura)
Rodar `getChiefPayableShiftsBoard("YYYY-MM")` com `DATABASE_URL` pelo túnel
(`ssh -f -N -L 5433:127.0.0.1:5432 magalu`) acrescentando
`-cdefault_transaction_read_only=on` às `options` da connection string, e
agrupar `payableShifts` por `doctorId + slotStartedAt`. Qualquer grupo com mais
de um item é violação deste ADR.
