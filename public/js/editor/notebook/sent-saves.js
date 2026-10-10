// Abgeschickte Save-Stände dieses Tabs, je Seite — Erkennung des eigenen
// verspäteten Saves.
//
// Hängt die Verbindung (ohne dass der Browser «offline» meldet), laufen die
// PUTs der Autosave-Runden clientseitig in den Timeout, stecken aber schon in
// der Leitung. Kommt das Netz zurück, erreichen sie den Server gesammelt: der
// älteste geht durch, die übrigen laufen in 409. Der Server-Stand ist dann ein
// älterer Zwischenstand DIESES Tabs, und der Block-Merge (Basis = letzter
// bestätigter Save) meldet eine Kollision zwischen der eigenen alten und der
// eigenen neuen Fassung.
//
// Darum merkt sich jeder Save vor dem PUT einen Fingerabdruck seines HTML.
// Entspricht der Server-Stand einem davon, ist der lokale Stand sein
// Nachfahre — gespeichert wird er dann ohne Merge auf den Server-Stempel.
// sessionStorage, weil der Fall ein Neuladen überleben muss (der Draft läuft
// beim nächsten startEdit gegen den Server-Stand) und weil er pro Tab gilt:
// ein anderer Tab hat nie genau diesen Stand geschickt.
import { normalizeForCompare } from '../shared/html-clean.js';

const KEY_PREFIX = 'notebook_sent_saves:';
const MAX_ENTRIES = 8;
const TTL_MS = 24 * 60 * 60 * 1000;

// cyrb53 — 53-Bit-String-Hash; mit der Länge zusammen ist eine zufällige
// Kollision zweier Fassungen derselben Seite ausgeschlossen genug.
function hash53(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

// Fingerabdruck über die Blockstruktur, nicht über das rohe HTML: der Server
// bereinigt den PUT (lib/html-clean.js#cleanPageHtml — u.a. Rand-&nbsp; am
// Blockende, leere Blöcke), der Editor-Output trägt das noch. Je Block der
// obersten Ebene zählen Block-ID, die Folge der Inline-Tags und der Text mit
// zusammengefasstem Leerraum; leere Blöcke fallen heraus. Eine reine
// Attribut-Änderung (Link-Ziel, Bildquelle) sieht der Abdruck nicht.
const EMPTY_BLOCK_CONTENT = ':not(br)';

function blockSignature(el) {
  const text = (el.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const tags = [...el.querySelectorAll(EMPTY_BLOCK_CONTENT)].map((d) => d.tagName.toLowerCase()).join(',');
  if (!text && !tags) return null;
  return `${el.getAttribute?.('data-bid') || ''}|${tags}|${text}`;
}

export function saveFingerprint(html) {
  const norm = normalizeForCompare(html || '');
  if (!norm || typeof DOMParser === 'undefined') return '';
  const body = new DOMParser().parseFromString(norm, 'text/html').body;
  const sig = [...body.children].map(blockSignature).filter(Boolean).join('\n');
  return sig ? `${sig.length}:${hash53(sig)}` : '';
}

function read(pageId) {
  try {
    const raw = sessionStorage.getItem(KEY_PREFIX + pageId);
    const list = raw ? JSON.parse(raw) : [];
    const cutoff = Date.now() - TTL_MS;
    return Array.isArray(list) ? list.filter((e) => e && e.fp && e.at > cutoff) : [];
  } catch { return []; }
}

export function recordSentSave(pageId, html) {
  if (pageId == null) return;
  const fp = saveFingerprint(html);
  if (!fp) return;
  const list = read(pageId).filter((e) => e.fp !== fp);
  list.push({ fp, at: Date.now() });
  try { sessionStorage.setItem(KEY_PREFIX + pageId, JSON.stringify(list.slice(-MAX_ENTRIES))); } catch { /* voll/gesperrt: Erkennung fällt aus, Merge wie bisher */ }
}

// true, wenn `serverHtml` ein Stand ist, den dieser Tab selbst abgeschickt hat.
export function isOwnSentSave(pageId, serverHtml) {
  if (pageId == null) return false;
  const fp = saveFingerprint(serverHtml);
  return !!fp && read(pageId).some((e) => e.fp === fp);
}
