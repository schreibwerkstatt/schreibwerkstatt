// Weltfakten-Slice der Referenz-Karte (Alpine.data('referenceCard'),
// cards/reference-card.js): Laden der Welt-Fakten des Buchs und der Sprung in
// die Weltfakten-Karte. Welche Fakten zum offenen Abschnitt gehören, entscheidet
// die Kontext-Regel in cards/reference-context.js#referenceWeltfaktenItems.
// Read-only — gepflegt wird in der Weltfakten-Karte.

import { fetchJson } from '../utils.js';
import { ctxRow } from './reference-rows.js';

const normName = (s) => String(s || '').trim().toLowerCase();

/** Kontext-Regel des Reiters (pure). Welt-Fakten haengen ueber
 *  `world_fact_chapters` an Kapiteln (`chapter_ids`), nicht an Abschnitten. Zum
 *  Abschnitt ('page') gehoert ein Fakt, wenn die Analyse ihn aus diesem Abschnitt
 *  hat (`seite` = Abschnittsname) ODER sein Subjekt im Abschnittstext steht
 *  (`inText`, gleiche Wortregel wie Figuren/Orte) — so kommen auch buchweite
 *  Fakten ohne Kapitel-Bruecke in den Kontext. Sonst zaehlt der Kapitel-Anker
 *  ('chapter'). Kopie statt Mutation: `refCtx` an Kopien (ctxRow, stabil je Quell-Array). */
export function selectWeltfaktenForPage(all, { pageName = '', chapterId = null, inText = () => false } = {}) {
  const pn = normName(pageName);
  const onPage = [];
  const inChapter = [];
  for (const f of all || []) {
    const ids = (f?.chapter_ids || []).filter(x => x != null);
    const inChap = chapterId != null && ids.some(x => Number(x) === Number(chapterId));
    // Abschnittsnamen sind nicht buchweit eindeutig: der Herkunfts-Abschnitt
    // zaehlt nur, wenn der Fakt nicht an einem ANDEREN Kapitel haengt.
    const fromPage = !!pn && normName(f?.seite) === pn && (!ids.length || inChap);
    if (fromPage || (f?.subjekt && inText(f.subjekt))) onPage.push(f);
    else if (inChap) inChapter.push(f);
  }
  return [
    ...onPage.map(f => ctxRow(all, f, 'page')),
    ...inChapter.map(f => ctxRow(all, f, 'chapter')),
  ];
}

export function referenceWeltfaktenState() {
  return {
    // Buchweit geladen (/world-facts/:book_id → fakten), gefiltert clientseitig.
    referenceWeltfakten: [],
    referenceWeltfaktenLoading: false,
    referenceWeltfaktenError: '',
  };
}

export const referenceWeltfaktenMethods = {
  // Bei jedem Einblenden frisch — die Weltfakten-Karte kann sie geändert haben,
  // und einen geteilten Store dafür gibt es nicht.
  async _loadReferenceWeltfakten() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) { this.referenceWeltfakten = []; return; }
    this.referenceWeltfaktenLoading = true;
    this.referenceWeltfaktenError = '';
    try {
      const data = await fetchJson(`/world-facts/${encodeURIComponent(bookId)}`);
      if (this._staleBook(bookId)) return;
      this.referenceWeltfakten = Array.isArray(data?.fakten) ? data.fakten : [];
    } catch {
      if (this._staleBook(bookId)) return;
      // Fehler sagen statt «Keine Welt-Fakten» — ein Netzausfall sähe sonst
      // aus wie ein Buch ohne Welt.
      this.referenceWeltfakten = [];
      this.referenceWeltfaktenError = window.__app.t('reference.weltfakten.loadError');
    } finally {
      if (!this._staleBook(bookId)) this.referenceWeltfaktenLoading = false;
    }
  },

  /** Kapitel eines Fakts als Referenz-Specs (`chapter_refs` aus withChapterIds). */
  referenceWeltfaktChapters(f) {
    return (Array.isArray(f?.chapter_refs) ? f.chapter_refs : [])
      .map(r => ({ type: 'kapitel', id: r.chapter_id, name: r.chapter_name }));
  },

  // Zeile → Weltfakten-Karte. Kein Fakt-Permalink: die Karte öffnet als Ganzes.
  // Wer in der Zeile Text markiert, springt nicht (wie openReferenceEntity).
  openReferenceWeltfakten() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || String(window.getSelection?.() || '').trim()) return;
    location.hash = `#book/${bookId}/fakten`;
  },
};
