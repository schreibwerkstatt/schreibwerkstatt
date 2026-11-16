// Vorlagen für KI-Profile (public/js/admin/ai-profile-templates.js): eine Vorlage füllt
// nur Felder, die das Profil-Formular kennt und die Route speichert, nie Host oder
// API-Key (gehören zur Installation), und ihre Texte stehen in beiden Locales.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AI_PROFILE_TEMPLATES, aiProfileTemplate } from '../../public/js/admin/ai-profile-templates.js';

const ROOT = new URL('../../', import.meta.url);
const de = JSON.parse(readFileSync(new URL('public/js/i18n/de.json', ROOT), 'utf8'));
const en = JSON.parse(readFileSync(new URL('public/js/i18n/en.json', ROOT), 'utf8'));
const formSrc = readFileSync(new URL('public/js/admin/admin-ai-profiles.js', ROOT), 'utf8');
const formKeys = Object.keys(Function(`return (${/const EMPTY_PROFILE = (\{[\s\S]*?\});/.exec(formSrc)[1]})`)());

test('Vorlagen: eindeutige IDs, nur Formularfelder, nie Host/API-Key', () => {
  const ids = AI_PROFILE_TEMPLATES.map(t => t.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const t of AI_PROFILE_TEMPLATES) {
    for (const k of Object.keys(t.form)) assert.ok(formKeys.includes(k), `${t.id}: unbekanntes Feld ${k}`);
    assert.equal('host' in t.form, false, `${t.id}: Host gehört zur Installation`);
    assert.equal('api_key' in t.form, false, `${t.id}: API-Key gehört zur Installation`);
    // Dreiwertige Felder als String (Combobox-Werte), sonst matcht die Auswahl nicht.
    for (const k of ['cloud', 'think']) if (k in t.form) assert.ok(['', 'true', 'false'].includes(t.form[k]), `${t.id}.${k}`);
    assert.ok(['claude', 'ollama', 'openai-compat'].includes(t.form.provider));
  }
});

test('Vorlagen: Texte in beiden Locales', () => {
  for (const key of ['admin.profiles.field.template', 'admin.profiles.templateHelp', 'admin.profiles.template.none',
    ...AI_PROFILE_TEMPLATES.flatMap(t => [t.label, t.notes])]) {
    assert.ok(de[key], `de: ${key}`);
    assert.ok(en[key], `en: ${key}`);
  }
});

test('Qwen-Vorlage: die auf Prod gemessene Belegung', () => {
  const t = aiProfileTemplate('qwen38-27b-think-litellm');
  assert.deepEqual(t.form, {
    provider: 'openai-compat', model: 'qwen3.8-27b-think', cloud: 'true', think: 'true',
    max_parallel: 2, context_window: 196608, max_tokens_out: 32768,
  });
  assert.equal(aiProfileTemplate('gibt-es-nicht'), null);
});
