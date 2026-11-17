'use strict';
// Extraktions-Deckel der Komplettanalyse je lokalem Provider: `ai.komplett.extract_max_tokens`
// galt gemeinsam für Ollama und openai-compat (Claude ignoriert ihn). Ab jetzt
// `ai.ollama.komplett.extract_max_tokens` und `ai.openai-compat.komplett.extract_max_tokens`
// im Panel des jeweiligen Providers (routes/jobs/komplett/phases/tokens.js#komplettMaxTokens).
// Ein gesetzter Altwert geht an beide Keys, sofern dort noch nichts steht; der Alt-Key fällt weg.
const OLD = 'ai.komplett.extract_max_tokens';
const NEW = ['ai.ollama.komplett.extract_max_tokens', 'ai.openai-compat.komplett.extract_max_tokens'];

module.exports = {
  version: 368,
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
