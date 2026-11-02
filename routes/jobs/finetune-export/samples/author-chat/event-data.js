'use strict';

const { db } = require('../../../../../db/schema');
const { tServer } = require('../../../../../lib/i18n-server');
const { nameRegex, isIdLike } = require('../../lib/names');
const { splitParagraphs, splitSentences, clipAtSentence } = require('../../lib/text');

// Zeitstrahl-Ereignisse für den Autor-Chat einmal laden und anreichern, damit
// Szenen-, Ereignis- und Figuren-Block dieselbe Sicht haben.
//
// Kapitel- und Abschnittsnamen kommen aus dem geladenen Buchbaum (`chMap`,
// `pageNameById`), nicht per JOIN auf `chapters`/`pages`. Ausgeschlossene
// Kapitel fehlen dort — ihre Verweise fallen aus dem Training, wie ihr Text.
//
// Szene ↔ Ereignis: nur über denselben Abschnitt. Ein gemeinsames Kapitel
// verbände in Büchern mit wenigen grossen Kapiteln fast alles mit allem.
// Schauplätze eines Ereignisses: nur Orte, deren Name im Ereignistext, in der
// Bedeutung oder in der zugeordneten Buchstelle steht. Die Szenen-Orte des
// Abschnitts zählen nicht — sie sind die Ortsliste des ganzen Abschnitts und
// hängen sonst an jedem Ereignis darin. Ein eigenes Ortsfeld hat das Ereignis
// nicht.

const fmtDate = (y, m, d, langIsEn) => {
  if (!y) return '';
  if (!m) return String(y);
  const date = new Date(Date.UTC(y, m - 1, d || 1));
  const opts = d ? { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }
                 : { month: 'long', year: 'numeric', timeZone: 'UTC' };
  return date.toLocaleDateString(langIsEn ? 'en-GB' : 'de-CH', opts);
};

// «unbekannt», auch mit Zusatz («unbekannt (vergangenheit)»), ist keine Zeitangabe.
const cleanDatum = (s) => {
  const t = String(s || '').trim();
  return /^unbekannt\b/i.test(t) ? '' : t;
};
// `datum_label` trägt bei einem Teil der Analysen ein Textzitat statt eines
// Datums («…und Christian die Windpocken überstanden hatte…») — nur ein kurzes
// Label ohne Auslassungszeichen gilt als Datum.
const usableLabel = (s) => {
  const t = String(s || '').trim();
  return t && t.length <= 60 && !/\.\.\.|…/.test(t) ? t : '';
};

// { when, start, end, storyDay } — `when` ist die lesbare Gesamtangabe.
// Vorrang: Original-Notation (`datum`), dann ein brauchbares Label, dann die
// strukturierten Felder.
// Ein Titel, der mit «Wort:» beginnt («Millenniumsnacht: Stefans erster
// Joint …»), stünde am Antwortanfang wie ein Etikett — dann in «…». Gilt
// für den Titel allein, nicht für einen ganzen Antwortsatz.
const LABEL_LEAD = /^[\p{L}\p{N}_]+\s*:/u;
function leadSafe(title) {
  const t = String(title || '');
  return LABEL_LEAD.test(t) ? `«${t}»` : t;
}

// Ereignis als Listenglied: «Geburt von Ernst (1958) — Bedeutung». Ereignis
// vorn, nie ein Datum als Etikett («1958: …»). `eventList` reiht sie zu
// einem Satz («…; ….»).
function eventListItem(e, { meaning = true } = {}) {
  const bed = meaning && e.bedeutung ? ' — ' + String(e.bedeutung).trim().replace(/[.\s]+$/, '') : '';
  return `${leadSafe(e.ereignis)}${e.datum ? ' (' + e.datum + ')' : ''}${bed}`;
}
const eventList = (items, opts) => items.map(e => eventListItem(e, opts)).join('; ') + '.';

