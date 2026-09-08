#!/usr/bin/env bash
# Triagem de disco cheio no servidor magalu — RODE NO MAC, não no servidor.
#
# Padrão: só leitura (df/du/ls). Nada é apagado sem `--limpar`.
# Uso:
#   bash scripts/diagnose-disk-magalu.sh                    # diagnóstico
#   bash scripts/diagnose-disk-magalu.sh --limpar           # + faxina segura
#   bash scripts/diagnose-disk-magalu.sh --limpar --incluir-next-prev
#
# Host SSH configurável (default: alias `magalu` do ~/.ssh/config):
#   MAGALU_HOST=outro-alias bash scripts/diagnose-disk-magalu.sh
set -euo pipefail

HOST="${MAGALU_HOST:-magalu}"
APP_DIR="${MAGALU_APP_DIR:-/home/ubuntu/plantoes}"
BACKUP_DIR="${MAGALU_BACKUP_DIR:-/home/ubuntu/backups/plantoes-predeploy}"
LIMPAR=0
INCLUIR_NEXT_PREV=0

for arg in "$@"; do
  case "$arg" in
    --limpar) LIMPAR=1 ;;
    --incluir-next-prev) INCLUIR_NEXT_PREV=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "argumento desconhecido: $arg" >&2; exit 2 ;;
  esac
done

echo "=== host: $HOST · app: $APP_DIR ==="

# --------------------------------------------------------------------------
# 1. Diagnóstico (read-only). Um único SSH e um único `du` por área: o servidor
#    é compartilhado com ~10 projetos, não vale varrer o filesystem inteiro.
# --------------------------------------------------------------------------
ssh "$HOST" APP_DIR="$APP_DIR" BACKUP_DIR="$BACKUP_DIR" 'bash -s' <<'REMOTO'
set -uo pipefail

secao() { printf "\n----- %s -----\n" "$1"; }

secao "df (filesystems reais)"
df -h -x tmpfs -x devtmpfs -x overlay 2>/dev/null

secao "inodes (disco 'cheio' com poucos bytes usados = inode esgotado)"
df -i -x tmpfs -x devtmpfs -x overlay 2>/dev/null

secao "maiores diretórios em / (1 nível, sem cruzar mount)"
sudo -n du -xh --max-depth=1 / 2>/dev/null | sort -rh | head -15 \
  || du -xh --max-depth=1 / 2>/dev/null | sort -rh | head -15

secao "maiores diretórios em /home (2 níveis)"
du -xh --max-depth=2 /home 2>/dev/null | sort -rh | head -20

secao "logs do PM2 (~/.pm2/logs)"
du -sh ~/.pm2/logs 2>/dev/null
ls -lhS ~/.pm2/logs 2>/dev/null | head -15

secao "builds do Next no app"
for d in .next .next.prev .next.build node_modules/.cache node_modules; do
  [ -e "$APP_DIR/$d" ] && du -sh "$APP_DIR/$d" 2>/dev/null
done

secao "backups pré-deploy"
du -sh "$BACKUP_DIR" 2>/dev/null
ls -lht "$BACKUP_DIR" 2>/dev/null | head -12

secao "cache do npm"
du -sh ~/.npm 2>/dev/null

secao "journald"
journalctl --disk-usage 2>/dev/null

secao "/var/log (maiores)"
sudo -n du -xh --max-depth=1 /var/log 2>/dev/null | sort -rh | head -10 \
  || du -xh --max-depth=1 /var/log 2>/dev/null | sort -rh | head -10

secao "docker (outros projetos dividem este host)"
if command -v docker >/dev/null 2>&1; then
  docker system df 2>/dev/null || echo "(sem permissão para falar com o daemon)"
else
  echo "(docker não instalado)"
fi

secao "postgres"
sudo -n du -sh /var/lib/postgresql 2>/dev/null || echo "(precisa de sudo)"

secao "arquivos maiores que 500MB"
sudo -n find / -xdev -type f -size +500M -printf '%s\t%p\n' 2>/dev/null \
  | sort -rn | head -15 | awk -F'\t' '{printf "%.1f GB\t%s\n", $1/1073741824, $2}' \
  || echo "(precisa de sudo)"

