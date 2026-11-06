# Blue/green deployment kit

Run two identical copies of TaskFlow ("blue" and "green") behind an nginx **edge** proxy. Users are always
served by the **live** colour. A release is built on the **idle** colour, verified with real health probes,
checked by the **AI gate**, and only then does the edge switch traffic. The old colour keeps running, so
rollback is one command and takes about a second.

```
            ┌────────────── edge (nginx :80) ──────────────┐
 users ───▶ │  active.conf → taskflow-<live colour>-web    │
            └───────────────┬──────────────────┬───────────┘
                            │ live             │ idle (loopback preview :8081)
                     ┌──────▼──────┐     ┌─────▼───────┐
                     │ blue web+api│     │green web+api│
                     └──────┬──────┘     └──────┬──────┘
                            └─── shared MongoDB + uploads volume ───┘
```

## One-time setup

```bash
cp deploy/.env.example deploy/.env      # set JWT_SECRET (openssl rand -hex 32) and APP_PUBLIC_URL
./deploy/setup.sh                       # MongoDB + edge proxy + shared volume
./deploy/deploy.sh v1.0.0               # first release → blue, goes live
```

## Releasing with AI risk prediction

1. In TaskFlow open **Deployments → Plan deployment**. Describe the change (size, DB migration, tests, readiness…).
   You get a **risk score, predicted success rate, pros and cons** instantly, updating as you type.
2. Open **Pipeline integration** on the deployment page and copy the three values into `deploy/.env`
   (`TASKFLOW_API`, `TASKFLOW_DEPLOYMENT_ID`, `TASKFLOW_INGEST_TOKEN`). The token is shown once.
3. Run the release:
   ```bash
   ./deploy/deploy.sh v1.1.0
   ```
   What happens:
   - baseline error rate / p95 latency is measured on the **live** colour;
   - the idle colour is built and started, waiting for its container health checks;
   - a **soak test** probes it (default 6 batches × 5 requests) and streams error rate, p95 latency, CPU and
     memory to TaskFlow — the deployment page updates in real time and the prediction is **re-scored live**;
   - the **AI gate** (`GET /deployments/:id/gate`) must allow the switch (risk not high/critical, ≥3 samples,
     no critical verdict). Otherwise the script stops and leaves the new colour running for investigation
     (`--force` overrides);
   - traffic is switched atomically (`state/active.conf` + `nginx -s reload`), the edge is verified, and the
     first minutes are monitored. If the error rate jumps (≥20 %) the script **rolls back automatically**.
4. Roll back at any time: `./deploy/rollback.sh "reason"` (or the **Roll back** button in the UI, which records
   the decision; the scripts perform the actual traffic switch).
5. When you are confident: `./deploy/deploy.sh --retire` stops the idle colour to free resources.

Without the `TASKFLOW_*` variables everything still works — the script falls back to a local health check
and skips prediction and reporting.

## Database changes: expand → contract

Both colours share one database, so during a release **both versions must work with the same schema**.
Ship additive changes first (new columns/collections), deploy, then remove old fields in a later release.
The risk model penalises destructive migrations heavily for exactly this reason.

## Files

| File | Purpose |
|---|---|
| `docker-compose.edge.yml` | MongoDB + edge proxy (shared, long-lived) |
| `docker-compose.app.yml` | One colour (API + web); started as project `taskflow-blue` / `taskflow-green` |
| `edge/nginx.conf` | Public router + loopback preview of each colour (`127.0.0.1:8081/<colour>/…`) |
| `state/active.conf` | Which colour is live (rewritten atomically by the scripts) |
| `setup.sh` `deploy.sh` `rollback.sh` `status.sh` `lib.sh` | Operations |

## Notes & limits

- Single-host Docker. For Kubernetes use the same flow with two Deployments and a Service selector/Ingress switch,
  and post metrics to the same `/ingest` endpoint.
- The edge reloads nginx; in-flight requests finish on the old colour. WebSocket/long-lived sessions reconnect.
- Uploads live on a shared volume; the JWT secret must be identical for both colours (it is — one `.env`).
- Not exercised on a live Docker host in the build environment: run through a staging deploy first.