function eventWhen(ev, langIsEn) {
  const start = cleanDatum(ev.datum) || usableLabel(ev.datum_label)
    || fmtDate(ev.datum_year, ev.datum_month, ev.datum_day, langIsEn);
  const end = ev.datum_ende_year
    ? fmtDate(ev.datum_ende_year, ev.datum_ende_month, ev.datum_ende_day, langIsEn)
    : '';
  const startForRange = fmtDate(ev.datum_year, ev.datum_month, ev.datum_day, langIsEn) || start;
  let when = start;
  if (end && startForRange && !String(start).includes(end)) {
    when = langIsEn ? `from ${startForRange} to ${end}` : `von ${startForRange} bis ${end}`;
  }
  // Ein aus dem Kontext erschlossenes Jahr (`datum_unsicher`) steht ohne
  // Zusatz im Text; wer nur sichere Daten nennen darf (Porträt, Kernfakten,
  // Kapitelinhalt), prüft `unsure`.
  return {
    when,
    unsure: !!ev.datum_unsicher,
    start: startForRange,
    end,
    storyDay: Number.isInteger(ev.story_tag) && ev.story_tag >= 1 ? ev.story_tag : null,
  };
}

function subtypLabel(subtyp, langIsEn) {
  if (!subtyp || subtyp === 'sonstiges') return '';
  const key = 'events.subtyp.' + subtyp;
  const label = tServer(key, langIsEn ? 'en' : 'de');
  return label === key ? '' : label;
}

// Art des Ereignisses als Nominalphrase statt Enum-Wert («persoenlich»):
// «ein persönliches Ereignis (Geburt)». '' bei unbekanntem Typ.
function eventKindPhrase(typ, subtyp, langIsEn) {
  const t = String(typ || '').toLowerCase();
  const base = t === 'extern' ? (langIsEn ? 'a world event' : 'ein Ereignis des Weltgeschehens')
    : t === 'persoenlich' ? (langIsEn ? 'a personal event' : 'ein persönliches Ereignis')
    : '';
  if (!base) return '';
  const sub = subtypLabel(subtyp, langIsEn);
  return sub ? `${base} (${langIsEn ? sub.toLowerCase() : sub})` : base;
}
const capFirst = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Gemeinsame Detail-Teile für Zeitstrahl- und Figuren-Ereignisse.
function eventDetailParts(ev, { langIsEn, chapterNames = [], storyline = '' }) {
  const parts = [];
  const w = eventWhen(ev, langIsEn);
  if (w.when) parts.push(langIsEn ? `When: ${w.when}.` : `Zeitpunkt: ${w.when}.`);
  if (w.storyDay) parts.push(langIsEn ? `Day ${w.storyDay} of the story.` : `Tag ${w.storyDay} der Handlung.`);
  const kind = eventKindPhrase(ev.typ, ev.subtyp, langIsEn);
  if (kind) parts.push(capFirst(kind) + '.');
  if (storyline) parts.push(langIsEn ? `Storyline: ${storyline}.` : `Handlungsstrang: ${storyline}.`);
  if (chapterNames.length) parts.push(langIsEn ? `In chapter(s): ${chapterNames.join(', ')}.` : `In Kapitel: ${chapterNames.join(', ')}.`);
  return parts;
}

// Wortstämme aus dem Ereignistext, die eine Textstelle wiedererkennen lassen.
const stemsOf = (text) => [...new Set(
  String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 6).map(w => w.slice(0, 6))
)];

