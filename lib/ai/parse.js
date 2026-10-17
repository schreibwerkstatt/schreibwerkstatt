'use strict';
// JSON-Parse-Fallback-Kette für KI-Antworten + Rohtext-Feld-Extraktion.
// Mehrstufig: JSON.parse → extractBalancedJson → jsonrepair → escapeUnescapedQuotes.

const fsp = require('fs/promises');
const path = require('path');
const { jsonrepair } = require('jsonrepair');
const logger = require('../../logger');

// Nach N Dateien in ai_parse_fails/ werden die ältesten gelöscht – sonst wächst
// das Verzeichnis unbegrenzt, weil lokale Modelle oft identische Drifts produzieren.
const PARSE_FAILS_MAX = 50;

async function _rotateParseFails(dir) {
  try {
    const entries = await fsp.readdir(dir);
    if (entries.length <= PARSE_FAILS_MAX) return;
    const stats = await Promise.all(entries.map(async name => ({
      name, mtimeMs: (await fsp.stat(path.join(dir, name))).mtimeMs,
    })));
    stats.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const victims = stats.slice(0, entries.length - PARSE_FAILS_MAX);
    await Promise.all(victims.map(v => fsp.unlink(path.join(dir, v.name)).catch(() => {})));
  } catch { /* best-effort */ }
}

