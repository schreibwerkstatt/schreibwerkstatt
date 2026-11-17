import test from 'node:test';
import assert from 'node:assert';

// pdfx-convert liest ENV beim Call (nicht beim Require), darum koennen wir
// GS_DISABLED / GS_BIN / PDFX_ICC_PATH pro Test setzen.
const { convertToPdfX } = await import('../../lib/pdfx-convert.js');

const DUMMY = Buffer.from('%PDF-1.4\n%dummy\n');

test('GS_DISABLED → non-fatal, available:false (disabled)', async () => {
  const prev = process.env.GS_DISABLED;
  process.env.GS_DISABLED = 'true';
  try {
    const r = await convertToPdfX(DUMMY);
    assert.equal(r.available, false);
    assert.equal(r.reason, 'disabled');
  } finally {
    if (prev === undefined) delete process.env.GS_DISABLED; else process.env.GS_DISABLED = prev;
  }
});

test('fehlendes ICC → non-fatal, available:false (icc-missing)', async () => {
  const prevDis = process.env.GS_DISABLED;
  const prevIcc = process.env.PDFX_ICC_PATH;
  delete process.env.GS_DISABLED;
  process.env.PDFX_ICC_PATH = '/nonexistent/path/does-not-exist.icc';
  try {
    const r = await convertToPdfX(DUMMY);
    assert.equal(r.available, false);
    assert.equal(r.reason, 'icc-missing');
  } finally {
    if (prevDis === undefined) delete process.env.GS_DISABLED; else process.env.GS_DISABLED = prevDis;
    if (prevIcc === undefined) delete process.env.PDFX_ICC_PATH; else process.env.PDFX_ICC_PATH = prevIcc;
  }
});

test('fehlendes gs-Binary → non-fatal, available:false (binary-missing)', async () => {
  // ICC muss existieren, damit der Pfad bis zum Binary-Aufruf kommt — nutze
  // diese Testdatei selbst als vorhandenes "ICC".
  const prevDis = process.env.GS_DISABLED;
  const prevIcc = process.env.PDFX_ICC_PATH;
  const prevBin = process.env.GS_BIN;
  delete process.env.GS_DISABLED;
  process.env.PDFX_ICC_PATH = new URL(import.meta.url).pathname;
  process.env.GS_BIN = '/nonexistent/gs-binary-xyz';
  try {
    const r = await convertToPdfX(DUMMY);
    assert.equal(r.available, false);
    assert.equal(r.reason, 'binary-missing');
  } finally {
    if (prevDis === undefined) delete process.env.GS_DISABLED; else process.env.GS_DISABLED = prevDis;
    if (prevIcc === undefined) delete process.env.PDFX_ICC_PATH; else process.env.PDFX_ICC_PATH = prevIcc;
    if (prevBin === undefined) delete process.env.GS_BIN; else process.env.GS_BIN = prevBin;
  }
});

// ── SAFER-Modus ─────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeTmpDir } from './_helpers/tmp-dir.js';

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  return Promise.resolve().then(fn).finally(() => {
    for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  });
}

test('gs laeuft mit -dSAFER + --permit-file-read=<ICC>, nie mit -dNOSAFER', async () => {
  // Fake-gs: protokolliert seine Argumente und schreibt eine Ausgabedatei.
  const dir = makeTmpDir('pdfx-fake-');
  const log = path.join(dir, 'args.txt');
  const bin = path.join(dir, 'gs');
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\nfor a in "$@"; do case "$a" in -sOutputFile=*) printf '%%PDF-fake' > "\${a#-sOutputFile=}";; esac; done\n`);
  fs.chmodSync(bin, 0o755);
  const icc = new URL(import.meta.url).pathname;
  try {
    await withEnv({ GS_DISABLED: undefined, GS_BIN: bin, PDFX_ICC_PATH: icc }, async () => {
      const r = await convertToPdfX(DUMMY);
      assert.equal(r.available, true, JSON.stringify(r));
      const args = fs.readFileSync(log, 'utf8').split('\n');
      assert.ok(args.includes('-dSAFER'));
      assert.ok(!args.includes('-dNOSAFER'));
      assert.ok(args.includes(`--permit-file-read=${icc}`));
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('abgebrochenes Signal → AbortError (kein stilles Fallback)', async () => {
  await withEnv({ GS_DISABLED: undefined, PDFX_ICC_PATH: new URL(import.meta.url).pathname }, async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await assert.rejects(convertToPdfX(DUMMY, { signal: ctrl.signal }), { name: 'AbortError' });
  });
});

// Echtes Ghostscript (falls installiert) mit einem System-ICC: belegt, dass
// SAFER + permit-file-read reicht, damit das PDFX_def das ICC lesen darf.
const SYSTEM_ICC = ['/usr/share/color/icc/colord/FOGRA39L_coated.icc', '/usr/share/color/icc/ghostscript/default_cmyk.icc']
  .find(p => fs.existsSync(p));
let HAS_GS = false;
try { execFileSync('gs', ['--version'], { stdio: 'ignore' }); HAS_GS = true; } catch { /* kein gs */ }

test('echtes gs: pdfkit-PDF → PDF/X-3 unter -dSAFER', { skip: !(HAS_GS && SYSTEM_ICC) && 'gs oder System-ICC fehlt' }, async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const PDFDocument = require('pdfkit');
  const pdf = await new Promise((resolve) => {
    const d = new PDFDocument(); const ch = [];
    d.on('data', c => ch.push(c)); d.on('end', () => resolve(Buffer.concat(ch)));
    d.text('Probe'); d.end();
  });
  await withEnv({ GS_DISABLED: undefined, GS_BIN: undefined, PDFX_ICC_PATH: SYSTEM_ICC }, async () => {
    const r = await convertToPdfX(pdf, { title: 'T' });
    assert.equal(r.available, true, JSON.stringify({ reason: r.reason }));
    const s = r.buffer.toString('latin1');
    assert.match(s, /GTS_PDFX/);
    assert.match(s, /PDF\/X-3:2003/);
  });
});
