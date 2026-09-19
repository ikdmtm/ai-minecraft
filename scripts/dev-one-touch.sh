#!/usr/bin/env bash
set -euo pipefail

BRANCH="${AI_MC_BRANCH:-revive/gameplay-first-jev}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="$ROOT_DIR/.minecraft-dev"
LOCK_HASH_FILE="$STATE_DIR/.package-lock.sha256"
GAMEPLAY_PID_FILE="$STATE_DIR/gameplay.pid"
VIEWER_VERSION="${GAMEPLAY_VIEWER_VERSION:-1.33.0}"
VIEWER_CANVAS_VERSION="${GAMEPLAY_VIEWER_CANVAS_VERSION:-3.1.0}"
MODE="${1:-reset}"
RESET_SEED="${2:-8675309}"

# Keep reset/start semantics. Old run.sh versions already forward "check" and
# re-exec this updated script after pulling; no separate manual git step needed.
case "$MODE" in
  reset|start|check|eval) ;;
  *) printf 'ERROR: Unknown mode %s. Use bash run.sh [continue|check|eval|reset SEED].\n' "$MODE" >&2; exit 64 ;;
esac

cd "$ROOT_DIR"
mkdir -p "$STATE_DIR"

# Also runs on failed preflight or failed evaluation; share one existing run log.
report_log() {
  if [[ -n "${AI_MC_RUN_LOG:-}" ]]; then
    printf '\n[AI Minecraft] 共有するログファイル: %s\n' "$AI_MC_RUN_LOG"
  fi
}
trap report_log EXIT

log() {
  printf '\n[AI Minecraft] %s\n' "$*"
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
  log "Code revision: $(git rev-parse --short HEAD)"
  if [[ "$before" != "$after" && "${AI_MC_REEXECED:-0}" != "1" ]]; then
    log "Updated launcher detected; restarting with newest launcher"
    exec env AI_MC_REEXECED=1 AI_MC_RUN_LOG="${AI_MC_RUN_LOG:-}" bash "$ROOT_DIR/scripts/dev-one-touch.sh" "$MODE" "$RESET_SEED"
  fi
}

