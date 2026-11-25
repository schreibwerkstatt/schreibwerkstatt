'use strict';
// Anzeige-Rate der Text-Tokens folgt dem Claude-Modell: `tok = ROUND(chars / rate)`
// in page_stats, book_stats_history und page_revisions mit der Rate, die
// lib/ai/config.js#CHARS_PER_TOKEN ab jetzt beim Boot bildet — für eine
// Claude-Instanz die des globalen Modells (Opus/Sonnet 5.x: 2.1 statt pauschal 3).
// Ohne Neuberechnung sprängen Hero-Zahl und Sparkline am ersten Save, und
// Bestand und neue Zeilen stünden in zwei Einheiten nebeneinander.
//
// Die Rate kommt aus derselben Regel wie zur Laufzeit (lib/ai/chars-per-token.js,
// abhängigkeitsfrei). lib/ai selbst ist hier nicht ladbar: Migrationen laufen beim
// Laden von lib/app-settings. Die drei Settings werden darum direkt gelesen —
// app-settings liest ausschliesslich die DB-Zeile, sonst den Registry-Default.
const { instanceCharsPerToken } = require('../../lib/ai/chars-per-token');

function _setting(db, key) {
  try {
    const row = db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(key);
    return row ? JSON.parse(row.value_json) : undefined;
  } catch { return undefined; }
}

module.exports = {
  version: 374,
  up(db) {
    const provider = String(_setting(db, 'ai.provider') || 'claude').toLowerCase();
    const model = String(_setting(db, 'ai.claude.model') || 'claude-sonnet-5-5');
    const explicitRaw = _setting(db, 'ai.chars_per_token');
    const explicit = explicitRaw === undefined ? null : (Number(explicitRaw) || null);
    const rate = instanceCharsPerToken(provider, model, explicit);
    for (const table of ['page_stats', 'book_stats_history', 'page_revisions']) {
      db.prepare(`UPDATE ${table} SET tok = ROUND(chars / ?) WHERE chars IS NOT NULL`).run(rate);
    }
  },
};
