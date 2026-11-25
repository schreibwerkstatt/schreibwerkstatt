// Lauf-Verlauf: die Liste früherer Läufe einer Karte (KI-Läufe, Bewertungen,
// gespeicherte Exporte) — ein Kern für Zeile, Datum und Laden/Öffnen/Löschen
// (DESIGN.md «Lauf-Verlauf»). Gegated: tests/unit/run-history-single-place.test.mjs.
//
// Teile:
//   formatRunDate(ts)        → das eine Datumsformat einer Lauf-Zeile (App-Zeitzone)
//   runRowAdapter(ctx, spec) → Adapter für das Fragment run-history-row.html
//   makeRunHistoryMethods()  → load/open/delete einer Lauf-Liste + Zeilen-Adapter
//
// Die Zeile (public/partials/run-history-row.html) liest den Loop-Alias `r` und
// den Adapter `runRow`, den der Einbinder am umschliessenden Element anlegt:
//   <div class="history-bar" x-data="{ runRow: plotConsistencyRunRow() }">
//     <template x-for="r in consistencyRuns" :key="r.id">
//       <!-- @include run-history-row -->
// Der Adapter ruft die Kartenmethoden über `$data` der Karte auf, damit sie mit
// ihrem eigenen `$root` laufen, nicht mit dem der Verlaufsleiste.

import { fetchJson, fmtDateTime, renderStars } from './utils.js';
import { isSelectedBook, loadToken } from './cards/book-guard.js';

/** Datum + Uhrzeit einer Lauf-Zeile in UI-Sprache und App-Zeitzone. */
export function formatRunDate(ts) {
  return fmtDateTime(ts, window.Alpine?.store('shell')?.uiLocale);
}

/**
 * Adapter für run-history-row.html.
 * spec:
 *   isOpen(r)   → Zeile aufgeklappt/geöffnet (`history-item--open`, Chevron)
 *   toggle(r)   → Klick auf die Zeile
 *   remove(r)   → Löschen-Symbol (Rückfrage per appConfirm macht der Aufrufer)
 *   date(r)     → Zeitstempel der Zeile (Default `r.created_at`)
 *   badges(r)   → Zusatzangaben zwischen Datum und Modell, je Eintrag eines von
 *                 { text, cls?, tip? }   Tag/Badge (cls Default 'tag')
 *                 { stars, tip? }        Sterne-Note (renderStars, nur Zahl)
 *                 { ref }                Entitäts-Verweis (x-entity-ref)
 *                 leere/falsche Einträge entfallen.
 *   model(r)    → Modell-Tag (Default `r.model`), entfällt ohne Wert
 *   disabled(r) → nicht reaktivierbar (`history-item--disabled`, kein Chevron)
 *   tip(r)      → Tooltip an der Zeile
 */
export function runRowAdapter(scope, spec) {
  // Erzeugt im x-data-Ausdruck des Einbinders: `scope` trägt dort die Magics
  // des neuen Elements (`$root` = die Verlaufsleiste). `$data` ist der Stapel
  // darüber — Kartenmethoden sehen so ihr eigenes `$root` (Scroll ins Panel).
  const ctx = scope.$data ?? scope;
  return {
    date: (r) => formatRunDate(spec.date ? spec.date.call(ctx, r) : r.created_at),
    isOpen: (r) => !!spec.isOpen.call(ctx, r),
    toggle: (r) => spec.toggle.call(ctx, r),
    remove: (r) => spec.remove.call(ctx, r),
    badges: (r) => (spec.badges ? spec.badges.call(ctx, r) : []).filter(b => b && (b.text || b.stars || b.ref)),
    model: (r) => (spec.model ? spec.model.call(ctx, r) : r.model) || '',
    disabled: (r) => !!spec.disabled?.call(ctx, r),
    tip: (r) => spec.tip?.call(ctx, r) || null,
    // Sterne-Markup aus einer Zahl (renderStars coerced auf Number) — kein
    // User-/KI-Text, darum als x-html zulässig.
    stars: (note) => renderStars(note),
  };
}

const runId = (runOrId) => (runOrId && typeof runOrId === 'object' ? runOrId.id : runOrId);

