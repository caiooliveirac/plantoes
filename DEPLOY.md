# Deploy de producao

## Fonte oficial de runtime

Este projeto adota **PM2 como runtime oficial de producao**.

Nao existe arquitetura hibrida oficial PM2+Docker para o bot/plantao.
Qualquer runtime concorrente (ex.: container legado consumindo Telegram em polling)
e tratado como incidente de deploy.

Este projeto roda em PM2 com dois processos separados no mesmo checkout:

- `plantoes`: web Next.js via `npm start`
- `plantoes-telegram-worker`: worker de lembretes via `npm run telegram:worker`

## Mapa de execucao (single source of truth)

- Process manager oficial: `pm2`
- Config oficial: `ecosystem.config.cjs`
- Script oficial de deploy: `scripts/deploy-production.sh`
- Endpoint oficial Telegram: `/api/telegram/webhook`
- Proxy oficial: nginx (`plantoes.mnrs.com.br` -> `host.docker.internal:3004`)

Arquivos que controlam runtime:

- `ecosystem.config.cjs` (processos e env)
- `scripts/deploy-production.sh` (pre-checks, build, restart, webhook, validacoes)
- `app/api/telegram/webhook/route.ts` (entrada webhook + guard)
- `scripts/telegram-reminder-worker.ts` (worker + guard)
- `lib/runtime-identity.ts` (fingerprint + runtime guard)
- `app/api/health/route.ts` (observabilidade de runtime)

## Regras que nao podem ser quebradas

O banco e acessado exclusivamente por `DATABASE_URL`.

- a web precisa desse valor
- o worker precisa desse valor
- reiniciar o PM2 sem recarregar o ambiente pode deixar o worker sem `DATABASE_URL`, mesmo quando a web continua funcionando

Por isso, qualquer deploy precisa carregar `.env.production` no shell antes do restart e usar `pm2 restart ... --update-env`.

E obrigatorio manter runtime unico:

- `RUNTIME_SOURCE_OF_TRUTH=pm2`
- `TELEGRAM_DELIVERY_MODE=webhook`
- webhook apontando para `https://plantoes.mnrs.com.br/api/telegram/webhook`
- nenhum container legado `plantoes-app` ativo

Observacao importante:

- na web Next.js, ler `/proc/<pid>/environ` do wrapper `npm start` nao prova que `DATABASE_URL` chegou ao processo real da aplicacao
- a validacao confiavel da web e o sucesso de `api/health` e `api/board`
- para o worker, se precisar inspecionar ambiente no host, confira o processo filho real do `npm run telegram:worker`, nao apenas o wrapper do PM2

## Comando recomendado

Use sempre:

```bash
cd /home/ubuntu/plantoes
npm run deploy:production
```

Esse script faz, nesta ordem:

1. carrega `.env.production`
2. executa **pre-checks anti-concorrencia** (container legado, duplicidade PM2, porta ambigua, polling/webhook conflitante)
3. roda `npm run build`
4. recria `plantoes` e `plantoes-telegram-worker` no PM2 com `--update-env`
5. valida `api/health` e `api/board`
6. reconfigura o webhook do Telegram para `${AUTH_URL}/api/telegram/webhook`
7. valida que o webhook ficou registrado no Telegram
8. executa **post-checks anti-concorrencia**
9. roda `pm2 save`
10. imprime resumo final de deploy (runtime/commit/porta/pids/webhook)

## Passo a passo manual

Se o script nao puder ser usado, siga exatamente esta sequencia:

```bash
cd /home/ubuntu/plantoes
set -a
source .env.production
set +a
npm test
npm run build
pm2 restart plantoes --update-env
pm2 restart plantoes-telegram-worker --update-env
curl -fsS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
	-H 'Content-Type: application/json' \
	-d "{\"url\":\"${AUTH_URL%/}/api/telegram/webhook\",\"secret_token\":\"${TELEGRAM_WEBHOOK_SECRET}\",\"allowed_updates\":[\"message\"]}"
curl -fsS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"
pm2 save
```

## Validacoes obrigatorias

Depois do restart:

```bash
pm2 list
pm2 logs plantoes --lines 20 --nostream
pm2 logs plantoes-telegram-worker --lines 20 --nostream
```

E confirme localmente:

```bash
curl -fsS http://127.0.0.1:3004/api/health
curl -fsS http://127.0.0.1:3004/api/board
```

E confirme no Telegram que o bot aponta para a instancia publica certa:

```bash
curl -fsS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"
```

O campo `result.url` precisa ser exatamente `https://plantoes.mnrs.com.br/api/telegram/webhook`.

## Validacao obrigatoria no host publico (fluxo do agente)

Para qualquer alteracao de UX, rota admin, filtro ou comportamento de tela, o agente so pode encerrar a entrega apos validar no host publico usado para teste:

- Host oficial de teste do usuario: `plantoes.mnrs.com.br`
- Fazer cheque local do upstream (`127.0.0.1:3004`) e cheque externo no dominio publico
- Reportar no resumo final quais URLs foram testadas e os codigos HTTP retornados

Checklist minimo:

```bash
# upstream local
curl -fsS http://127.0.0.1:3004/api/health

# host publico (mesmo caminho que o usuario testa)
curl -sk -o /dev/null -w "%{http_code}\n" https://plantoes.mnrs.com.br/api/health

# rota de tela alterada (exemplo: fechamento)
curl -sk -o /dev/null -w "%{http_code}\n" https://plantoes.mnrs.com.br/admin/payment-closing
```

Sem essa validacao no dominio publico, a tarefa nao deve ser considerada concluida.

## Runtime guard / simulacao de cenarios

Use este comando para validar as protecoes contra runtime concorrente:

```bash
cd /home/ubuntu/plantoes
npm run runtime:guard-check
```

Simulacoes disponiveis:

```bash
bash scripts/runtime-guard-check.sh legacy-container
bash scripts/runtime-guard-check.sh duplicate-pm2
bash scripts/runtime-guard-check.sh polling-webhook-conflict
bash scripts/runtime-guard-check.sh clean
bash scripts/runtime-guard-check.sh live
```

O script deve falhar em cenarios ambiguos e passar no cenario limpo.

## Provisionamento inicial de acesso

As contas operacionais iniciais devem ser provisionadas por script, nunca com senha fixa versionada no repositório.

Use:

```bash
cd /home/ubuntu/plantoes
set -a
source .env.production
set +a
BOOTSTRAP_ACCESS_PASSWORD='defina-aqui' npm run provision:initial-access
```

O script cria ou atualiza:

- `tom@samu.local`
- `dora@samu.local`
- `ivan@samu.local`
- `caio@samu.local`

Todos saem com troca obrigatoria de senha no primeiro login.