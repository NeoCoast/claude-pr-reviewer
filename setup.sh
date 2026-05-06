#!/usr/bin/env bash
# setup.sh — generates smee URL, creates .env, and registers GitHub webhooks
# for every repo listed in config.json

set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly ENV_FILE="$SCRIPT_DIR/.env"
readonly CONFIG_FILE="$SCRIPT_DIR/config.json"

# ─── Logging ──────────────────────────────────────────────────────────────────

log_info()  { echo "[$(date +'%Y-%m-%d %H:%M:%S')] INFO  $*"; }
log_warn()  { echo "[$(date +'%Y-%m-%d %H:%M:%S')] WARN  $*" >&2; }
log_error() { echo "[$(date +'%Y-%m-%d %H:%M:%S')] ERROR $*" >&2; }

# ─── Prerequisites ────────────────────────────────────────────────────────────

check_dependencies() {
  local -a missing=()
  local -a required=(gh node curl openssl)

  for cmd in "${required[@]}"; do
    command -v "$cmd" &>/dev/null || missing+=("$cmd")
  done

  if [[ ${#missing[@]} -gt 0 ]]; then
    log_error "Missing required commands: ${missing[*]}"
    exit 1
  fi
}

check_dependencies

if [[ ! -f "$CONFIG_FILE" ]]; then
  log_error "config.json not found — copy config.example.json to config.json and edit it"
  exit 1
fi

# Read repos array from config.json
mapfile -t REPOS < <(node -e "
  const cfg = require('$CONFIG_FILE');
  if (!Array.isArray(cfg.repos) || cfg.repos.length === 0) {
    process.stderr.write('ERROR: config.json repos array is empty\n');
    process.exit(1);
  }
  cfg.repos.forEach(r => console.log(r));
")

readonly REPO_COUNT="${#REPOS[@]}"

# ─── Smee URL ─────────────────────────────────────────────────────────────────

SMEE_URL=""
WEBHOOK_SECRET=""

if [[ -f "$ENV_FILE" ]] && grep -q "^SMEE_URL=" "$ENV_FILE"; then
  SMEE_URL="$(grep "^SMEE_URL=" "$ENV_FILE" | cut -d= -f2-)"
  log_info "Reusing SMEE_URL: $SMEE_URL"
else
  log_info "Creating smee.io channel..."
  SMEE_URL="$(curl -Ls --max-time 15 -o /dev/null -w '%{url_effective}' https://smee.io/new)"

  if [[ -z "$SMEE_URL" || "$SMEE_URL" == "https://smee.io/new" ]]; then
    log_error "Failed to create smee.io channel — check network connectivity"
    exit 1
  fi

  if [[ ! "$SMEE_URL" =~ ^https://smee\.io/.+ ]]; then
    log_error "Unexpected smee.io URL format: $SMEE_URL"
    exit 1
  fi

  log_info "Channel created: $SMEE_URL"
fi

# ─── Webhook secret ───────────────────────────────────────────────────────────

if [[ -f "$ENV_FILE" ]] && grep -q "^WEBHOOK_SECRET=" "$ENV_FILE"; then
  WEBHOOK_SECRET="$(grep "^WEBHOOK_SECRET=" "$ENV_FILE" | cut -d= -f2-)"
  log_info "Reusing WEBHOOK_SECRET"
else
  WEBHOOK_SECRET="$(openssl rand -hex 32)"
  log_info "Generated new WEBHOOK_SECRET"
fi

# Write .env atomically
TMPENV="$(mktemp)"
trap 'rm -f -- "$TMPENV"' EXIT

cat > "$TMPENV" <<EOF
SMEE_URL=$SMEE_URL
WEBHOOK_SECRET=$WEBHOOK_SECRET
EOF
mv "$TMPENV" "$ENV_FILE"
trap - EXIT

log_info ".env saved to $ENV_FILE"
echo ""

# ─── Register webhooks ────────────────────────────────────────────────────────

log_info "Registering webhooks in $REPO_COUNT repo(s)..."
echo ""

SUCCESS=0; SKIP=0; FAIL=0

for FULL_REPO in "${REPOS[@]}"; do
  [[ -z "$FULL_REPO" ]] && continue

  EXISTING="$(gh api "repos/$FULL_REPO/hooks" 2>/dev/null \
    | node -e "
        process.stdin.resume();
        const chunks = [];
        process.stdin.on('data', c => chunks.push(c));
        process.stdin.on('end', () => {
          try {
            const hooks = JSON.parse(chunks.join(''));
            const h = Array.isArray(hooks) && hooks.find(h => h.config && h.config.url === process.argv[1]);
            process.stdout.write(h ? String(h.id) : '');
          } catch { process.stdout.write(''); }
        });
      " "$SMEE_URL" 2>/dev/null || echo "")"

  if [[ -n "$EXISTING" ]]; then
    log_info "  ⏭  $FULL_REPO — already registered (id: $EXISTING)"
    (( SKIP++ )) || true
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
    log_info "  ✅ $FULL_REPO"
    (( SUCCESS++ )) || true
  else
    log_warn "  ❌ $FULL_REPO — check gh auth and repo access"
    (( FAIL++ )) || true
  fi
done

echo ""
echo "────────────────────────────────────────"
log_info "Done: $SUCCESS created · $SKIP skipped · $FAIL failed"
echo ""
echo "Next:"
echo "  npm install"
echo "  node server.js          # foreground"
echo "  pm2 start server.js     # background (recommended)"
