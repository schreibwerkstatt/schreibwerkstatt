'use strict';
// Exposé (Bucheinstellungen → Reiter Exposé): Läufe lesen, Autorfassung
// speichern, Läufe löschen. Erzeugt wird ausschliesslich im Job
// (routes/jobs/expose.js); hier liegt nur der persistierte Stand des Users.
// Mindestrolle wie beim Job. Doku: docs/expose.md.
const express = require('express');
const { aclParamGuard, sessionEmail } = require('../lib/acl');
const { bookParamHandler } = require('../lib/log-context');
const { toIntId } = require('../lib/validate');
const { normseiten } = require('../lib/normseite');
const exposeDb = require('../db/expose');
const { getBookSettings } = require('../db/schema');
const { getMeta: getPublication } = require('../db/book-publication');
const contentStore = require('../lib/content-store');
const { buchtypLabel } = require('../lib/buchtyp');
const { slugify } = require('../lib/slug');
const { buildExposeDocx } = require('../lib/expose-docx');

const router = express.Router();
router.param('book_id', aclParamGuard('editor'));
router.param('book_id', bookParamHandler);

const TEXT_MAX = 20000;

// Autorfassung gegen den KI-Lauf normalisieren: nur die Textfelder des Profils
// und nur Listeneinträge, deren ID der Lauf selbst geliefert hat — die Fassung
// ändert Wortlaut, nicht, welche Figur/welches Kapitel vorkommt.
function normalizeEdited(edited, run) {
  if (edited == null) return null;
  if (typeof edited !== 'object') return undefined;
  const listKey = run.profil === 'sachlich' ? 'gliederung' : 'figuren';
  const idKey = run.profil === 'sachlich' ? 'chapter_id' : 'fig_id';
  const out = {};
  for (const [k, v] of Object.entries(run.result || {})) {
    if (k === listKey) continue;
    if (typeof v === 'string') out[k] = typeof edited[k] === 'string' ? edited[k].slice(0, TEXT_MAX) : v;
  }
  // Schlüssel als String vergleichen: Figuren tragen die fig_id, Kapitel eine Zahl.
  const byId = new Map((Array.isArray(edited[listKey]) ? edited[listKey] : [])
    .map(i => [String(i?.[idKey]), typeof i?.text === 'string' ? i.text.slice(0, TEXT_MAX) : null]));
  out[listKey] = (run.result?.[listKey] || []).map(i => ({ [idKey]: i[idKey], text: byId.get(String(i[idKey])) ?? i.text }));
  return out;
}

// Jüngster Lauf + Historie (ohne Ergebnis-JSON) + Umfang in Normseiten (live).
router.get('/:book_id', (req, res) => {
  const email = sessionEmail(req);
  res.json({
    latest: exposeDb.latestExpose(req.bookId, email),
    history: exposeDb.listExposes(req.bookId, email),
    normseiten: normseiten(exposeDb.bookChars(req.bookId)),
  });
});

router.get('/:book_id/:id', (req, res) => {
  const id = toIntId(req.params.id);
  const run = id && exposeDb.getExpose(req.bookId, sessionEmail(req), id);
  if (!run) return res.status(404).json({ error_code: 'EXPOSE_NOT_FOUND' });
  res.json(run);
});

// Autorfassung: { edited: {…} } oder { edited: null } (zurück zur KI-Fassung).
router.patch('/:book_id/:id', express.json({ limit: '1mb' }), (req, res) => {
  const id = toIntId(req.params.id);
  const email = sessionEmail(req);
  const run = id && exposeDb.getExpose(req.bookId, email, id);
  if (!run) return res.status(404).json({ error_code: 'EXPOSE_NOT_FOUND' });
  const edited = normalizeEdited(req.body?.edited, run);
  if (edited === undefined) return res.status(400).json({ error_code: 'INVALID_VALUE', params: { field: 'edited' } });
  exposeDb.setExposeEdited(req.bookId, email, id, edited);
  res.json(exposeDb.getExpose(req.bookId, email, id));
});

// Word-Dokument eines Laufs (Autorfassung vor KI-Fassung). Eckdaten, Namen,
// Klappentext und Vita werden hier live gelesen (lib/expose-docx.js).
router.get('/:book_id/:id/docx', async (req, res) => {
  const id = toIntId(req.params.id);
  const email = sessionEmail(req);
  const run = id && exposeDb.getExpose(req.bookId, email, id);
  if (!run) return res.status(404).json({ error_code: 'EXPOSE_NOT_FOUND' });
  const book = await contentStore.loadBook(req.bookId, req);
  const settings = getBookSettings(req.bookId, email);
  const pub = getPublication(req.bookId);
  const chapters = run.profil === 'sachlich' ? await contentStore.listChapters(req.bookId, req) : [];
  const { buffer, mime } = await buildExposeDocx({
    title: book.name,
    run,
    eckdaten: {
      untertitel: pub.subtitle,
      autor: [pub.author_name, ...(pub.co_authors || []).map(c => c.name)].filter(Boolean).join(', '),
      genre: buchtypLabel(settings?.buchtyp, settings?.language),
      normseiten: normseiten(exposeDb.bookChars(req.bookId)),
      zielgruppe: pub.zielgruppe,
      vergleichstitel: pub.vergleichstitel,
    },
    figurNamen: new Map(exposeDb.listExposeFiguren(req.bookId, email).map(f => [f.id, f.name])),
    kapitelNamen: new Map(chapters.map(c => [Number(c.id), c.name])),
    klappentext: pub.description,
    vita: pub.author_bio,
    locale: settings?.language || 'de',
  });
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `attachment; filename="${slugify(book.name) || 'buch'}-expose.docx"`);
  res.setHeader('Content-Length', buffer.length);
  res.end(buffer);
});

router.delete('/:book_id/:id', (req, res) => {
  const id = toIntId(req.params.id);
  if (!id || !exposeDb.deleteExpose(req.bookId, sessionEmail(req), id)) {
    return res.status(404).json({ error_code: 'EXPOSE_NOT_FOUND' });
  }
  res.json({ ok: true });
});

module.exports = router;
module.exports.normalizeEdited = normalizeEdited;
