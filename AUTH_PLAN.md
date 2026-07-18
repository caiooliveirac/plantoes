# Plano de autenticacao e autorizacao

Este documento define o plano para a primeira evolucao real de autenticacao do sistema. O foco aqui nao e implementar todo o modulo administrativo, e sim criar uma base segura para dois perfis operacionais:

- `chief`: chefe de plantao
- `admin`: administrador operacional

O objetivo desta fase e permitir cadastro por convite, aprovacao manual e sessao autenticada com permissao por papel, sem abrir ainda a camada completa de historico financeiro, relatorios ou folha.

## Escopo desta fase

Entram agora no plano:

- acesso ao painel principal pela propria URL `/`
- ponto de login discreto e nao intrusivo sobre a view operacional
- login por email e senha
- convite por link gerado por admin
- convite com papel definido no momento da emissao: `chief` ou `admin`
- cadastro iniciado pelo convidado
- aprovacao manual pelo admin antes de liberar acesso
- sessao autenticada por cookie HTTP-only
- gates server-side por papel
- habilitacao de acoes operacionais no quadro quando houver sessao `chief` ou `admin`

Nao entram nesta fase:

- expiração automatica de convite
- recuperacao sofisticada de conta
- MFA
- permissao por base, regional ou unidade
- trilha financeira completa
- autosservico de medico comum sem papel administrativo

## Regra de negocio principal

O sistema nao tera cadastro publico.

O painel operacional continua publico em modo leitura na URL `/`.

O acesso nasce assim:

1. Um admin cria um convite.
2. O convite ja nasce com o papel desejado: `chief` ou `admin`.
3. O convidado abre o link e preenche o cadastro.
4. O cadastro fica pendente.
5. Um admin revisa manualmente e aprova ou rejeita.
6. So depois da aprovacao o usuario passa a autenticar e operar.

O link de convite nao precisa expirar automaticamente. O controle de veracidade sera humano, via aprovacao manual do admin.

## Entrada pelo painel em `/`

O usuario nao precisa ir para uma tela separada de login para descobrir o produto.

Decisao de UX:

- a URL `/` continua mostrando o quadro em leitura
- no canto da interface existe um controle pequeno e discreto de login
- esse controle nao pode competir visualmente com regulação e intervenção
- o estado deslogado preserva leitura do quadro, mas nao habilita alteracao
- apos login bem-sucedido, a mesma tela passa a expor as acoes operacionais permitidas

Implementacao recomendada:

- usar um botao pequeno em camada fixa, por exemplo canto superior direito ou canto inferior com `position: fixed`
- abrir painel leve de autenticacao por `popover`, `sheet` ou `drawer` curto
- evitar redirect para outra rota como fluxo primario

## Comportamento apos login de `chief`

Assim que um `chief` autenticar na propria home, ele passa a operar o quadro na mesma tela.

No recorte imediato descrito agora, isso habilita principalmente as acoes sobre medico em estado de verificacao ou aguardando noticia:

- informar que o medico saiu
- informar que o medico vai continuar
- corrigir horario ou nome quando necessario

Essas interacoes nao podem ficar apenas em estado de frontend. Precisam persistir em banco e refletir em leitura subsequente do board.

## Persistencia das acoes do quadro

O projeto ja tem uma base correta para isso: as rotas de ocupacao e correcao ja passam pelo servidor e gravam em banco.

Decisao:

- toda acao clicada pelo `chief` ou `admin` deve chamar rota server-side autenticada
- a rota grava em `regulation_occupancies` ou `intervention_occupancies`
- a interface apenas refaz o `router.refresh()` depois da confirmacao

### Acao "saiu"

Mapeamento recomendado:

- usar endpoint de encerramento da ocupacao
- persistir `endedAt` e `actualEndedAt`
- manter auditoria do ator que encerrou

### Acao "vai continuar"

Mapeamento recomendado:

- operar sobre a ocupacao ativa atual, nao apenas em estado local
- persistir essa continuidade como dado real do registro
- no modelo atual, a forma mais segura e marcar `shiftLabel = P` e registrar observacao operacional

Observacao:

