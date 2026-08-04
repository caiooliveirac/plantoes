# Estudo do fluxo de continuidade — cenários × consumidores (ago/2026)

Estudo sênior pós-incidente de 03/08/2026 (plantonistas de P sumindo do painel
e da divisão do jantar após "continua"; corrigido no commit `87131fd`).
Três auditorias independentes (entradas de continuidade; banco de horas +
pagamento; painel + refeições + relatórios), com as alegações críticas
re-verificadas no código. Nada aqui é suposição: cada risco tem arquivo:linha.

## O modelo (como deveria funcionar)

- Uma **cadeia** de continuidade = `continuity_group_id`. Cada bloco de turno é
  uma linha em `regulation_occupancies`/`intervention_occupancies`.
- `board_started_at` = chegada original da cadeia (painel, prioridade).
  `started_at` = início do bloco corrente. `scheduled_start/end_at` = janela do
  bloco (auto-close, pagamento). `shift_label` = bloco (SD/SN) — "P" é reservado
  à linha única estendida in-place (`continueRegulationOccupancy`).
- Continuação explícita ("continua") referencia a virada mais próxima
  (`resolveContinuationReferenceBoundary`) e abre o bloco SEGUINTE
  (`resolveTelegramExplicitContinuationBlock`, pós-87131fd).
- **Banco de horas**: 1 entry por cadeia (`syncBankHoursByContinuityGroup`);
  atraso medido no primeiro membro, saída no último; miolo invisível.
- **Pagamento**: slot de 12h × alvo; linha paga o slot que casa com
  `logicalSlotStart`; rótulo "P" (e só ele) paga também o slot seguinte
  (`doesCandidateCoverPaymentSlot`, teto 24h).

## Matriz cenário × consumidor (estado atual)

| Cenário | Painel | Jantar/almoço | Banco de horas | Pagamento | Prior. saída / relatórios |
|---|---|---|---|---|---|
| P estendido in-place (fonte ativa, mesmo posto) | ✅ | ✅ (1h de jantar) | ✅ | ✅ SD+SN | ✅ |
| Continuação explícita pós-fix (bloco SN novo, board 06:41) | ✅ mostra 06:41 | entra ✅, mas jantar de **meia hora** (R8) e **só se roster ainda não montado** (R3) | ✅ sem dupla contagem | ✅ sem slot duplo | ❌ tratado como chegada 19:00 (R4); saída do SD sem "CONTINUA" (R9) |
| Cross-target/cross-domínio (started = hora da mensagem) | ✅ | idem acima | ⚠️ buraco declarado vira crédito (R5) | ⚠️ slot inteiro com presença parcial (R5) | ❌ corte de 4h usa started 20:02 (R4) |
| Rendido que "continua" no MESMO posto | ❌ **derruba o rendedor** (takeover forçado, R2) | — | — | — | — |
| Rendido que "continua" em outro posto (muito depois) | ✅ vincula certo | ✅ | ⚠️ gap creditado (R5) | ⚠️ | ❌ (R4) |
| Continuação implícita (rótulo P / troca SD↔SN sem "continua") | ⚠️ sem o guard de janela vencida (R6) | | | | |
| "Continua" em outra função | função antiga mantida in-place; cross-target sobrescreve sem trilha (R10) | | meio-plantão emendado contamina cadeia (R11) | meio→bloco cheio se não repetir "meio" (R11) | |
| Dado legado pré-fix (label SN, janela SD; fantasmas de 03/08) | ❌ auto-close falso às 19:00 (R1) | ❌ | ❌ pode **apagar banco da cadeia** (R1) | ✅ protegido | — |

## Riscos priorizados

### P0 — perde dinheiro/hora ou derruba gente agora

1. **Dados legados pré-fix seguem tóxicos.**
   (a) Fantasmas de 03/08 (SD 06:41→19:15 criadas 19:24, 3× no mesmo grupo) não
   são zero-duration → passam pelos filtros e entram no `isClosed` da cadeia:
   `syncBankHoursByContinuityGroup` **apaga a entry antes de validar** e retorna
   null (`modules/bank-hours/service.ts:165-194`) → banco de horas da cadeia
   some retroativamente, sem alerta (`modules/bank-hours/continuity.ts:77-87,175`).
   (b) Linhas com rótulo/janela trocados levam auto-close falso com
   `actual_ended_at` fabricado (`modules/regulation/service.ts:970-974`).
   **Ação**: saneamento dos dados (existe `scripts/repair-continuation-collateral.ts`)
   + inverter a ordem delete/validate no sync + filtro de fantasma por
   `created_at ≫ started_at`.
2. **Rendido que manda "continua" no MESMO posto derruba o rendedor.**
   Qualquer `arrival_conflicts_with_active_occupancy` + `isContinuation` vira
   takeover forçado sem checar se o ocupante atual é o sucessor recém-chegado
   (`modules/telegram/service.ts:1861-1868` + 8800-8835/9082-9117). Cenário: A
   rendido 07:05 manda "continuando 2032" 07:30 → B é fechado e A reinstalado.
   **Ação**: no conflito com continuação, se o ocupante começou DEPOIS do fim da
   fonte do continuador, responder "posto já rendido — confirme com a chefia"
   em vez de takeover.
3. **Retardatário não entra na divisão do jantar já montada.** Roster é
   snapshot; continuação declarada depois do `/jantar` fica fora até a chefia
   editar o ramal ou `/jantar reiniciar` (`modules/telegram/meal-breaks.ts:5041-5069`,
   reconcile 2277-2313 só atualiza quem já está). Foi metade do incidente de 03/08.
   **Ação**: ao registrar continuação/chegada de regulação com sessão ativa do
   turno, chamar `ensureMealBreakDoctorInSession` automaticamente.
