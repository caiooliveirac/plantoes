# app/ — páginas e rotas

> Carregado sob demanda: só entra no contexto quando um arquivo desta pasta é lido. Índice na raiz: [CLAUDE.md](../CLAUDE.md)

**Páginas principais** (`app/`): `/` é a mesa operacional ao vivo (quadro de
regulação/intervenção); `/historico-operacional` e `/historico/turno-anterior` são
visões de auditoria; `/folha-ponto/[medicoId]/[ano]/[mes]` é o extrato individual
(acessível também sem login via token assinado, ver Autenticação); `/admin/*` reúne
telas de admin — `payment-allocation`, `payment-attestation` (+`/audit`),
`payment-closing`, `reports`, `bank-hours`, `chief-access`, `slot-audit`.

**API routes** (`app/api/`, todas sob Route Handlers, sem `middleware.ts`):
- `auth/*` — login, session, logout, change-password, password-reset
- `board/*` — `GET /api/board` (estado ao vivo), `board/stream` (Server-Sent Events),
  `board/history`, `board/payment-allocation`, `board/meal-breaks/priorities/[ramal]`
- `regulation/occupancies/*`, `intervention/occupancies/*`,
  `intervention/bases/[id]/state`, `regulation/posts/[id]/state` — CRUD de plantões e
  ativação/desativação de postos/bases
- `operational/*` — transferências e sistema de undo (`undo`, `undoable-actions`)
- `admin/*` — payment-closing (contracts, attestations, extra-shifts, bank-hours,
  meta), payment-attestation/slot, reports/export
- `chief/*` — invites, requests, review, bootstrap (onboarding de chefes)
- `telegram/webhook` — único ponto de entrada do bot
- `doctors/import`, `health`