- para regulacao, `P` ja interfere diretamente na regra de permanencia do quadro
- para intervencao, `P` pode inicialmente servir como sinal operacional e de auditoria, mesmo quando a permanencia visual continuar sendo guiada pela verificacao do turno

Se depois for necessario modelar continuidade com mais riqueza, isso pode virar um evento proprio. Nesta fase, nao precisa complicar.

## Perfis e fronteiras de permissao

### Chief

Poderes previstos desde a modelagem de auth:

- entrar no sistema
- editar nome exibido no quadro quando isso fizer parte do fluxo operacional
- corrigir horarios
- informar chegadas e saidas
- pedir relatorios operacionais do plantao

Saidas de relatorio previstas para fase posterior, mas ja guiando a autorizacao:

- PDF
- Markdown
- XLS
- DOC
- TXT

Restricoes do `chief`:

- nao acessa historico completo de toda a vida funcional de qualquer medico
- nao calcula folha completa, plano de pagamento, banco de horas global ou nota fiscal global de terceiros
- nao administra usuarios nem convites de outros admins

### Admin

Poderes previstos:

- tudo que o `chief` pode fazer, se a rota assim permitir por heranca de papel ou checagem explicita
- emitir convite com papel `chief` ou `admin`
- revisar e aprovar cadastro pendente
- desativar acesso
- consultar historico integral de um medico
- futuramente acionar relatorios financeiros e administrativos amplos

## Principio de autorizacao

Auth e role nao podem depender do frontend.

Toda acao sensivel deve ser protegida no servidor com `requireAuthenticatedSession()` e checagem explicita de papel. A UI pode esconder botoes, mas a autorizacao real fica no backend.

## Decisao importante para Next.js

Nao usar middleware como guarda principal de autorizacao operacional.

Motivo:

- middleware em Next.js tende a virar ponto frágil para auth baseada em cookie, cache e comportamento de edge
- a aplicacao ja depende de leitura dinamica de sessao e de banco
- regras de permissao aqui sao sensiveis demais para ficarem espalhadas entre middleware, client e server

Diretriz:

- leitura de sessao na home por server component
- guards por papel dentro de route handlers e server actions
- middleware, se existir no futuro, serve no maximo para ergonomia de navegacao e nunca como unica barreira de seguranca

## Reaproveitamento do estado atual

O projeto ja possui base util:

- tabela `users`
- tabela `user_roles` com `admin` e `chief`
- sessao por cookie assinado em `lib/auth/server.ts`
- tabela `chief_invites`
- tabela `chief_access_requests`

O problema e que a estrutura de convite ainda esta acoplada a `chief`. Como agora o convite pode gerar `chief` ou `admin`, o plano precisa generalizar essa camada.

## Decisao de arquitetura

Para nao quebrar o que existe, a evolucao deve ser incremental e compatível:

### Opcao recomendada

Generalizar a camada atual de convites e solicitacoes.

Mudancas de modelagem:

- `chief_invites` passa a representar convites de acesso administrativo
- `chief_access_requests` passa a representar pedidos de acesso administrativo
- adicionar papel desejado no convite
- adicionar papel aprovado no pedido, congelado a partir do convite

Idealmente, os nomes futuros das tabelas devem ficar neutros:

- `auth_invites`
- `auth_access_requests`

Mas para reduzir risco de migracao nesta primeira entrega, pode-se manter os nomes fisicos atuais e apenas generalizar semanticamente via novas colunas e services.

## Modelo de dados proposto

### Convite

Campos necessarios:

- `id`
- `token`
- `email` opcional
- `invite_mode`
- `target_role`: `chief` ou `admin`
- `invited_by_user_id`
- `used_at` opcional
- `revoked_at` opcional
- `created_at`

Decisoes:

- sem expiração automatica obrigatoria
- token de uso unico
- convite pode ser revogado manualmente
- se `email` vier preenchido, o cadastro precisa usar o mesmo email

### Solicitação de acesso

Campos necessarios:

- `id`
- `invite_id`
- `doctor_id`
- `requested_email`
- `password_hash`
- `status`: `pending`, `approved`, `rejected`
- `requested_role`
- `reviewed_by_user_id`
- `reviewed_at`
- `review_notes`
- `approved_user_id`
- `created_at`
- `updated_at`

