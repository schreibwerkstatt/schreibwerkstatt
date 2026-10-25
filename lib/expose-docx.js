'use strict';
// Exposé als Word-Dokument (GET /expose/:book_id/:id/docx). Ein eigenes
// Dokument, kein Buch-Export: ein kapitelloser „Abschnitt" durch denselben
// Word-Builder wie das Manuskript (lib/export-builders/docx.js), mit eigener
// schlanker Konfiguration (keine Titelseite, 1,5-zeilig, Abstand statt Einzug).
//
// Die Eckdaten, Figurennamen, Kapitelnamen, der Klappentext und die Vita werden
// beim Export LIVE gelesen — im Exposé liegen nur die KI-/Autortexte.
// Beschriftungen in der Buchsprache (book_settings.language).

const { buildDocxProfile, DOCX_MIME } = require('./export-builders/docx');
const { tServer, tServerParams } = require('./i18n-server');
const { escapeUtil } = require('./esm-bridge');

const DOCX_CONFIG = {
  page: { size: 'A4', marginsMm: { top: 25, right: 25, bottom: 25, left: 25 } },
  font: { family: 'Times New Roman', sizePt: 12, lineSpacing: 'oneAndHalf', paragraphStyle: 'spaced', justify: false },
  header: { mode: 'title', pageNumber: 'footer', skipFirstPage: false },
  title: { mode: 'none', wordCount: false },
  chapter: { numbering: 'none', pageBreakBefore: false },
};

function _paras(esc, text) {
  return String(text || '').split(/\n{2,}|\r\n\r\n/).map(t => t.trim()).filter(Boolean)
    .map(t => `<p>${esc(t).replace(/\n/g, '<br>')}</p>`).join('\n');
}

/**
 * Baut das HTML des Exposés. Pure (bis auf den Escape-Import) — testbar.
 * @param {object} a
 * @param {object} a.run        Exposé-Lauf (db/expose#getExpose)
 * @param {object} a.eckdaten   { untertitel, autor, genre, normseiten, zielgruppe, vergleichstitel }
 * @param {Map}    a.figurNamen fig_id → Name (live)
 * @param {Map}    a.kapitelNamen chapter_id → Name (live)
 * @param {string} a.klappentext book_publication.description (live)
 * @param {string} a.vita        book_publication.author_bio (live)
 * @param {string} a.locale      'de' | 'en'
 */
function buildExposeHtml(esc, { run, eckdaten, figurNamen, kapitelNamen, klappentext, vita, locale }) {
  const t = (k) => tServer(k, locale);
  const text = run.edited || run.result || {};
  const out = [];
  const facts = [
    [t('publication.subtitle'), eckdaten.untertitel],
    [t('expose.facts.autor'), eckdaten.autor],
    [t('expose.facts.genre'), eckdaten.genre],
    [t('expose.facts.umfang'), eckdaten.normseiten ? tServerParams('expose.facts.normseiten', { n: eckdaten.normseiten }, locale) : ''],
    [t('publication.zielgruppe'), eckdaten.zielgruppe],
    [t('publication.vergleichstitel'), eckdaten.vergleichstitel],
  ].filter(([, v]) => String(v || '').trim());
  if (facts.length) {
    out.push(`<h2>${esc(t('expose.facts.title'))}</h2>`);
    out.push(facts.map(([k, v]) => `<p><strong>${esc(k)}:</strong> ${esc(String(v)).replace(/\n/g, '<br>')}</p>`).join('\n'));
  }
  const section = (key, body) => { if (String(body || '').trim()) out.push(`<h2>${esc(t(key))}</h2>`, _paras(esc, body)); };
  section('expose.field.logline', text.logline);
  if (run.profil === 'sachlich') {
    section('expose.field.kurzbeschreibung', text.kurzbeschreibung);
    section('expose.field.alleinstellung', text.alleinstellung);
    const items = (text.gliederung || []).filter(g => kapitelNamen.has(g.chapter_id));
    if (items.length) {
      out.push(`<h2>${esc(t('expose.field.gliederung'))}</h2>`);
      out.push(items.map(g => `<p><strong>${esc(kapitelNamen.get(g.chapter_id))}:</strong> ${esc(g.text)}</p>`).join('\n'));
    }
  } else {
    section('expose.field.kurzinhalt', text.kurzinhalt);
    const figs = (text.figuren || []).filter(f => figurNamen.has(f.fig_id));
    if (figs.length) {
      out.push(`<h2>${esc(t('expose.field.figuren'))}</h2>`);
      out.push(figs.map(f => `<p><strong>${esc(figurNamen.get(f.fig_id))}:</strong> ${esc(f.text)}</p>`).join('\n'));
    }
    section('expose.field.synopse', text.synopse);
  }
  section('expose.klappentext.title', klappentext);
  section('publication.authorBio', vita);
  return out.join('\n');
}

/** Liefert { buffer, mime }. `title` = Buchtitel (Überschrift + Kopfzeile). */
async function buildExposeDocx({ title, ...rest }) {
  const { escHtml } = await escapeUtil();
  const html = buildExposeHtml(escHtml, rest);
  const bundle = {
    scope: 'book',
    book: { id: 0, name: title },
    groups: [{ chapterId: null, chapter: null, pages: [{ p: { id: 0, name: title, chapter_id: null }, pd: { html } }] }],
  };
  const buffer = await buildDocxProfile(bundle, { config: DOCX_CONFIG, lang: rest.locale, author: rest.eckdaten?.autor || '' });
  return { buffer, mime: DOCX_MIME };
}

module.exports = { buildExposeDocx, buildExposeHtml };
