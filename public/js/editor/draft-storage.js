// Lokale Draft-Persistenz für unsaved Edits im contenteditable-Editor.
// Eigenes Modul ohne browser-only Top-Level-Imports (page-view.js triggert
// `window.matchMedia` beim Laden) — so können auch reine Logik-Module wie
// app-view.js die Helper importieren, ohne dass Node-Tests am Window-Stub
// scheitern.
import { EVT } from '../events.js';
import { lsGetJSON, lsSetJSON, lsRemove, lsKeys } from '../safe-storage.js';
import { ownSaveIds } from '../repo/save-ids.js';

// Schlüssel: `editor_draft_u:<email>:<pageId>` — das Konto steht im
// Schlüssel, weil localStorage pro Browser-Profil gilt, nicht pro Konto.
// Melden sich auf einem Gerät nacheinander zwei User an, dürfen sie sich
// weder die Entwürfe überschreiben noch einander angezeigt bekommen, und die
// Outbox (app/app-outbox.js) darf keinen fremden Entwurf unter dem eigenen
// Konto speichern. Gesetzt wird das Konto, sobald die Config den User kennt
// (app-init.js); davor und in Node-Tests gilt der kontolose Alt-Schlüssel
// `editor_draft_<pageId>`. Alt-Entwürfe migriert setDraftOwner in den
// Konto-Schlüssel ihres `owner`-Felds (fehlt es, gehört der Entwurf dem
// ersten angemeldeten User); was nicht migriert werden konnte (Quota), bleibt
// unter dem Alt-Schlüssel les- und löschbar.
const DRAFT_PREFIX = 'editor_draft_';
const LEGACY_RE = /^editor_draft_(\d+)$/;
const LEGACY_KEY = (pageId) => `${DRAFT_PREFIX}${pageId}`;
const OWNER_PREFIX = (owner) => `${DRAFT_PREFIX}u:${owner}:`;

let _owner = null;

const DRAFT_KEY = (pageId) => (_owner ? `${OWNER_PREFIX(_owner)}${pageId}` : LEGACY_KEY(pageId));

function _visible(draft) {
  return !!draft && (!_owner || !draft.owner || draft.owner === _owner);
}

export function setDraftOwner(email) {
  _owner = email || null;
  if (_owner) migrateLegacyDrafts();
}

// Alt-Schlüssel in Konto-Schlüssel überführen. Liegt am Ziel schon ein
// Entwurf, gewinnt der jüngere (`savedAt`). Der Alt-Schlüssel fällt erst,
// wenn das Ziel geschrieben ist — ein voller Speicher verliert nichts.
export function migrateLegacyDrafts() {
  if (!_owner) return;
  for (const key of lsKeys(DRAFT_PREFIX)) {
    const m = LEGACY_RE.exec(key);
    if (!m) continue;
    const draft = lsGetJSON(key);
    if (!draft || typeof draft !== 'object') continue;
    const owner = draft.owner || _owner;
    const target = `${OWNER_PREFIX(owner)}${m[1]}`;
    const existing = lsGetJSON(target);
    if (existing && (existing.savedAt || 0) >= (draft.savedAt || 0)) { lsRemove(key); continue; }
    if (lsSetJSON(target, { ...draft, owner })) lsRemove(key);
  }
}

// Best-Effort-Signal für die Reconnect-Outbox + den Pending-Sync-Zähler, damit
// die App den Draft-Bestand nicht pollen muss. Laufzeit-guarded (nicht am
// Modul-Top-Level), damit reine Node-Tests dieses Modul ohne window importieren
// können.
function _emitDraftChanged() {
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent(EVT.DRAFT_CHANGED));
    }
  } catch {}
}

export function readDraft(pageId) {
  const own = lsGetJSON(DRAFT_KEY(pageId));
  if (own) return own;
  if (!_owner) return null;
  const legacy = lsGetJSON(LEGACY_KEY(pageId));
  return _visible(legacy) ? legacy : null;
}

// Liefert true, wenn der Entwurf lokal persistiert wurde, sonst false (i.d.R.
// QuotaExceededError bei vollem localStorage). Der Aufrufer MUSS das Ergebnis
// prüfen und false sichtbar machen — ein still verworfener Offline-Entwurf ist
// echter Datenverlust (kein Server-Fallback, wenn offline).
//
// `ownSaveIds`: Kennungen der Saves, die der Notebook-Editor dieses Tabs seit
// der Draft-Basis geschickt hat, ohne Antwort (repo/save-ids.js). Der Draft ist
// deren Nachfahre — die Outbox nennt sie beim Nachsenden, auch aus einem
// anderen Tab, und der Server erkennt einen davon als Vorgänger-Stand.
export function writeDraft(pageId, html, originalHtml, originalUpdatedAt) {
  const ok = lsSetJSON(DRAFT_KEY(pageId), {
    html, originalHtml, originalUpdatedAt: originalUpdatedAt || null, savedAt: Date.now(),
    owner: _owner, ownSaveIds: ownSaveIds('notebook', pageId),
  });
  if (!ok) return false;
  // Ein liegengebliebener eigener Alt-Entwurf ist jetzt überholt.
  if (_owner && _visible(lsGetJSON(LEGACY_KEY(pageId)))) lsRemove(LEGACY_KEY(pageId));
  _emitDraftChanged();
  return true;
}

export function clearDraft(pageId) {
  lsRemove(DRAFT_KEY(pageId));
  if (_owner && _visible(lsGetJSON(LEGACY_KEY(pageId)))) lsRemove(LEGACY_KEY(pageId));
  _emitDraftChanged();
}

// Alle Seiten-IDs mit einem lokal gesicherten Entwurf. Ein vorhandener Draft
// bedeutet: lokaler Inhalt, der (noch) nicht bestätigt auf dem Server liegt —
// erfolgreiche Saves rufen clearDraft. Basis für die Reconnect-Outbox und den
// „N Seiten warten auf Sync"-Zähler.
// Fremde Entwürfe (anderes Konto) zählen nicht.
export function listDraftPageIds() {
  const ids = new Set();
  const ownPrefix = _owner ? OWNER_PREFIX(_owner) : null;
  for (const key of lsKeys(DRAFT_PREFIX)) {
    let raw = null;
    if (ownPrefix && key.startsWith(ownPrefix)) raw = key.slice(ownPrefix.length);
    else {
      const m = LEGACY_RE.exec(key);
      if (!m || (_owner && !_visible(lsGetJSON(key)))) continue;
      raw = m[1];
    }
    const id = Number(raw);
    if (Number.isFinite(id) && id > 0) ids.add(id);
  }
  return [...ids];
}