Observacao importante:

- mesmo para `admin`, o usuario continua vinculado a um medico em `doctors`, porque isso preserva consistencia de identidade no dominio atual
- se depois houver admins nao medicos, isso vira uma fase posterior e deve ser tratado explicitamente

### Usuario e papeis

- `users` continua como credencial principal
- `user_roles` continua como tabela de papeis
- um mesmo usuario pode ter mais de um papel no futuro, mas nesta fase o fluxo de convite deve gerar exatamente um papel por convite

## Fluxos

### Fluxo 1. Admin emite convite

1. Admin autenticado cria convite.
2. Escolhe `target_role = chief` ou `target_role = admin`.
3. Sistema gera token e link.
4. Link pode ser compartilhado diretamente.
5. Convite pode ser revogado depois, se necessario.

### Fluxo 2. Convidado se cadastra

1. Convidado abre o link.
2. Sistema valida que o convite existe, nao foi usado e nao foi revogado.
3. Convidado informa:
   - medico correspondente
   - email
   - senha
   - dados de validacao definidos pela operacao
4. Sistema grava solicitacao com status `pending`.
5. Convite fica marcado como utilizado para impedir reaproveitamento bruto do link.

### Fluxo 3. Admin valida veracidade

1. Admin lista solicitacoes pendentes.
2. Confere identidade e legitimidade fora de banda, se necessario.
3. Aprova ou rejeita.
4. Se aprovar:
   - cria ou atualiza `users`
   - associa `doctor_id`
   - grava papel em `user_roles`
   - ativa conta
5. Se rejeitar:
   - cadastro permanece sem acesso
   - motivo fica registrado

### Fluxo 4. Login

1. Usuario aprovado faz login com email e senha.
2. Sistema valida credenciais.
3. Sistema emite cookie de sessao.
4. Requests server-side passam a ler roles do banco.

## Endpoints planejados

### Admin

- `POST /api/auth/invites`
  - cria convite com `targetRole`
- `GET /api/auth/invites`
  - lista convites
- `POST /api/auth/invites/[token]/revoke`
  - revoga convite
- `GET /api/auth/access-requests`
  - lista pedidos pendentes e historicos
- `POST /api/auth/access-requests/[id]/approve`
  - aprova pedido
- `POST /api/auth/access-requests/[id]/reject`
  - rejeita pedido

### Publico autenticavel por convite

- `GET /api/auth/invites/[token]`
  - valida convite e devolve metadados seguros, inclusive `targetRole`
- `POST /api/auth/register`
  - envia cadastro a partir de convite
- `POST /api/auth/login`
  - autentica usuario aprovado
- `POST /api/auth/logout`
  - limpa sessao
- `GET /api/auth/session`
  - devolve sessao atual

### Operacao no quadro apos login

Esses endpoints ja sao o alvo natural para persistencia operacional do `chief` e do `admin`:

- `POST /api/regulation/occupancies`
- `PATCH /api/regulation/occupancies/[id]`
- `POST /api/regulation/occupancies/[id]/end`
- `POST /api/intervention/occupancies`
- `PATCH /api/intervention/occupancies/[id]`
- `POST /api/intervention/occupancies/[id]/end`

O plano de auth deve preservar esse desenho: autenticacao libera operacao, mas operacao continua gravando por rotas especificas de dominio.

## Politica de sessao

Para esta fase, manter o modelo atual e suficiente:

- cookie HTTP-only
- `sameSite=lax`
- assinatura por `AUTH_SECRET`
- duracao curta, por exemplo 12 horas

## Senha temporaria e primeiro login

Para acessos bootstrap criados manualmente pela operacao:

- a senha inicial deve ser temporaria e aplicada fora do repositorio, por script com variavel de ambiente
- a conta deve nascer com `must_change_password = true`
- o usuario consegue autenticar, mas nao consegue operar o quadro ate trocar a senha
- a troca obrigatoria precisa acontecer na propria home, no fluxo discreto de login, sem depender de area administrativa separada
- o bloqueio precisa existir tambem no servidor, para impedir bypass por chamada direta de rota

Melhoria recomendada sem expandir demais o escopo:

- adicionar `session_version` no usuario no futuro para invalidacao manual global

