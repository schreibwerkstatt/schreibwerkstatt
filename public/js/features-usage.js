// Feature-Usage-Tracking am Root.
// Erfasst Karten-Öffnungen via $watch auf den Show-Flags (rising edge), POSTet
// pro User an /usage/track (der Server schreibt daraus auch `card.open`).
// Dazu Sitzungsstart und Editor-Sitzungen als Nutzungs-Events
// (trackUsageEvent, docs/usage-events.md). Lädt /usage/recent beim Login, fällt auf
// DEFAULT_RECENT_KEYS zurück. Die Liste wird ausschliesslich von der
// Command-Palette gelesen (Section „Zuletzt"). Hero-Trigger ruft openPalette().

import { FEATURES, DEFAULT_RECENT_KEYS, featureByKey } from './cards/feature-registry.js';
import { fetchJson } from './utils.js';
import { EVT } from './events.js';

// Einmal-Quelle fuer den naechsten /usage/track-Call einer Karte. Die Palette
// markiert vor dem Toggle; gezaehlt wird weiterhin nur vom Show-Flag-Watch,
// der die Quelle verbraucht. Modul-lokal statt Root-State: rein transient,
// nichts rendert davon.
let _pendingUsageSource = null;
export function markNextUsageSource(key, source) {
  _pendingUsageSource = { key, source };
}

// Nutzungs-Event an /usage/event (docs/usage-events.md). Nur Events mit
// origin 'client' aus lib/usage-events.js; der Server schneidet `meta` auf die
// kategorialen Felder des Katalogs zu — nie Text uebergeben. `keepalive`, damit
// `editor.close` beim Schliessen des Tabs noch rausgeht. Best-Effort, wirft nie.
export function trackUsageEvent(event, meta = null, bookId = undefined) {
  try {
    const book = bookId !== undefined ? bookId : (window.Alpine?.store('nav')?.selectedBookId || null);
    fetch('/usage/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, meta, book_id: book }),
      credentials: 'same-origin',
      keepalive: true,
    }).catch(() => {});
  } catch (e) { /* Tracking ist Best-Effort, niemals UI blockieren. */ }
}

// Vorschlag aus einem der fuenf Chats uebernommen/verworfen/wieder geoeffnet/
// rueckgaengig gemacht. `chat`: page|book|research|plot|ideen; `kind`: Vorschlagstyp
// (korrektur, idee_create, beat_update, note …); `count` > 1 bei «alle».
export function trackChatProposal(chat, action, kind, count = 1) {
  if (count > 0) trackUsageEvent('chat.proposal', { chat, action, kind: kind || undefined, count });
}

function _viewportClass() {
  const w = window.innerWidth || 0;
  return w < 640 ? 'mobile' : (w < 1024 ? 'tablet' : 'desktop');
}

// Laufende Editor-Sitzung (welcher der drei Editoren, seit wann). Modul-lokal:
// rein transient, nichts rendert davon.
let _editorSession = null;

