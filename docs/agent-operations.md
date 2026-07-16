# Runbook de operação para agentes (a partir do macOS local)

Este documento ensina um agente Claude Code rodando **no Mac** a operar a produção
do `plantoes` **sem rodar carga no servidor** — consultas read-only ao banco, leitura
de logs, e deploy. Tudo aqui é seguro para o GitHub: **nenhum segredo**, só aliases
SSH e variáveis de ambiente que ficam fora do repositório.

> Por que isso existe: o EC2 de produção (`m8g.large`, 8GB, compartilhado com ~10
> projetos) é apertado. Editar/buildar/consultar pesado lá dentro já causou OOM e
> reboot do servidor inteiro. A partir do Mac, o agente tem mais RAM e não ameaça a
> produção. Ver a seção "Incidente de memória" no fim.

---

## 1. Pré-requisitos no Mac (configurar uma vez, fora do repo)

### 1.1 Alias SSH (não hardcode IP/host no repositório)

No seu `~/.ssh/config` local (NÃO versionado):

```sshconfig
Host plantoes-prod
    HostName <ip-ou-dns-do-ec2>
    User ubuntu
    IdentityFile ~/.ssh/<sua-chave>.pem
    ServerAliveInterval 30
```

A partir daqui, todos os comandos usam apenas `plantoes-prod`.

### 1.2 Variáveis locais (no seu shell, ex. `~/.zshrc` — fora do repo)

```bash
# Conexão read-only ao banco de produção, via túnel local na porta 5433 (ver §3).
# A senha NÃO vai para o repositório nem para o histórico — só no seu ambiente.
export PLANTOES_RO_URL='postgres://plantoes_ro:<senha-ro>@localhost:5433/plantoes'
```

---

## 2. Ler logs de produção (read-only, sem carga)

Tudo via SSH, sem abrir editor remoto:

```bash
# Status dos processos PM2
ssh plantoes-prod 'pm2 status'

# Últimas linhas do app (sem streaming — não segura o terminal)
ssh plantoes-prod 'pm2 logs plantoes --lines 100 --nostream'
ssh plantoes-prod 'pm2 logs plantoes-telegram-worker --lines 100 --nostream'

# Apenas erros recentes
ssh plantoes-prod 'tail -n 200 ~/.pm2/logs/plantoes-error.log'

# Healthchecks (devem responder 200)
ssh plantoes-prod 'curl -fsS http://127.0.0.1:3004/api/health && echo OK'
ssh plantoes-prod 'curl -fsS http://127.0.0.1:3004/api/board >/dev/null && echo OK'

# Memória do box antes de qualquer operação pesada
ssh plantoes-prod 'free -h && uptime'
```

Regra: prefira `--nostream` e `tail`/`head`. Não rode `grep` recursivo pesado, `npm`,
`tsx` nem build no servidor — faça isso local sobre uma cópia do banco se precisar.

---

## 3. Consultar o banco de produção (READ-ONLY) a partir do Mac

O Postgres de produção escuta só em `localhost:5432` no EC2. O acesso remoto é por
**túnel SSH** + um **usuário somente-leitura** dedicado (`plantoes_ro`). Nunca use o
usuário de aplicação (read-write) para inspeção.

### 3.1 Criar o papel read-only (uma vez, no servidor)

Execute no EC2 (ex.: `ssh plantoes-prod`, depois `sudo -u postgres psql -d plantoes`).
Defina a senha por variável de ambiente — **não comite a senha**:

```sql
-- Rode com :ro_pwd vindo de fora, ex.: psql -v ro_pwd="'...'" -f este_arquivo
CREATE ROLE plantoes_ro LOGIN PASSWORD :ro_pwd;
GRANT CONNECT ON DATABASE plantoes TO plantoes_ro;
GRANT USAGE ON SCHEMA public TO plantoes_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO plantoes_ro;
-- Tabelas futuras também ficam legíveis:
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO plantoes_ro;
```

Esse papel só consegue `SELECT` — não há risco de alterar produção.

### 3.2 Abrir o túnel e consultar (no Mac)

```bash
# Túnel: porta local 5433 -> 5432 do servidor. Deixe rodando num terminal.
ssh -N -L 5433:localhost:5432 plantoes-prod

# Em outro terminal — consulta ad-hoc com psql:
psql "$PLANTOES_RO_URL" -c "select count(*) from telegram_ingested_messages;"

# Ou one-liner abrindo e fechando o túnel automaticamente:
ssh -f -N -L 5433:localhost:5432 plantoes-prod && \
  psql "$PLANTOES_RO_URL" -c "select now();" ; \
  pkill -f 'ssh -f -N -L 5433:localhost:5432'
```

Para consultas estruturadas reutilizáveis, prefira scripts `tsx` no repo (rodados
**localmente** apontando `DATABASE_URL` para `$PLANTOES_RO_URL`), seguindo o padrão de
[db/index.ts](../db/index.ts) e dos scripts `list-telegram-*` em `scripts/`.

### 3.3 Trabalhar sobre uma cópia (quando precisar de análise pesada)

Para qualquer coisa custosa (agregações grandes, reprocessamento, testes contra dados
reais), **traga um dump para o Mac** em vez de pesar o servidor:

```bash
ssh plantoes-prod 'pg_dump -Fc -d plantoes' > /tmp/plantoes_$(date +%F).dump
# restaure num Postgres local e analise à vontade, sem tocar produção.
```

---

## 4. Deploy

### 4.1 Fluxo atual (sem build no EC2)

Deploy de produção é feito por imagem Docker imutável (`image@sha256`) gerada no
GitHub-hosted runner (ARM64). O host **não compila** e **não instala dependências Node**.

Fluxo:

1. PR: `.github/workflows/ci-pr.yml` valida lint/typecheck/test/build em `ubuntu-latest`.
2. Merge em `main`: `.github/workflows/release-deploy.yml` valida novamente, faz
  buildx `linux/arm64`, publica no GHCR e resolve digest.
3. O workflow conecta via SSH e chama script fixo no host:

```bash
sudo /usr/local/sbin/deploy-plantoes <image@sha256:...>
```

Esse script faz pull, valida arquitetura arm64, sobe candidato, checa health,
promove e faz rollback automático em falha.

### 4.2 Migrations — etapa explícita

Migração não roda em PR e não roda durante build de imagem. Quando necessário,
execute explicitamente com a própria imagem já publicada:

```bash
sudo /usr/local/sbin/deploy-plantoes <image@sha256:...> --run-migrations
```

Isso mantém o princípio: zero build/test/install Node na EC2.

---

## 5. Princípios

- **Produção serve, não compila nem edita.** Dev e build pesado moram no Mac.
- **Read-only por padrão** ao inspecionar produção (papel `plantoes_ro`, dumps).
- **Deploy por digest imutável**, sem depender de working tree git no host.
- **Segredos nunca no repo.** Use aliases SSH e variáveis de ambiente locais.
- **Cheque memória antes de qualquer operação no servidor** (`free -h`).

---

## 6. Incidente de memória (contexto)

Em 31/05/2026 um deploy derrubou o EC2 por build local (`next build`) sob pressão de
memória. O modelo atual remove essa classe de incidente ao eliminar build/test/install
Node no host de produção e adotar deploy por imagem ARM64 já pronta.
