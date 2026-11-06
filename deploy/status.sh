#!/usr/bin/env bash
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
need docker
echo "Live colour : $(active_color || true)"
docker ps --filter name=taskflow- --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'
