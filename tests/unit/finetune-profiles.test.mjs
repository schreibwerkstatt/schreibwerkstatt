// Trainingsprofile der Fine-Tuning-Export-Karte (public/js/book/finetune-profiles.js):
// erzeugtes Studio-YAML, Drift gegen die kommentierte Referenz
// docs/unsloth-config/studio-config.yaml (Default-Profil) und gegen die
// Profiltabelle in docs/finetuning.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  FINETUNE_PROFILES, DEFAULT_FINETUNE_PROFILE_ID, finetuneProfileById, studioConfig, buildStudioYaml,
} from '../../public/js/book/finetune-profiles.js';

const read = (rel) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

const scalar = (raw) => {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const n = Number(raw);
  return raw !== '' && Number.isFinite(n) ? n : raw;
};

// Flacher Parser für das Studio-Schema (zwei Ebenen + Listen), reicht für
// beide Dateien: `section.key` → Wert bzw. Liste.
function flatYaml(text) {
  const out = {};
  let section = null;
  let listKey = null;
  for (const line of text.split('\n')) {
    const code = line.replace(/\s+#.*$/, '');
    if (!code.trim() || code.trimStart().startsWith('#')) continue;
    let m;
    if ((m = /^(\w+):\s*$/.exec(code))) { section = m[1]; listKey = null; continue; }
    if ((m = /^ {2}(\w+):\s*$/.exec(code))) { listKey = `${section}.${m[1]}`; out[listKey] = []; continue; }
    if ((m = /^ {4}- (.+)$/.exec(code))) { out[listKey].push(scalar(m[1].trim())); continue; }
    if ((m = /^ {2}(\w+):\s*(.+)$/.exec(code))) { out[`${section}.${m[1]}`] = scalar(m[2].trim()); listKey = null; continue; }
    throw new Error(`unerwartete YAML-Zeile: ${line}`);
  }
  return out;
}

const flatConfig = (cfg) => {
  const out = {};
  for (const [section, fields] of Object.entries(cfg)) {
    for (const [k, v] of Object.entries(fields)) out[`${section}.${k}`] = v;
  }
  return out;
};

test('Profil-IDs sind eindeutig, Default existiert, Sequenz passt ins Export-Feld', () => {
  const ids = FINETUNE_PROFILES.map(p => p.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes(DEFAULT_FINETUNE_PROFILE_ID));
  for (const p of FINETUNE_PROFILES) {
    assert.ok(p.seq > 0 && p.seq <= 16384, `${p.id}: seq ausserhalb des numInput-Bereichs`);
    assert.equal(p.batch * p.accum, 16, `${p.id}: effektive Batch weicht von 16 ab`);
  }
  assert.equal(finetuneProfileById('gibt-es-nicht').id, DEFAULT_FINETUNE_PROFILE_ID);
});

test('buildStudioYaml liefert genau die Werte aus studioConfig', () => {
  for (const p of FINETUNE_PROFILES) {
    const yaml = buildStudioYaml(p, { header: ['Kopf', 'Zeile: mit Doppelpunkt'] });
    assert.deepEqual(flatYaml(yaml), flatConfig(studioConfig(p)), p.id);
  }
});

test('max_seq_length folgt dem Export-Feld, 0 fällt aufs Profil zurück', () => {
  const p = finetuneProfileById(DEFAULT_FINETUNE_PROFILE_ID);
  assert.equal(studioConfig(p, { maxSeqTokens: 2048 }).training.max_seq_length, 2048);
  assert.equal(studioConfig(p, { maxSeqTokens: 0 }).training.max_seq_length, p.seq);
});

test('docs/unsloth-config/studio-config.yaml entspricht dem Default-Profil', () => {
  const docs = flatYaml(read('docs/unsloth-config/studio-config.yaml'));
  const expected = flatConfig(studioConfig(finetuneProfileById(DEFAULT_FINETUNE_PROFILE_ID)));
  assert.deepEqual(docs, expected);
});

test('docs/finetuning.md listet jedes Profil mit seinen Werten', () => {
  const md = read('docs/finetuning.md');
  for (const p of FINETUNE_PROFILES) {
    const row = `| ${p.name} | ${p.vramGb} GB | ${p.batch} | ${p.accum} | ${p.seq} | ${p.r} |`;
    assert.ok(md.includes(row), `fehlende Zeile: ${row}`);
  }
});