ensure_system_dependencies() {
  local missing=()
  command -v curl >/dev/null 2>&1 || missing+=(curl)
  command -v jq >/dev/null 2>&1 || missing+=(jq)
  command -v java >/dev/null 2>&1 || missing+=(openjdk-21-jre-headless)
  command -v python3 >/dev/null 2>&1 || missing+=(python3)
  if (( ${#missing[@]} > 0 )); then
    log "Installing system dependencies: ${missing[*]}"
    sudo apt-get update
    sudo apt-get install -y "${missing[@]}"
  fi

  local node_major=0
  if command -v node >/dev/null 2>&1; then
    node_major="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
  fi
  if ! command -v npm >/dev/null 2>&1 || (( node_major < 22 )); then
    log "Installing Node.js 22 (required by current Mineflayer)"
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
    rm -f "$LOCK_HASH_FILE"
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

ensure_viewer_dependencies() {
  if [[ "${GAMEPLAY_VIEWER_ENABLED:-1}" == "0" ]]; then return; fi
  if node -e "require.resolve('prismarine-viewer'); require.resolve('canvas')" >/dev/null 2>&1; then return; fi

  local packages=(build-essential python3 pkg-config libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev)
  local missing=()
  for package in "${packages[@]}"; do
    dpkg -s "$package" >/dev/null 2>&1 || missing+=("$package")
  done
  if (( ${#missing[@]} > 0 )); then
    log "Installing viewer native dependencies: ${missing[*]}"
    sudo apt-get update
    sudo apt-get install -y "${missing[@]}"
  fi

  log "Installing local gameplay viewer + canvas"
  npm install --no-save --package-lock=false \
    "prismarine-viewer@${VIEWER_VERSION}" \
    "canvas@${VIEWER_CANVAS_VERSION}"
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

is_placeholder() {
  local value="$1"
  [[ -z "$value" || "$value" == "replace-me" || "$value" == "changeme" || "$value" == "sk-xxxxx" || "$value" == "sk-proj-xxxxx" ]]
}

ensure_secret() {
  local name="$1"
  local current
  current="$(sed -n "s/^${name}=//p" .env | head -n1 || true)"
  if ! is_placeholder "$current"; then return; fi

  local from_environment="${!name:-}"
  local key="$from_environment"
  if [[ -z "$key" ]]; then
    echo
    echo "First run only: enter ${name}. Input is hidden."
    read -r -s key
    echo
  fi
  if [[ -z "$key" ]]; then
    echo "ERROR: ${name} is required for gameplay mode." >&2
    exit 1
  fi
  set_env_value "$name" "$key"
  log "Saved ${name} to local .env (gitignored)"
}

ensure_env() {
  if [[ ! -f .env ]]; then
    log "First-time setup: creating .env"
    cp .env.example .env
  fi
  ensure_secret OPENAI_API_KEY
  # The policy resolves .env and inherited environment itself. Never overwrite
  # an explicit provider/model or disguise missing capabilities as a fallback.
  log "Keeping configured provider and models unchanged"
}

check_gameplay() {
  log "Checking configured gameplay capabilities before any world/server changes"
  local report status alternative reply
  if report="$(npm run --silent check:gameplay)"; then
    printf '%s\n' "$report"
    log "Static interface check passed; remote authentication and gameplay are not yet verified"
    return 0
  else
    status=$?
  fi
  printf '%s\n' "$report"

  # Only the isolated trial offers an explicitly confirmed, process-local
  # alternative. Never rewrite .env or silently downgrade the configured path.
  if [[ "$MODE" == "eval" && "$status" == "2" ]] &&
      jq -e '.effectiveProvider == "jev" and .issues == ["configured_adapter_missing_autonomy_tasks"]' \
        >/dev/null 2>&1 <<< "$report"; then
    if alternative="$(POLICY_PROVIDER=openai npm run --silent check:gameplay)"; then
      printf '\n%s\n' \
        '[AI Minecraft] 現在のJEV接続実装では、手順保存・記憶検索などが未対応です。' \
        '今回の隔離60秒テストだけ、設定済みOpenAIモデルで実行することはできます。' \
        '.envや通常起動の設定は変更しません。モデルAPIの利用料金は発生し得ます。' \
        '時間制限は金額の上限ではありません。'
      printf '%s\n' "$alternative"
      printf '[AI Minecraft] 今回だけOpenAI経路を使用しますか？ [y/N]: '
      if read -r reply && [[ "$reply" == "y" || "$reply" == "Y" ]]; then
        export POLICY_PROVIDER=openai
        log "Operator approved OpenAI for this isolated trial only; .env unchanged"
        return 0
      fi
      log "接続経路を変更せず停止します（明示的な承認なし）。"
    fi
  fi

  printf '\n[AI Minecraft] 起動前確認で停止しました（終了コード %s）。\n' "$status" >&2
  printf '%s\n' \
    'ワールドのリセット・サーバーの起動/停止・AIの起動は行っていません。記憶DBも変更していません。' \
    '上の issues / missingTasks と、この実行ログを共有してください。' \
    '.env やAPIキーそのものは共有不要です。' >&2
  return "$status"
}

run_evaluation() {
  log "Starting isolated 60-second trial; the existing world and memory DB are not modified"
  log "Uses configured model APIs; the time bound is not a spending limit"
  # eval:gameplay owns its fresh server/port, memory backup, diagnostics and
  # cleanup. Do not call mc:setup/reset/start or stop_previous_gameplay here.
  local status
  if npm run eval:gameplay -- --run --seconds=60; then
    log "試験プロセスが終了しました。自律プレイの成功判定はログ確認後です。"
    return 0
  else
    status=$?
  fi
  if [[ "$status" == "124" ]]; then
    log "60秒の試験時間上限で終了しました（正常に遊べたという判定ではありません）。"
  else
    log "試験が停止しました（終了コード $status）。ログを共有してください。"
  fi
  return "$status"
}

ensure_minecraft_server() {
  if [[ ! -f "$STATE_DIR/server/server.jar" ]]; then
    log "First-time setup: preparing local Minecraft server"
    npm run mc:setup
  fi
  if [[ "$MODE" == "reset" ]]; then
    log "Resetting Hardcore world with fixed seed $RESET_SEED"
    # Reset and start are deliberately separate. Keeping the Java server out of
    # the npm reset process prevents a detached server from holding that command open.
    MC_RESET_NO_START=1 bash "$ROOT_DIR/scripts/mc-reset-local.sh" "$RESET_SEED"
    bash "$ROOT_DIR/scripts/mc-start-local.sh"
  else
    log "Starting Minecraft server if needed"
    bash "$ROOT_DIR/scripts/mc-start-local.sh"
  fi

  log "Minecraft server is ready; continuing to gameplay runtime"
}

stop_previous_gameplay() {
  [[ -f "$GAMEPLAY_PID_FILE" ]] || return 0
  local old_pid
  old_pid="$(cat "$GAMEPLAY_PID_FILE" 2>/dev/null || true)"
  if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
    local cmdline=""
    [[ -r "/proc/$old_pid/cmdline" ]] && cmdline="$(tr '\0' ' ' < "/proc/$old_pid/cmdline")"
    if [[ "$cmdline" == *"dev-one-touch.sh"* || "$cmdline" == *"run.sh"* ]]; then
      log "Stopping previous gameplay launcher (pid=$old_pid)"
      kill "$old_pid" 2>/dev/null || true
      sleep 0.3
      kill -9 "$old_pid" 2>/dev/null || true
    fi
  fi
  rm -f "$GAMEPLAY_PID_FILE"
}

run_gameplay() {
  stop_previous_gameplay
  log "Launching gameplay AI with the checked provider and model settings"
  log "Close this terminal or press Ctrl+C to stop the AI. Minecraft server stays running."
  [[ -n "${AI_MC_RUN_LOG:-}" ]] && log "Share this run log when reporting behavior: $AI_MC_RUN_LOG"
  echo "$$" > "$GAMEPLAY_PID_FILE"
  trap 'rm -f "$GAMEPLAY_PID_FILE"; report_log' EXIT INT TERM
  npm run start:gameplay
}

sync_repository
ensure_system_dependencies
ensure_node_modules
# check is update-and-inspect only: no .env creation, secret prompt, viewer,
# world setup/reset/start, previous-runtime stop, or gameplay launch.
if [[ "$MODE" == "check" ]]; then
  check_gameplay
  log "確認のみ完了しました。ゲームは開始していません。"
  exit 0
fi
ensure_env
check_gameplay
if [[ "$MODE" == "eval" ]]; then
  run_evaluation
  exit 0
fi
ensure_viewer_dependencies
ensure_minecraft_server
run_gameplay
