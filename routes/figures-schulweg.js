'use strict';
// Schulweg der Figuren (docs/figur-lebenslauf.md, «Schullaufbahn»):
//   GET    /figures/:book_id/schulwege                       (viewer)  System, Wege, Geburten, Handlungsjahr
//   PUT    /figures/:book_id/schulwege/:fig_id               (editor)  Autor setzt
//   POST   /figures/:book_id/schulwege/:fig_id/uebernehmen   (editor)  KI-Vorschlag übernehmen
//   DELETE /figures/:book_id/schulwege/:fig_id/vorschlag     (editor)  KI-Vorschlag verwerfen
//
// EIGENER ROUTER neben routes/figures.js (Muster figures-alter.js): der Schulweg
// gehört nicht in den heissen Katalog-Fetch. Schlüssel nach aussen ist die
// Katalog-Kennung `fig_id`; gespeichert wird an `figures.id`, weil fig_id bei
// jeder Komplettanalyse neu nummeriert wird.
//
// Validierung gegen das Schulsystem des Buchs über die Rechenschicht
// (public/js/book/school-path.js via ESM-Bridge) — ein Weg-Key, den das System
// nicht kennt, ist ein 400, ebenso eine Repetition auf einer Klasse, die der Weg
// nicht durchläuft. Nichts fällt still heraus.
//
// GEBURT KOMMT VOM SERVER: GET liefert je Figur die massgebliche Geburt
// (lib/figure-birth.js, Vorrang Steckbrief › Geburts-Ereignis › Alters-Index).
// Der Browser rechnet damit — dieselbe Geburt wie Job und `get_figure_age`, sonst
// nennten Lebenslauf und Buch-Chat für dieselbe Figur verschiedene Klassen.

const express = require('express');
const { aclParamGuard, sessionEmail } = require('../lib/acl');
const { bookParamHandler } = require('../lib/log-context');
const { schoolPath } = require('../lib/esm-bridge');
const { activeBookSchulsystem } = require('../lib/buchtyp');
const { resolveBirthsForFigures } = require('../lib/figure-birth');
const { getBookHandlungsjahr } = require('../db/book-settings');
const {
  listSchoolPaths, getSchoolPath, findFigureForSchoolPath, listFiguresForSchoolPath,
  setSchoolPath, clearSchoolPathVorschlag,
} = require('../db/figure-school-paths');
const logger = require('../logger');

const router = express.Router();
const jsonBody = express.json();

const MIN_JAHR = 1000, MAX_JAHR = 2999;

// Lesen ab viewer, Schreiben ab editor — dieselbe Achse wie Alters-Index/-Scan.
router.param('book_id', bookParamHandler);

function _out(sp) {
  if (!sp) return null;
  const { figure_id, ...rest } = sp;
  return rest;
}

router.get('/:book_id/schulwege', aclParamGuard('viewer'), async (req, res) => {
  const bookId = req.bookId;
  const email = sessionEmail(req);
  const schulsystem = await activeBookSchulsystem(bookId);
  const wege = {};
  for (const sp of listSchoolPaths(bookId, email)) wege[sp.fig_id] = _out(sp);
  const geburten = {};
  if (schulsystem) {
    const figs = listFiguresForSchoolPath(bookId, email);
    const births = resolveBirthsForFigures(bookId, email, figs);
    for (const f of figs) if (births.has(f.id)) geburten[f.fig_id] = births.get(f.id);
  }
  res.json({ schulsystem, wege, geburten, handlungsjahr: getBookHandlungsjahr(bookId) });
});

/** Figur + aufgelöstes System laden; antwortet selbst und liefert null bei Fehler. */
async function _scope(req, res) {
  const fig = findFigureForSchoolPath(req.bookId, req.params.fig_id, sessionEmail(req));
  if (!fig) { res.status(404).json({ error_code: 'FIGURE_NOT_FOUND' }); return null; }
  const sp = await schoolPath();
  const system = sp.resolveSchulsystem(await activeBookSchulsystem(req.bookId));
  if (!system) { res.status(400).json({ error_code: 'SCHULSYSTEM_MISSING' }); return null; }
  return { fig, sp, system };
}