# Clássico do disco cheio: log apagado com `rm` enquanto o processo ainda o
# mantém aberto. O `du` não vê mais o arquivo, o `df` continua contando.
secao "arquivos grandes apagados mas ainda abertos (espaço não liberado)"
sudo -n lsof -nP 2>/dev/null \
  | awk '/deleted/ && $8+0 > 104857600 {printf "%.1f MB\t%s\t%s\n", $8/1048576, $1, $10}' \
  | sort -rn | head -10 || echo "(precisa de sudo/lsof)"

secao "saúde do app"
pm2 status 2>/dev/null | head -20
curl -fsS -o /dev/null -w 'health: %{http_code}\n' http://127.0.0.1:3004/api/health 2>/dev/null \
  || echo "health: NÃO RESPONDEU"
REMOTO

if [ "$LIMPAR" -eq 0 ]; then
  cat <<'FIM'

=== diagnóstico concluído (nada foi apagado) ===
Para recuperar espaço com as ações seguras, rode:
  bash scripts/diagnose-disk-magalu.sh --limpar
FIM
  exit 0
fi

# --------------------------------------------------------------------------
# 2. Faxina. Só o que é reconstruível e não interrompe a produção.
#    Fora daqui de propósito: /var/lib/postgresql, dados de outros projetos do
#    host, e o `.next` que o processo no ar está servindo.
# --------------------------------------------------------------------------
echo
echo "=== faxina segura em $HOST ==="
if [ "$INCLUIR_NEXT_PREV" -eq 1 ]; then
  echo "ATENÇÃO: .next.prev incluído — o rollback instantâneo do último deploy se perde."
fi
read -r -p "confirmar? [s/N] " resposta
case "$resposta" in s|S|sim|SIM) ;; *) echo "abortado."; exit 0 ;; esac

ssh "$HOST" APP_DIR="$APP_DIR" BACKUP_DIR="$BACKUP_DIR" \
    INCLUIR_NEXT_PREV="$INCLUIR_NEXT_PREV" 'bash -s' <<'REMOTO'
set -uo pipefail
antes=$(df --output=avail -BM / | tail -1 | tr -dc '0-9')

echo "-> pm2 flush (zera os logs sem derrubar os processos)"
pm2 flush >/dev/null 2>&1 && echo "   ok" || echo "   falhou"

echo "-> logs rotacionados do pm2 com mais de 7 dias"
find ~/.pm2/logs -type f \( -name '*.log.*' -o -name '*.gz' \) -mtime +7 -print -delete 2>/dev/null \
  | wc -l | xargs echo "   removidos:"

echo "-> restos de build interrompido (.next.build)"
rm -rf "$APP_DIR/.next.build" && echo "   ok"

echo "-> cache de build (node_modules/.cache)"
rm -rf "$APP_DIR/node_modules/.cache" && echo "   ok"

echo "-> cache do npm"
npm cache clean --force >/dev/null 2>&1 && echo "   ok" || echo "   falhou"

echo "-> backups pré-deploy além dos 5 mais recentes"
ls -t "$BACKUP_DIR"/db-*.sql.gz 2>/dev/null | tail -n +6 | tee /dev/stderr | xargs -r rm

echo "-> journald acima de 200M"
sudo -n journalctl --vacuum-size=200M 2>/dev/null | tail -2 || echo "   (precisa de sudo)"

if [ "${INCLUIR_NEXT_PREV:-0}" = "1" ]; then
  echo "-> .next.prev (build anterior — rollback instantâneo se perde)"
  rm -rf "$APP_DIR/.next.prev" && echo "   ok"
fi

depois=$(df --output=avail -BM / | tail -1 | tr -dc '0-9')
echo
echo "espaço livre em /: ${antes}M -> ${depois}M (recuperado: $((depois - antes))M)"
df -h /
echo
curl -fsS -o /dev/null -w 'health após faxina: %{http_code}\n' http://127.0.0.1:3004/api/health 2>/dev/null \
  || echo "health após faxina: NÃO RESPONDEU"
REMOTO
