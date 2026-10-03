# Internos do GOA — do SkyRescue ao Painel sem segunda senha

Desde 03/10/2026. Internos de medicina que usam o SkyRescue (goa.mnrs.com.br)
com usuário nominal abrem o **Painel** do portal mnrs.com.br (Tabela, Destino,
Giro, Quadro informativo), **só leitura**, **de qualquer lugar**, sem digitar
outra senha. **A Mesa operacional fica de fora** (decisão de 03/10/2026: mais
fácil de explicar à coordenação e ao admin) — a conta não abre o app Plantões.
Substitui, para eles, a conta compartilhada `interno.samu@samu.local` (que
continua existindo, só Painel e só da Central).

## O caminho

```
SkyRescue (logado)          porteiro (mnrs.com.br/_auth)             plantões
──────────────────          ────────────────────────────             ────────
botão "Painel"
GET /api/auth/portal
  assina handoff 60 s ───►  GET /de/goa?token=…&proximo=tabela
  (GOA_FEDERACAO_SECRET)      confere assinatura, aud, prazo, jti
                              (uso único)
                              POST /api/servicos/portal/federado ──►  acha/cria a conta `interno`
                                (x-escala-token)               ◄──  vinculada ao id do GOA
                              emite mnrs_sso (corte da virada)
                              302 /tabela/ (ou o portal)
                              a cada pedido da Tabela/Quadro:
                              POST /api/servicos/portal/acesso ──►  conta ativa? portão de turno
                                                                     (interno passa de qualquer lugar)
```

A sessão do portal é como qualquer outra: conferida no plantões a cada
pedido, cai no corte da virada (07:15/19:15), suspender ou "encerrar sessões"
derruba.

## O papel `interno`

`modules/auth/contracts.ts` (`INTERNO_ROLE`, `ehSoInterno`). Fora de
`PLANTOES_ROLES`, como o `portal`: no app Plantões a conta é tratada como sem
papel — `/api/auth/sso` responde `sem-acesso`, sem sessão, sem Mesa.

| Onde | O que faz |
|---|---|
| App Plantões (`rolesDoPlantoes`) | não conta: sem sessão, sem Mesa, sem `/medico` |
| Portão de turno (`modules/acessos/portao.ts`) | libera Tabela e Quadro de qualquer lugar e fora do plantão (motivo `interno`), só para conta que é SÓ interno |
| Login por senha no portal (`authenticateWithPassword`, escopo `portal`) | recusado (`no_roles_assigned`): entra **só** pelo GOA |
| Porteiro (`internoDoGoa` em mnrs-portal) | vê Tabela, Destino, Giro e Quadro, só leitura (regra do Painel) |

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
na conta, com IP/aparelho repassados pelo porteiro; o uso da Tabela e do
Quadro segue como sessão `portal_cookie`, igual ao login do portal.

Para dar a Mesa um dia: tirar `interno` da exclusão em `PLANTOES_ROLES`, isentar
da presença (`contaNaMesa`), barrar a escrita da passagem de ocorrências e pôr
`plantoes` em `sistemasDaConta` do porteiro — foi assim na primeira versão do
PR #416.

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
   internos (`node scripts/acesso-portal.js <usuário> on`). Sem a chave, o
   botão não aparece.

Desligar em emergência: tirar `GOA_FEDERACAO_SECRET` do porteiro (ou do GOA)
e reiniciar — quem já tem sessão segue até o corte da virada; para cortar na
hora, suspender as contas `goa.*` em `/admin/acessos`.