/** Body → normalisierte Felder; null = ungültig (Antwort ist dann raus). */
function _fields(res, body, { sp, system }, { strict = true } = {}) {
  const weg = body?.weg == null || body.weg === '' ? null : String(body.weg);
  if (weg != null && !sp.wegKeys(system).includes(weg)) {
    res.status(400).json({ error_code: 'INVALID_VALUE', params: { field: 'weg', allowed: sp.wegKeys(system).join(', ') } });
    return null;
  }
  let einschulung = null;
  if (body?.einschulung_jahr != null && body.einschulung_jahr !== '') {
    const n = Number(body.einschulung_jahr);
    if (!Number.isInteger(n) || n < MIN_JAHR || n > MAX_JAHR) {
      res.status(400).json({ error_code: 'INVALID_VALUE', params: { field: 'einschulung_jahr', allowed: `${MIN_JAHR}–${MAX_JAHR}` } });
      return null;
    }
    einschulung = n;
  }
  // Repetitionen gelten nur auf Klassen, die der wirksame Weg (eigener oder
  // Standardweg) durchläuft. Strikt: was wegfiele, ist ein 400; beim Übernehmen
  // (strict false) fallen Repetitionen eines verlassenen Wegs weg und werden gezählt.
  const raw = Array.isArray(body?.repetitionen) ? body.repetitionen : [];
  const wirksam = sp.figurWeg(system, { weg });
  const repetitionen = sp.normalizeRepetitionen(raw, system, wirksam);
  if (strict && repetitionen.length !== raw.length) {
    res.status(400).json({ error_code: 'SCHULWEG_REPETITION_INVALID' });
    return null;
  }
  return { weg, einschulung_jahr: einschulung, repetitionen, entfernt: raw.length - repetitionen.length };
}

router.put('/:book_id/schulwege/:fig_id', aclParamGuard('editor'), jsonBody, async (req, res) => {
  const scope = await _scope(req, res);
  if (!scope) return;
  const fields = _fields(res, req.body, scope);
  if (!fields) return;
  const saved = setSchoolPath(scope.fig.id, fields, 'autor');
  logger.info(`[schulweg] figur=${scope.fig.id} weg=${fields.weg || 'standard'} einschulung=${fields.einschulung_jahr ?? '–'} repetitionen=${fields.repetitionen.length}`);
  res.json({ ok: true, schulweg: _out(saved) });
});

router.post('/:book_id/schulwege/:fig_id/uebernehmen', aclParamGuard('editor'), async (req, res) => {
  const scope = await _scope(req, res);
  if (!scope) return;
  const cur = getSchoolPath(scope.fig.id);
  const v = cur?.vorschlag;
  if (!v) return res.status(404).json({ error_code: 'SCHULWEG_VORSCHLAG_MISSING' });
  // Der Vorschlag wurde gegen das System seines Laufs geprüft; das Buch kann
  // seither ein anderes haben — darum hier noch einmal durch dieselbe Prüfung.
  // Eine vorgeschlagene Repetition kommt zu den bestehenden dazu, statt sie zu
  // ersetzen; Repetitionen, die der neue Weg nicht durchläuft, fallen weg und
  // werden der Oberfläche gemeldet.
  const fields = _fields(res, {
    weg: v.weg,
    einschulung_jahr: v.einschulung_jahr ?? cur.einschulung_jahr,
    repetitionen: [...(cur.repetitionen || []), ...(v.repetition ? [v.repetition] : [])],
  }, scope, { strict: false });
  if (!fields) return;
  setSchoolPath(scope.fig.id, fields, 'ki');
  clearSchoolPathVorschlag(scope.fig.id);
  logger.info(`[schulweg] Vorschlag übernommen figur=${scope.fig.id} weg=${fields.weg || 'standard'} repetitionenEntfernt=${fields.entfernt}`);
  res.json({ ok: true, schulweg: _out(getSchoolPath(scope.fig.id)), repetitionen_entfernt: fields.entfernt });
});

router.delete('/:book_id/schulwege/:fig_id/vorschlag', aclParamGuard('editor'), (req, res) => {
  const fig = findFigureForSchoolPath(req.bookId, req.params.fig_id, sessionEmail(req));
  if (!fig) return res.status(404).json({ error_code: 'FIGURE_NOT_FOUND' });
  clearSchoolPathVorschlag(fig.id);
  res.json({ ok: true, schulweg: _out(getSchoolPath(fig.id)) });
});

module.exports = router;
