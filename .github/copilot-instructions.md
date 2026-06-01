# Fluxo Operacional Obrigatorio Para Entregas

Estas instrucoes se aplicam a todo trabalho neste repositorio.

## Regra de validacao em producao

Quando houver alteracao de UI, filtros, navegacao, rotas admin, regras de exibicao ou qualquer comportamento que o usuario vai validar em navegador:

1. O agente deve validar no host publico de teste: `plantoes.mnrs.com.br`.
2. Nao encerrar a tarefa sem informar URLs testadas e codigos HTTP retornados.
3. Sempre validar tambem o upstream local (`http://127.0.0.1:3004`) para separar problema de app vs proxy.

Checklist minimo:

```bash
curl -fsS http://127.0.0.1:3004/api/health
curl -sk -o /dev/null -w "%{http_code}\n" https://plantoes.mnrs.com.br/api/health
```

## Invariante critica de continuidade no Telegram

Quando alterar parser, fluxo de chegada, ocupacoes, board, regras operacionais ou qualquer heuristica de continuidade:

- Continuidade automatica so pode ser inferida a partir do turno atual ou do turno imediatamente anterior.
- Nunca tratar uma mensagem de hoje como continuidade de ocupacao ativa/encerrada de dias atras.
- Se a referencia encontrada for anterior a ultima virada de turno relevante, abrir novo plantao ou mandar para revisao; nao confirmar continuidade.

Para mudancas de tela, incluir a rota alterada no teste externo (por exemplo `https://plantoes.mnrs.com.br/admin/payment-closing`).

## Regra de comunicacao de deploy

Sempre que houver deploy/restart para publicar mudancas:

- Informar no resumo final se o deploy foi executado
- Informar status de verificacao no dominio publico
- Nao afirmar "pronto" sem evidencia minima de validacao no host publico

## Comandos PROIBIDOS em `ssh samu` (producao) sem confirmacao humana explicita

Estes comandos podem destruir trabalho em progresso, derrubar o servico ou apagar
estado nao versionado. NUNCA execute sem que o humano peca textualmente, no turno
atual, citando o comando exato. Nao basta autorizacao implicita ou de turnos
anteriores. Em duvida, pergunte.

- `git reset --hard`, `git checkout -- .`, `git checkout <commit> -- .`, `git clean -fd`, `git stash drop/clear`
- `git push --force`, `git push -f`, `git push --force-with-lease` em `main`
- `rm -rf` em `~/plantoes`, `~/plantoes/.next`, `~/plantoes/.env*`, `/var/`, `/etc/`
- `pm2 kill`, `pm2 delete all`, `pm2 flush` (use `npm run deploy:production`)
- `docker rm -f`, `docker volume rm`, `docker system prune`
- `dropdb`, `DROP DATABASE`, `DROP SCHEMA`, `TRUNCATE` em DB de producao
- `psql ... -c "DELETE FROM ..."` sem `WHERE` ou sem `BEGIN/ROLLBACK` de teste
- Qualquer edicao direta de `.env.production` (use commit + redeploy)
- `sudo` em qualquer comando que altere estado fora de `~/plantoes`

O workflow correto e: editar local, commitar em branch, abrir PR, mergear em `main`,
deixar o CI rodar `npm run deploy:production`. O deploy script ja faz reconcile
seguro do working tree de prod para o commit do CI (e falha loud se sujo).

## Protecao de `main` em camadas (sem branch protection paga)

Repo privado em conta free nao tem branch protection. Substituimos por:

1. Hook `pre-push` em `.githooks/pre-push` (ativar com `git config core.hooksPath .githooks`).
2. Job `deploy` no CI recusa commits que nao venham de PR mergeado.
3. `scripts/deploy-production.sh` recusa working tree sujo e reconcilia para `EXPECTED_GIT_COMMIT_SHA`.

Agentes NAO devem:
- usar `PRE_PUSH_ALLOW_DIRECT_MAIN=1` para pular o hook
- usar `ALLOW_DIRTY_TREE=1` no deploy
- usar `workflow_dispatch` para pular o guard de PR
sem pedido humano explicito no turno atual.


