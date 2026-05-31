# CLAUDE.md — Guia para agentes de IA neste repositório

Este arquivo é carregado automaticamente pelo Claude Code. Leia-o antes de agir.
O runbook operacional completo (acesso a logs/DB de produção, deploy) está em
[docs/agent-operations.md](docs/agent-operations.md).

## O modelo: desenvolva local, produção só recebe o commit final

**Regra de ouro: NÃO desenvolva dentro do servidor de produção.**

O `plantoes` roda num EC2 `m8g.large` (8GB / 2 vCPU) **compartilhado com ~10 outros
projetos + bancos + ~20 containers**. Esse box é apertado. Rodar editor + Claude Code
+ `next build` lá dentro já derrubou o servidor inteiro por falta de memória (OOM →
reboot). Histórico do incidente: este arquivo + `docs/agent-operations.md`.

Fluxo correto:

1. **Editar e testar no macOS local** (muito mais RAM). É aqui que um agente Claude
   Code deve fazer mudanças, rodar testes e validar.
2. **Commitar em feature branch** e abrir PR. O working tree de produção deve ficar
   **sempre limpo** (sem experimentos não commitados rodando ao vivo).
3. **Deploy** leva apenas o commit/tag final para o EC2. Detalhes em
   [docs/agent-operations.md](docs/agent-operations.md).

Um agente rodando **no Mac** pode fazer quase tudo sem tocar no EC2: alterar código,
rodar a suíte de testes, e até **consultar logs e banco de produção remotamente**
(read-only via túnel SSH) — ver o runbook.

## Stack

- **Next.js 16** (App Router) + TypeScript.
- **Drizzle ORM** sobre PostgreSQL (driver `postgres` / postgres.js). Conexão em
  [db/index.ts](db/index.ts); schema em `db/schema`.
- Bot de Telegram para registro de plantões médicos. Worker de lembretes separado.
- Runtime de produção: **PM2** (`plantoes` = web, `plantoes-telegram-worker` = worker).

## Comandos (rodar no LOCAL)

```bash
npm install            # Node >= 20
npm run dev            # Next dev server
npm test               # suíte completa (node --test + tsx)
npm run test:deploy    # suíte de gate de deploy (exclui meal-breaks, que trava sob isolamento)
npm run build          # build de produção (faça LOCAL, não no EC2)
```

Notas de teste conhecidas: `tests/telegram-meal-breaks.test.ts` trava sob isolamento;
use `--test-isolation=none` quando precisar rodá-lo. Detalhes na memória do projeto.

## Segredos — nunca commitar

- `.env`, `.env.local`, `.env.production` estão no `.gitignore`. **Mantenha assim.**
- As chaves esperadas estão em [.env.example](.env.example) (sem valores).
- `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, `AUTH_SECRET`, `TELEGRAM_WEBHOOK_SECRET` etc.
  vivem **apenas** no `.env.production` do servidor. Nunca cole valores reais em
  código, docs, commits ou mensagens.

## Produção (resumo — runbook completo em docs/agent-operations.md)

- App em `~/plantoes` no EC2; porta `3004`; URL pública `https://plantoes.mnrs.com.br`.
- Banco: PostgreSQL do host em `localhost:5432` db `plantoes` (só loopback → acesso
  remoto via túnel SSH).
- Observabilidade e DB de produção são acessíveis **read-only do Mac via SSH**, sem
  rodar carga no EC2. Veja o runbook.
- O deploy ainda compila no EC2 (guard de memória + build atômico com rollback já
  protegem contra OOM). Meta futura: compilar fora da produção e enviar só o artefato.
