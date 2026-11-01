'use strict';

// Das zuletzt erzeugte Trainingsset liegt pro Buch + User auf der Platte, neben
// der Datenbank (Verzeichnis `finetune-exports/`, überschreibbar per
// FINETUNE_DIR). Der Speicher muss einen Neustart überleben: ein Export mit
// KI-Augmentierung läuft Stunden. Die Nutzdaten gehen NICHT in job.result, weil
// der generische Status-GET (/jobs/:id) die ganze result-Struktur serialisiert —
// bei einem grossen Buch Megabytes pro Poll.
//
// `fingerprint` hält den Buchstand fest, aus dem das Set entstand (Reihenfolge,
// Kapitel und `updated_at` jedes Abschnitts). Weicht der aktuelle Stand ab,
// zeigt die Karte eine Warnung; neu generiert wird nur auf Klick.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DB_FILE } = require('../../../../db/connection');

const DIR = path.resolve(process.env.FINETUNE_DIR || path.join(path.dirname(DB_FILE), 'finetune-exports'));

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

function _base(bookId, userEmail) {
  return path.join(DIR, `${parseInt(bookId, 10)}-${sha1(String(userEmail || '')).slice(0, 16)}`);
}

// Pages aus loadOrderedBookContents (Lesereihenfolge, ohne ausgeschlossene Kapitel).
function bookFingerprint(pages) {
  return sha1(pages.map(p => `${p.id}:${p.chapter_id ?? ''}:${p.updated_at || ''}`).join('|'));
}

function finetuneFilePath(bookId, userEmail, kind) {
  return `${_base(bookId, userEmail)}.${kind}.jsonl`;
}

// Schreibt erst in .tmp-Dateien und benennt dann um: ein Absturz mitten im
// Schreiben lässt das vorige Set heil. Meta zuletzt — sie macht das Set gültig.
// `valFamilyJsonl`: Val je Familie ({ facts, writing, refusal }) → Dateien
// `val-facts`, `val-writing`, `val-refusal`.
async function saveFinetuneResult(bookId, userEmail, { trainJsonl, valJsonl, allJsonl, evalJsonl, valFamilyJsonl = {}, meta }) {
  await fs.promises.mkdir(DIR, { recursive: true });
  const base = _base(bookId, userEmail);
  const files = [
    [`${base}.train.jsonl`, trainJsonl || ''],
    [`${base}.val.jsonl`, valJsonl || ''],
    [`${base}.all.jsonl`, allJsonl || ''],
    [`${base}.eval.jsonl`, evalJsonl || ''],
    ...['facts', 'writing', 'refusal'].map(f => [`${base}.val-${f}.jsonl`, valFamilyJsonl[f] || '']),
    [`${base}.meta.json`, JSON.stringify(meta)],
  ];
  for (const [file, content] of files) {
    await fs.promises.writeFile(`${file}.tmp`, content, 'utf8');
    await fs.promises.rename(`${file}.tmp`, file);
  }
}

function loadFinetuneMeta(bookId, userEmail) {
  try {
    return JSON.parse(fs.readFileSync(`${_base(bookId, userEmail)}.meta.json`, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

module.exports = { bookFingerprint, finetuneFilePath, saveFinetuneResult, loadFinetuneMeta };
