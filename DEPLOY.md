# Deploy de producao

Este projeto roda em PM2 com dois processos separados no mesmo checkout:

- `plantoes`: web Next.js via `npm start`
- `plantoes-telegram-worker`: worker de lembretes via `npm run telegram:worker`

## Regra que nao pode ser quebrada

O banco e acessado exclusivamente por `DATABASE_URL`.

- a web precisa desse valor
- o worker precisa desse valor
- reiniciar o PM2 sem recarregar o ambiente pode deixar o worker sem `DATABASE_URL`, mesmo quando a web continua funcionando

Por isso, qualquer deploy precisa carregar `.env.production` no shell antes do restart e usar `pm2 restart ... --update-env`.

## Comando recomendado

Use sempre:

```bash
cd /home/ubuntu/plantoes
npm run deploy:production
```

Esse script faz, nesta ordem:

1. carrega `.env.production`
2. roda `npm test`
3. roda `npm run build`
4. reinicia `plantoes` com `--update-env`
5. reinicia `plantoes-telegram-worker` com `--update-env`
6. valida `api/health`
7. valida `api/board`
8. reconfigura o webhook do Telegram para `${AUTH_URL}/api/telegram/webhook`
9. valida que o webhook ficou registrado no Telegram
10. roda `pm2 save`

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