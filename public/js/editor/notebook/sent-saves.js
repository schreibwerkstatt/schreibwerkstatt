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
// Darum merkt sich jeder Save vor dem PUT einen Fingerabdruck seines HTML und
// die Basis, gegen die er geschickt wurde (`expected_updated_at`). Entspricht
// der Server-Stand einem davon UND baut der lokale Stand auf derselben Basis
// auf, ist er sein Nachfahre — gespeichert wird er dann ohne Merge auf den
// Server-Stempel. Der Fingerabdruck allein beweist das nicht: die Einträge
// leben 24 h, überstehen ein Neuladen, und ein Stand, den dieser Tab am Morgen
// geschickt hat, ist kein Vorfahre einer Fassung, die auf einem älteren Stand
// aufbaut (veraltete Ansicht aus dem SW-Cache, Konflikt-Auflösung dagegen) —
// ohne Basis-Prüfung überschriebe die Abkürzung dessen Fortschritt ungemergt.
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
// obersten Ebene zählen die Folge der Inline-Tags und der Text mit
// zusammengefasstem Leerraum; leere Blöcke fallen heraus. Eine reine
// Attribut-Änderung (Link-Ziel, Bildquelle) sieht der Abdruck nicht.
// Die Block-ID zählt bewusst NICHT: der Server vergibt fehlende und doppelte
// IDs neu (lib/html-clean.js#ensureBlockIds), und die Antwort, die sie dem
// Editor mitteilen würde, ist genau die, die verloren ging. Ein Treffer heisst
// damit «Text und Struktur gleich einem Stand, den dieser Tab geschickt hat» —
// der lokale Stand überschreibt dann nichts, was nicht von hier kam.
// `<a>` zählt nicht zur Tag-Folge: der Server macht aus nackten URLs Links
// (linkifyBareUrls), der Linktext ist die URL selbst — der Text bleibt gleich,
// die Tag-Folge nicht. Gegated gegen die echte Server-Pipeline in
// tests/unit/notebook-edit-conflict.test.mjs.
const EMPTY_BLOCK_CONTENT = ':not(br):not(a)';

// Der Server kürzt Rand-Leerraum je innerem Block (lib/html-clean.js
// #_EDGE_TRIM_BLOCKS: jede Verlaufszeile, jedes Listenelement, jeder Absatz im
// Zitat), nicht nur am Rand des Blocks der obersten Ebene. Der Text wird darum
// je innerem Block gekürzt und mit Trenner gebildet — sonst ergäbe «Marie »
// über der nächsten Verlaufszeile vor dem Save einen anderen Text als danach.
// Mehr Grenzen als der Server schaden nicht: beide Seiten laufen hier durch.
const INNER_BLOCK_SEL = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,div,td,th,dd,dt,figcaption,ul,ol,table,thead,tbody,tr,figure';
const squash = (s) => s.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

function blockText(el) {
  const parts = [];
  let run = '';
  for (const n of el.childNodes) {
    if (n.nodeType === 1 && n.matches(INNER_BLOCK_SEL)) {
      parts.push(squash(run), blockText(n));
      run = '';
    } else {
      run += n.textContent || '';
    }
  }
  parts.push(squash(run));
  return parts.filter(Boolean).join('\n');
}

function blockSignature(el) {
  const text = blockText(el);
  const tags = [...el.querySelectorAll(EMPTY_BLOCK_CONTENT)].map((d) => d.tagName.toLowerCase()).join(',');
  if (!text && !tags) return null;
  return `${tags}|${text}`;
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

// `baseAt`: der Stempel, gegen den der PUT geschickt wird. Ohne ihn kann der
// Eintrag nie als Vorfahre gelten — der Save wird nicht vermerkt.
export function recordSentSave(pageId, html, baseAt) {
  if (pageId == null || !baseAt) return;
  const fp = saveFingerprint(html);
  if (!fp) return;
  const list = read(pageId).filter((e) => !(e.fp === fp && e.base === baseAt));
  list.push({ fp, base: baseAt, at: Date.now() });
  try { sessionStorage.setItem(KEY_PREFIX + pageId, JSON.stringify(list.slice(-MAX_ENTRIES))); } catch { /* voll/gesperrt: Erkennung fällt aus, Merge wie bisher */ }
}

// true, wenn `serverHtml` ein Stand ist, den dieser Tab selbst abgeschickt hat,
// und zwar gegen eine der Basen in `localBases` — der Stempel, auf denen der
// lokale Stand aufbaut. Nur dann ist der lokale Stand sein Nachfahre.
export function isOwnSentSave(pageId, serverHtml, localBases) {
  if (pageId == null) return false;
  const bases = (localBases || []).filter(Boolean);
  if (!bases.length) return false;
  const fp = saveFingerprint(serverHtml);
  return !!fp && read(pageId).some((e) => e.fp === fp && bases.includes(e.base));
}