async function _dumpParseFail(clean, pos, reason = '') {
  const dir = path.resolve(__dirname, '..', '..', 'ai_parse_fails');
  try {
    await fsp.mkdir(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const fp = path.join(dir, `${ts}.txt`);
    await fsp.writeFile(fp, clean, 'utf8');
    logger.error(`JSON-Parse-Fehler${reason ? ` (${reason})` : ''}: Rohtext (${clean.length} chars, pos=${pos}) nach ${fp} geschrieben.`);
    _rotateParseFails(dir); // fire-and-forget
  } catch (writeErr) {
    logger.warn(`Konnte Rohtext nicht in ai_parse_fails/ schreiben: ${writeErr.message}`);
  }
}

// Extrahiert das erste balancierte JSON-Objekt aus text, ohne Trailing-Content
// mit {}-Mustern (z.B. Modell-Hinweise nach dem JSON) einzuschliessen.
// Nutzt einen typ-sensitiven Stack – so wird `{"a":[}` nicht fälschlich als
// balanciert erkannt (wie die frühere depth-Zählung ohne Typ-Info es tat).
function extractBalancedJson(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  const stack = [];
  let inString = false, escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (inString && ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') {
      const opener = stack.pop();
      const expected = ch === '}' ? '{' : '[';
      if (opener !== expected) return null; // unpassendes Schliesszeichen → kein valider JSON-Bereich
      if (stack.length === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// Heuristik gegen unescaptes ASCII-`"` mitten in JSON-String-Werten (typisch:
// Modell schreibt Anführungszeichen-Beispiele in «erklaerung» und vergisst Escape).
// Walk char-für-char, im String-State: ist das nächste non-whitespace nach `"`
// eines von , } ] : → echter Terminator; sonst escape `"` zu `\"`.
function escapeUnescapedQuotes(text) {
  let out = '';
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      continue;
    }
    if (escape) { out += ch; escape = false; continue; }
    if (ch === '\\') { out += ch; escape = true; continue; }
    if (ch === '"') {
      const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
      let j = i + 1;
      while (j < text.length && isWs(text[j])) j++;
      const next = text[j];
      let terminator;
      if (next === '}' || next === ']' || next === ':' || next === undefined) {
        // Struktur-Schliesser/Key-Doppelpunkt/EOF → eindeutig echter Terminator.
        terminator = true;
      } else if (next === ',') {
        // Mehrdeutig: echter Terminator `",` ODER Dialog-Quote + Prosa-Komma
        // (DE „Ada", bis …). Echtes JSON setzt nach `",` immer einen weiteren
        // Key/Wert-Start (`"`), einen Struktur-Schliesser oder EOF — niemals
        // einen Prosa-Buchstaben. Ein Komma gefolgt von Wort → Dialog → escapen.
        let k = j + 1;
        while (k < text.length && isWs(text[k])) k++;
        const after = text[k];
        terminator = after === '"' || after === '}' || after === ']' || after === undefined;
      } else {
        terminator = false;
      }
      if (terminator) {
        out += ch;
        inString = false;
      } else {
        out += '\\"';
      }
      continue;
    }
    out += ch;
  }
  return out;
}

// i18n-Key des Parse-Fehlers (job.error.parseFailed in de/en.json).
const PARSE_FAILED_KEY = 'job.error.parseFailed';

function parseJSON(text) {
  const clean = text.replace(/```json\s*|```/g, '').trim();
  try { return JSON.parse(clean); } catch {
    const candidate = extractBalancedJson(clean) ?? clean;
    try { return JSON.parse(candidate); } catch {
      try { return JSON.parse(jsonrepair(candidate)); } catch {
        const escaped = escapeUnescapedQuotes(candidate);
        try { return JSON.parse(escaped); } catch {
          try { return JSON.parse(jsonrepair(escaped)); } catch (e3) {
        const posMatch = /position\s+(\d+)/i.exec(e3.message);
        const pos = posMatch ? parseInt(posMatch[1], 10) : null;
        let preview;
        if (pos != null) {
          const from = Math.max(0, pos - 300);
          const to   = Math.min(clean.length, pos + 300);
          preview = `…${clean.slice(from, pos)}⟦HIER⟧${clean.slice(pos, to)}… (pos ${pos} von ${clean.length})`;
        } else {
          preview = clean.length > 300 ? clean.slice(0, 300) + '…' : clean;
        }
        // Technisches Detail (Parser-Meldung, Rohtext-Dump) nur ins Log bzw. an
        // `err.detail`; der User bekommt den i18n-Key. Derselbe Key steht in der
        // Notify-Skip-Liste (lib/notify.js#DEFAULT_SKIP_ERRORS, mail.notify.skip_errors).
        _dumpParseFail(clean, pos, e3.message);
        const err = new Error(PARSE_FAILED_KEY);
        err.code = 'AI_PARSE_FAILED';
        err.i18nParams = { pos: pos ?? '-', len: clean.length };
        err.detail = `${e3.message}. Kontext: ${preview}`;
        throw err;
          }
        }
      }
    }
  }
}

// Anführungszeichen-Paare, die das Modell statt ASCII `"` produzieren kann.
// Reihenfolge: ASCII zuerst (Standard), dann typografische Varianten.
// Modelle verwechseln gerne JSON-Quotes mit Sprach-Quotes (DE „…", CH «…»,
// EN "…", FR «…»/‹…›). Bei kaputtem JSON akzeptieren wir alle.
const QUOTE_PAIRS = [
  ['"', '"'],
  ['„', '“'], // „ … "  DE
  ['«', '»'], // « … »  CH/FR
  ['“', '”'], // " … "  typografisch EN
  ['‘', '’'], // ' … '  typografisch single
  ['‚', '‘'], // ‚ … '  DE single
  ['‹', '›'], // ‹ … ›  FR single guillemets
];

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Extrahiert String-Feldwert per Regex aus JSON-Rohtext, ohne den Baum zu
// parsen. Zweck: wenn parseJSON wirft (z.B. unescaptes `"` in Nachbarfeld
// oder Modell-Mix mit Sprach-Quotes), wenigstens Pflichtfeld retten.
// Iteriert alle Quote-Paare für Schlüssel und Wert. JSON-decoded falls
// möglich (nur ASCII-Capture), sonst Roh-Capture.
function extractStringField(text, fieldName) {
  for (const [ko, kc] of QUOTE_PAIRS) {
    for (const [vo, vc] of QUOTE_PAIRS) {
      const re = new RegExp(
        `${escapeRe(ko)}${escapeRe(fieldName)}${escapeRe(kc)}\\s*:\\s*${escapeRe(vo)}((?:\\\\.|(?!${escapeRe(vc)}).)*)${escapeRe(vc)}`,
        's',
      );
      const m = text.match(re);
      if (m) {
        if (vo === '"') {
          try { return JSON.parse('"' + m[1] + '"'); }
          catch { return m[1]; }
        }
        return m[1];
      }
    }
  }
  return null;
}

// Lenient parseJSON: schluckt Parse-Fehler, extrahiert benannte String-Felder
// einzeln. Für Konsumenten, die User-sichtbare Prosa retten wollen statt zu
// failen. Rückgabe: { ok, parsed?, partial?, error? } — partial._raw als
// Notnagel der fence-freie Rohtext.
function parseJSONLenient(text, stringFields = []) {
  try { return { ok: true, parsed: parseJSON(text) }; }
  catch (err) {
    const partial = {};
    for (const f of stringFields) {
      const v = extractStringField(text, f);
      if (v != null) partial[f] = v;
    }
    if (Object.keys(partial).length === 0) {
      partial._raw = text.replace(/```json\s*|```/g, '').trim();
    }
    return { ok: false, partial, error: err };
  }
}

module.exports = {
  PARSE_FAILED_KEY,
  parseJSON, parseJSONLenient, extractStringField,
  extractBalancedJson, escapeUnescapedQuotes, QUOTE_PAIRS,
};