export const featuresUsageMethods = {
  // Wird in init() aufgerufen, sobald Alpine $watch bereitsteht.
  setupFeatureUsageWatchers() {
    if (this._featureUsageWatchersInstalled) return;
    this._featureUsageWatchersInstalled = true;

    for (const f of FEATURES) {
      const flag = f.flag;
      const key = f.key;
      // $watch liefert (newVal, oldVal) — false→true ist Öffnen.
      this.$watch(flag, (val, old) => {
        if (val && !old) this._trackFeatureUsage(key);
      });
    }

    trackUsageEvent('session.start', {
      surface: window.matchMedia?.('(display-mode: standalone)')?.matches ? 'pwa' : 'browser',
      viewport: _viewportClass(),
      locale: this.$store.shell?.uiLocale,
    }, null);
    this._setupEditorSessionTracking();
  },

  // Welcher der drei Editoren gerade offen ist. Bucheditor vor Fokus vor Notebook:
  // der Fokusmodus laeuft innerhalb des Notebook-Edit-Modus (editMode bleibt an),
  // gezaehlt wird aber nur die innerste Flaeche.
  _activeEditor() {
    if (this.showBookEditorCard) return 'book';
    if (this.focusActive) return 'focus';
    if (this.editMode) return 'notebook';
    return null;
  },

  // Eine Sitzung je Editor: `editor.open` beim Betreten, `editor.close` mit
  // Dauer beim Verlassen oder Wechsel. Ein einziger Watch auf die abgeleitete
  // Flaeche statt Hooks in den drei Editoren — deren Ein-/Ausgaenge sind
  // mehrere (Teardown, Seitenwechsel, Fokus-Exit setzt editMode direkt).
  _setupEditorSessionTracking() {
    const switchTo = (next) => {
      if (_editorSession && _editorSession.editor !== next) {
        const durationSec = Math.round((Date.now() - _editorSession.since) / 1000);
        trackUsageEvent('editor.close', { editor: _editorSession.editor, durationSec }, _editorSession.bookId);
        _editorSession = null;
      }
      if (next && !_editorSession) {
        const bookId = this.$store.nav?.selectedBookId || null;
        _editorSession = { editor: next, since: Date.now(), bookId };
        trackUsageEvent('editor.open', { editor: next }, bookId);
      }
    };
    this.$watch(() => this._activeEditor(), switchTo);
    // Tab zu / App in den Hintergrund (iOS beendet dort ohne weiteres Signal):
    // Sitzung abschliessen, beim Zurueckkehren neu beginnen.
    window.addEventListener('pagehide', () => switchTo(null));
    window.addEventListener('pageshow', (e) => { if (e.persisted) switchTo(this._activeEditor()); });
  },

  async _trackFeatureUsage(key) {
    // Quelle (z.B. 'palette') nur, wenn sie zu genau dieser Oeffnung gehoert.
    const pending = _pendingUsageSource;
    _pendingUsageSource = null;
    const source = pending?.key === key ? pending.source : undefined;
    try {
      await fetch('/usage/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, source, book_id: this.$store.nav.selectedBookId || null }),
        credentials: 'same-origin',
      });
    } catch (e) {
      // Tracking ist Best-Effort, niemals UI blockieren.
    }
    // Liste lokal sofort umsortieren (kein Roundtrip nötig).
    this._bumpRecentFeatureKey(key);
  },

  // Custom-Event an die Reichweitenmessung (Plausible). No-op, solange Analytics
  // aus ist — dann existiert window.plausible gar nicht.
  //
  // Properties sind Dimensionen, keine Messwerte: Plausible zaehlt Ereignisse und
  // aggregiert keine Zahlen. Dauer, Tokenverbrauch und Karten-Oeffnungen liegen
  // first-party in page_stats bzw. /usage/track und in der Admin-Usage-Karte —
  // sie hier zu spiegeln erzeugte nur eine zweite Wahrheit.
  trackAnalytics(event, props = null) {
    try { window.plausible?.(event, props ? { props } : undefined); }
    catch (e) { /* Tracking ist Best-Effort, niemals UI blockieren. */ }
  },

  // Audit-Event an /me/event POSTen. Server loggt unter Allowlist
  // (siehe routes/usersettings.js#AUDIT_EVENTS). Best-Effort, niemals throwen.
  logAuditEvent(event, meta = null) {
    try {
      fetch('/me/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event, meta }),
        credentials: 'same-origin',
      }).catch(() => {});
    } catch (e) { /* swallow */ }
  },

  _bumpRecentFeatureKey(key) {
    const cur = Array.isArray(this.recentFeatureKeys) ? this.recentFeatureKeys.slice() : [];
    const idx = cur.indexOf(key);
    if (idx !== -1) cur.splice(idx, 1);
    cur.unshift(key);
    this.recentFeatureKeys = cur.slice(0, 3);
  },

  async loadRecentFeatures() {
    try {
      const rows = await fetchJson('/usage/recent?limit=3');
      const keys = (Array.isArray(rows) ? rows : [])
        .map(r => r.feature_key)
        .filter(k => featureByKey(k));
      this.recentFeatureKeys = keys.length ? keys.slice(0, 3) : DEFAULT_RECENT_KEYS.slice();
    } catch (e) {
      this.recentFeatureKeys = DEFAULT_RECENT_KEYS.slice();
    }
  },

  // Letzte N Seiten des aktuellen Buchs (Command-Palette „Zuletzt"-Sektion).
  // Wird bei Buch-Wechsel + nach Tracking-Bumps neu geladen.
  async loadRecentPages(bookId) {
    if (!bookId) { this.recentPageIds = []; return; }
    try {
      const rows = await fetchJson(`/usage/page/recent?book_id=${encodeURIComponent(bookId)}&limit=5`);
      this.recentPageIds = (Array.isArray(rows) ? rows : [])
        .map(r => r.page_id)
        .filter(Number.isFinite);
    } catch (e) {
      this.recentPageIds = [];
    }
  },

  // Best-Effort-Tracking. Aufgerufen aus selectPage(). Lokale Liste wird
  // sofort umsortiert, damit Palette ohne Roundtrip aktuell ist.
  _trackPageUsage(pageId, bookId) {
    if (!pageId || !bookId) return;
    try {
      fetch('/usage/page/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page_id: pageId, book_id: bookId }),
        credentials: 'same-origin',
      }).catch(() => {});
    } catch {}
    const cur = Array.isArray(this.recentPageIds) ? this.recentPageIds.slice() : [];
    const idx = cur.indexOf(pageId);
    if (idx !== -1) cur.splice(idx, 1);
    cur.unshift(pageId);
    this.recentPageIds = cur.slice(0, 5);
  },

  openPalette() {
    window.dispatchEvent(new CustomEvent(EVT.PALETTE_OPEN));
  },
};