/**
 * Laden, Öffnen (Toggle) und Löschen einer Lauf-Liste, dazu der Zeilen-Adapter.
 * cfg:
 *   names       { load?, open, remove, row } — Methodennamen auf der Karte
 *   list        Prop der Liste (oder getList/setList für verschachtelte Listen)
 *   selected    Prop der geöffneten Lauf-ID
 *   listUrl(bookId)  Liste des Buchs; ohne → keine load-Methode (Karte lädt selbst)
 *   runUrl(id)       Detail (GET) und Löschen (DELETE) eines Laufs
 *   busy(ctx)        true → Öffnen gesperrt (Live-Lauf derselben Art)
 *   busyKey          i18n-Key, der dann in errorMessage steht (sonst still)
 *   canOpen(ctx, run) i18n-Key, wenn der Lauf nicht (mehr) zu öffnen ist, sonst null
 *   apply(ctx, detail) Ergebnis des Laufs ins Panel legen (wie ein Live-Lauf)
 *   clear(ctx)       Panel schliessen; `selected` setzt der Kern selbst zurück
 *   afterOpen(ctx)   z.B. zum Panel scrollen
 *   confirmKey, errorKeys { open, remove }
 *   row         Zusatz-Spec für runRowAdapter (badges, disabled, tip, toggle)
 */
export function makeRunHistoryMethods(cfg) {
  const n = cfg.names;
  const getList = cfg.getList || ((ctx) => ctx[cfg.list]);
  const setList = cfg.setList || ((ctx, rows) => { ctx[cfg.list] = rows; });
  const close = (ctx) => { ctx[cfg.selected] = null; cfg.clear?.(ctx); };
  const m = {};

  if (cfg.listUrl) {
    m[n.load] = async function () {
      const bookId = window.Alpine?.store('nav')?.selectedBookId;
      if (!bookId) { setList(this, []); return; }
      const isCurrent = loadToken(this, `_${cfg.list}Seq`, bookId);
      try {
        const rows = await fetchJson(cfg.listUrl(bookId));
        if (isCurrent()) setList(this, Array.isArray(rows) ? rows : []);
      } catch (e) {
        if (isCurrent()) setList(this, []);
      }
    };
  }

  // Toggle: Klick auf den geöffneten Lauf schliesst ihn; sonst Detail laden und
  // ins Panel legen. Während eines Live-Laufs derselben Art gesperrt — dessen
  // Ergebnis überschriebe sonst den geöffneten Lauf.
  m[n.open] = async function (runOrId) {
    const app = window.__app;
    const id = runId(runOrId);
    if (id == null) return;
    if (cfg.busy?.(this)) {
      if (cfg.busyKey) this.errorMessage = app.t(cfg.busyKey);
      return;
    }
    const blocked = cfg.canOpen && typeof runOrId === 'object' ? cfg.canOpen(this, runOrId) : null;
    if (blocked) { this.errorMessage = app.t(blocked); return; }
    if (this[cfg.selected] === id) { close(this); return; }
    const bookId = window.Alpine?.store('nav')?.selectedBookId;
    try {
      const detail = await fetchJson(cfg.runUrl(id));
      if (bookId && !isSelectedBook(bookId)) return;
      if (!detail?.result) throw new Error('no result');
      cfg.apply(this, detail);
      this[cfg.selected] = detail.id;
      cfg.afterOpen?.(this);
    } catch (e) {
      this.errorMessage = app.t(cfg.errorKeys.open);
    }
  };

  m[n.remove] = async function (runOrId) {
    const app = window.__app;
    const id = runId(runOrId);
    if (id == null) return;
    if (!await app.appConfirm({ message: app.t(cfg.confirmKey), danger: true })) return;
    try {
      await fetchJson(cfg.runUrl(id), { method: 'DELETE' });
      setList(this, (getList(this) || []).filter(r => r.id !== id));
      if (this[cfg.selected] === id) close(this);
    } catch (e) {
      this.errorMessage = app.t(cfg.errorKeys.remove);
    }
  };

  m[n.row] = function () {
    return runRowAdapter(this, {
      isOpen: function (r) { return this[cfg.selected] === r.id; },
      toggle: function (r) { return this[n.open](r); },
      remove: function (r) { return this[n.remove](r); },
      ...cfg.row,
    });
  };

  return m;
}
