# lib/auth/ — autenticação e papéis

> Carregado sob demanda: só entra no contexto quando um arquivo desta pasta é lido. Índice na raiz: [CLAUDE.md](../../CLAUDE.md)


Autenticação **customizada**, não usa NextAuth apesar da dependência estar instalada:

- **Sessão**: cookie HTTP-only `operations_v2_session`, TTL padrão 12h, `secure` só
  em produção. Token é JWT simplificado (`{ sub: userId, exp }`) assinado com HMAC-SHA256
  usando `AUTH_SECRET`, verificação timing-safe. Implementação em
  [lib/auth/token.ts](token.ts) e [lib/auth/server.ts](server.ts).
- **Login**: `POST /api/auth/login` (email+senha, bcrypt) em
  [app/api/auth/login/route.ts](../../app/api/auth/login/route.ts), lógica em
  [services/auth.service.ts](../../services/auth.service.ts). Trata contas inativas, sem
  role atribuída, e o fluxo de `chiefAccessRequests` pendente/rejeitado.
- **Papéis**: apenas dois — `admin` e `chief` (enum `userRoleEnum`, tabela
  `userRoles`, many-to-many). Não há role "médico comum" nem "coordenador" como
  conceito formal do sistema — controle mais granular é feito por checagem manual em
  cada rota, não por um role dedicado.
- **Controle de acesso**: **não há `middleware.ts`**. Cada Server Component/Route
  Handler chama `requireAuthenticatedSession(requiredRoles?)` explicitamente (ex.:
  `requireAuthenticatedSession(["admin"])` nas rotas `/admin/*` e `/api/chief/*`).
- **Exceção**: a folha de ponto individual (`/folha-ponto/[medicoId]/[ano]/[mes]`)
  aceita acesso **sem login** via token assinado com validade de 7 dias
  ([lib/folha-ponto/token.ts](../folha-ponto/token.ts)), enviado ao médico no
  privado do bot do Telegram.
- **Telegram ↔ usuário**: sem vínculo formal no banco. Operacional (chegada/saída) é
  resolvido por nome (fuzzy match); admin/chief no bot são reconhecidos por
  `TELEGRAM_ADMIN_IDS`/`TELEGRAM_CHIEF_IDS` no `.env`; acesso a pagamento usa
  codinome com HMAC (`doctorPaymentAccess`), não o ID do Telegram.
- Webhook do bot ([app/api/telegram/webhook/route.ts](../../app/api/telegram/webhook/route.ts))
  valida `x-telegram-bot-api-secret-token` contra `TELEGRAM_WEBHOOK_SECRET` (fallback
  `AUTH_SECRET`).

