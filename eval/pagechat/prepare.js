'use strict';
// Eval-DB aus einer Prod-Kopie: entschärft und mit den LOKALEN Zugangsdaten.
//
// - Alle Keys, die die Registry verschlüsselt speichert (ENCRYPTED_KEYS: API-Keys,
//   OAuth-Secrets, SMTP-Passwort, GitHub-Token), fliegen raus — und nur diese. Ein
//   grober Muster-Filter träfe auch `ai.claude.max_tokens_out` & Co. und änderte das
//   Verhalten, das gemessen werden soll.
// - KI-Profile verlieren ihren Key, Blog-/HubSpot-Verbindungen werden geleert: die
//   Eval darf nichts publizieren und keine fremden Endpunkte mit Prod-Rechten rufen.
// - Eingesetzt werden aus der lokalen DB (mit dem lokalen SESSION_SECRET
//   verschlüsselt, passend zur .env der Eval): Claude-Key, Embedding- und
//   Rerank-Key — die Buch-Kontext-Suche des Abschnitts-Chats braucht sie.

const fs = require('fs');
const Database = require('better-sqlite3');

const INJECT_KEYS = ['ai.claude.api_key', 'embed.api_key', 'rerank.api_key'];

function prepareEvalDb({ source, target, localDb }) {
  if (!fs.existsSync(source)) throw new Error(`Quelle fehlt: ${source}`);
  if (!fs.existsSync(localDb)) throw new Error(`Lokale DB fehlt (für die Zugangsdaten): ${localDb}`);
  const { ENCRYPTED_KEYS } = require('../../lib/app-settings/registry');

  // DB samt WAL kopieren; der Checkpoint läuft in der Zielkopie (die Quelle bleibt
  // unberührt und darf schreibgeschützt sein).
  for (const ext of ['-wal', '-shm']) fs.rmSync(target + ext, { force: true });
  fs.copyFileSync(source, target);
  if (fs.existsSync(source + '-wal')) fs.copyFileSync(source + '-wal', target + '-wal');

  const db = new Database(target);
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.pragma('journal_mode = DELETE');
  const keys = [...ENCRYPTED_KEYS];
  const del = db.prepare('DELETE FROM app_settings WHERE key = ?');
  const removed = db.transaction(() => keys.reduce((n, k) => n + del.run(k).changes, 0))();
  db.prepare('UPDATE ai_profiles SET api_key = NULL').run();
  for (const t of ['blog_connections', 'hubspot_connections']) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch { /* Tabelle fehlt in alten Kopien */ }
  }

  const local = new Database(localDb, { readonly: true });
  const ins = db.prepare('INSERT OR REPLACE INTO app_settings (key, value_json, encrypted, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)');
  const injected = [];
  for (const k of INJECT_KEYS) {
    const row = local.prepare('SELECT value_json, encrypted FROM app_settings WHERE key = ?').get(k);
    if (!row) continue;
    ins.run(k, row.value_json, row.encrypted, new Date().toISOString(), 'eval-pagechat');
    injected.push(k);
  }
  local.close();
  db.close();
  return { removed, injected };
}

module.exports = { prepareEvalDb, INJECT_KEYS };
