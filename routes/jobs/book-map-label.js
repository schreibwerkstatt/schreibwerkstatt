'use strict';
// Buchlandkarte: PCA-Achsen benennen. Das Frontend schickt je Achse die
// Abschnitte an ihren zwei Enden (die extremsten Punkte, die die Karte ohnehin
// zeigt); die KI liest Auszüge davon und sagt, worin sich die Enden
// unterscheiden. Ein Lauf ist eine bewusste Handlung (Knopf), kein Teil des
// Kartenlaufs: die Karte selbst ruft nie ein KI-Backend.
//
// Ergebnis wird nicht persistiert — es gehört zu genau einer Projektion, und
// die ändert sich mit jedem Index-Lauf. Das Frontend hält es im Sitzungs-Cache
// neben dem Kartenergebnis.

const express = require('express');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError, jsonBody,
  aiCall, getPrompts, tps, startBookJob, htmlToTextForPrompt,
} = require('./shared');
const contentStore = require('../../lib/content-store');
const { toIntId } = require('../../lib/validate');

const bookMapLabelRouter = express.Router();

const MAX_AXES = 3;
const MAX_PAGES_PER_POLE = 4;
// Auszug je Abschnitt: Anfang plus ein Stück aus der Mitte. Der Anfang allein
// ist oft Szenen-Exposition und trägt nicht, wofür der Abschnitt auf der Achse
// liegt; der ganze Abschnitt sprengt bei 40k-Zeichen-Kapiteln das Budget.
const EXCERPT_HEAD = 900;
const EXCERPT_MID = 600;
const LABEL_MAX = 60;

function _excerpt(text) {
  if (text.length <= EXCERPT_HEAD + EXCERPT_MID) return text;
  const mid = Math.floor(text.length / 2);
  return `${text.slice(0, EXCERPT_HEAD)} […] ${text.slice(mid, mid + EXCERPT_MID)} […]`;
}

function _ids(raw) {
  if (!Array.isArray(raw)) return null;
  const ids = [...new Set(raw.map(toIntId).filter(Boolean))].slice(0, MAX_PAGES_PER_POLE);
  return ids.length ? ids : null;
}

/** Body → `[{ neg: ids, pos: ids }]` oder null. Exportiert für den Unit-Test. */
function parseLabelAxes(body) {
  const axes = body?.axes;
  if (!Array.isArray(axes) || !axes.length || axes.length > MAX_AXES) return null;
  const out = [];
  for (const a of axes) {
    const neg = _ids(a?.neg);
    const pos = _ids(a?.pos);
    if (!neg || !pos) return null;
    out.push({ neg, pos });
  }
  return out;
}

function _label(v) {
  return String(v == null ? '' : v).replace(/^[\s"'«»„“”]+|[\s"'«»„“”.]+$/g, '').slice(0, LABEL_MAX).trim();
}

async function runBookMapLabelJob(jobId, bookId, userEmail, axes) {
  const logger = makeJobLogger(jobId);
  try {
    const { buildBookMapAxisSystem, buildBookMapAxisPrompt, SCHEMA_BOOK_MAP_AXES } = await getPrompts(userEmail);
    updateJob(jobId, { statusText: 'job.phase.loadingPages', progress: 5 });

    // Abschnitte laden; einer aus einem fremden Buch zählt als fehlend. Die IDs
    // kommen aus dem Request — ohne diesen Abgleich läse der Job jeden
    // Abschnitt, den der User irgendwo sehen darf, in einen fremden Kontext.
    const cache = new Map();
    const load = async (id) => {
      if (cache.has(id)) return cache.get(id);
      let item = null;
      try {
        const pd = await contentStore.loadPage(id);
        if (pd && Number(pd.book_id) === Number(bookId)) {
          const text = htmlToTextForPrompt(pd.html || '').trim();
          if (text) item = { name: pd.name || `#${id}`, text: _excerpt(text) };
        }
      } catch { /* fehlend → item bleibt null */ }
      cache.set(id, item);
      return item;
    };
    const filled = [];
    for (const ax of axes) {
      const neg = (await Promise.all(ax.neg.map(load))).filter(Boolean);
      const pos = (await Promise.all(ax.pos.map(load))).filter(Boolean);
      if (!neg.length || !pos.length) throw i18nError('job.error.bookMapLabelNoText');
      filled.push({ neg, pos });
    }

    updateJob(jobId, { statusText: 'job.phase.bookMapLabel', progress: 20 });
    const tok = { in: 0, out: 0, ms: 0 };
    const raw = await aiCall(jobId, tok,
      buildBookMapAxisPrompt(filled),
      buildBookMapAxisSystem(),
      20, 95, 600 * axes.length, 0.2, null, undefined, SCHEMA_BOOK_MAP_AXES,
    );
    const list = Array.isArray(raw?.achsen) ? raw.achsen : null;
    if (!list || list.length !== axes.length) throw i18nError('job.error.bookMapLabelInvalid');
    const labels = list.map(a => ({
      neg: _label(a?.negativ),
      pos: _label(a?.positiv),
      diff: String(a?.unterschied == null ? '' : a.unterschied).trim().slice(0, 400),
    }));
    if (labels.some(l => !l.neg || !l.pos)) throw i18nError('job.error.bookMapLabelInvalid');

    logger.info(`Buchlandkarte-Achsen benannt: ${labels.map(l => `${l.neg} ↔ ${l.pos}`).join(' | ')}`);
    completeJob(jobId, { axes: labels, tokensIn: tok.in, tokensOut: tok.out }, tps(tok),
      `${labels.length} Achsen benannt`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Buchlandkarte-Achsen Fehler: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

bookMapLabelRouter.post('/book-map-label', jsonBody, (req, res) => {
  const axes = parseLabelAxes(req.body);
  if (!axes) return res.status(400).json({ error_code: 'INVALID_VALUE', params: { field: 'axes' } });
  return startBookJob(req, res, {
    type: 'book-map-label',
    minRole: 'lektor',
    label: 'job.label.bookMapLabel',
    dedupId: (id) => `${id}:${axes.map(a => `${a.neg.join(',')}/${a.pos.join(',')}`).join('|')}`,
    run: (jobId, { bookId, userEmail }) => runBookMapLabelJob(jobId, bookId, userEmail, axes),
  });
});

module.exports = { bookMapLabelRouter, runBookMapLabelJob, parseLabelAxes };
