# Internos do GOA — do SkyRescue à Mesa sem segunda senha

Desde 03/10/2026. Internos de medicina que usam o SkyRescue (goa.mnrs.com.br)
com usuário nominal abrem a **Mesa operacional** daqui e o **Painel** do
portal (Tabela, Destino, Giro, Quadro informativo), **só leitura**, **de
qualquer lugar**, sem digitar outra senha. Substitui, para eles, a conta
compartilhada `interno.samu@samu.local` (que continua existindo, só Painel e
só da Central).

## O caminho

```
SkyRescue (logado)          porteiro (mnrs.com.br/_auth)             plantões
──────────────────          ────────────────────────────             ────────
botão "Mesa"
GET /api/auth/portal
  assina handoff 60 s ───►  GET /de/goa?token=…&proximo=plantoes
  (GOA_FEDERACAO_SECRET)      confere assinatura, aud, prazo, jti
                              (uso único)
                              POST /api/servicos/portal/federado ──►  acha/cria a conta `interno`
                                (x-escala-token)               ◄──  vinculada ao id do GOA
                              emite mnrs_sso (corte da virada)
                              302 /_auth/ir/plantoes
                              assina o handoff de sempre (sv) ───►  GET /api/auth/sso → cookie daqui
                                                                     → `/` (Mesa, só leitura)
```

Daí em diante a sessão do portal é como qualquer outra: conferida no
plantões a cada pedido (`/api/servicos/portal/acesso`), cai no corte da
virada (07:15/19:15), suspender ou "encerrar sessões" derruba.

## O papel `interno`

`modules/auth/contracts.ts` (`INTERNO_ROLE`, `ehSoInterno`). Vale só para conta
que é **só** interno — somado a médico/chefia não muda nada:

| Onde | O que faz |
|---|---|
| Portão de turno (`modules/acessos/portao.ts`) | libera Mesa, Tabela e Quadro de qualquer lugar e fora do plantão (motivo `interno`) |
| Presença na Mesa (`contaNaMesa`) | isento: só lê, não disputa a vez |
| Escrita na Mesa | toda escrita exige admin/chief; a passagem de ocorrências (que aceitava qualquer sessão) barra o interno com 403 |
| Login por senha (`authenticateWithPassword`) | recusado, aqui e no portal (`no_roles_assigned`): entra **só** pelo GOA |
| Porteiro (`internoDoGoa` em mnrs-portal) | vê Tabela, Destino, Giro, Quadro (leitura, regra do Painel) e o Plantões |

## Conta e vínculo

Tabela `identidades_federadas` (migrations `0060`/`0061`): `provedor = 'goa'`,
`sujeito` = `users.id` do SkyRescue, `user_id` daqui, `login`, `nome`,
`ultimo_uso_em`. Regras em `services/internos-goa.service.ts`:

- **Primeira vez**: nasce a conta `goa.<login>@samu.local` com papel `interno`,
  sem médico vinculado, senha aleatória que ninguém conhece, e o vínculo.
  Audit `interno_goa.created`.
- **Depois**: vale o vínculo (id do GOA), nunca o e-mail. Renomear o login lá
  não troca a conta daqui; o `nome`/`login` do vínculo acompanham.
- **Teto de privilégio**: só sai conta ativa e só interno. Se alguém der outro
  papel à conta, a via do GOA recusa (`papel_nao_permitido`) — quem administra
  o GOA não vira médico, chefia ou admin daqui.
- **E-mail ocupado**: nunca vincula a conta que já existia (`email_em_uso`,
  409). O admin resolve à mão.
- **Suspender**: `is_active = false` na conta daqui (ou suspender em
  `/admin/acessos`). O vínculo fica e o GOA não recria outra conta.
- **Quem pode**: o admin do GOA marca o usuário (`acesso_portal`), lá:
  `node scripts/acesso-portal.js <username> on|off` ou
  `PATCH /api/users/:id {acesso_portal}`. Sem a marca, o botão não aparece e a
  rota de lá responde 403.

Monitor de acessos: cada passagem vira evento `goa_entrou` (ou `goa_recusado`)
na conta, com IP/aparelho repassados pelo porteiro; o uso segue como sessão
`portal` e `portal_cookie`, igual ao login do portal.

## Contrato (para quem mexer nos outros repos)

**Handoff GOA → porteiro** (skyrescue `server/src/portal.js` → mnrs-portal
`lerHandoffGoa`): JWT HS256 com `GOA_FEDERACAO_SECRET` (só GOA e porteiro),
`{ tipo: "goa-handoff", origem: "goa", sub: "<id>", login, nome?, aud:
"mnrs-porteiro", iat, exp ≤ iat+60, jti }`. Tipo e aud próprios: nunca se
confunde com o handoff que o porteiro emite.

**Porteiro → plantões**: `POST /api/servicos/portal/federado`, header
`x-escala-token` (`ESCALA_SSO_TOKEN`), corpo `{ provedor: "goa", sujeito,
login, nome? }`. Resposta 200 no formato do `verificar-escala` (`email`,
`roles`, `sessionVersion`, `mustChangePassword: false`, …); recusas 403
`inactive_account`/`papel_nao_permitido`, 409 `email_em_uso`, 400
`login_invalido`.

## Ligar (ordem do deploy)

1. **plantões**: aplicar `0060_papel_interno.sql` e `0061_identidades_federadas.sql`
   no servidor (`npm run db:migrate` com `.env.production`) e só então
   mergear. Sem segredo novo aqui.
2. **porteiro**: `GOA_FEDERACAO_SECRET` (`openssl rand -hex 32`) em
   `~/porteiro/.env`, rsync e `pm2 restart porteiro`. Sem a chave, `/de/goa`
   responde 404.
3. **SkyRescue**: o mesmo valor em `GOA_FEDERACAO_SECRET` no `server/.env`,
   deploy (o `migrate.js` cria `users.acesso_portal`), restart, e marcar os
   internos. Sem a chave, o botão não aparece.

Desligar em emergência: tirar `GOA_FEDERACAO_SECRET` do porteiro (ou do GOA)
e reiniciar — quem já tem sessão segue até o corte da virada; para cortar na
hora, suspender as contas `goa.*` em `/admin/acessos`.
