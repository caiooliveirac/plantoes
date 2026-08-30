# Migração do bot do checklist para o bot dos Plantões

**Objetivo:** desativar o `@samu_checklists_bot` (repo `checklist`) e concentrar
toda a interação Telegram no bot dos Plantões — que conhece o quadro e sabe quem
é o médico. O app web `checklist.mnrs.com.br` e o banco dele **ficam**: só a
camada Telegram muda de casa. Decisão da coordenação em 2026-08-30.

## Estado (lado plantoes — este repo)

| Peça | Status | Onde |
| --- | --- | --- |
| `/chave` (médico, privado/grupo, deep link `?start=chave`) | ✅ pronto e ativo | `modules/telegram/checklist-key*.ts` |
| Chave nas confirmações de chegada/remanejamento (bot e quadro web) | ✅ pronto e ativo | `checklist-key.ts`, `reassignment-alert.ts` |
| Menu `/checklist` (status, pendentes, faltas, obs, unidade, material, sumidos) | ✅ pronto — degrada didático até os endpoints existirem | `modules/telegram/checklist-menu.ts` + handlers no `service.ts` |
| Digest 11h/13h pelos Plantões | ✅ pronto — **desligado** por `CHECKLIST_DIGEST_ENABLED` | `modules/telegram/checklist-digest.ts` |
| Aviso imediato de conclusão + foto de inconformidade | ❌ ainda no bot checklist | fase 3 abaixo |

## Contrato: endpoints internos a criar no repo `checklist`

Mesmo padrão do `/api/internal/keys/:code` já existente: header
`x-internal-token` conferido contra `config.internalToken`; 401 sem ele. Os
endpoints de texto devolvem `{ ok: true, text }` com **HTML do Telegram já
renderizado** (a compilação continua no repo checklist, junto do dado — as
funções `collectDigestData`/`renderDigestMessage`, `textPendentes`,
`textFaltas`, `textObservacoes`, `textUnidade`, `materialHistoryText`,
`recentMissing`/`missingSummaryText` de `server/src/bot.ts`, `digest.ts` e
`history.ts` são exatamente o corpo de cada rota). Texto ≤ ~3900 chars (o
plantoes trunca defensivamente).

```
GET /api/internal/menu/status               → { ok, text }   renderDigestMessage(collectDigestData(), "consulta HH:mm")
GET /api/internal/menu/pendentes            → { ok, text }   textPendentes()
GET /api/internal/menu/faltas               → { ok, text }   textFaltas()
GET /api/internal/menu/obs                  → { ok, text }   textObservacoes()
GET /api/internal/menu/unit/:code           → { ok, text }   textUnidade(code)         · 404 base desconhecida
GET /api/internal/menu/material/:code/:key  → { ok, text }   materialHistoryText(...)  · 404 item/base desconhecidos
GET /api/internal/menu/sumidos/:code        → { ok, text, missing: [{ key, label }] }
                                              missingSummaryText + recentMissing(code) · 404 base desconhecida
GET /api/internal/menu/units                → { ok, day, units: [{ code, done }] }     board + latestByBase (grade de botões)
GET /api/internal/menu/materials            → { ok, materials: [{ key, label }] }      materialButtons() (keys tipo g5i2 — cabem no callback_data)
```

O plantoes trata: 404 → "alvo desconhecido"; demais erros/timeout (4s) →
"app fora do ar ou endpoints ainda não publicados"; sem
`CHECKLIST_API_URL`/`CHECKLIST_INTERNAL_TOKEN` → "integração não configurada".
Nunca silêncio.

## Fases de virada

1. **Menu (fase 1)** — publicar os endpoints acima no repo `checklist`. O
   `/checklist` daqui liga sozinho (o cliente já aponta para eles). Depois,
   no repo checklist: trocar as respostas do bot antigo por um redirect curto
   ("agora é no bot dos Plantões: /chave e /checklist") — o `guard`/fallback de
   `server/src/bot.ts` é o lugar.
2. **Digest (fase 2)** — desligar o croner de 11h/13h no `server/src/index.ts`
   do checklist e ligar `CHECKLIST_DIGEST_ENABLED=1` no `.env.production` daqui
   (worker manda para os `TELEGRAM_ADMIN_IDS`, dedupe por
   `telegram_bot_notices`). Não ligar antes de desligar lá: sai em dobro.
3. **Avisos imediatos (fase 3 — o que falta construir)** — conclusão de
   checklist e inconformidade **com foto** nascem no servidor do checklist
   (`notifySubmission`/`notifyNonconformity`). Para o bot dos Plantões assumir:
   feed `GET /api/internal/notices?after=<id>` no checklist + poller no worker
   daqui + `sendPhoto` multipart no `modules/telegram/api.ts` (hoje só há
   sendMessage). Até lá o bot checklist continua vivo SÓ para esses avisos.
4. **Desativação** — com as três fases viradas: `BOT_MODE=disabled` no
   `.deploy-env` do checklist (flag já existe, o canary usa), aposentando também
   o `/admin <código>`/`bot_chats` (destinatários passam a ser os
   `TELEGRAM_ADMIN_IDS` daqui). A mensagem de erro de chave inválida no
   `POST /api/submissions` do checklist ainda cita o bot antigo — trocar por
   "/chave no bot dos Plantões" nessa hora.

## Gating e auditoria no lado plantoes

- `/checklist` e os botões `clm:*` são de **coordenação** (admin/chefia via
  `resolveTelegramCommandActor`). Médico comum no privado é redirecionado ao
  `/chave`; no grupo, silêncio (mesmo comportamento do bot antigo).
- `/chave` é aberto a todos; pedidos no privado avisam os admins
  (`checklist-key-request.ts`).
