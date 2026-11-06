import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeText, detectType, redactSecrets } from '../src/services/dockerAnalyzer.js';

const ids = (r) => r.findings.map((f) => f.id);

test('detects file types', () => {
  assert.equal(detectType('FROM node:20\nRUN echo hi', 'Dockerfile'), 'dockerfile');
  assert.equal(detectType('services:\n  web:\n    image: nginx', ''), 'compose');
  assert.equal(detectType('container exited with error', 'app.log'), 'logs');
  assert.equal(detectType('hello world', ''), 'text');
});

test('flags insecure Dockerfile', () => {
  const r = analyzeText(`FROM node:latest
ENV API_TOKEN=abc123456
COPY . .
RUN npm install
RUN curl https://x.sh | sh
CMD npm start`, 'Dockerfile');
  for (const id of ['df-latest', 'df-secret', 'df-root', 'df-curl-pipe', 'df-cache-order', 'df-shell-form']) assert.ok(ids(r).includes(id), id);
  assert.equal(r.findings[0].severity, 'critical');
});

test('clean Dockerfile has no high findings', () => {
  const r = analyzeText(`FROM node:20.11-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
USER node
HEALTHCHECK CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["node","server.js"]`, 'Dockerfile');
  assert.equal(r.counts.critical + r.counts.high, 0);
});

test('flags risky compose', () => {
  const r = analyzeText(`services:
  db:
    image: postgres:latest
    ports:
      - "5432:5432"
    environment:
      POSTGRES_PASSWORD: hunter2
  agent:
    image: foo:1
    privileged: true
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock`, 'docker-compose.yml');
  for (const id of ['dc-privileged', 'dc-docker-sock', 'dc-db-exposed', 'dc-secret', 'dc-latest']) assert.ok(ids(r).includes(id), id);
});

test('diagnoses logs', () => {
  const r = analyzeText(`api exited with code 137
Error: bind: address already in use
dial tcp 10.0.0.2:27017: connect: connection refused`, 'run.log');
  for (const id of ['log-oom', 'log-port', 'log-conn-refused']) assert.ok(ids(r).includes(id), id);
});

test('redacts secrets', () => {
  const { text, count } = redactSecrets('DB_PASSWORD=supersecret\nurl=mongodb://user:pw123@host/db\nkey AKIAABCDEFGHIJKLMNOP');
  assert.ok(count >= 3);
  assert.ok(!text.includes('supersecret') && !text.includes('pw123') && !text.includes('AKIAABCDEFGHIJKLMNOP'));
});
