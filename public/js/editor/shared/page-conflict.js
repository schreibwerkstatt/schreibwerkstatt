// Pre-Save-Conflict-Check für Read-Modify-Write-Pfade — geteilt von Notebook-
// Editor und Bucheditor.
//
// Liegt unter shared/, weil die Frage „hat jemand anderes seit meinem Snapshot
// geschrieben?" eine Eigenschaft der SEITE ist, nicht eines Editors. Der
// Bucheditor griff dafür früher über die Root-Trampoline in die Notebook-Karte
// (`app._checkPageConflict`) — sein Stale-Schutz hing damit daran, dass eine
// fremde Karte gemountet ist, und der Forwarder lieferte bei fehlender Karte
// `null`, also „kein Konflikt".
//
// Trennung von shared/page-api.js ist dieselbe wie dort beschrieben: hier steht,
// WAS geprüft wird, dort WIE geschrieben wird.

import { contentRepo } from '../../repo/content.js';
import { editorHost } from './editor-host.js';
import { isOwnServerSave } from '../../repo/save-ids.js';

/**
 * Vor dem PUT die Seite frisch lesen und `updated_at` mit dem Editor-Snapshot
 * vergleichen; Mismatch = jemand hat zwischendrin gespeichert.
 *
 * Wirft NICHT — der Aufrufer entscheidet bei einem Read-Fehler selbst (und
 * bekommt `null`, also „weitermachen"): ein Modal auf unsicherer Datenlage wäre
 * irreführend, der ohnehin folgende PUT läuft in den OCC-Guard des Backends.
 *
 * `writer` (repo/save-ids.js): stammt der abweichende Server-Stand von einem
 * Save, den derselbe Schreiber gegen `expectedUpdatedAt` geschickt hat (Antwort
 * verloren), ist es kein Konflikt — der folgende PUT nennt die Kennung, der
 * Server nimmt ihn an.
 *
 * @returns {Promise<null|{remoteUpdatedAt, remoteUserName, remoteIsSelf, remoteDevice, remoteDeviceId, remoteSaveId, remoteHtml}>}
 */
// `extraOwn`: Save-Kennungen, die ein wiederhergestellter Entwurf von seinem
// Schreiber mitbringt (`{ id, base }`, repo/save-ids.js) — nach einem Neustart
// fehlen sie im sessionStorage, und der eigene Save mit verlorener Antwort
// sähe fremd aus.
export async function checkPageConflict(pageId, expectedUpdatedAt, { writer = null, extraOwn = [] } = {}) {
  if (!expectedUpdatedAt) return null;
  // Offline kann es keinen Cross-User-Konflikt geben — der ohnehin folgende
  // PUT wird ebenfalls scheitern und in den Offline-Banner-Pfad fallen. Modal
  // hier zu zeigen wäre irreführend (kein verlässlicher Server-Stand).
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return null;
  let remote;
  try {
    // `fresh: true` ist Pflicht: ohne den Bypass liefert der SW-SWR-Cache einen
    // stale `updated_at`, der Pre-Check passt fälschlich durch und überschreibt
    // den fremden Save.
    remote = await contentRepo.loadPage(pageId, { fresh: true });
  } catch (e) {
    console.warn('[checkPageConflict] read failed, skip modal', { pageId, status: e?.status, code: e?.code, msg: e?.message });
    return null;
  }
  if (!remote?.updated_at) {
    console.warn('[checkPageConflict] remote response without updated_at, skip modal', { pageId });
    return null;
  }
  if (remote.updated_at === expectedUpdatedAt) return null;
  if (writer && isOwnServerSave(writer, pageId, remote.last_save_id, [expectedUpdatedAt], extraOwn)) return null;
  return {
    remoteUpdatedAt: remote.updated_at,
    ...remoteAuthorFrom(remote),
    remoteHtml: remote.html || '',
  };
}

/**
 * Wer hat den Server-Stand einer Seite zuletzt geschrieben? Eigenes Zweit-Gerät
 * (Mac-Client, zweiter Laptop, Android) vs. fremder ACL-User:
 * `last_editor.device_name` ist serverseitig ohnehin nur für die eigenen Geräte
 * des Anfragers gefüllt. Feldsatz wie im Konflikt-Objekt (conflict-text.js).
 *
 * @param {object|null} page  Antwort von `contentRepo.loadPage`
 * @returns {{remoteUserName, remoteIsSelf, remoteDevice, remoteDeviceId, remoteSaveId}}
 */
export function remoteAuthorFrom(page) {
  const selfEmail = editorHost()?.$store?.session?.currentUser?.email || null;
  return {
    remoteUserName: page?.updated_by_name || null,
    remoteIsSelf: !!selfEmail && page?.last_editor_email === selfEmail,
    remoteDevice: page?.last_editor?.device_name || null,
    remoteDeviceId: page?.last_editor?.device_id || null,
    // Kennung des Saves, der diesen Stand schrieb (repo/save-ids.js).
    remoteSaveId: page?.last_save_id || null,
  };
}

// Banner-/Block-State aus einem `checkPageConflict`-Objekt: derselbe Feldsatz
// ohne `remoteHtml` (das gehört dem Merge-Pfad, nicht der Anzeige). Die
// 409-Variante liefert `readConflictBody(err)` aus shared/page-api.js dieselbe
// Form aus dem Server-Body — beide Quellen, ein Feldsatz.
export function conflictBannerFrom(conflict) {
  return {
    remoteUserName: conflict.remoteUserName,
    remoteUpdatedAt: conflict.remoteUpdatedAt,
    remoteIsSelf: conflict.remoteIsSelf,
    remoteDevice: conflict.remoteDevice,
  };
}