// Buchstelle zu einem Ereignis. Ein verknüpfter Abschnitt, der als Ganzes in
// `maxChars` passt, ist die Stelle selbst. Sonst gewinnt das Fenster aus
// aufeinanderfolgenden Absätzen bzw. Sätzen (bis `maxChars`), in dem die
// beteiligten Figuren und Stichwörter am dichtesten stehen. Lange Absätze —
// oft ist ein ganzer Abschnitt ein einziger Block — zählen satzweise.
// Stichwörter, die in mehr als einem Drittel der Einheiten vorkommen
// (Familienname, Hauptort), unterscheiden nichts und zählen nicht.
function eventExcerpt(e, { pageById, maxChars }) {
  const stems = stemsOf(e.ereignis);
  let best = null;
  for (const pid of e.pageIds) {
    const page = pageById.get(pid);
    if (!page || !page.text) continue;
    if (page.text.length <= maxChars) {
      if (page.text.length >= 200) return { text: page.text, page };
      continue;
    }
    // Einheit = { text, sep } — `sep` steht beim Zusammensetzen davor.
    const units = splitParagraphs(page.text).flatMap(para => para.length > maxChars / 4
      ? splitSentences(para).map((s, j) => ({ text: s, sep: j ? ' ' : '\n\n' }))
      : [{ text: para, sep: '\n\n' }]);
    const lows = units.map(u => u.text.toLowerCase());
    const useful = stems.filter(st => lows.filter(l => l.includes(st)).length <= Math.max(1, units.length / 3));
    const scores = units.map((u, k) =>
      e.figs.filter(f => f.names.some(n => nameRegex(n).test(u.text))).length * 2
      + useful.filter(st => lows[k].includes(st)).length);
    for (let k = 0; k < units.length; k++) {
      if (!scores[k]) continue;
      let len = 0, sum = 0, end = k;
      while (end < units.length && (end === k || len + units[end].sep.length + units[end].text.length <= maxChars)) {
        len += units[end].text.length + units[end].sep.length;
        sum += scores[end];
        end++;
      }
      if (sum >= 2 && (!best || sum > best.sum)) best = { sum, units, k, end, page };
    }
  }
  if (!best) return null;
  const joined = best.units.slice(best.k, best.end).map((u, j) => (j ? u.sep : '') + u.text).join('');
  const text = clipAtSentence(joined, maxChars);
  return text.length >= 200 ? { text, page: best.page } : null;
}

