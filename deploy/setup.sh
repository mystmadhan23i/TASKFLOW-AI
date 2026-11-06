#!/usr/bin/env bash
# One-time setup: shared networks/volumes, MongoDB and the edge proxy.
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
need docker
[ -f "$DEPLOY_DIR/.env" ] || die "Create deploy/.env first:  cp deploy/.env.example deploy/.env  (and set JWT_SECRET)"
[ -n "${JWT_SECRET:-}" ] && [ "${#JWT_SECRET}" -ge 16 ] || die "Set JWT_SECRET (16+ chars) in deploy/.env — e.g. openssl rand -hex 32"

log "Creating shared volume and starting MongoDB + edge proxy"
docker volume inspect taskflow-uploads >/dev/null 2>&1 || docker volume create taskflow-uploads >/dev/null
docker compose -f "$DEPLOY_DIR/docker-compose.edge.yml" --env-file "$DEPLOY_DIR/.env" up -d
# Networks are created by the edge project (taskflow-data, taskflow-edge-net).
log "Ready. Deploy the first version with:  ./deploy/deploy.sh v1.0.0"
