#!/usr/bin/env bash
# Cadastra no GitHub os secrets usados para assinar o APK nos releases.
# Lê a chave e as senhas da pasta local (fora do repositório). Nada é exibido na tela.
# Uso: bash scripts/set-release-secrets.sh [pasta-da-chave] [owner/repo]
set -euo pipefail
DIR="${1:-$HOME/.diakoplayer-signing}"
REPO="${2:-antunesls/DiakoPlayer}"

[ -f "$DIR/release.jks" ] && [ -f "$DIR/credenciais.env" ] || { echo "Chave não encontrada em $DIR"; exit 1; }
set -a; . "$DIR/credenciais.env"; set +a

base64 -w0 "$DIR/release.jks" | gh secret set DIAKOPLAYER_KEYSTORE_BASE64 -R "$REPO"
printf '%s' "$DIAKOPLAYER_STORE_PASSWORD" | gh secret set DIAKOPLAYER_STORE_PASSWORD -R "$REPO"
printf '%s' "$DIAKOPLAYER_KEY_PASSWORD"   | gh secret set DIAKOPLAYER_KEY_PASSWORD -R "$REPO"
printf '%s' "$DIAKOPLAYER_KEY_ALIAS"      | gh secret set DIAKOPLAYER_KEY_ALIAS -R "$REPO"
gh secret list -R "$REPO"
