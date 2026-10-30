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
// Buchtypen ohne Figurenensemble — dort ist «Figuren erkennen» kein Schritt.
const OHNE_FIGUREN = new Set(['journalismus', 'sachbuch', 'wissenschaft', 'essay', 'blog', 'lyrik']);

/**
 * Pure Auswahl (testbar ohne Alpine). Reihenfolge = Priorität.
 * @param {{ bookId, tree, ideen, figurenCount, figurenForbidden, chars, buchtyp,
 *           pageCount, bookChatSessions, isFinished }} d
 * @param {(key: string) => boolean} isOpen  Tipp-Key noch nicht weggeklickt
 * @returns {Array<{ kind, key, params }>}
 */
export function computeNextSteps(d, isOpen) {
  const out = [];
  const push = (kind, params = {}) => {
    const key = `overview.${kind}.${d.bookId}`;
    if (isOpen(key)) out.push({ kind, key, params });
  };

  // Erstes angelegtes, noch leeres Kapitel (ohne Unterkapitel, nicht vom
  // Export ausgeschlossen): dort steht die Schreibfront.
  if (!d.isFinished) {
    const empty = (d.tree || []).find(c => c.type === 'chapter' && !c.solo && !c.excluded
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
    };
    // Kein Memo: `hints.dismissed` und `nav.tree` wechseln ihre Identität bei
    // jeder Änderung, die Auswahl selbst ist ein einziger Durchlauf.
    return computeNextSteps(d, key => hints.isOpen(key));
  },

  overviewNextStepText(s) {
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
  },
};
