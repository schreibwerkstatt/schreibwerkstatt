// Alpine.data('helpCard') — Hilfe & Funktionen: zwei Reiter.
//
//   „Funktionen"   — Funktionsueberblick, gruppiert nach Bereich. Inhalt kommt
//                    aus [help-catalog.js](help-catalog.js) (Feature-Registry +
//                    Funktionen ohne eigene Karte); bei offenem Buch gefiltert
//                    nach Buchtyp und Rolle. „Oeffnen" ruft den Registry-Toggle
//                    bzw. die Registry-Aktion.
//   „Neuigkeiten"  — Release-Notizen aus `changelog/` (GET /changelog), neueste
//                    Version zuerst. Lazy: erst beim ersten Oeffnen des Reiters
//                    geholt, nicht beim Mount der Karte.
//
// Buch-unabhaengig (wie Suche/Meine-Statistik), `showHelpCard` +
// `toggleHelpCard` leben im Root (generiert aus EXCLUSIVE_CARDS). Darum auch
// kein `setupCardLifecycle`: der Helper ist fuer Buch-skopierte Karten
// (book:changed/view:reset/card:refresh) — hier gibt es nichts zu resetten.
//
// Neu-Punkt: `$store.shell.changelogLatest > changelogSeen` (beides aus
// /config) traegt den Achtungs-Punkt am Hilfe-Knopf im Header. Das Oeffnen des
// Reiters quittiert (POST /changelog/seen) und aktualisiert den Store lokal
// mit — ohne das bliebe der Punkt bis zum naechsten Reload stehen.

import { formatIsoDay } from '../utils.js';
import { featureByKey } from './feature-registry.js';
import { buildHelpSections } from './help-catalog.js';
import { memoMethods } from './card-memo.js';

/** Semver-Vergleich; ein leerer/ungueltiger Stand gilt als „aelter als alles".
 *  Spiegel von routes/changelog.js#_cmp — die Frage „gibt es Neues?" wird auf
 *  beiden Seiten gestellt (Punkt im Frontend, Nur-vorwaerts-Quittung im Server). */
