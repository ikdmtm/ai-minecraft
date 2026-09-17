#!/usr/bin/env bash
set -euo pipefail

BRANCH="${AI_MC_BRANCH:-revive/gameplay-first-jev}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="$ROOT_DIR/.minecraft-dev"
LOCK_HASH_FILE="$STATE_DIR/.package-lock.sha256"
GAMEPLAY_PID_FILE="$STATE_DIR/gameplay.pid"
VIEWER_VERSION="${GAMEPLAY_VIEWER_VERSION:-1.33.0}"
VIEWER_CANVAS_VERSION="${GAMEPLAY_VIEWER_CANVAS_VERSION:-3.1.0}"
MODE="${1:-start}"
RESET_SEED="${2:-8675309}"

cd "$ROOT_DIR"
mkdir -p "$STATE_DIR"

log() {
  printf '\n[AI Minecraft] %s\n' "$*"
}

ensure_system_dependencies() {
  local missing=()
  command -v curl >/dev/null 2>&1 || missing+=(curl)
  command -v jq >/dev/null 2>&1 || missing+=(jq)
  command -v java >/dev/null 2>&1 || missing+=(openjdk-21-jre-headless)

  if (( ${#missing[@]} > 0 )); then
    log "First-time setup: installing ${missing[*]}"
    sudo apt-get update
    sudo apt-get install -y "${missing[@]}"
  fi

  local node_major=0
  if command -v node >/dev/null 2>&1; then
    node_major="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
  fi

  if ! command -v npm >/dev/null 2>&1 || (( node_major < 20 )); then
    log "First-time setup: installing Node.js 20"
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
  fi
}

sync_repository() {
  log "Syncing $BRANCH from GitHub"

  local stashed=0
  if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
    log "Local source changes detected; temporarily stashing them"
    git stash push -u -m "one-touch auto-stash $(date -Iseconds)" >/dev/null
    stashed=1
  fi

  local before
  before="$(git rev-parse HEAD)"

  git fetch origin "$BRANCH"
  if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
    git switch "$BRANCH" >/dev/null
  else
    git switch -c "$BRANCH" --track "origin/$BRANCH" >/dev/null
  fi
  git pull --ff-only origin "$BRANCH"

  if (( stashed == 1 )); then
    if ! git stash pop; then
      echo "ERROR: Automatic stash restore conflicted. Resolve the conflict before continuing." >&2
      exit 1
    fi
  fi

  local after
  after="$(git rev-parse HEAD)"
  if [[ "$before" != "$after" && "${AI_MC_REEXECED:-0}" != "1" ]]; then
    log "Updated launcher detected; restarting with the newest script"
    exec env AI_MC_REEXECED=1 bash "$ROOT_DIR/scripts/dev-one-touch.sh" "$MODE" "$RESET_SEED"
  fi
}

ensure_node_modules() {
  local current_hash
  current_hash="$(sha256sum package-lock.json | awk '{print $1}')"
  local saved_hash=""
  [[ -f "$LOCK_HASH_FILE" ]] && saved_hash="$(cat "$LOCK_HASH_FILE")"

  if [[ ! -d node_modules || "$current_hash" != "$saved_hash" ]]; then
    log "Installing/updating Node dependencies"
    npm ci
    printf '%s\n' "$current_hash" > "$LOCK_HASH_FILE"
  else
    log "Node dependencies are already current"
  fi
}

ensure_viewer_system_dependencies() {
  local packages=(
    build-essential
    python3
    pkg-config
    libcairo2-dev
    libpango1.0-dev
    libjpeg-dev
    libgif-dev
    librsvg2-dev
  )
  local missing=()

  for package in "${packages[@]}"; do
    dpkg -s "$package" >/dev/null 2>&1 || missing+=("$package")
  done

  if (( ${#missing[@]} > 0 )); then
    log "Installing viewer native dependencies: ${missing[*]}"
    sudo apt-get update
    sudo apt-get install -y "${missing[@]}"
  fi
}

ensure_viewer_dependency() {
  if [[ "${GAMEPLAY_VIEWER_ENABLED:-1}" == "0" ]]; then
    return
  fi

  if node -e "require.resolve('prismarine-viewer'); require.resolve('canvas')" >/dev/null 2>&1; then
    return
  fi

  ensure_viewer_system_dependencies

  log "Installing local gameplay viewer + canvas"
  npm install --no-save --package-lock=false \
    "prismarine-viewer@${VIEWER_VERSION}" \
    "canvas@${VIEWER_CANVAS_VERSION}"

  node -e "require('prismarine-viewer'); require('canvas')" >/dev/null
}

set_env_value() {
  local name="$1"
  local value="$2"
  if grep -q "^${name}=" .env; then
    sed -i "s|^${name}=.*|${name}=${value}|" .env
  else
    printf '\n%s=%s\n' "$name" "$value" >> .env
  fi
}

is_placeholder_key() {
  local value="$1"
  [[ -z "$value" || "$value" == "changeme" || "$value" == "sk-xxxxx" || "$value" == "sk-proj-xxxxx" || "$value" == "sk-ant-xxxxx" ]]
}

is_valid_openai_key() {
  local value="$1"
  [[ "$value" == sk-* && "$value" != *" "* ]]
}

is_valid_anthropic_key() {
  local value="$1"
  [[ "$value" == sk-ant-* && "$value" != *" "* ]]
}

ensure_env() {
  if [[ ! -f .env ]]; then
    log "First-time setup: creating .env"
    cp .env.example .env
  fi

  local provider
  provider="$(sed -n 's/^LLM_PROVIDER=//p' .env | head -n1 | tr '[:upper:]' '[:lower:]' || true)"
  local anthropic_key
  anthropic_key="$(sed -n 's/^ANTHROPIC_API_KEY=//p' .env | head -n1 || true)"
  local openai_key
  openai_key="$(sed -n 's/^OPENAI_API_KEY=//p' .env | head -n1 || true)"

  if [[ -z "$provider" ]] || { [[ "$provider" == "anthropic" ]] && is_placeholder_key "$anthropic_key"; }; then
    provider="openai"
    set_env_value LLM_PROVIDER openai
    log "Using OpenAI for gameplay cognition"
  fi

  case "$provider" in
    openai)
      if ! is_valid_openai_key "$openai_key"; then
        if [[ -n "$openai_key" ]] && ! is_placeholder_key "$openai_key"; then
          log "Existing OPENAI_API_KEY is not a valid key format; replacing it"
        fi
        local key="${OPENAI_API_KEY:-}"
        if [[ -z "$key" ]]; then
          echo
          echo "First run only: enter OPENAI_API_KEY. Input is hidden."
          read -r -s key
          echo
        fi
        if ! is_valid_openai_key "$key"; then
          echo "ERROR: OPENAI_API_KEY must look like an OpenAI secret key (sk-...)." >&2
          exit 1
        fi
        set_env_value OPENAI_API_KEY "$key"
        log "Saved OpenAI API key to local .env (gitignored)"
      fi
      ;;
    anthropic)
      if ! is_valid_anthropic_key "$anthropic_key"; then
        local key="${ANTHROPIC_API_KEY:-}"
        if [[ -z "$key" ]]; then
          echo
          echo "First run only: enter ANTHROPIC_API_KEY. Input is hidden."
          read -r -s key
          echo
        fi
        if ! is_valid_anthropic_key "$key"; then
          echo "ERROR: ANTHROPIC_API_KEY must look like sk-ant-..." >&2
          exit 1
        fi
        set_env_value ANTHROPIC_API_KEY "$key"
        log "Saved Anthropic API key to local .env (gitignored)"
      fi
      ;;
    *)
      echo "ERROR: Unsupported LLM_PROVIDER '$provider'. Use openai or anthropic." >&2
      exit 1
      ;;
  esac
}

ensure_minecraft_server() {
  if [[ ! -f "$STATE_DIR/server/server.jar" ]]; then
    log "First-time setup: preparing local Minecraft server"
    npm run mc:setup
  fi

  if [[ "$MODE" == "reset" ]]; then
    log "Resetting Hardcore world with fixed seed $RESET_SEED"
    npm run mc:reset -- "$RESET_SEED"
  else
    log "Starting Minecraft server if needed"
    npm run mc:start
  fi
}

stop_previous_gameplay() {
  if [[ ! -f "$GAMEPLAY_PID_FILE" ]]; then
    return
  fi

  local old_pid
  old_pid="$(cat "$GAMEPLAY_PID_FILE" 2>/dev/null || true)"
  if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
    local cmdline=""
    if [[ -r "/proc/$old_pid/cmdline" ]]; then
      cmdline="$(tr '\0' ' ' < "/proc/$old_pid/cmdline")"
    fi

    if [[ "$cmdline" == *"dev-one-touch.sh"* || "$cmdline" == *"run.sh"* ]]; then
      log "Stopping previous gameplay launcher (pid=$old_pid)"
      kill "$old_pid" 2>/dev/null || true
      for _ in {1..20}; do
        kill -0 "$old_pid" 2>/dev/null || break
        sleep 0.1
      done
      kill -9 "$old_pid" 2>/dev/null || true
    else
      log "Ignoring stale gameplay PID $old_pid (belongs to another process)"
    fi
  fi
  rm -f "$GAMEPLAY_PID_FILE"
}

run_gameplay() {
  stop_previous_gameplay

  log "Launching gameplay-only AI"
  log "Close this terminal or press Ctrl+C to stop the AI. The Minecraft server stays running."

  echo "$$" > "$GAMEPLAY_PID_FILE"
  trap 'rm -f "$GAMEPLAY_PID_FILE"' EXIT INT TERM

  npm run start:gameplay
}

ensure_system_dependencies
sync_repository
ensure_node_modules
ensure_viewer_dependency
ensure_env
ensure_minecraft_server
run_gameplay
