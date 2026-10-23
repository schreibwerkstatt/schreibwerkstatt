// Fake-Endpunkt für lib/ai/openai-compat.js: lokaler HTTP-Server, der SSE-Chunks
// ausliefert, plus Bootstrap auf einer Wegwerf-DB. Geteilt von den Tool- und den
// Thinking-Tests des Providers.

import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require_ = createRequire(import.meta.url);

/** Fake-Endpunkt. `handler(body, res)` bestimmt die Antwort. Liefert { url, state, close }. */
export async function fakeEndpoint(handler) {
  const state = { last: null, bodies: [] };
  const srv = createServer((req, res) => {
    let buf = '';
    req.on('data', c => { buf += c; });
    req.on('end', () => {
      state.last = JSON.parse(buf || '{}');
      state.bodies.push(state.last);
      handler(state.last, res);
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, state, close: () => srv.close() };
}

export function sse(res, events) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

/** Frische DB + Settings mit dem Fake-Host; `settings` setzt weitere App-Settings. */
export function bootstrap(host, settings = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'oai-fake-'));
  process.env.DB_PATH = join(dir, 'test.db');
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test';
  for (const key of Object.keys(require_.cache)) {
    if (key.includes('/db/') || key.includes('/lib/')) delete require_.cache[key];
  }
  require_('../../../db/connection');
  require_('../../../db/migrations').runMigrations();
  const appSettings = require_('../../../lib/app-settings');
  appSettings.set('ai.openai-compat.host', host, 'test@example.com');
  appSettings.set('ai.openai-compat.retry_max', 1, 'test@example.com');
  for (const [k, v] of Object.entries(settings)) appSettings.set(k, v, 'test@example.com');
  return {
    ai: require_('../../../lib/ai'),
    teardown: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}
