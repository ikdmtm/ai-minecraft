#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if (( $# == 0 )); then
  set -- start
fi

exec bash "$ROOT_DIR/scripts/dev-one-touch.sh" "$@"