export function cmpVersion(a, b) {
  const pa = String(a || '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  const pb = String(b || '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!pa) return pb ? -1 : 0;
  if (!pb) return 1;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Gibt es ungelesene Release-Notizen? Liest den shell-Store, damit Header-Punkt
 *  und Karte dieselbe Frage stellen. */
export function hasUnreadChangelog(shell) {
  const latest = shell?.changelogLatest || '';
  if (!latest) return false;
  return cmpVersion(latest, shell?.changelogSeen || '') > 0;
}

export function registerHelpCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('helpCard', () => ({
    helpQuery: '',
    _memos: {},

    // Aktiver Reiter (SSoT; die `tabs`-Komponente haengt via x-modelable dran).
    helpTab: 'features',
    changelogReleases: [],
    changelogLoading: false,
    changelogError: '',
    _changelogLoaded: false,
    // Changelog-Stand beim Oeffnen der Karte. Wird beim Quittieren NICHT
    // mitgezogen: die „Neu"-Plakette soll waehrend der Sitzung stehen bleiben,
    // in der der User die Notizen zum ersten Mal liest — sonst verschwindet sie
    // im selben Tick, in dem er sie sieht.
    _changelogSeenAtOpen: '',

    init() {
      this._changelogSeenAtOpen = window.Alpine.store('shell')?.changelogSeen || '';
      // Wer einen Neu-Punkt sieht und auf „?" klickt, meint die Neuigkeiten —
      // nicht den Funktionsueberblick, den er schon kennt.
      if (hasUnreadChangelog(window.Alpine.store('shell'))) this.helpTab = 'changelog';
      // Expliziter Reiter-Wunsch (z.B. Versionszeile im Avatar-Menü) schlägt
      // die Heuristik; der Watcher deckt die bereits offene Karte ab.
      this._consumeHelpTabRequest();
      this.$watch('$store.shell.helpTabRequest', () => this._consumeHelpTabRequest());
      // Mount und Reiter-Wahl liegen im selben Tick; das Laden haengt darum am
      // Watcher statt an einem zweiten Aufruf hier.
      this.$watch('helpTab', (v) => { if (v === 'changelog') this.onChangelogTab(); });
      if (this.helpTab === 'changelog') this.onChangelogTab();
    },

    _consumeHelpTabRequest() {
      const shell = window.Alpine.store('shell');
      const tab = shell?.helpTabRequest;
      if (!tab) return;
      shell.helpTabRequest = '';
      this.helpTab = tab;
    },

    /** Kontext wie in der Palette: Buch, Rolle, Buchtyp, Modell-Klasse. */
    _helpCtx() {
      const root = window.__app || {};
      const nav = window.Alpine.store('nav') || {};
      return {
        selectedBookId: nav.selectedBookId || null,
        hasBooks: (nav.books || []).length > 0,
        pages: nav.pages || [],
        bookRole: root.currentBookRole || null,
        buchtyp: (typeof root.currentBuchtyp === 'function' ? root.currentBuchtyp() : null) || null,
        cloudModelEffective: (window.Alpine.store('config')?.effectiveProviderClass || 'cloud') === 'cloud',
      };
    },

    ...memoMethods,

    /** Sektionen, gefiltert nach Suchbegriff (Titel + Beschreibung in der
     *  UI-Sprache). Leere Sektionen fallen weg. */
    helpSections() {
      const ctx = this._helpCtx();
      const t = window.__app.t.bind(window.__app);
      const locale = window.Alpine.store('shell')?.uiLocale || '';
      const q = this.helpQuery.trim().toLowerCase();
      return this._memo('sections', [
        ctx.selectedBookId, (ctx.pages || []).length, ctx.bookRole, ctx.buchtyp, ctx.cloudModelEffective, locale, q,
      ], () => {
        const sections = buildHelpSections(ctx);
        if (!q) return sections;
        return sections
          .map(s => ({ ...s, entries: s.entries.filter(e => (t(e.titleKey) + ' ' + t(e.descKey)).toLowerCase().includes(q)) }))
          .filter(s => s.entries.length > 0);
      });
    },

    /** Plaketten-Text; `typ` ist eine Liste von Buchtyp-Keys. */
    helpNeedLabel(need) {
      const t = window.__app.t.bind(window.__app);
      const typ = need.params?.typ;
      return typ ? t(need.key, { typ: typ.map(x => t(x.i18n)).join(', ') }) : t(need.key);
    },

    /** Karte oeffnen bzw. Aktion ausfuehren. Toggle ueber den Root: das
     *  schliesst die Hilfe (Exklusivitaet) und oeffnet das Ziel. */
    helpOpen(entry) {
      if (!entry?.open || !entry.available) return;
      const root = window.__app;
      if (entry.open.run) {
        featureByKey(entry.open.run)?.run?.(root);
      } else if (typeof root[entry.open.toggle] === 'function') {
        root[entry.open.toggle]();
      }
    },

    /** Reiter „Neuigkeiten" ist aktiv: einmal laden, dann quittieren. */
    onChangelogTab() {
      this.loadChangelog();
      this.markChangelogSeen();
    },

    async loadChangelog() {
      if (this._changelogLoaded || this.changelogLoading) return;
      this.changelogLoading = true;
      this.changelogError = '';
      try {
        const r = await fetch('/changelog', { credentials: 'same-origin' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        this.changelogReleases = Array.isArray(data?.releases) ? data.releases : [];
        this._changelogLoaded = true;
      } catch (_) {
        this.changelogError = window.__app.t('changelog.loadError');
      } finally {
        this.changelogLoading = false;
      }
    },

    /** Quittieren — Store zuerst, damit der Punkt sofort verschwindet; ein
     *  gescheiterter POST laesst ihn beim naechsten Boot wiederkommen (der
     *  Server ist die Wahrheit), was besser ist als ein haengender Punkt. */
    async markChangelogSeen() {
      const shell = window.Alpine.store('shell');
      const latest = shell?.changelogLatest || '';
      if (!latest || !hasUnreadChangelog(shell)) return;
      shell.changelogSeen = latest;
      try {
        await fetch('/changelog/seen', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ version: latest }),
        });
      } catch (_) { /* non-fatal: naechster Boot holt den Stand vom Server */ }
    },

    /** Eintragstext in der UI-Sprache des Betrachters (de = Fallback). */
    changelogText(entry) {
      const loc = window.Alpine.store('shell')?.uiLocale || 'de';
      return (loc === 'en' ? entry?.en : entry?.de) || entry?.de || '';
    },

    /** Release-Datum (YYYY-MM-DD) als Kalendertag in der UI-Locale. */
    changelogDate(iso) {
      if (!iso) return '';
      return formatIsoDay(iso, window.Alpine.store('shell')?.uiLocale,
        { year: 'numeric', month: '2-digit', day: '2-digit' }) || iso;
    },

    /** War dieses Release beim Oeffnen der Karte noch ungelesen? Plakette am
     *  Versions-Kopf, damit der Neu-Punkt am Knopf ein Ziel in der Liste hat. */
    isNewRelease(version) {
      return cmpVersion(version, this._changelogSeenAtOpen) > 0;
    },
  }));
}
