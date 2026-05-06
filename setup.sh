#!/usr/bin/env bash
# setup.sh — generates smee URL, creates .env, and registers GitHub webhooks
# for every repo listed in config.json

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$ROOT/.env"
CONFIG_FILE="$ROOT/config.json"

# ─── Prerequisites ────────────────────────────────────────────────────────────

for cmd in gh node curl openssl; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "❌ '$cmd' not found — please install it first"
    exit 1
  fi
done

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "❌ config.json not found — copy config.example.json to config.json and edit it"
  exit 1
fi

# Read repos array from config.json
REPOS=$(node -e "console.log(require('$CONFIG_FILE').repos.join('\n'))")
REPO_COUNT=$(echo "$REPOS" | wc -l | tr -d ' ')

# ─── Smee URL ─────────────────────────────────────────────────────────────────

if [[ -f "$ENV_FILE" ]] && grep -q "^SMEE_URL=" "$ENV_FILE"; then
  set -a; source "$ENV_FILE"; set +a
  echo "✅ Reusing SMEE_URL: $SMEE_URL"
else
  echo "🔗 Creating smee.io channel..."
  SMEE_URL=$(curl -Ls -o /dev/null -w '%{url_effective}' https://smee.io/new)
  [[ -z "$SMEE_URL" || "$SMEE_URL" == "https://smee.io/new" ]] && {
    echo "❌ Failed to create smee.io channel"
    exit 1
  }
  echo "✅ Channel: $SMEE_URL"
fi

# ─── Webhook secret ───────────────────────────────────────────────────────────

if [[ -z "${WEBHOOK_SECRET:-}" ]]; then
  WEBHOOK_SECRET=$(openssl rand -hex 32)
  echo "✅ Generated WEBHOOK_SECRET"
else
  echo "✅ Reusing WEBHOOK_SECRET"
fi

# Write .env
cat > "$ENV_FILE" <<EOF
SMEE_URL=$SMEE_URL
WEBHOOK_SECRET=$WEBHOOK_SECRET
EOF
echo ""
echo "📝 .env saved"
echo ""

# ─── Register webhooks ────────────────────────────────────────────────────────

echo "🔧 Registering webhooks in $REPO_COUNT repos..."
echo ""

SUCCESS=0; SKIP=0; FAIL=0

while IFS= read -r FULL_REPO; do
  [[ -z "$FULL_REPO" ]] && continue

  EXISTING=$(gh api "repos/$FULL_REPO/hooks" 2>/dev/null \
    | node -e "
        const d = require('fs').readFileSync('/dev/stdin','utf8');
        const h = JSON.parse(d).find(h => h.config?.url === '$SMEE_URL');
        console.log(h ? h.id : '');
      " 2>/dev/null || echo "")

  if [[ -n "$EXISTING" ]]; then
    echo "  ⏭  $FULL_REPO — already registered (id: $EXISTING)"
    ((SKIP++)) || true
    continue
  fi

  if gh api "repos/$FULL_REPO/hooks" \
    --method POST \
    --field "name=web" \
    --field "active=true" \
    --field "events[]=pull_request" \
    --field "config[url]=$SMEE_URL" \
    --field "config[content_type]=json" \
    --field "config[secret]=$WEBHOOK_SECRET" \
    --field "config[insecure_ssl]=0" \
    --silent 2>&1; then
    echo "  ✅ $FULL_REPO"
    ((SUCCESS++)) || true
  else
    echo "  ❌ $FULL_REPO — check gh auth and repo access"
    ((FAIL++)) || true
  fi
done <<< "$REPOS"

echo ""
echo "────────────────────────────────────────"
echo "Done: $SUCCESS created · $SKIP skipped · $FAIL failed"
echo ""
echo "Next:"
echo "  npm install"
echo "  node server.js          # foreground"
echo "  pm2 start server.js     # background (recommended)"
