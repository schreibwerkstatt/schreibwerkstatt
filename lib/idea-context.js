'use strict';
// Ideen als KI-Kontext — die Pendenzen des Autors an einem planenden Objekt
// (Beat, Motiv, …), verdichtet für Prompts. Nur die DATEN; die Textform im Prompt
// ist SSoT in public/js/prompts/plot/lines.js#_ideenMarker (Facade `ideenMarker`).
//
// Warum ein eigener Griff: Plot-Jobs, Plot-Chat und Kapitelbewertung stellen
// dieselbe Frage („was weiss der Autor hier schon?") und brauchen dieselbe Form.
// Zwei Stufen zählen, eine nicht:
//   · offen / in_arbeit — der Autor kennt das Problem schon; ein Befund, der es
//     nur wiederholt, ist Rauschen.
//   · verworfen — der Autor hat die Idee geprüft und sich dagegen entschieden;
//     sie erneut vorzuschlagen ignoriert seine Entscheidung.
//   · erledigt — umgesetzt, kein Kontext mehr.
//
// User-privat wie jede Ideen-Lesung: db/ideen.js filtert auf `user_email`.

const { ideaLinksByTarget } = require('../db/ideen');
const { isOpenIdeeStatus, normalizeIdeeStatus } = require('./ideen-status');

const DEFAULT_PER_TARGET = 4;
const DEFAULT_CHARS = 160;

function _trim(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}

/** Ist eine Idee als Kontext relevant (offen, in Arbeit oder verworfen)? */
function isContextIdea(status) {
  const st = normalizeIdeeStatus(status);
  return isOpenIdeeStatus(st) || st === 'verworfen';
}

/**
 * Map target_id → [{ content, status }] für EINE Ziel-Art. Offene zuerst, je Ziel
 * gedeckelt. Best-effort: ein Fehler liefert eine leere Map — die Ideen sind eine
 * Beigabe, kein Grund, einen KI-Job zu failen.
 *
 * @param {'beat'|'motif'|'research'|string} kind
 * @param {number} bookId
 * @param {string} userEmail
 * @param {{ perTarget?: number, chars?: number }} [opts]
 * @returns {Map<number, Array<{content:string, status:string}>>}
 */
function ideaNotesByTarget(kind, bookId, userEmail, { perTarget = DEFAULT_PER_TARGET, chars = DEFAULT_CHARS } = {}) {
  const out = new Map();
  let map;
  try { map = ideaLinksByTarget(kind, bookId, userEmail); } catch { return out; }
  for (const [targetId, ideas] of map) {
    const rel = ideas.filter(i => isContextIdea(i.status))
      .sort((a, b) => Number(b.status !== 'verworfen') - Number(a.status !== 'verworfen'))
      .slice(0, perTarget)
      .map(i => ({ content: _trim(i.content, chars), status: i.status }));
    if (rel.length) out.set(targetId, rel);
  }
  return out;
}

module.exports = { isContextIdea, ideaNotesByTarget };
