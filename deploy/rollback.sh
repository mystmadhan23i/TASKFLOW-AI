#!/usr/bin/env bash
# Instantly switch traffic back to the previous colour (it must still be running).
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
need docker; need curl; need awk
REASON="${1:-manual rollback}"
ACTIVE="$(active_color)"; [ -n "$ACTIVE" ] || die "No active colour recorded."
PREV="$(other_color "$ACTIVE")"
docker inspect "taskflow-$PREV-web" >/dev/null 2>&1 || die "$PREV is not running (was it retired?). Redeploy the previous version with deploy.sh instead."
probe_batch "$PREVIEW_URL/$PREV" 3
[ "$BATCH_FAILS" = 0 ] || die "$PREV is not healthy (errors ${BATCH_ERR}%); refusing to switch to it."
log "Rolling back: $ACTIVE → $PREV"
set_active "$PREV"
tf_event "Rollback: traffic switched back to $PREV. Reason: $REASON"
tf_status rollback "$REASON"
log "Traffic is served by $PREV again."