function loadEventData(ctx) {
  const {
    langIsEn, opts, bookIdInt, userEmail,
    figRows, locRows,
    sceneRows,
    pageContents, chMap, pageNameById,
  } = ctx;
  const maxChars = opts.maxChars;
  const email = userEmail || '';

  const storylineNameById = new Map(
    db.prepare('SELECT id, name FROM storylines WHERE book_id = ?').all(bookIdInt)
      .filter(r => (r.name || '').trim()).map(r => [r.id, r.name.trim()])
  );
  const chapterName = (id) => (id != null && chMap[id]) || '';
  const pageName = (id) => (id != null && pageNameById.get(id)) || '';
  const pageById = new Map(pageContents.map(p => [p.id, p]));

  const rows = db.prepare(`
    SELECT id, ereignis, datum, datum_label, datum_year, datum_month, datum_day,
           datum_ende_year, datum_ende_month, datum_ende_day, story_tag, datum_unsicher,
           typ, subtyp, bedeutung, storyline_id
    FROM zeitstrahl_events WHERE book_id = ? AND user_email = ? ORDER BY sort_order
  `).all(bookIdInt, email);
  const group = (sql) => {
    const m = new Map();
    for (const r of db.prepare(sql).all(bookIdInt, email)) {
      if (!m.has(r.event_id)) m.set(r.event_id, []);
      m.get(r.event_id).push(r);
    }
    return m;
  };
  const chByEvt = group(`
    SELECT zec.event_id, zec.chapter_id FROM zeitstrahl_event_chapters zec
    JOIN zeitstrahl_events ze ON ze.id = zec.event_id
    WHERE ze.book_id = ? AND ze.user_email = ? ORDER BY zec.event_id, zec.sort_order`);
  const pgByEvt = group(`
    SELECT zep.event_id, zep.page_id FROM zeitstrahl_event_pages zep
    JOIN zeitstrahl_events ze ON ze.id = zep.event_id
    WHERE ze.book_id = ? AND ze.user_email = ? ORDER BY zep.event_id, zep.sort_order`);
  const fgByEvt = group(`
    SELECT zef.event_id, zef.figure_id, zef.figur_name FROM zeitstrahl_event_figures zef
    JOIN zeitstrahl_events ze ON ze.id = zef.event_id
    WHERE ze.book_id = ? AND ze.user_email = ? ORDER BY zef.event_id, zef.sort_order`);

  const figByPk = new Map(figRows.map(f => [f.pk, f]));
  const scenesByPage = new Map();
  for (const s of sceneRows) {
    if (s.page_id == null || !s.titel) continue;
    if (!scenesByPage.has(s.page_id)) scenesByPage.set(s.page_id, []);
    scenesByPage.get(s.page_id).push(s);
  }

  const events = [];
  const eventsBySceneId = new Map();
  for (let i = 0; i < rows.length; i++) {
    const ev = rows[i];
    const ereignis = (ev.ereignis || '').trim().replace(/[.\s]+$/, '');
    if (!ereignis) continue;

    const chapterIds = [...new Set((chByEvt.get(ev.id) || []).map(r => r.chapter_id))].filter(id => chapterName(id));
    const pageIds = [...new Set((pgByEvt.get(ev.id) || []).map(r => r.page_id))].filter(id => pageName(id));
    const kapitel = chapterIds.map(chapterName);

    const figs = [];
    const seenFig = new Set();
    for (const r of (fgByEvt.get(ev.id) || [])) {
      const f = (r.figure_id != null && figByPk.get(r.figure_id))
        || figRows.find(x => r.figur_name && (x.name === r.figur_name || x.kurzname === r.figur_name));
      const name = f ? f.name : (r.figur_name || '').trim();
      if (!name || isIdLike(name)) continue;
      const key = f ? f.fig_id : name.toLowerCase();
      if (seenFig.has(key)) continue;
      seenFig.add(key);
      const names = f ? [f.name, f.kurzname].filter(n => n && String(n).trim().length >= 2) : [name];
      figs.push({ fig_id: f ? f.fig_id : null, key, name, names });
    }

    const scenes = pageIds.flatMap(pid => scenesByPage.get(pid) || []);
    const storyline = storylineNameById.get(ev.storyline_id) || '';
    const w = eventWhen(ev, langIsEn);
    const e = {
      i, ereignis,
      datum: w.when, start: w.start, end: w.end, storyDay: w.storyDay, unsure: w.unsure,
      year: ev.datum_year || null, month: ev.datum_month || null, day: ev.datum_day || null,
      typ: ev.typ, subtyp: ev.subtyp, subtypLabel: subtypLabel(ev.subtyp, langIsEn),
      kindPhrase: eventKindPhrase(ev.typ, ev.subtyp, langIsEn),
      bedeutung: ev.bedeutung, storyline,
      kapitel, pageIds,
      figs, scenes,
    };
    e.excerpt = eventExcerpt(e, { pageById, maxChars });

    const haystack = [ereignis, ev.bedeutung || '', e.excerpt ? e.excerpt.text : ''].join('\n');
    e.locs = locRows.filter(l => l.name && l.name.length >= 3 && nameRegex(l.name).test(haystack));

    const parts = [leadSafe(ereignis) + '.'];
    parts.push(...eventDetailParts(ev, { langIsEn, storyline }));
    if (figs.length) parts.push(langIsEn
      ? `Characters involved: ${figs.map(f => f.name).join(', ')}.`
      : `Beteiligte Figuren: ${figs.map(f => f.name).join(', ')}.`);
    if (e.locs.length) parts.push(langIsEn
      ? `Locations: ${e.locs.map(l => l.name).join(', ')}.`
      : `Schauplätze: ${e.locs.map(l => l.name).join(', ')}.`);
    if (scenes.length) parts.push(langIsEn
      ? `Scenes: ${scenes.map(s => '«' + s.titel + '»').join(', ')}.`
      : `Szenen: ${scenes.map(s => '«' + s.titel + '»').join(', ')}.`);
    if (kapitel.length) parts.push(langIsEn ? `In chapter(s): ${kapitel.join(', ')}.` : `In Kapitel: ${kapitel.join(', ')}.`);
    if (ev.bedeutung) parts.push((langIsEn ? 'Why it matters: ' : 'Bedeutung: ') + ev.bedeutung);
    e.fullAnswer = parts.join(' ');
    events.push(e);
    for (const s of scenes) {
      if (!eventsBySceneId.has(s.id)) eventsBySceneId.set(s.id, []);
      eventsBySceneId.get(s.id).push(e);
    }
  }

  return { events, eventsBySceneId, storylineNameById };
}

module.exports = { leadSafe, eventListItem, eventList, loadEventData, eventDetailParts, eventWhen, eventExcerpt, subtypLabel, eventKindPhrase };
