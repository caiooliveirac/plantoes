# operations-v2

Nova base paralela para a operacao de plantao SAMU.

## Visao geral

O sistema consolida regulação, intervenção, chefia e banco de horas em uma base própria, com regras explícitas de turno, persistência operacional e leitura em tempo real para a mesa de plantão.

## Objetivo

- banco como fonte de verdade
- backend pequeno e explicito
- frontend fino
- deploy previsivel
- nenhum reaproveitamento obrigatorio do frontend legado
- auth e trilhas de auditoria como pilares para crescimento operacional

## Estrutura

- app: paginas e endpoints
- db: schema e migrations
- modules: regras por dominio
- services: composicao de leitura do quadro
- scripts: importacao e migracao explicitas
- tests: regras centrais

## Regras operacionais de referencia

- ver [OPERATIONAL_RULES.md](OPERATIONAL_RULES.md) para a matriz oficial de comportamento entre intervencao, regulacao, lembretes de Telegram e banco de horas
- qualquer ajuste de janela de turno, tolerancia ou continuidade deve atualizar codigo, testes e esse documento de referencia na mesma entrega

## Plano de autenticacao

- ver [AUTH_PLAN.md](AUTH_PLAN.md) para o plano de convite por link, aprovacao manual por admin e separacao de permissao entre `chief` e `admin`
- o plano tambem fixa a decisao de manter o painel principal em `/`, com login discreto e operacao persistida por rotas server-side sem depender de middleware como guarda principal

## Deploy de producao

- ver [DEPLOY.md](DEPLOY.md) antes de qualquer push com restart
- a regra critica e: carregar `.env.production` antes do build e reiniciar os dois processos PM2 com `--update-env`, porque o worker pode perder `DATABASE_URL` se o deploy for feito de forma incompleta
- preferir sempre `npm run deploy:production`

## Principios arquiteturais

- operacao primeiro: a visualizacao do quadro deve responder ao estado real do plantao e nao a heuristicas frouxas
- escrita auditavel: toda acao de chefia ou ajuste futuro deve deixar trilha clara de ator, horario e payload
- auth incremental: crescer de auth minima para auth por perfis sem reescrever o dominio
- separacao de papeis: regulacao, intervencao, chefia e coordenacao compartilham a base, mas nao a mesma experiencia nem o mesmo poder de alteracao
- compatibilidade operacional: integracoes com Telegram, banco de horas e importacao legada devem continuar desacopladas

## Comandos

- npm install
- npm run dev
- npm run build
- npm run db:migrate
- npm run db:import-doctors -- --file ./algum-arquivo.csv --dry-run
- npm run db:import-doctors -- --file ./algum-arquivo.csv --allow-additions
- comando Telegram admin: /medico cadastrar Nome Completo | Nome de exibicao | codigo | alias 1, alias 2
- comando Telegram admin: /medico atualizar Busca Atual | Nome Completo Correto | Nome de exibicao | codigo | alias 1, alias 2
- comando Telegram pagamento: /pagamento conferir [YYYY-MM-DD] [SD|SN]
- comando Telegram correção de pagamento: /pagamento corrigir alvo | Nome Completo | [YYYY-MM-DD] | [SD|SN] | [motivo]
- npm run test

## Importacao segura de medicos

- todo apply real agora exige backup automatico antes de gravar
- o script gera dump SQL completo do schema `operations_v2` em `.backups/doctor-imports/<timestamp>/operations_v2.sql`
- o mesmo diretório recebe `manifest.json` com resumo e preview da importacao
- novas adicoes ficam bloqueadas por padrao; para criar medico novo, use `--allow-additions` somente depois de revisar o preview
- a API `/api/doctors/import` ficou restrita a preview para evitar apply sem backup

## Estado atual

Esta primeira iteracao prioriza:

- schema novo
- importacao de medicos
- fluxo de chefia persistido por invite e aprovacao manual
- calculadora de banco de horas
- auth minima por cookie assinado
- painel minimo de leitura

## Perfis de acesso previstos

### Medico