4. **Prioridade de saída ignora a cadeia.** `departure-priority.ts` rankeia por
   `row.startedAt` e reconhece continuidade só por `shiftLabel === "P"`
   (250-262, 289-305): quem dobra desde 06:41 no bloco SN novo é tratado como
   chegada 19:00 (perde prioridade) e no cross-target pode ficar FORA do
   ranking pelo corte de 4h. A migração P→blocos encadeados inverteu a justiça.
   **Ação**: usar `boardStartedAt ?? startedAt` (âncora da cadeia) para tenure
   e ordenação.

### P1 — dinheiro/registro sutilmente errado

5. **Miolo da cadeia é invisível para banco e pagamento.** Buraco declarado
   (rendido 18:30 → continua 21:00) não é debitado (atraso só no primeiro
   membro: `modules/bank-hours/calculator.ts:48-49`, span em
   `continuity.ts:153-177`) e o slot é pago inteiro com presença parcial
   (cobertura só rebaixa score: `services/board.service.ts:2695-2723`).
   **Decisão de produto**: aceitar (tolerância operacional) ou debitar
   gap/pró-rata. Hoje é crédito silencioso.
6. **Ramo implícito sem o guard de janela vencida.** O erro-alto pós-87131fd
   exige `parsed.isContinuation`; continuidade implícita (rótulo "P" ou troca
   SD↔SN sem a palavra) ainda pode herdar âncora/rótulo de bloco vencido
   (`modules/telegram/service.ts:8752-8754`, guards 8842-8849/9123-9130).
   **Ação**: estender `resolveTelegramExplicitContinuationBlock` + guard ao
   ramo implícito.
7. **Rótulo "P" legado ainda é alavanca de pagamento duplo.** O fix vale só
   para ingest novo; linha histórica "P" numa cadeia paga o slot seguinte
   (`doesCandidateCoverPaymentSlot`, `board.service.ts:2624-2650`) — classe do
   caso Ana Beatriz 31/07. **Ação**: auditoria pontual das linhas "P" com
   continuação no período pago.
8. **Jantar de 1h perdido.** `resolveNightDinnerDuration` dá 1h só a
   `shiftLabel === "P"` (`meal-breaks.ts:1117-1126`); o bloco SN de continuação
   (quem mais precisa — dobra desde a manhã) ganha meia hora. **Ação**: decidir
   por âncora da cadeia (`arrivalStartedAt` em turno SD), não por rótulo.
9. **"CONTINUA" sumiu dos relatórios de saída.** `continuesBeyondShift` exige
   `sourceShiftLabel === "P"` (`board.service.ts:3068-3069`); cadeia explícita
   imprime "saiu 19:00" no relatório do SD sem 🔁 (`departure-report.ts:128,166-176`).
   **Ação**: considerar sucessor na mesma cadeia como "continua".
10. **Sombra × continuidade.** Fonte ativa não filtra sombra
    (`telegram/service.ts:1259-1294,1334`) e chegada-sombra pode consumir
    continuidade e fechar a titular do médico (8687-8711 sem guard de
    `isShadowArrival`). **Ação**: excluir sombras da seleção de fonte e do
    fechamento em lote.

### P2 — arestas e higiene

11. **Meio-plantão**: continuação cross-target perde a proteção das 17:00 se
    não repetir "meio" (roleLabel novo em 8785); `shouldAssumeTelegramHalfShift`
    ignora `shiftType` recebido (948-959); auto-checkout das 17:00 atropela
    continuação declarada (deliberado — `reminders.ts:1225-1256`).
12. **Sem rota `/continue` de regulação na UI** (só intervenção:
    `app/api/intervention/occupancies/[id]/continue/route.ts`); correção manual
    não aplica a regra da fronteira.
13. **Botão revert P→SN não valida autor** (qualquer membro do grupo, 2 min —
    `telegram/service.ts:12083-12189`).
14. **Transfer clona `scheduled_end_at` possivelmente vencido**
    (`corrections.ts:573-640`) — candidata a auto-close silencioso no destino.
15. **Textos do Telegram mostram `startedAt` (19:00) onde o painel mostra
    06:41** (`reminders.ts:322,776-777`; `shift-report.ts:150,177`) — cosmético,
    mas gera desconfiança dos médicos.
16. **`closeTelegramActiveContinuityOccupancies` fecha com `actualEndedAt`**
    (não handoff) e o skip de <60s pode deixar duplicata ativa
    (`telegram/service.ts:1516-1551`).

## O que já está certo (não mexer sem motivo)

- Painel exibe `board_started_at`; todas as variantes vivas aparecem no turno.
- Banco de horas: 1 entry por cadeia (delete-all + insert) — sem dupla contagem
  estrutural; overlap 19:00–19:15 pós-fix é inócuo.
- Pagamento: dedup por médico/alvo/slot + teto de 24h do "P" + guard de
  backdated — sem pagamento duplo nos cenários novos.
- Roster de refeições usa a âncora da cadeia na fila de prioridade.

## Ordem sugerida de ataque

1. Saneamento dos dados legados (repair script + verificação das cadeias de
   03/08) — destrava banco de horas já hoje. Exige aprovação (escrita em prod).
2. P0.2 (takeover do rendedor) e P0.3 (jantar automático) — pequenos, alto
   impacto operacional, testáveis por unidade.
3. P0.4 (prioridade de saída pela âncora) — uma função, muitos beneficiados.
4. P1.6 (guard no ramo implícito) — fecha a classe inteira do bug de 03/08.
5. P1.5/7/8/9 conforme decisão de produto.
