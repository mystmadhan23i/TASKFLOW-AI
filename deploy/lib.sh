#!/usr/bin/env bash
# Shared helpers for the blue/green scripts. Source this file; do not execute it.
# shellcheck shell=bash

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_FILE="${STATE_FILE:-$DEPLOY_DIR/state/active.conf}"
[ -f "$DEPLOY_DIR/.env" ] && { set -a; . "$DEPLOY_DIR/.env"; set +a; }

EDGE_PORT="${EDGE_PORT:-80}"
PROBES_PER_BATCH="${PROBES_PER_BATCH:-5}"
PROBE_INTERVAL="${PROBE_INTERVAL:-1}"
SOAK_BATCHES="${SOAK_BATCHES:-6}"
POST_SWITCH_BATCHES="${POST_SWITCH_BATCHES:-3}"
AUTO_ROLLBACK="${AUTO_ROLLBACK:-1}"
PREVIEW_URL="${PREVIEW_URL:-http://127.0.0.1:8081}"

log()  { printf '\033[1;34m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "'$1' is required but not installed."; }

other_color() { [ "$1" = blue ] && echo green || echo blue; }

# Prints the colour currently receiving traffic ("blue"/"green"), or nothing if unset.
active_color() {
  [ -f "$STATE_FILE" ] || return 0
  sed -n 's/.*taskflow-\(blue\|green\)-web.*/\1/p' "$STATE_FILE" | head -n1
}

# Atomically point the edge proxy at a colour and reload nginx.
set_active() {
  local color="$1" tmp
  tmp="$(mktemp "$DEPLOY_DIR/state/.active.XXXXXX")"
  printf '# Managed by deploy.sh — which colour receives public traffic.\nset $active_upstream taskflow-%s-web;\n' "$color" > "$tmp"
  chmod 644 "$tmp"
  mv "$tmp" "$STATE_FILE"
  docker exec taskflow-edge nginx -t >/dev/null 2>&1 || die "nginx config test failed after switching to $color"
  docker exec taskflow-edge nginx -s reload >/dev/null
}

compose_app() { # compose_app <color> <version> <docker compose args...>
  local color="$1" version="$2"; shift 2
  local envfile=(); [ -f "$DEPLOY_DIR/.env" ] && envfile=(--env-file "$DEPLOY_DIR/.env")
  COLOR="$color" APP_VERSION="$version" docker compose -p "taskflow-$color" "${envfile[@]}" -f "$DEPLOY_DIR/docker-compose.app.yml" "$@"
}

# p95 (nearest-rank) of the numbers given as arguments.
p95() {
  [ "$#" -gt 0 ] || { echo 0; return; }
  printf '%s\n' "$@" | sort -n | awk '{a[NR]=$1} END{i=int(0.95*NR); if (i<0.95*NR) i++; if (i<1) i=1; print a[i]}'
}

# probe_batch <base-url> <count>  ->  sets BATCH_ERR (%), BATCH_P95 (ms), BATCH_FAILS
probe_batch() {
  local base="$1" count="$2" i out code t ms lat=() fails=0
  for ((i = 0; i < count; i++)); do
    out="$(curl -s -o /dev/null -m 5 -w '%{http_code} %{time_total}' "$base/api/health" 2>/dev/null)" || out="000 5"
    code="${out% *}"; t="${out#* }"
    ms="$(awk -v t="$t" 'BEGIN{printf "%d", t*1000}')"
    [ "$code" = 200 ] || fails=$((fails + 1))
    lat+=("$ms")
    [ "$i" -lt $((count - 1)) ] && sleep "$PROBE_INTERVAL"
  done
  BATCH_FAILS="$fails"
  BATCH_ERR="$(awk -v f="$fails" -v n="$count" 'BEGIN{printf "%.2f", f*100/n}')"
  BATCH_P95="$(p95 "${lat[@]}")"
}

# Container resource usage as "<cpu> <mem>" integers (percent, capped at 100).
container_usage() {
  docker stats --no-stream --format '{{.CPUPerc}} {{.MemPerc}}' "$1" 2>/dev/null \
    | awk '{c=$1; m=$2; gsub("%","",c); gsub("%","",m); if (c>100) c=100; printf "%d %d", c, m}' || echo "0 0"
}

# ---- TaskFlow API (optional). Every call is a no-op when not configured. ----
tf_enabled() { [ -n "${TASKFLOW_API:-}" ] && [ -n "${TASKFLOW_DEPLOYMENT_ID:-}" ] && [ -n "${TASKFLOW_INGEST_TOKEN:-}" ]; }

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n\r\t' '   '; }

tf_post() { # tf_post <json>
  tf_enabled || return 0
  curl -s -m 10 -X POST "$TASKFLOW_API/deployments/$TASKFLOW_DEPLOYMENT_ID/ingest" \
    -H "X-Ingest-Token: $TASKFLOW_INGEST_TOKEN" -H 'Content-Type: application/json' -d "$1" >/dev/null 2>&1 \
    || warn "Could not reach TaskFlow API (continuing)."
}
tf_event()  { tf_post "{\"type\":\"event\",\"message\":\"$(json_escape "$1")\"}"; }
tf_status() { tf_post "{\"type\":\"status\",\"action\":\"$1\",\"reason\":\"$(json_escape "${2:-}")\"}"; }
tf_baseline() { tf_post "{\"type\":\"baseline\",\"errorRate\":$1,\"p95Ms\":$2}"; }
tf_metrics() { # <err> <p95> <cpu> <mem> <healthy:true|false>
  tf_post "{\"type\":\"metrics\",\"errorRate\":$1,\"p95Ms\":$2,\"cpuPct\":$3,\"memPct\":$4,\"healthy\":$5}"
}
tf_gate() { # prints raw JSON of the AI gate, or nothing when disabled/unreachable
  tf_enabled || return 0
  curl -s -m 10 "$TASKFLOW_API/deployments/$TASKFLOW_DEPLOYMENT_ID/gate" -H "X-Ingest-Token: $TASKFLOW_INGEST_TOKEN" 2>/dev/null || true
}
