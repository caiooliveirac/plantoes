# Unificação dos apps SAMU em escala.mnrs.com.br — avaliação e plano

> Escrito em 2026-08-30 a partir da leitura dos repos `plantoes`,
> `escalas-e-trocas-samu` e da configuração de produção documentada nos dois.
> Responde à pergunta: "existe como migrar tudo para dentro de
> escala.mnrs.com.br — um site só, uma conta só, um visual só?"
>
> ⚠️ **Leia o [Adendo (§8)](#8-adendo-o-kairós-responde-as-decisões-em-aberto)
> antes de agir sobre as fases.** Após a escrita deste documento, a leitura do
> repo `kairos` mostrou que três recomendações daqui já foram decididas —
> melhor e por ADR — naquele projeto: o teto é `mnrs.com.br` (não
> `escala.mnrs.com.br`), o provedor de identidade é o Kairós (não o escala) e
> a URL única vem por absorção, não por `basePath`. O inventário (§1–§2) e os
> alertas (§5–§6) continuam válidos.

**Resposta curta: sim, existe — e boa parte das peças já está construída.**
O caminho recomendado **não** é fundir os codebases num app único de uma vez,
e sim unificar em camadas o que o usuário sente (URL, conta, visual, cadastro),
mantendo os serviços separados por trás. O próprio histórico do repo aponta
nessa direção: a migration `0037_drop_escala_trocas_orfaos.sql` removeu uma
segunda implementação de escala/trocas que viveu dentro do plantões e nunca foi
usada — a decisão registrada ali é "cada produto no seu app, integrados por
API". O que falta não é reescrever, é **costurar**.

## 1. O que existe hoje

Todos no mesmo servidor (magalu), atrás do mesmo nginx:

| App | URL | Processo | Porta | Banco | Auth | Bot |
| --- | --- | --- | --- | --- | --- | --- |
| plantões (este repo) | plantoes.mnrs.com.br | PM2 (`plantoes` + worker) | 3004 | Postgres do host, schema `operations_v2`, 18 tabelas relacionais | cookie `operations_v2_session`, JWT HMAC próprio, roles `admin`/`chief`/`doctor`/`payment_closing_limited` | "Plantões SAMU" (Telegram, grupo da escala) |
| escala (`escalas-e-trocas-samu`) | escala.mnrs.com.br | Docker (imagem GHCR) | 3040 | Postgres 17 próprio em container; domínio em JSONB versionado (`estado`) + `trilha`/`contas`/`cadastros` | cookie `escala_sessao`, JWT (jose HS256), RBAC 4 níveis, convites + senha temporária | sem Telegram; WhatsApp (Twilio + gateway whatsmeow, 2 grupos + mural) |
| tabela | mnrs.com.br/tabela | (repo `tabela`) | 3001 | próprio | PIN da chefia | bot regulador (Telegram, grupo dos reguladores) |
| checklist | checklist.mnrs.com.br | (repo `checklist`) | — | próprio | — | @samu_checklists_bot |

As duas dores que motivam a pergunta estão confirmadas no código:

- **Cadastro duplicado e junção frágil.** O mesmo médico existe em
  `doctors` (plantões) e no cadastro do escala, unidos por *nome normalizado*
  com normalizadores divergentes e tolerância de 1 letra
  (`lib/auth/plantoes.ts` do escala: BOMFIM/BONFIM, FARIA/FARIAS…), refeita a
  cada login. Homônimo = acesso recusado. Não há ID persistente cruzado.
- **Duas contas, duas senhas, dois visuais.** Cada app tem sessão, cookie,
  telas de senha e paleta próprios (dark glass legado × Kairós em migração).

## 2. O que já está pronto e joga a favor

1. **Login do escala com a senha do plantões — já em produção.**
   `POST /api/auth/verificar-escala` (aqui) + `lib/auth/plantoes.ts` (lá),
   portão `ESCALA_SSO_TOKEN`/`PLANTOES_AUTH_TOKEN`. Metade do problema de
   "cadastrar num, usar no outro" já foi resolvida nessa direção.
2. **Federação com handoff assinado — já implementada no escala.**
   `lib/servidor/federacao.ts`: `ESCALA_SERVICOS` declara as instalações,
   `GET /api/auth/handoff?para=<id>` → `/api/auth/sso?token=<jwt 60s>` emite a
   sessão local do destino sem senha, com provisionamento JIT de admins e
   régua anti open-redirect. Foi desenhada para escala↔UPA, mas o mecanismo é
   exatamente o que o plantões precisa para aceitar quem já está logado no
   escala.
3. **Design system Kairós — já existe e tem guia de adoção incremental.**
   `docs/handoff-kairos/` no escala (tokens claro+escuro em `tokens-cores.css`,
   `INTEGRACAO.md`, migração tela a tela via `.pagina-kairos`). Unificar o
   visual = adotar os mesmos tokens aqui, página por página.
4. **Contratos de dados com dono definido.** O escala mantém
   `docs/DADOS-E-DONOS.md`; já consome daqui `/api/medicos/nomes` e a
   verificação de credencial, e expõe `/api/esperados` (consumido por
   `modules/operational/expected-schedule.ts` para o "aguardando fulano" e a
   chegada×escala nível A). A malha de APIs entre os dois já é bidirecional.
5. **Roteamento por path já é praticado nesta infra**: o tabela vive em
   `mnrs.com.br/tabela`. Servir apps sob subcaminhos do mesmo domínio não é
   novidade no nginx do magalu.

## 3. Recomendação de arquitetura

**"Um site, vários serviços"** (strangler fig): `escala.mnrs.com.br` vira a
porta de entrada única — casca comum (topo com navegação entre módulos, conta,
perfil) — e cada app continua um processo/banco separado servido sob um
subcaminho. A conta passa a ter um dono único; o visual converge para o Kairós;
o cadastro ganha ID cruzado persistente. Fundir codebases/bancos fica como
evolução opcional, módulo a módulo, só onde houver ganho real.

Por que não fundir tudo num app agora:

- Os modelos de persistência são deliberadamente diferentes (relacional
  18-tabelas × documento JSONB + reducer). Fundir é reescrever um dos lados.
- Os dois estão em operação 24/7 (SAMU 192). O risco de uma fusão big-bang é
  desproporcional ao ganho — o usuário final não distingue "um app" de "um
  site com sessão única e visual único".
- O precedente interno (0037) mostra que a segunda implementação dentro de um
  app só gera órfão.

## 4. Plano em fases

### Fase 0 — Costurar identidade e cadastro (sem mudar URL; dias)

1. **SSO no sentido que falta (escala → plantões).** Registrar o plantões como
   serviço federado no modelo do escala e criar aqui `GET /api/auth/sso` que
   valida o token de handoff (`aud` = plantões) e emite o cookie
   `operations_v2_session` para o usuário correspondente. Preferir um segredo
   de federação dedicado (ex.: `FEDERACAO_SECRET` idêntico nos dois) a
   compartilhar o `AUTH_SECRET` de sessão — mesmo efeito, raio de explosão
   menor. Resultado imediato: logado num, entra no outro com um clique.
2. **Mapeamento persistente de IDs.** Rodar o match por nome UMA vez, gravar
   `escalaProfissionalId` ↔ `doctorId` (aqui cabe em `doctors.metadata` ou
   coluna própria; lá, no cadastro), e passar as integrações a usar o ID.
   Não-casados viram lista de exceção para resolver à mão. Isso aposenta o
   fuzzy match por login e destrava tudo que vem depois.

### Fase 1 — Domínio único (o pedido central; ~1–2 semanas com validação)

1. **nginx**: `escala.mnrs.com.br/` continua no escala (3040);
   `escala.mnrs.com.br/plantoes/` → 3004. `plantoes.mnrs.com.br` passa a
   redirecionar 301 para o caminho novo (manter o vhost por meses — links de
   folha de ponto, mensagens antigas do bot e favoritos sobrevivem).
2. **plantões sob `basePath: "/plantoes"`** (`next.config.ts`). Custo mapeado:
   - ~38 chamadas client-side `fetch("/api/…")` em ~20 arquivos que **não**
     ganham o prefixo automaticamente — resolver com um helper único
     (`apiUrl()`) ou caminhos relativos;
   - `AUTH_URL` e as URLs absolutas emitidas fora do site: links do bot
     (folha de ponto, quadro), e-mail de reset, `metadataBase`;
   - re-registrar o webhook do Telegram na URL nova (`setWebhook`);
   - validar o SSE (`/api/board/stream`) e os healthchecks sob o subcaminho.
3. **Cookies no mesmo host** (nomes distintos, sem colisão). O handoff da
   Fase 0 pode então virar transparente: sem sessão local mas com a do irmão →
   redirect interno emite a sessão e o usuário nem vê tela de login.

Opcional nesta fase: `escala.mnrs.com.br/tabela` → 3001, trazendo o painel de
vagas para o mesmo teto.

> Nota de nome: o pedido foi "tudo dentro de escala.mnrs.com.br" e o plano
> entrega isso. Se um dia fizer sentido um nome neutro (ex.:
> `samu.mnrs.com.br`) por abrigar coisas que não são escala, a mudança vira
> barata depois desta fase: um vhost novo + os mesmos redirects.

### Fase 2 — Conta única (1–2 semanas, com migração cuidadosa)

- **Eleger o escala como dono da conta (IdP).** É o lado multicategoria
  (medicina, enfermagem, técnicos, condução), com convites, senha temporária,
  bloqueio por tentativas e RBAC de 4 níveis — o plantões só conhece médicos e
  admins. O plantões vira "cliente": aceita a sessão federada e mantém apenas
  a autorização local (quem é admin/chief AQUI continua decisão daqui, como a
  federação do escala já faz — perfil não atravessa).
- Migrar as contas `admin`/`chief` do plantões para o escala (são poucas) e
  apontar o fluxo de senha/reset/perfil para um lugar só (`/perfil` do escala).
  O caminho "login com senha do plantões" continua como ponte durante a
  transição e é desligável por env, como hoje.
- Só então avaliar aposentar `users`/`passwordResetTokens` daqui — sem pressa;
  conviver não dói depois que o usuário não os vê mais.

### Fase 3 — Visual único (progressivo, sem data de corte)

- Portar os tokens do Kairós (`docs/handoff-kairos/tokens-cores.css`) para o
  plantões e migrar tela a tela com o mesmo mecanismo `.pagina-kairos` que o
  escala já usa para conviver com o legado dark glass.
- Extrair a **casca comum** (topo com o seletor de serviços da federação,
  conta, avatar) — pode ser copiada nos dois apps num primeiro momento;
  pacote compartilhado é otimização posterior.

### Fase 4 — Cadastro único e bots (decisões de produto; por último)

- **Cadastro**: com o ID cruzado da Fase 0 estável, promover um dono único por
  dado (na linha do `DADOS-E-DONOS.md`): pessoas/categorias no escala;
  contratos, financeiro e ponto continuam do plantões. Sincronização por API
  com token, como as integrações atuais.
- **Bots**: a segmentação por grupo é feature (grupo da escala ≠ grupo dos
  reguladores ≠ checklists), então "um bot só" é decisão de produto, não
  técnica. Tecnicamente é viável (um token, um webhook no domínio novo,
  roteamento por `chat_id` para cada serviço), mas migrar grupos e re-treinar
  usuários tem custo real. Caminho pragmático: unificar identidade visual e
  linguagem dos bots, fazer todo link apontar para o site único, e deixar a
  fusão física de bots para quando o resto estiver assentado — se ainda
  parecer necessária. O canal WhatsApp do escala (Twilio/whatsmeow) segue
  paralelo; unificação de canais é outra conversa.

## 5. Riscos e mitigação

| Risco | Mitigação |
| --- | --- |
| Links antigos quebrarem (folha de ponto assinada, mensagens de bot, favoritos) | manter `plantoes.mnrs.com.br` como 301 por meses; tokens continuam válidos porque a rota é a mesma sob o prefixo |
| Webhook do Telegram fora do ar na virada | `setWebhook` para a URL nova é atômico; o guard de runtime (`scripts/runtime-guard-check.sh`) já vigia webhook duplicado |
| Segredo compartilhado da federação vazar | segredo dedicado (`FEDERACAO_SECRET`) ≠ `AUTH_SECRET` de cada app; rotação independente |
| `basePath` esquecido em alguma chamada client | helper único de URL + varredura `grep fetch("/api` no CI |
| Confusão de contas na migração (Fase 2) | ponte "senha do plantões" continua ligada até o fim; migração de admins é manual e pequena |
| Dois Postgres continuam existindo | ok por desenho — backup/restore já é separado hoje; consolidar banco não é pré-requisito de nada acima |

## 6. O que NÃO fazer

- **Não** fundir os repositórios/bancos num monólito de uma tacada — risco
  alto, ganho invisível para o usuário, e o precedente 0037 já mostrou o
  destino de implementações paralelas.
- **Não** duplicar cadastro "temporariamente" em nenhum passo — toda a Fase 0
  existe para matar a duplicação, não para criar a terceira cópia.
- **Não** compartilhar o `AUTH_SECRET` de sessão entre apps como atalho de SSO
  — handoff assinado com segredo próprio dá o mesmo resultado sem acoplar a
  segurança dos dois.

## 7. Decisões em aberto (para o dono do produto)

1. **Nome definitivo do domínio-teto**: `escala.mnrs.com.br` (pedido atual) ou
   um neutro tipo `samu.mnrs.com.br` mais adiante — barato de mudar após a
   Fase 1. *(Superado — ver §8.)*
2. **IdP**: recomendação é o escala (multicategoria); a alternativa plantões
   só faria sentido se o produto voltasse a ser só-médicos. *(Superado — ver §8.)*
3. **Bot único**: sim/não é decisão de produto; o plano funciona igual nos
   dois casos.
4. **Tabela e checklist**: entram no teto na Fase 1 ou depois — nenhum passo
   depende deles.

## 8. Adendo: o Kairós responde as decisões em aberto

> Acrescentado no mesmo dia, após leitura do repo `kairos` (monorepo
> `apps/shell` + `packages/core|modules|ui|indicadores`), que está **no ar** em
> `kairos.mnrs.com.br` com login, tela-mãe, catálogo de módulos e indicadores.
> Os ADRs de lá supersedem parte do plano acima.

O Kairós já é a plataforma multi-tenant que este documento propunha construir
por costura. O que muda em relação às fases acima:

1. **O teto é `mnrs.com.br`, na raiz** (ADR 0004 do kairos), não
   `escala.mnrs.com.br` nem `samu.mnrs.com.br`. A decisão em aberto nº 1 está
   respondida. E o mesmo ADR **rejeita** mover os apps existentes para
   subcaminho via `basePath` ("o basePath já mordeu neste parque antes") — a
   Fase 1 acima não deve ser executada como escrita. Os subdomínios
   (`plantoes.`, `escala.`) continuam vivos e morrem um a um quando cada
   sistema for **absorvido como módulo** (ADR 0005: absorção por recriação); a
   URL nova nasce em caminho da raiz no dia da absorção.
2. **O provedor de identidade é o Kairós** (ADR 0002), não o escala. A decisão
   em aberto nº 2 está respondida. O mecanismo: cookie `kairos_sessao` no
   domínio pai `.mnrs.com.br` (chega sozinho em todos os subdomínios) +
   `POST /api/sessao/introspeccao` com token de serviço — contrato para o lado
   de cá em `kairos/docs/integracao-servicos.md`. A "Fase 2" acima vira:
   plantões e escala **consomem a introspecção** (aceitando as duas
   autenticações durante a transição, § 6 do contrato) em vez de eleger o
   escala como IdP. O mapeamento persistente de IDs da Fase 0 é a tabela
   `legacy_ref` do Kairós — mesmo conceito, casa canônica.
3. **Sessão única sem esperar absorção.** Hoje **nenhum** serviço consome a
   introspecção (medido no ESTADO.md do kairos: "os sistemas ainda pedem o
   login deles"). Ligar isso no plantões e no escala é o passo de maior
   impacto imediato para "uma conta só" — e é ponte sancionada com data de
   morte (ADR 0005), não arquitetura permanente.
4. **Há dois provedores de identidade em construção em paralelo** — a
   introspecção do Kairós e a federação por handoff do escala
   (`lib/servidor/federacao.ts`, escala↔UPA), além do login-com-senha-do-
   plantões. São três pontes de identidade para o mesmo parque. Recomendação:
   declarar o Kairós como destino único (já está em ADR aceito) e tratar as
   pontes do escala como transitórias, para a bifurcação não crescer.
5. **O levantamento do Kairós (2026-07-31) está desatualizado quanto ao
   escala.** Ele registra "5 contas, domínio em `localStorage`"; desde então o
   escala foi produtizado (estado em Postgres via `ESCALA_STORE=pg` em
   12/08/2026, convites com senha temporária, RBAC, WhatsApp, federação). A
   premissa de adoção-zero que embasou o ADR 0005 continua valendo para
   checagem/giro/NEP, mas a absorção do módulo `escala` é hoje **maior** do
   que o medido lá — vale re-medir antes de agendá-la.
6. **O que continua valendo deste documento**: o inventário (§1–§2), o alerta
   de não fundir codebases/bancos na marra (§3, §6 — coerente com a recriação
   por módulo do ADR 0005, que é o oposto de um merge big-bang), a ponte
   "senha do plantões" como transição desligável por env, e a discussão de
   bots (§4 Fase 4), que o Kairós ainda não cobre.

## 9. Plataforma de venda multi-SAMU: módulos à la carte, um login, uma home

> Registro da direção definida pelo dono do produto em 30/08: o Kairós será
> vendido a outros SAMUs, módulo a módulo ("cidade que compra só escala, só
> trocas, só checagem, só almoxarifado"), mantendo repos/módulos separados no
> desenvolvimento — mas com o usuário final entrando por **uma** tela de login
> e caindo na **sua** vida: admin vê tudo, coordenador menos, médico menos
> ainda, sempre o que precisa.

### 9.1 A costura que precisa ser única não é o repo — é o contrato

O que TEM de ser um só, para a experiência ser uma: **identidade/sessão**
(cookie no domínio + introspecção), **tenant** (`cliente`), **entitlements**
(o que o cliente comprou), **permissões** (o que a pessoa pode), **tokens de
design** (Kairós) e **cadastro canônico** (pessoa, unidade). O que PODE
continuar separado: repositório e runtime de cada módulo.

Dois tipos de módulo convivem no mesmo catálogo, invisíveis para quem compra:

- **Módulo nativo** — roda no core (in-process), tabelas próprias com RLS
  `FORCE` por `cliente_id` e auditoria append-only. É o destino de todo módulo
  **vendido** com dado de cliente: o isolamento entre cidades é provado uma
  vez, no core (teste de vazamento no CI), e não N vezes em N apps. O desejo
  de "repos separados" continua atendível aqui: módulo nativo pode ser
  desenvolvido em repo próprio e entrar no monorepo como pacote versionado —
  separação de desenvolvimento, runtime unificado.
- **Módulo satélite** — app próprio (qualquer stack; o manual é Django),
  montado sob um caminho da raiz via nginx, autenticando pela introspecção,
  presente no catálogo com `destino`. É o estado de **incubação** e o estado
  permanente do que não é vendido. Regra de bolso: **satélite incuba, nativo
  vende.**

Vender um módulo satélite antes da recriação tem um custo escondido: cada
satélite teria de virar multi-tenant por conta própria (o plantões, p.ex., é
single-tenant por construção). O caminho interino para uma venda antecipada é
instância dedicada por cidade — nunca remendar tenancy em N apps.

### 9.2 Mecânica da venda

- `cliente` = a cidade/SAMU. Nova tabela `cliente_modulo` = o que ela comprou
  (é o gap atual: `MODULOS` é global no código e papéis são do produto — sem
  esse filtro, o admin da cidade X veria módulos que não comprou).
- Visibilidade = **catálogo ∩ módulos do cliente ∩ permissões da pessoa**,
  três portões, todos no servidor. "Admin vê tudo" = tudo *do que o cliente
  comprou*.
- **SKU ≠ módulo técnico.** Escala e trocas são um app só (levantamento do
  kairos); comercialmente podem ser dois produtos — a venda liga grupos de
  permissões (`trocas.*`), não repos.
- Modos de entrega: SaaS multi-tenant (uma instalação, RLS — o default para o
  qual o core foi construído) ou instância dedicada para quem exigir dado em
  casa. Catálogo e entitlements idênticos nos dois.

### 9.3 nginx é encanamento; a experiência vem do contrato

Roteamento por caminho na raiz `mnrs.com.br` (ADR 0004, Etapa 0) é a resposta
certa de transporte — mas sozinho ele só produz links bonitos para logins
diferentes, que é o estado atual. O que faz parecer UM produto é a pilha:
cookie no domínio pai + introspecção (uma sessão) → catálogo+entitlements (o
que aparece) → tokens Kairós (uma cara) → regra de destino pós-login (cair
onde se vive).

### 9.4 "Ver a própria vida": a home por pessoa

Além do portão por módulo, a home compõe **ações rápidas e cartões que cada
módulo contribui**, filtrados por permissão: médico vê "avisar chegada"
(plantões), "próximo plantão / pedir troca" (escala), "checklist da viatura",
"manual do serviço"; coordenador vê pendências de aprovação e carências; admin
vê tudo mais indicadores. Mecanismo em duas fases:

1. **Estática** (barata, já dá a sensação): cada entrada do catálogo declara
   ações rápidas (rótulo, permissão exigida, rota/URL). Satélite entra por
   declaração, sem API nova.
2. **Com estado** ("você está escalado hoje às 19h"): contrato explícito de
   resumo por módulo — separado da introspecção, para não violar a regra do
   ADR 0003 (nenhuma regra de negócio atravessa a introspecção). Módulo nativo
   entrega isso in-process de graça; satélite só se valer a pena.

Destino pós-login (ordem): deep-link `?de=` seguro → pessoa com um único
módulo entra direto → módulo inicial do papel (override por pessoa) → home.

### 9.5 Próximos passos concretos, em ordem (ver também §10)

1. **Etapa 0 do kairos** (raiz `mnrs.com.br`) — já planejada, independente de
   tudo.
2. **`cliente_modulo`** + filtro em `modulosPermitidos`/tela-mãe (pequeno, e
   destrava a conversa comercial).
3. **Ligar a introspecção no primeiro satélite real** — plantões (maior dor),
   depois escala. Mata o "logar duas vezes" sem esperar absorção.
4. **Home "minha vida" v1** — ações rápidas estáticas + regra de destino
   pós-login.
5. **ADR novo no kairos** registrando: fronteira vira portfólio por cliente;
   "satélite incuba, nativo vende"; SKU ≠ módulo técnico. (As ações citadas já
   têm casa: chegada/saída → plantões; troca → escala; defeito de equipamento
   → almoxarifado/frota; manual → samu-normas como satélite Django; checklist
   → checklist; presença de interno → capacitação, que o ADR 0008 já trouxe
   para dentro.)

## 10. Polimento do shell: do clique ao destino sem atrito

> Sintomas relatados em 30/08 no Kairós em produção: cada link abre uma
> "janela" intermediária, encaminha ao destino depois de segundos, a transição
> de view é lenta e os módulos parecem sites separados. Diagnóstico feito no
> código de `apps/shell` (main); cada item abaixo aponta causa → conserto.

### 10.1 Diagnóstico

1. **O clique num módulo externo tem cinco passos hoje.** `Link` do cabeçalho
   → roundtrip de servidor para `/modulo/[chave]` → painel intermediário
   (`modulo/[chave]/page.tsx`) → clique em "Abrir …" (`target="_blank"`) →
   login próprio do satélite. A "janela horrível" é esse painel — desenhado
   para anunciar o estado do módulo, mas cobrando o preço de uma navegação
   inteira para dizer o que o badge "demo/prévia" do cabeçalho já diz antes
   do clique.
2. **Não existe `loading.tsx` nem `Suspense` em `(tela-mae)`.** Toda
   navegação espera a resposta RSC completa sem nenhum feedback — o clique
   parece morto até o servidor voltar. É a "transição lenta" percebida.
3. **`concessoes()` roda uma consulta por chamada, sem dedupe**
   (`packages/core/src/autorizacao.ts`). O layout da tela-mãe chama
   `modulosPermitidos` + um `pode()` por indicador e por trilha — N consultas
   idênticas por render. O comentário do próprio arquivo já aponta o lugar de
   cachear.
4. **Os indicadores leem o banco de produção do plantões a cada render, sem
   revalidate** (`packages/indicadores/src/fontes/plantoes.ts`). O primeiro
   paint da tela-mãe espera todas essas consultas em série com o resto.
5. **"Encaminha a outra URL mesmo"** — estrutural: satélite em outra origem
   com login próprio. Já tratado nos §8–§9 (introspecção → Etapa 0 raiz →
   absorção). Nenhum polish de shell elimina isso sozinho; iframe NÃO é
   atalho aceitável (cookie de terceiros, CSP, scroll duplo) — o painel
   "60% sobre a tela-mãe" é modelo para módulo nativo, não para satélite.

### 10.2 Conserto, em ordem de custo-benefício

1. **Link direto, mesma aba, para módulo `em-uso` com `destino`** — cabeçalho
   e tiles apontam `href={destino}`; o painel intermediário sobrevive apenas
   para `demonstracao`/`previa` (aviso de dado fictício continua obrigatório)
   e para módulo sem destino. Um condicional em `cabecalho.tsx`.
2. **`loading.tsx` no grupo `(tela-mae)`** e skeleton do painel de módulo
   nativo: o clique muda a tela no mesmo frame.
3. **Dedupe de `concessoes` por requisição** com `cache()` do React — mesma
   técnica já usada em `sessaoAtual` (`apps/shell/src/lib/sessao.ts`). N
   consultas viram 1 por requisição, sem mudar semântica de revogação.
4. **`Suspense` + streaming na grade de indicadores e na trilha de decurso**:
   a tela-mãe pinta imediatamente; indicadores preenchem quando chegarem
   (estado "carregando" é coerente com a decisão "indicador sem fonte mostra
   sem-fonte, nunca número plausível").
5. **Revalidate curto (30–60 s) nos adaptadores de indicadores**
   (`unstable_cache`): são leituras de painel, não comandos; o banco do
   plantões deixa de ser tocado por requisição. (Os adaptadores morrem na
   absorção — ADR 0005 — mas até lá não precisam custar o primeiro paint.)
6. **Introspecção no satélite antes de qualquer polish do salto**: sem ela,
   até o link direto termina num formulário de login alheio. É o item 3 do
   §9.5.
7. **Acabamento**: View Transitions do Next 16 (`experimental.viewTransition`)
   para suavizar a troca de view; `prefetch` nos painéis nativos.

### 10.3 Critério de aceite

- Clicar em qualquer módulo muda algo na tela **no mesmo frame**.
- Módulo externo `em-uso` abre com **uma** navegação (zero telas
  intermediárias) e, com introspecção ligada, **zero logins**.
- A tela-mãe pinta sem esperar o banco do plantões; indicadores chegam por
  streaming.
- O aviso de dado fictício de `demonstracao`/`previa` continua aparecendo
  **antes** de qualquer dado fictício — o atalho não pode custar a
  honestidade do catálogo.

## 11. Implementado: shell "instantâneo por desenho" (patch para o kairos)

> 30/08, na sequência do §10. O conserto foi **implementado e validado** num
> clone do kairos (branch local `claude/shell-spa`, 11 arquivos,
> +415/−72). O push direto ao repo kairos foi bloqueado pela permissão da
> sessão (anexado somente-leitura), então a entrega é um patch `git am`
> enviado na conversa. Conteúdo:

1. **`concessoes()` deduplicada por requisição** (`packages/core/src/autorizacao.ts`)
   — WeakMap pela identidade do `Contexto`; as ~10 consultas idênticas de
   permissão por render da tela-mãe viram 1. Revogação entre requisições
   intacta; falha não fica memoizada.
2. **Fontes do plantões com validade de 45 s** (`packages/indicadores/src/fontes/plantoes.ts`)
   — `lembrar()` sobre as três leituras; vazio/falha não são guardados
   (fonte fora do ar volta sem esperar validade); limite fora do padrão lê
   direto.
3. **Tela-mãe pinta antes do banco** (`apps/shell/.../layout.tsx` + novo
   `leituras.tsx`) — indicadores, barra e trilha descem como promessas para
   blocos em `<Suspense>` com esqueletos pulsantes (esqueleto = "chegando",
   distinto de `sem-fonte` e de número); novo `atualizador.tsx` renova a
   árvore a cada 60 s com a aba visível e ao voltar do segundo plano.
4. **Clique sem pedágio** (`cabecalho.tsx`, `modulo/[chave]/page.tsx`,
   `permissoes.ts`) — o catálogo ganha `rota` (caminho interno; checagem =
   `/checagem`, que antes nem era alcançável pela navegação): módulo com rota
   navega client-side com prefetch e `loading.tsx`; módulo **em uso** com
   `destino` vai direto na mesma aba (o badge já anuncia o estado); o painel
   intermediário sobrevive só para demonstração/prévia, onde o aviso de dado
   fictício precisa vir antes do dado. URL antiga `/modulo/x` vira redirect —
   link salvo continua funcionando.

**Validação executada aqui**: typecheck nos 6 pacotes; suíte completa contra
Postgres 16 real (papéis → migrations → catálogo → seed; core 49/49 com os
testes de sabotagem de RLS/auditoria); `next build` de produção limpo.

**Aplicar**: no checkout do kairos, `git checkout -b claude/shell-spa` e
`git am 0001-shell-*.patch`; canary primeiro, como sempre. Se preferir que eu
mesmo empurre a branch numa próxima sessão, basta liberar o repo `kairos`
para escrita nas configurações de repositórios do Claude.

**Fora deste patch, por decisão** (seguem no §10 como próximos): introspecção
nos satélites (sem ela o link direto ainda termina no login do destino),
View Transitions (`experimental.viewTransition`) e o mapa/home por pessoa.

## 12. Implementado: o plantões aceita a sessão do Kairós

> 30/08, na sequência do §11. É o item "ligar a introspecção no primeiro
> satélite real" (§9.5.3) — implementado NESTE repo, na fase "aceitar as
> duas" do contrato `kairos/docs/integracao-servicos.md` (§6 de lá).

- **[lib/auth/kairos.ts](../lib/auth/kairos.ts)** — cliente da introspecção:
  POST `{KAIROS_URL}/api/sessao/introspeccao` com token de serviço no
  `Authorization` e o cookie no CORPO (nunca na URL). Nunca lança; as quatro
  regras do contrato viram respostas: `ativa:false` recusa, troca de senha
  pendente recusa, Kairós fora do ar recusa (fail-closed), e autorização
  continua local.
- **Wiring em `readAuthenticatedSession`** (lib/auth/server.ts): sem sessão
  local válida, o cookie `kairos_sessao` (domínio pai, chega sozinho) é
  introspeccionado e casa por **e-mail** com a conta local ativa — nenhuma
  conta é criada, roles continuam as daqui, e a validade real é a sessão do
  Kairós, reconferida a cada requisição (revogar lá corta cá no instante
  seguinte). Pessoa sem e-mail (médico importado) segue pelo login local até
  a `legacy_ref` do Kairós cobrir este sistema.
- **Desligado por padrão**: sem `KAIROS_URL` + `KAIROS_SERVICO_TOKEN`
  (.env.example documenta), nada muda. Ligar é gerar o token no kairos
  (`pnpm servico:registrar -- --chave plantoes`) e definir as duas envs.
- **Validação**: typecheck (strict, inclui tests/), 10 testes novos em
  [tests/kairos-sso.test.ts](../tests/kairos-sso.test.ts) e a suíte de gate
  completa (1400/1400).

Com isto, o primeiro "logar duas vezes" do parque morre assim que as envs
forem definidas em produção. O análogo no escala (mesmo contrato, outro repo)
é o próximo satélite.
