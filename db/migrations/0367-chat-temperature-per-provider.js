'use strict';
// Chat-Temperatur je lokalem Provider: `ai.chat_temperature` wirkte nur bei Ollama und
// openai-compat (Claude kennt keine Temperatur-Einstellung) und stand darum provider-
// übergreifend im Admin-Tab «Erweitert». Ab jetzt `ai.ollama.chat_temperature` und
// `ai.openai-compat.chat_temperature` im Panel des jeweiligen Providers
// (lib/ai/config.js#chatTemperature). Ein gesetzter Altwert geht an beide Keys,
// sofern dort noch nichts steht; der Alt-Key fällt weg.
const OLD = 'ai.chat_temperature';
const NEW = ['ai.ollama.chat_temperature', 'ai.openai-compat.chat_temperature'];

module.exports = {
  version: 367,
  up(db) {
    const hasTable = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'").get();
    if (!hasTable) return;
    const row = db.prepare('SELECT value_json, encrypted, updated_at, updated_by FROM app_settings WHERE key = ?').get(OLD);
    if (!row) return;
    const insert = db.prepare(
      `INSERT OR IGNORE INTO app_settings (key, value_json, encrypted, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?)`
    );
    for (const key of NEW) insert.run(key, row.value_json, row.encrypted, row.updated_at, row.updated_by);
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(OLD);
  },
};
