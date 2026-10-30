'use strict';
// Schulstufen-/Weg-Bezeichnungen für Server-Texte, die ein MODELL liest (Prompt
// des Jobs `schulweg-vorschlag`, Ergebnis von `get_figure_age`). Die Rechenschicht
// (public/js/book/school-path.js) liefert nur i18n-Keys (`schule.*`); die Wörter
// stehen ausschliesslich in public/js/i18n/{de,en}.json. Dieser Leser löst die Keys
// in der Buchsprache auf, statt eine zweite Wortliste im Server zu führen.

const fs = require('fs');
const path = require('path');

const _cache = new Map();

function _locale(lang) {
  const l = lang === 'en' ? 'en' : 'de';
  if (!_cache.has(l)) {
    let data = {};
    try {
      data = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'public', 'js', 'i18n', `${l}.json`), 'utf8'));
    } catch { /* fehlende Datei: Keys bleiben roh */ }
    _cache.set(l, data);
  }
  return _cache.get(l);
}

/** Übersetzung eines `schule.*`-Keys in der Sprache `lang` (Fallback de, dann Key). */
function schoolLabel(key, lang = 'de', params = null) {
  let s = _locale(lang)[key] ?? _locale('de')[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

module.exports = { schoolLabel };