- login para visualizar quadro e estado pessoal quando essa camada for aberta
- sem permissao de alterar ocupacoes de terceiros
- futuramente pode confirmar sua propria chegada, saida e continuidade

### Chefe de plantao

- acesso direto para corrigir, abrir e encerrar ocupacoes no quadro
- acesso a trilha de auditoria operacional
- permissao para revisar inconsistencias e excecoes do turno
- futuramente acesso a fila de pendencias de confirmacao e divergencias

### Coordenador

- acesso de leitura gerencial sobre horarios realizados, banco de horas e cobertura por base/posto
- sem responsabilidade operacional direta no quadro em tempo real, salvo concessao explicita
- consumo de relatorios consolidados por periodo, medico, base, posto e tipo de turno
- futuramente exportacao e conciliacao com sistemas administrativos

### Admin

- gestao de usuarios, papeis, convites, parametros e integracoes
- manutencao de catalogos operacionais e referenciais de bases e ramais

## Roadmap

### Fase 1. Operacao confiavel

- consolidar regras de virada de turno e persistencia por tipo de tabela
- amadurecer correcao operacional pela chefia com melhor UX e filtros
- ampliar cobertura de testes para cenarios de turno, continuidade e prolongamento
- expor endpoint de saude operacional com diagnostico de leitura do board

### Fase 2. Auth e autorizacao robustas

- substituir auth minima por sessao estruturada com revogacao, expiracao e trilha de login
- introduzir RBAC formal com papeis `doctor`, `chief`, `coordinator`, `admin`
- suportar permissao por escopo operacional, por exemplo chefia regional ou por grupo de bases
- registrar auditoria de alteracoes sensiveis: antes, depois, ator, motivo e origem
- preparar reset de senha, convite e aprovacao com estados mais claros

### Fase 3. Mesa de chefia

- dashboard de pendencias: bases sem cobertura, ramais sem confirmacao, divergencias e viradas criticas
- edicao direta de ocupacoes com regras de consistencia e motivo obrigatorio
- fila de verificacoes para plantonistas que extrapolaram o turno sem nova confirmacao
- historico operacional navegavel por turno e por entidade

### Fase 4. Modulo de coordenacao

- visao consolidada de horas realizadas e banco de horas por medico
- filtros por periodo, base, posto, papel e tipo de plantao
- relatorios para fechamento mensal e auditoria de pagamento
- exportacao CSV e integracao futura com rotinas administrativas

### Fase 5. Integracoes e automacao

- ingestao mais estruturada de Telegram com menor ambiguidade e feedback orientado por contexto
- notificacoes ativas para chefia em eventos criticos
- conciliacao automatica entre quadro operacional, banco de horas e eventos declarados
- webhooks ou API externa para consumo por sistemas satelite

## Evolucao recomendada de auth

### Modelo alvo

- tabela de sessoes persistidas com invalidação e trilha de ultimo acesso
- RBAC central em base relacional, sem espalhar logica de permissao pelo frontend
- middleware de autorizacao por papel e escopo
- auditoria separada de auth e auditoria operacional, mas correlacionaveis

### Crescimento do login de chefe de plantao

- curto prazo: manter login por credencial com papel `chief` e gates server-side nas rotas de alteracao
- medio prazo: vincular chefe a janelas operacionais, por exemplo plantao atual ou unidade coordenada
- longo prazo: liberar delegacao temporaria de chefia com expiração automatica

### Crescimento do consumo pelo coordenador

- curto prazo: leitura agregada de horas e plantoes encerrados
- medio prazo: filtros, exportacao e comparativos por periodo
- longo prazo: fechamento operacional e administrativo com workflow de aprovacao

## Endpoints iniciais

- /api/auth/login
- /api/auth/logout
- /api/auth/session
- /api/auth/password-reset
- /api/chief/invites
- /api/chief/requests
- /api/regulation/occupancies
- /api/intervention/occupancies
- /api/board

## Publicacao e versionamento

- manter `.env.production` fora do versionamento
- versionar apenas `.env.example` com placeholders seguros
- evitar commits de artefatos locais como `.next` e `node_modules`
- preservar build e deploy via PM2 enquanto a stack evolui
