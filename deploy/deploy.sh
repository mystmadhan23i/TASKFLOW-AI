#!/usr/bin/env bash
# Blue/green deploy: build the idle colour, verify it, ask the AI gate, then switch traffic.
#   ./deploy/deploy.sh <version> [--force] [--no-switch]
#   ./deploy/deploy.sh --retire          # stop the idle colour once you are happy
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
need docker; need curl; need awk

VERSION="" FORCE=0 NO_SWITCH=0 RETIRE=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --force) FORCE=1 ;; --no-switch) NO_SWITCH=1 ;; --retire) RETIRE=1 ;;
    -h|--help) sed -n '2,5p' "$0"; exit 0 ;;
    -*) die "Unknown option $1" ;;
    *) VERSION="$1" ;;
  esac; shift
done

docker inspect taskflow-edge >/dev/null 2>&1 || die "Edge proxy is not running. Run ./deploy/setup.sh first."
ACTIVE="$(active_color)"; [ -n "$ACTIVE" ] || ACTIVE=blue

if [ "$RETIRE" = 1 ]; then
  IDLE="$(other_color "$ACTIVE")"
  log "Retiring idle colour: $IDLE (rollback to it will no longer be instant)"
  compose_app "$IDLE" retired down
  tf_event "Retired idle colour $IDLE."
  exit 0
fi

[ -n "$VERSION" ] || die "Usage: deploy.sh <version> [--force] [--no-switch] | --retire"
# First ever deploy: nothing is live yet, so deploy to blue and switch without a baseline.
FIRST=0; docker inspect "taskflow-$ACTIVE-web" >/dev/null 2>&1 || FIRST=1
TARGET="$(other_color "$ACTIVE")"; [ "$FIRST" = 1 ] && TARGET="$ACTIVE"
log "Live: $([ "$FIRST" = 1 ] && echo 'none (first deploy)' || echo "$ACTIVE")  →  deploying $VERSION to: $TARGET"

fail_deploy() { # <message>
  warn "$1"; tf_event "$1"; tf_status fail "$1"
  compose_app "$TARGET" "$VERSION" logs --tail 40 backend 2>/dev/null || true
  [ "$FIRST" = 1 ] || compose_app "$TARGET" "$VERSION" down >/dev/null 2>&1 || true
  exit 1
}

tf_status start "deploy.sh $VERSION"
tf_event "deploy.sh: building $VERSION on $TARGET (live colour $ACTIVE stays untouched)."

if [ "$FIRST" = 0 ]; then
  log "Recording baseline from the live colour ($ACTIVE)"
  probe_batch "$PREVIEW_URL/$ACTIVE" "$PROBES_PER_BATCH"
  log "  baseline: errors ${BATCH_ERR}%  p95 ${BATCH_P95}ms"
  tf_baseline "$BATCH_ERR" "$BATCH_P95"
fi

log "Building and starting $TARGET (waits for health checks)…"
compose_app "$TARGET" "$VERSION" up -d --build --wait --wait-timeout 240 || fail_deploy "Build/health check failed for $VERSION on $TARGET."
tf_status verify
tf_event "$TARGET is healthy at container level; starting soak test ($SOAK_BATCHES batches x $PROBES_PER_BATCH probes)."

ALL_OK=1
for ((b = 1; b <= SOAK_BATCHES; b++)); do
  probe_batch "$PREVIEW_URL/$TARGET" "$PROBES_PER_BATCH"
  read -r CPU MEM <<<"$(container_usage "taskflow-$TARGET-backend")"
  HEALTHY=true; [ "$BATCH_FAILS" = 0 ] || { HEALTHY=false; ALL_OK=0; }
  log "  soak $b/$SOAK_BATCHES: errors ${BATCH_ERR}%  p95 ${BATCH_P95}ms  cpu ${CPU:-0}%  mem ${MEM:-0}%  healthy=$HEALTHY"
  tf_metrics "$BATCH_ERR" "$BATCH_P95" "${CPU:-0}" "${MEM:-0}" "$HEALTHY"
done

# ---- AI gate ----
GATE="$(tf_gate)"
if [ -n "$GATE" ]; then
  MSG="$(printf '%s' "$GATE" | sed -n 's/.*"message":"\([^"]*\)".*/\1/p')"
  LVL="$(printf '%s' "$GATE" | sed -n 's/.*"level":"\([a-z]*\)".*/\1/p')"
  SUC="$(printf '%s' "$GATE" | sed -n 's/.*"successProbability":\([0-9]*\).*/\1/p')"
  log "AI gate: risk=$LVL  predicted success=${SUC}%  — $MSG"
  if ! printf '%s' "$GATE" | grep -q '"allowSwitch":true'; then
    if [ "$FORCE" = 1 ]; then warn "AI gate says hold — continuing because --force was given."; tf_event "deploy.sh: gate overridden with --force."
    else
      tf_event "Gate blocked the cutover (risk $LVL): $MSG"
      warn "Not switching. $TARGET keeps running for investigation. Re-run with --force to override, or roll the release forward after fixing."
      exit 2
    fi
  fi
elif [ "$ALL_OK" = 0 ] && [ "$FORCE" = 0 ]; then
  warn "Some health probes failed and no AI gate is configured. Not switching (use --force to override)."; exit 2
fi

[ "$NO_SWITCH" = 1 ] && { log "--no-switch given: leaving $TARGET running without traffic."; exit 0; }

log "Switching traffic: $ACTIVE → $TARGET"
set_active "$TARGET"
sleep 2
probe_batch "http://127.0.0.1:$EDGE_PORT" 3
if [ "$BATCH_FAILS" != 0 ]; then
  warn "Edge health check failed right after the switch."
  if [ "$FIRST" = 0 ]; then set_active "$ACTIVE"; tf_status rollback "Edge check failed immediately after switch"; die "Rolled back to $ACTIVE."; fi
  die "First deploy is not healthy — check: docker logs taskflow-$TARGET-backend"
fi
tf_status switch "deploy.sh $VERSION"
tf_event "Traffic is now served by $TARGET ($VERSION). $ACTIVE kept running for instant rollback."

for ((b = 1; b <= POST_SWITCH_BATCHES; b++)); do
  probe_batch "http://127.0.0.1:$EDGE_PORT" "$PROBES_PER_BATCH"
  read -r CPU MEM <<<"$(container_usage "taskflow-$TARGET-backend")"
  HEALTHY=true; [ "$BATCH_FAILS" = 0 ] || HEALTHY=false
  log "  live $b/$POST_SWITCH_BATCHES: errors ${BATCH_ERR}%  p95 ${BATCH_P95}ms  healthy=$HEALTHY"
  tf_metrics "$BATCH_ERR" "$BATCH_P95" "${CPU:-0}" "${MEM:-0}" "$HEALTHY"
  if [ "$FIRST" = 0 ] && [ "$AUTO_ROLLBACK" = 1 ] && awk -v e="$BATCH_ERR" 'BEGIN{exit !(e>=20)}'; then
    warn "Error rate ${BATCH_ERR}% after cutover — rolling back automatically."
    set_active "$ACTIVE"; tf_status rollback "Auto-rollback: error rate ${BATCH_ERR}% after cutover"
    die "Rolled back to $ACTIVE. Investigate $TARGET with: docker logs taskflow-$TARGET-backend"
  fi
done
log "Done. $TARGET is live. Instant rollback: ./deploy/rollback.sh   |   free resources: ./deploy/deploy.sh --retire"
