#!/usr/bin/env bash
set -euo pipefail

echo "[deploy][ERROR] Deploy legado via build local no host foi desativado."
echo "[deploy][ERROR] Use o pipeline GitHub Actions para publicar imagem ARM64 no GHCR e chamar /usr/local/sbin/deploy-plantoes com imagem@digest."
exit 1
