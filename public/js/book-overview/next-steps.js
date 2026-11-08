// «Nächste Schritte»-Tile: bis zu drei Vorschläge aus den Buchdaten, jeder mit
// genau einer Aktion und dauerhaft wegklickbar (Alpine.store('hints'), Key je
// Buch — was in einem Buch erledigt ist, gilt nicht für das nächste). Rein
// abgeleitet, kein KI-Job: die Aktion öffnet nur die passende Karte bzw. legt
// eine Frage ins Eingabefeld des Buch-Chats (gesendet wird von Hand).
import { IDEEN_CHECK_MIN, openAnchoredIdeenCount } from '../book/ideen-shared.js';

export const NEXT_STEPS_MAX = 3;
// Ab diesem Umfang lohnt die Figuren-Erkennung (Komplettanalyse).
const FIGUREN_MIN_CHARS = 20000;
// Ab so vielen Abschnitten trägt eine buchweite Frage (Reihenfolge, Bögen).
const BOOK_CHAT_MIN_PAGES = 8;
// Ab so vielen seit der letzten Komplettanalyse geänderten Abschnitten weist die
// Übersicht darauf hin, dass Figuren, Szenen, Orte usw. nicht mehr zum Text passen.
export const ANALYSIS_STALE_MIN_PAGES = 3;
// Buchtypen ohne Figurenensemble — dort ist «Figuren erkennen» kein Schritt.
const OHNE_FIGUREN = new Set(['journalismus', 'sachbuch', 'wissenschaft', 'essay', 'blog', 'lyrik']);

/**
 * Pure Auswahl (testbar ohne Alpine). Reihenfolge = Priorität.
 * @param {{ bookId, tree, ideen, figurenCount, figurenForbidden, chars, buchtyp,
 *           pageCount, bookChatSessions, isFinished, isExcluded? }} d
 *   `isExcluded(chapterId)` kaskadiert den Export-Ausschluss über die Vorfahren
 *   (_chapterRollup); ohne ihn zählt nur das Flag am Kapitel selbst.
 * @param {(key: string) => boolean} isOpen  Tipp-Key noch nicht weggeklickt
 * @returns {Array<{ kind, key, params }>}
 */
export function computeNextSteps(d, isOpen) {
  const out = [];
  // `keySuffix`: der Schritt gilt nur für einen Stand (Veraltet-Hinweis je
  // Analyse-Lauf) — wegklicken blendet ihn bis zum nächsten Lauf aus.
  const push = (kind, params = {}, keySuffix = '') => {
    const key = `overview.${kind}.${d.bookId}${keySuffix ? '.' + keySuffix : ''}`;
    if (isOpen(key)) out.push({ kind, key, params });
  };

  // Komplettanalyse veraltet: Abschnitte, die nach ihrem Ende geändert wurden.
  if (d.analysisAt) {
    const n = (d.pages || []).filter(p => p.updated_at && p.updated_at > d.analysisAt).length;
    if (n >= ANALYSIS_STALE_MIN_PAGES) push('analysisStale', { n, total: (d.pages || []).length }, d.analysisAt);
  }

  // Erstes angelegtes, noch leeres Kapitel (ohne Unterkapitel, weder selbst
  // noch über ein Oberkapitel vom Export ausgeschlossen): dort steht die Schreibfront.
  if (!d.isFinished) {
    const excluded = d.isExcluded || (() => false);
    const empty = (d.tree || []).find(c => c.type === 'chapter' && !c.solo
      && !c.excluded && !excluded(c.id)
      && !c.hasChildren && !(c.pages || []).length);
    if (empty) push('emptyChapter', { id: empty.id, name: empty.name || '' });
  }

  const anchored = openAnchoredIdeenCount(d.ideen);
  if (anchored >= IDEEN_CHECK_MIN) push('ideenCheck', { n: anchored });

  if (!d.figurenForbidden && d.figurenCount === 0 && d.chars >= FIGUREN_MIN_CHARS
      && !OHNE_FIGUREN.has(d.buchtyp)) push('figuren');

  if (d.bookChatSessions === 0 && d.pageCount >= BOOK_CHAT_MIN_PAGES) push('bookChat');

  return out.slice(0, NEXT_STEPS_MAX);
}

export const nextStepsMethods = {
  overviewNextSteps() {
    const hints = Alpine.store('hints');
    if (!hints?.loaded) return [];
    // Beim Buchwechsel stehen noch die Daten des vorigen Buchs, die Hint-Keys
    // trügen aber schon die neue Buch-ID — ein Klick blendete dann im falschen
    // Buch einen Schritt dauerhaft aus.
    if (this.overviewShowsOtherBook()) return [];
    const tree = Alpine.store('nav').tree || [];
    const d = {
      bookId: this.overviewBookId,
      tree,
      ideen: this.overviewIdeen,
      figurenCount: (this.overviewFiguren || []).length,
      figurenForbidden: (this.overviewForbidden || []).includes('figuren'),
      chars: Number(this.overviewLatest()?.chars) || 0,
      buchtyp: this.overviewBuchtyp,
      pageCount: (Alpine.store('nav').pages || []).length,
      bookChatSessions: this.overviewBookChatSessions,
      isFinished: this.overviewIsFinished,
      isExcluded: this._chapterRollup().isExcluded,
      analysisAt: Alpine.store('jobs').alleAktualisierenLastRunAt,
      pages: Alpine.store('nav').pages || [],
    };
    // Kein Memo: `hints.dismissed` und `nav.tree` wechseln ihre Identität bei
    // jeder Änderung, die Auswahl selbst ist ein einziger Durchlauf.
    return computeNextSteps(d, key => hints.isOpen(key));
  },

  overviewNextStepText(s) {
    if (s.kind === 'analysisStale') return window.__app.tn('overview.next.analysisStale.text', s.params.n, s.params);
    return window.__app.t(`overview.next.${s.kind}.text`, s.params);
  },

  overviewNextStepAction(s) {
    return window.__app.t(`overview.next.${s.kind}.action`);
  },

  // Aktion ausführen und den Schritt wegklicken — er ist damit angestossen.
  async runOverviewNextStep(s) {
    const app = window.__app;
    Alpine.store('hints').dismiss(s.key);
    if (s.kind === 'emptyChapter') {
      return app.openBookChatDraft(app.t('overview.next.emptyChapter.question', { name: s.params.name }));
    }
    if (s.kind === 'bookChat') return app.openBookChatDraft(app.t('overview.next.bookChat.question'));
    if (s.kind === 'ideenCheck' && !app.showIdeenBoardCard) return app.toggleIdeenBoardCard();
    if (s.kind === 'figuren' && !app.showFiguresCard) return app.toggleFiguresCard();
    if (s.kind === 'analysisStale') return app.alleAktualisieren();
  },
};
