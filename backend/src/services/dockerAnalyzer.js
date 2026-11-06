/**
 * Deterministic Docker analysis engine. Pure functions only (no I/O), so it can be unit-tested
 * and used as the fallback — or as grounding context — when an LLM provider is configured.
 */

const SEV_ORDER = ['critical', 'high', 'medium', 'low', 'info'];

/* ------------------------------------------------------------ detection */
export function detectType(text, filename = '') {
  const name = filename.toLowerCase();
  if (/(^|\/)dockerfile(\.|$)|\.dockerfile$/.test(name)) return 'dockerfile';
  if (/docker-compose|compose\.ya?ml$/.test(name)) return 'compose';
  if (/^\s*FROM\s+\S+/im.test(text) && /^\s*(RUN|CMD|COPY|ENTRYPOINT|WORKDIR|EXPOSE)\b/im.test(text)) return 'dockerfile';
  if (/^\s*services\s*:/m.test(text) && /^\s+(image|build)\s*:/m.test(text)) return 'compose';
  if (/\b(error|exception|failed|fatal|panic|warn|exited|killed|denied|refused|cannot|can't|unhealthy|oom)\b/i.test(text)) return 'logs';
  return 'text';
}

/* ----------------------------------------------------- secret redaction */
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED AWS KEY]'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, '[REDACTED GITHUB TOKEN]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED SLACK TOKEN]'],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED API KEY]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, '[REDACTED JWT]'],
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+):([^\s@/]+)@/gi, '$1:[REDACTED]@'],
  [/\b((?:[A-Z0-9_]*)(?:PASSWORD|PASSWD|SECRET|TOKEN|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY)[A-Z0-9_]*)(\s*[=:]\s*)(["']?)([^\s"'#]{3,})\3/gi, '$1$2$3[REDACTED]$3']
];

export function redactSecrets(text) {
  let count = 0;
  let out = String(text);
  for (const [rx, repl] of SECRET_PATTERNS) {
    out = out.replace(rx, (...args) => {
      count += 1;
      return repl.replace(/\$(\d)/g, (_, i) => args[Number(i)] ?? '');
    });
  }
  return { text: out, count };
}

/* ------------------------------------------------------------- helpers */
const f = (id, severity, title, detail, fix, line) => ({ id, severity, title, detail, fix, ...(line ? { line } : {}) });

function lineOf(lines, predicate) {
  const i = lines.findIndex(predicate);
  return i === -1 ? undefined : i + 1;
}

/* ----------------------------------------------------------- Dockerfile */
export function analyzeDockerfile(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  // join line continuations while keeping first line number
  const instr = [];
  for (let i = 0; i < lines.length; i += 1) {
    let l = lines[i];
    if (/^\s*(#|$)/.test(l)) continue;
    const start = i + 1;
    while (/\\\s*$/.test(l) && i + 1 < lines.length) { i += 1; l = `${l.replace(/\\\s*$/, ' ')}${lines[i]}`; }
    const m = l.trim().match(/^(\w+)\s+([\s\S]*)$/);
    if (m) instr.push({ op: m[1].toUpperCase(), args: m[2], line: start });
  }
  const froms = instr.filter((i) => i.op === 'FROM');
  if (!froms.length) out.push(f('df-no-from', 'critical', 'No FROM instruction', 'A Dockerfile must start with FROM (after optional ARG).', 'Add a FROM line with a pinned base image.'));

  for (const fr of froms) {
    const ref = fr.args.replace(/--platform=\S+\s+/i, '').split(/\s+as\s+/i)[0].trim();
    if (ref.toLowerCase() === 'scratch' || /^\$\{?\w+\}?$/.test(ref)) continue;
    if (/@sha256:/.test(ref)) continue;
    const tag = ref.includes(':') ? ref.split(':').pop() : '';
    if (!tag) out.push(f('df-untagged', 'high', `Base image "${ref}" has no tag`, 'Untagged images resolve to :latest, which changes over time and makes builds non-reproducible.', `Pin a specific version, e.g. ${ref}:<version>, or a digest.`, fr.line));
    else if (tag === 'latest') out.push(f('df-latest', 'high', `Base image "${ref}" uses :latest`, 'The latest tag is a moving target and can break builds or introduce vulnerabilities without notice.', 'Pin an exact version (and ideally a digest).', fr.line));
  }
  if (froms.length === 1 && instr.some((i) => i.op === 'RUN' && /(npm (ci|install)|pip install|go build|mvn|gradle|cargo build|dotnet (build|publish))/.test(i.args))) {
    out.push(f('df-single-stage', 'low', 'Single-stage build', 'Build tools and caches stay in the final image, increasing size and attack surface.', 'Use a multi-stage build: compile in a builder stage, copy artifacts into a slim runtime image.'));
  }
  const lastFrom = froms.length ? froms[froms.length - 1].line : 0;
  const finalStage = instr.filter((i) => i.line >= lastFrom);
  const users = finalStage.filter((i) => i.op === 'USER');
  if (!users.length || /^(root|0)(:|$)/.test(users[users.length - 1].args.trim())) {
    out.push(f('df-root', 'high', 'Container runs as root', 'No non-root USER is set in the final stage, so a compromised process has root privileges inside the container.', 'Create an unprivileged user (RUN adduser …) and add USER <name> before CMD/ENTRYPOINT.'));
  }
  if (!instr.some((i) => i.op === 'HEALTHCHECK')) {
    out.push(f('df-healthcheck', 'low', 'No HEALTHCHECK', 'Without a health check, orchestrators only know whether the process is running, not whether it is serving.', 'Add HEALTHCHECK CMD curl -f http://localhost:PORT/health || exit 1 (or use a tool already in the image).'));
  }
  for (const i of instr) {
    if (i.op === 'ADD' && !/^\s*(https?:|\S+\.(tar|tgz|tar\.gz|tar\.xz)\b)/i.test(i.args)) {
      out.push(f('df-add', 'low', 'ADD used where COPY would do', 'ADD has implicit extraction and remote-URL behavior that can surprise you.', 'Use COPY unless you specifically need tar auto-extraction.', i.line));
    }
    if (i.op === 'RUN') {
      if (/(curl|wget)[^|;&]*\|\s*(sudo\s+)?(ba)?sh/.test(i.args)) out.push(f('df-curl-pipe', 'high', 'Piping a download into a shell', 'Executing remote scripts at build time is unverifiable and a supply-chain risk.', 'Download, verify a checksum or signature, then run.', i.line));
      if (/apt-get\s+install/.test(i.args)) {
        if (!/-y|--yes|-qq/.test(i.args)) out.push(f('df-apt-y', 'medium', 'apt-get install without -y', 'The build will hang or fail waiting for confirmation.', 'Use apt-get install -y --no-install-recommends.', i.line));
        if (!/--no-install-recommends/.test(i.args)) out.push(f('df-apt-recommends', 'low', 'apt-get install pulls recommended packages', 'Extra packages inflate the image.', 'Add --no-install-recommends.', i.line));
        if (!/rm -rf \/var\/lib\/apt\/lists/.test(i.args)) out.push(f('df-apt-clean', 'low', 'apt cache not cleaned in the same layer', 'Package lists remain in the layer and bloat the image.', 'Append && rm -rf /var/lib/apt/lists/* to the same RUN.', i.line));
        if (!/apt-get\s+update/.test(i.args)) out.push(f('df-apt-update', 'medium', 'apt-get install without update in the same RUN', 'A cached "update" layer can leave stale package indexes and cause 404 errors.', 'Chain: apt-get update && apt-get install -y … in one RUN.', i.line));
      }
      if (/apk\s+add/.test(i.args) && !/--no-cache/.test(i.args)) out.push(f('df-apk', 'low', 'apk add without --no-cache', 'The package index cache is left in the image.', 'Use apk add --no-cache.', i.line));
      if (/pip3?\s+install/.test(i.args) && !/--no-cache-dir/.test(i.args)) out.push(f('df-pip', 'low', 'pip install without --no-cache-dir', 'pip caches wheels inside the layer.', 'Add --no-cache-dir.', i.line));
      if (/npm\s+install\b/.test(i.args) && !/npm\s+install\s+-g/.test(i.args)) out.push(f('df-npm-install', 'low', 'npm install used for reproducible builds', 'npm install may modify the lockfile and resolve different versions.', 'Use npm ci (and --omit=dev for production).', i.line));
      if (/\bsudo\b/.test(i.args)) out.push(f('df-sudo', 'low', 'sudo inside Dockerfile', 'Builds already run as root; sudo is unnecessary and often missing.', 'Remove sudo or restructure USER switches.', i.line));
      if (/chmod\s+(-R\s+)?777/.test(i.args)) out.push(f('df-chmod777', 'medium', 'World-writable permissions (chmod 777)', 'Any process in the container can modify those files.', 'Grant the minimum permissions to the specific user instead.', i.line));
    }
    if ((i.op === 'ENV' || i.op === 'ARG') && /(PASSWORD|PASSWD|SECRET|TOKEN|API[_-]?KEY|PRIVATE[_-]?KEY)\s*[= ]\s*\S+/i.test(i.args) && !/\$\{?\w+\}?\s*$/.test(i.args)) {
      out.push(f('df-secret', 'critical', `Possible secret baked into the image (${i.op})`, 'ENV and ARG values are stored in image layers and visible via docker history.', 'Inject secrets at runtime (env vars, Docker/K8s secrets) or use BuildKit --mount=type=secret.', i.line));
    }
    if (i.op === 'EXPOSE' && /\b22\b/.test(i.args)) out.push(f('df-ssh', 'medium', 'Port 22 exposed', 'Running SSH in a container is usually an anti-pattern.', 'Use docker exec / kubectl exec instead.', i.line));
  }
  const copyAllIdx = instr.findIndex((i) => i.op === 'COPY' && /^(--\S+\s+)*\.\s+\S+/.test(i.args));
  const depIdx = instr.findIndex((i) => i.op === 'RUN' && /(npm (ci|install)|pip install|yarn|pnpm install|bundle install|composer install|go mod download)/.test(i.args));
  if (copyAllIdx !== -1 && depIdx !== -1 && copyAllIdx < depIdx) {
    out.push(f('df-cache-order', 'medium', 'Layer-cache order is inefficient', 'Copying the whole source before installing dependencies invalidates the dependency layer on every code change.', 'COPY only package manifests first (package*.json, requirements.txt), install, then COPY the rest.', instr[copyAllIdx].line));
  }
  const cmds = finalStage.filter((i) => i.op === 'CMD');
  if (cmds.length > 1) out.push(f('df-multi-cmd', 'low', 'Multiple CMD instructions', 'Only the last CMD takes effect.', 'Keep one CMD per stage.', cmds[0].line));
  for (const i of finalStage.filter((x) => x.op === 'CMD' || x.op === 'ENTRYPOINT')) {
    if (!i.args.trim().startsWith('[')) out.push(f('df-shell-form', 'low', `${i.op} in shell form`, 'Shell form wraps the process in /bin/sh -c, so signals (SIGTERM) are not forwarded and graceful shutdown fails.', `Use exec form: ${i.op} ["executable", "arg"].`, i.line));
  }
  if (!instr.some((i) => i.op === 'WORKDIR')) out.push(f('df-workdir', 'info', 'No WORKDIR set', 'Files end up in / which is messy and error-prone.', 'Set WORKDIR /app.'));
  return out;
}

/* -------------------------------------------------------------- Compose */
export function analyzeCompose(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  const L = (rx) => lineOf(lines, (l) => rx.test(l));
  if (/^\s*version\s*:/m.test(text)) out.push(f('dc-version', 'info', 'Obsolete "version" key', 'Compose v2 ignores the top-level version field and warns about it.', 'Remove the version line.', L(/^\s*version\s*:/)));
  if (/privileged\s*:\s*true/.test(text)) out.push(f('dc-privileged', 'critical', 'Privileged container', 'privileged: true gives the container nearly full host access.', 'Drop it; grant only the specific capabilities needed with cap_add.', L(/privileged\s*:\s*true/)));
  if (/\/var\/run\/docker\.sock/.test(text)) out.push(f('dc-docker-sock', 'critical', 'Docker socket mounted into a container', 'Access to docker.sock is equivalent to root on the host.', 'Avoid it, or use a socket proxy with restricted API permissions and mount read-only.', L(/docker\.sock/)));
  if (/network_mode\s*:\s*["']?host/.test(text)) out.push(f('dc-host-net', 'high', 'Host networking', 'Bypasses network isolation and port mapping.', 'Use a user-defined bridge network and publish only the ports you need.', L(/network_mode/)));
  if (/pid\s*:\s*["']?host/.test(text)) out.push(f('dc-host-pid', 'high', 'Host PID namespace', 'The container can see and signal host processes.', 'Remove pid: host.', L(/pid\s*:/)));
  const latest = [...text.matchAll(/^\s*image\s*:\s*["']?([^\s"'#]+)/gm)].map((m) => m[1]);
  for (const img of latest) {
    const tag = img.includes(':') ? img.split(':').pop() : '';
    if (!tag || tag === 'latest') out.push(f('dc-latest', 'medium', `Image "${img}" is unpinned`, 'Unpinned images can change underneath you on the next pull.', 'Pin a specific version tag or digest.', L(new RegExp(`image\\s*:\\s*["']?${img.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))));
  }
  const dbPorts = { 5432: 'PostgreSQL', 3306: 'MySQL', 27017: 'MongoDB', 6379: 'Redis', 9200: 'Elasticsearch', 11211: 'Memcached' };
  for (const m of text.matchAll(/^\s*-\s*["']?(?:(\d+\.\d+\.\d+\.\d+):)?(\d+):(\d+)["']?/gm)) {
    const [, bind, host, cont] = m;
    const db = dbPorts[cont] || dbPorts[host];
    if (db && (!bind || bind === '0.0.0.0')) out.push(f('dc-db-exposed', 'high', `${db} port published on all interfaces`, `Port ${host} is reachable from outside the host. Databases should not be internet-facing.`, `Bind to localhost ("127.0.0.1:${host}:${cont}") or remove the mapping and use the internal network.`, lineOf(lines, (l) => l.includes(m[0].trim()))));
  }
  for (const m of text.matchAll(/^\s*-?\s*([A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|API_?KEY)[A-Z0-9_]*)\s*[:=]\s*["']?([^\s"'$#]+)/gim)) {
    out.push(f('dc-secret', 'high', `Hardcoded credential in ${m[1]}`, 'Secrets committed in compose files leak through version control.', 'Use an .env file excluded from git, Docker secrets, or an external secret manager.', lineOf(lines, (l) => l.includes(m[1]))));
  }
  const services = [...text.matchAll(/^ {2}([\w.-]+)\s*:\s*$/gm)].map((m) => m[1]);
  if (!/restart\s*:/.test(text) && services.length) out.push(f('dc-restart', 'low', 'No restart policy', 'Containers will not recover automatically after a crash or host reboot.', 'Add restart: unless-stopped for long-running services.'));
  if (!/healthcheck\s*:/.test(text) && services.length) out.push(f('dc-healthcheck', 'low', 'No healthchecks defined', 'depends_on cannot wait for a service to be healthy without one.', 'Add healthcheck: blocks and use depends_on: condition: service_healthy.'));
  if (!/(mem_limit|cpus|deploy:\s*[\s\S]*resources|memory\s*:)/.test(text) && services.length) out.push(f('dc-limits', 'info', 'No resource limits', 'A runaway container can starve the host (OOM, CPU).', 'Set mem_limit / cpus (or deploy.resources.limits).'));
  if (/depends_on\s*:/.test(text) && !/condition\s*:\s*service_healthy/.test(text)) out.push(f('dc-depends', 'info', 'depends_on only waits for container start', 'The dependent service may start before the database is ready, causing connection-refused errors.', 'Use depends_on with condition: service_healthy plus a healthcheck.'));
  return out;
}

/* ----------------------------------------------------------------- Logs */
const LOG_RULES = [
  { id: 'log-oom', rx: /oomkilled|exit(?:ed)?(?: with)?(?: code)? 137|out of memory|cannot allocate memory|java\.lang\.OutOfMemoryError|heap out of memory/i, sev: 'critical',
    title: 'Container killed for running out of memory (OOM / exit 137)', detail: 'The kernel or Docker terminated the process because it exceeded its memory limit.',
    fix: 'Check `docker stats` and `docker inspect <c> --format "{{.State.OOMKilled}}"`. Raise the memory limit only after confirming usage; look for leaks and set runtime heap flags (e.g. --max-old-space-size, -Xmx).' },
  { id: 'log-disk', rx: /no space left on device/i, sev: 'critical', title: 'Disk is full',
    detail: 'Docker (or the container) cannot write because the filesystem has no free space.', fix: 'Run `docker system df`, then `docker system prune` (review first; add --volumes only if safe). Check /var/lib/docker and log sizes; configure log rotation (max-size / max-file).' },
  { id: 'log-daemon', rx: /cannot connect to the docker daemon|is the docker daemon running|docker\.sock.*(connect|dial)/i, sev: 'high', title: 'Cannot reach the Docker daemon',
    detail: 'The client cannot talk to dockerd.', fix: 'Check `systemctl status docker`, start it, and make sure DOCKER_HOST is correct.' },
  { id: 'log-sock-perm', rx: /permission denied.*docker\.sock|got permission denied while trying to connect to the docker daemon/i, sev: 'high', title: 'Permission denied on the Docker socket',
    detail: 'The current user is not allowed to use /var/run/docker.sock.', fix: 'Add the user to the docker group (`sudo usermod -aG docker $USER`, then re-login) — understand that this is root-equivalent — or use rootless Docker.' },
  { id: 'log-port', rx: /port is already allocated|address already in use|bind: address already in use|failed to bind/i, sev: 'high', title: 'Port already in use',
    detail: 'Another process or container already listens on the host port you are publishing.', fix: 'Find it with `ss -ltnp | grep <port>` or `docker ps --format "{{.Names}} {{.Ports}}"`, stop it, or change the host port in your mapping.' },
  { id: 'log-pull-denied', rx: /pull access denied|repository does not exist|requested access to the resource is denied|unauthorized: authentication required/i, sev: 'high', title: 'Image pull denied or image does not exist',
    detail: 'The image name is wrong, private, or you are not logged in to the registry.', fix: 'Verify the name/tag, run `docker login <registry>`, and for CI check registry credentials/pull secrets.' },
  { id: 'log-manifest', rx: /manifest (for .+ )?not found|manifest unknown|no matching manifest/i, sev: 'high', title: 'Image tag or platform not found',
    detail: 'The tag does not exist, or there is no image for this CPU architecture (e.g. arm64 vs amd64).', fix: 'Check tags in the registry; for platform mismatches use `--platform linux/amd64` or a multi-arch image.' },
  { id: 'log-ratelimit', rx: /toomanyrequests|rate limit/i, sev: 'medium', title: 'Registry rate limit hit',
    detail: 'Docker Hub limits anonymous and free pulls.', fix: 'Authenticate (`docker login`), use a registry mirror/pull-through cache, or host base images in your own registry.' },
  { id: 'log-exec-format', rx: /exec format error|exec user process caused/i, sev: 'high', title: 'Architecture mismatch (exec format error)',
    detail: 'The binary or image was built for a different CPU architecture, or the entrypoint script lacks a shebang.', fix: 'Build with `docker buildx build --platform …`; check `#!/bin/sh` on the first line of scripts and Unix (LF) line endings.' },
  { id: 'log-exec-notfound', rx: /executable file not found in \$path|no such file or directory.*(entrypoint|exec)|exec: .* not found|standard_init_linux.*no such file/i, sev: 'high', title: 'Entrypoint / command not found',
    detail: 'The command in CMD/ENTRYPOINT does not exist in the image, is not executable, or has CRLF line endings.', fix: 'Verify the path inside the image (`docker run --rm -it --entrypoint sh <img>`), `chmod +x` scripts, and convert CRLF to LF.' },
  { id: 'log-copy-missing', rx: /(copy|add) failed.*(no such file|file not found)|failed to compute cache key.*not found|not found in build context/i, sev: 'high', title: 'File missing from build context',
    detail: 'A COPY/ADD source path does not exist in the build context or is excluded by .dockerignore.', fix: 'Check the path relative to the context directory, review .dockerignore, and make sure you run `docker build` from the right folder.' },
  { id: 'log-build-fail', rx: /failed to solve|the command '.*' returned a non-zero code|did not complete successfully|executor failed running/i, sev: 'high', title: 'Docker build step failed',
    detail: 'A RUN instruction exited non-zero. The root cause is in the output just above this line.', fix: 'Re-run with `docker build --progress=plain --no-cache .` and inspect the first error before this message.' },
  { id: 'log-dns', rx: /no such host|temporary failure in name resolution|could not resolve host|getaddrinfo (enotfound|eai_again)|server misbehaving/i, sev: 'high', title: 'DNS resolution failure',
    detail: 'The container could not resolve a hostname.', fix: 'Check the service name matches the compose service, containers share a network, and the daemon DNS (`/etc/docker/daemon.json` "dns") works. Behind VPNs try setting explicit DNS servers.' },
  { id: 'log-conn-refused', rx: /connection refused|econnrefused|dial tcp .*: connect: connection refused/i, sev: 'high', title: 'Connection refused',
    detail: 'The target host is reachable but nothing is listening on that port yet — often a startup-order issue or the app binds to 127.0.0.1 only.', fix: 'Use the service name (not localhost) between containers, bind the app to 0.0.0.0, add healthchecks with depends_on condition: service_healthy, and add retry logic.' },
  { id: 'log-timeout', rx: /i\/o timeout|connection timed out|etimedout|context deadline exceeded|tls handshake timeout/i, sev: 'medium', title: 'Network timeout',
    detail: 'Requests are not getting a response in time (firewall, proxy, MTU, slow dependency).', fix: 'Check egress/proxy settings (HTTP_PROXY), firewall/security groups, and test with `docker run --rm curlimages/curl -v <url>`.' },
  { id: 'log-cert', rx: /x509: certificate|unable to verify the first certificate|self[- ]signed certificate|ssl certificate problem/i, sev: 'medium', title: 'TLS certificate problem',
    detail: 'The certificate is untrusted, expired, or the system clock/CA bundle is wrong.', fix: 'Install ca-certificates in the image, add your corporate CA, or fix the registry/server certificate. Avoid disabling verification in production.' },
  { id: 'log-perm', rx: /permission denied|eacces|operation not permitted|read-only file system/i, sev: 'medium', title: 'Permission denied inside the container',
    detail: 'The container user cannot read/write a path (volume ownership, non-root USER, or read-only root filesystem).', fix: 'Check file ownership of mounted volumes vs the container UID (`ls -ln`), use `chown` in the Dockerfile, or set `user:` in compose. SELinux hosts may need the :z volume flag.' },
  { id: 'log-conflict', rx: /conflict\. the container name|name .* is already in use/i, sev: 'medium', title: 'Container name already in use',
    detail: 'A stopped or running container already has this name.', fix: 'Run `docker rm -f <name>` or choose another name; with compose use `docker compose down --remove-orphans`.' },
  { id: 'log-network', rx: /network .* not found|network .* declared as external, but could not be found/i, sev: 'medium', title: 'Docker network missing',
    detail: 'A referenced network does not exist.', fix: 'Create it (`docker network create <name>`) or remove the external flag.' },
  { id: 'log-unhealthy', rx: /\bunhealthy\b|health check .* failed|health_status: unhealthy/i, sev: 'medium', title: 'Container reported unhealthy',
    detail: 'The HEALTHCHECK command is failing.', fix: 'Inspect `docker inspect <c> --format "{{json .State.Health}}"` for the last check output; verify the endpoint/port and give a longer start_period.' },
  { id: 'log-restart-loop', rx: /restarting \(\d+\)|crashloopbackoff|back-off restarting failed container/i, sev: 'high', title: 'Crash loop',
    detail: 'The container starts, exits, and is restarted repeatedly.', fix: 'Read the logs of the previous run (`docker logs --tail 200 <c>`; `kubectl logs --previous`), then fix the first fatal error. Temporarily override the entrypoint to debug.' },
  { id: 'log-imagepull', rx: /imagepullbackoff|errimagepull/i, sev: 'high', title: 'Kubernetes cannot pull the image',
    detail: 'Wrong image name/tag, missing imagePullSecret, or registry unreachable.', fix: 'Run `kubectl describe pod <pod>` and read the Events; confirm the tag exists and the pull secret is attached.' },
  { id: 'log-exit-127', rx: /exit(?:ed)?(?: with)?(?: code)? 127|command not found/i, sev: 'medium', title: 'Command not found (exit 127)',
    detail: 'A program invoked in the build or entrypoint is not installed in the image.', fix: 'Install the package in the image (alpine images lack bash/curl by default) or use the correct shell.' },
  { id: 'log-exit-139', rx: /exit(?:ed)?(?: with)?(?: code)? 139|segmentation fault/i, sev: 'high', title: 'Segmentation fault (exit 139)',
    detail: 'The process crashed with SIGSEGV, often due to native libraries, musl/glibc mismatch, or architecture issues.', fix: 'Try a glibc-based base image (debian-slim) instead of alpine, check native module builds, and upgrade the offending library.' },
  { id: 'log-node-module', rx: /cannot find module|err_module_not_found|modulenotfounderror|no module named/i, sev: 'medium', title: 'Missing runtime dependency',
    detail: 'The app imports a package that is not installed in the image.', fix: 'Make sure dependencies are installed in the final stage (npm ci --omit=dev / pip install -r requirements.txt) and are not excluded by .dockerignore.' },
  { id: 'log-mongo', rx: /mongoserverselectionerror|mongonetworkerror|failed to connect to server .*27017/i, sev: 'high', title: 'Cannot reach MongoDB',
    detail: 'The app cannot connect to the MongoDB host.', fix: 'In Compose use mongodb://mongo:27017/… (service name), wait for the database to be healthy, and for Atlas allow the server IP.' }
];

export function analyzeLogs(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (const rule of LOG_RULES) {
    const idx = lines.findIndex((l) => rule.rx.test(l));
    if (idx === -1) continue;
    const hits = lines.filter((l) => rule.rx.test(l)).length;
    const evidence = lines[idx].trim().slice(0, 200);
    out.push(f(rule.id, rule.sev, rule.title, `${rule.detail}${hits > 1 ? ` (seen ${hits} times)` : ''} Evidence: “${evidence}”`, rule.fix, idx + 1));
  }
  return out;
}

/* ------------------------------------------------------- main entrypoint */
export function analyzeText(rawText, filename = '') {
  const text = String(rawText || '');
  const type = detectType(text, filename);
  let findings = [];
  if (type === 'dockerfile') findings = analyzeDockerfile(text);
  else if (type === 'compose') findings = analyzeCompose(text);
  else findings = analyzeLogs(text);

  if (type !== 'logs') findings.push(...analyzeLogs(text).filter((x) => x.severity === 'critical'));
  const { count: secretCount } = redactSecrets(text);
  if (secretCount && !findings.some((x) => x.id.endsWith('secret'))) {
    findings.push(f('secrets-present', 'high', 'Secret-like values detected in the input', `${secretCount} value(s) look like credentials, tokens or keys. They were redacted before any external AI call.`, 'Rotate anything that was exposed, and keep secrets out of logs, images and repositories.'));
  }
  findings.sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity));

  const counts = Object.fromEntries(SEV_ORDER.map((s) => [s, 0]));
  findings.forEach((x) => { counts[x.severity] += 1; });
  return { detectedType: type, findings, counts, summary: buildSummary(type, counts, findings, text) };
}

function buildSummary(type, counts, findings, text) {
  const label = { dockerfile: 'Dockerfile', compose: 'Docker Compose file', logs: 'Docker/container logs', text: 'text' }[type];
  const lineCount = text.split(/\r?\n/).length;
  if (!findings.length) {
    return type === 'text'
      ? `Analyzed ${lineCount} lines of ${label}. No Docker-specific issue patterns were recognised — paste Dockerfile content, a compose file or container logs for deeper checks.`
      : `Analyzed ${lineCount} lines of ${label}. No known issue patterns were found.`;
  }
  const worst = ['critical', 'high', 'medium', 'low', 'info'].filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`).join(', ');
  return `Analyzed ${lineCount} lines of ${label} and found ${findings.length} item(s): ${worst}. Most important: ${findings[0].title}.`;
}

export function suggestNextSteps(findings) {
  const steps = [];
  const top = findings.slice(0, 3);
  top.forEach((x) => steps.push(`${x.title} — ${x.fix}`));
  steps.push('Re-run the build or container after each fix and compare the logs.');
  return steps;
}
