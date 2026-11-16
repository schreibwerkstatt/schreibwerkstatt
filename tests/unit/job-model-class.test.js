'use strict';
// Gate: jeder Job-Typ steht in genau einer Modell-Klasse — sonst trägt
// createJob ihm das Chat-Modell der Instanz in job_runs ein, und Job-Statistik,
// Admin-Nutzung und /metrics weisen einen Claude-Lauf aus, der nie stattfand.
// Regel: routes/jobs/CLAUDE.md («Modell-Klasse: was der Job protokolliert»).
//
//  - Chat-Job        → Zeile in JOB_TIER_CATALOG (lib/ai/job-tiers.js)
//  - Embedding-Job   → EMBED_JOB_TYPES
//  - STT-Job         → STT_JOB_TYPES
//  - ohne Modell     → NO_AI_JOB_TYPES
//
// Grundmenge sind die Typen in JOB_TYPE_LABELS (Pflicht für jeden neuen Job).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('job-model-class');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
require('../../db/migrations');

const jobs = require('../../routes/jobs/shared/jobs');
const { JOB_TIER_CATALOG } = require('../../lib/ai/job-tiers');

const CHAT = new Set(JOB_TIER_CATALOG.map(e => e.type));
const CLASSES = {
  chat: CHAT,
  embed: jobs.EMBED_JOB_TYPES,
  stt: jobs.STT_JOB_TYPES,
  none: jobs.NO_AI_JOB_TYPES,
};

test('jeder Job-Typ steht in genau einer Modell-Klasse', () => {
  const problems = [];
  for (const type of Object.keys(jobs.JOB_TYPE_LABELS)) {
    const hits = Object.entries(CLASSES).filter(([, set]) => set.has(type)).map(([k]) => k);
    if (hits.length !== 1) problems.push(`${type}: ${hits.length ? hits.join(' + ') : 'keine Klasse'}`);
  }
  assert.deepEqual(problems, [],
    'Job-Typ ohne bzw. mit mehrfacher Modell-Klasse — siehe routes/jobs/CLAUDE.md «Modell-Klasse»');
});

// Ein Typ ausserhalb der Chat-Klasse darf keinen Chat-Call machen. Grob über den
// Quelltext: jede Datei unter routes/jobs/, die den Typ als String-Literal nennt,
// darf `callAI(`/`aiCall(` nicht ausserhalb eines Kommentars aufrufen.
test('Jobs ohne Chat-Klasse rufen kein callAI/aiCall', () => {
  const root = path.join(__dirname, '../../routes/jobs');
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'shared') walk(p); }
      else if (e.name.endsWith('.js')) files.push(p);
    }
  })(root);
  const src = new Map(files.map(f => [f, fs.readFileSync(f, 'utf8')]));
  const code = (s) => s.split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  const problems = [];
  for (const set of [jobs.EMBED_JOB_TYPES, jobs.STT_JOB_TYPES, jobs.NO_AI_JOB_TYPES]) {
    for (const type of set) {
      for (const [f, s] of src) {
        if (!s.includes(`'${type}'`)) continue;
        if (/\b(callAI|aiCall)\s*\(/.test(code(s))) problems.push(`${type} → ${path.relative(root, f)}`);
      }
    }
  }
  assert.deepEqual(problems, [], 'Job in Embedding-/STT-/Ohne-Modell-Klasse ruft ein Chat-Modell');
});