## Gates de permissao iniciais

### Rotas exclusivas de admin

- criar convite
- revisar cadastro pendente
- revogar convite
- listar historico completo de usuarios e acessos

### Rotas de chief e admin

- operar quadro manualmente
- informar chegadas e saidas
- marcar continuidade de plantao
- corrigir horarios
- pedir relatorios operacionais do plantao

## Cuidados de infraestrutura

### Banco fora do container

Se a app Next.js estiver rodando dentro de container e o Postgres estiver fora dele, `localhost` nao pode ser usado como host do banco.

Diretriz:

- toda conexao deve sair de `DATABASE_URL`
- em ambiente containerizado, usar hostname roteavel a partir do container, por exemplo `host.docker.internal` quando essa estrategia estiver habilitada
- nao hardcodear `localhost` em auth, login, healthcheck ou services

### Sessao e runtime

- auth precisa rodar no runtime Node, nao em edge
- leitura e escrita de cookie ficam no servidor
- nao depender de estado de login apenas no client

### Cache e renderizacao

- a home autenticada deve continuar dinamica
- as respostas de sessao e operacao nao devem ser tratadas como estaticas
- depois de login, logout ou acao operacional, a tela deve revalidar pelo servidor

## Auditoria minima obrigatoria

Toda acao abaixo deve gerar log:

- convite criado
- convite revogado
- cadastro submetido
- cadastro aprovado
- cadastro rejeitado
- login bem-sucedido
- login negado
- logout

Isso precisa cair em dominio `auth` da auditoria existente.

## Plano de implementacao

### Etapa 1. Generalizar a modelagem atual

- adicionar `target_role` em convites
- adicionar `requested_role` em solicitacoes
- permitir convite sem `expires_at` ou parar de depender dele na validacao
- adicionar `revoked_at`
- revisar services hoje acoplados a `chief`

### Etapa 2. Fechar o fluxo de aprovacao admin

- tela ou endpoint de emissao de convite
- tela ou endpoint de revisao de cadastro pendente
- aprovacao com criacao de `users` + `user_roles`

### Etapa 3. Consolidar login

- endpoint de login por email e senha
- sessao lida em server components e rotas
- guards reutilizaveis por papel
- entrada de login discreta na `/`, sem deslocar a operacao para outra pagina

### Etapa 4. Proteger o produto

- restringir rotas sensiveis por `admin` ou `chief`
- garantir que leitura historica total fique reservada a `admin`
- habilitar no quadro as acoes persistidas de `continuar` e `saiu` para cards elegiveis

## Criterios de aceite

Esta fase estara pronta quando:

1. Um admin conseguir gerar um link de convite com papel definido.
2. O convidado conseguir abrir o link e submeter cadastro.
3. O cadastro ficar pendente sem liberar acesso imediato.
4. Um admin conseguir aprovar manualmente.
5. So apos aprovacao o usuario conseguir logar.
6. Um `chief` autenticado nao conseguir acessar rotas exclusivas de `admin`.
7. Um `admin` autenticado conseguir revisar convites, solicitacoes e historico amplo.
8. O quadro em `/` continuar utilizavel em leitura mesmo sem login.
9. Apos login de `chief`, acoes de `saiu` e `continuar` gravarem em banco e reaparecerem corretamente no board.

## Riscos e cuidados

- o schema atual esta nomeado como `chief_*`, mas a regra agora e mais ampla; misturar sem documentar vai gerar acoplamento conceitual ruim
- convite sem expiracao aumenta necessidade de revogacao manual e auditoria clara
- `admin` com acesso a historico total exige cuidado extremo em logs e futuras exportacoes
- se o papel for lido apenas no frontend, a autorizacao ficara falsa; os gates precisam ser server-side

## Decisao pragmatica recomendada

Para a proxima implementacao, seguir o menor caminho seguro:

1. manter sessao por cookie assinado
2. generalizar convites atuais para aceitarem `chief` e `admin`
3. deixar aprovacao sempre manual por admin
4. proteger tudo no servidor por papel
5. adiar escopos mais finos e expiracao automatica

Esse caminho entrega o que voce descreveu sem reabrir o dominio inteiro agora.