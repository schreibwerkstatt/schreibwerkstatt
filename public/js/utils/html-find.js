// Tolerantes Suchen/Ersetzen in HTML über eine Text-View mit Positions-Map.
// Findet KI-/User-Phrasen, die im HTML von Inline-Tags durchsetzt sind, und
// ersetzt sie tag-balance-sicher (Block-Grenzen werden nie gekreuzt).

import { CITE_CLASS, CITE_ATTR_SRC } from '../sources/cite-html.js';
import { XREF_CLASS, XREF_ATTR_ID } from '../xrefs/xref-html.js';
import { foldQuotes, normalizeMatchText } from './text-match.js';

// Dekodiert eine einzelne HTML-Entity (z.B. &bdquo;) via Browser-Parser.
// Gibt null zurück, wenn sich die Entity nicht auflöst.
const _entityDecoder = typeof document !== 'undefined' ? document.createElement('textarea') : null;
function _decodeHtmlEntity(entity) {
  if (!_entityDecoder) return null;
  _entityDecoder.innerHTML = entity;
  const decoded = _entityDecoder.value;
  return decoded === entity ? null : decoded;
}

/**
 * Baut eine Text-View von `html` mit Positions-Map zurück ins Original-HTML.
 * - Tags werden entfernt; Tag-Grenzen wirken wie Whitespace.
 * - Aufeinanderfolgender Whitespace wird auf einzelne Spaces kollabiert.
 * - Entities werden via Browser-Parser dekodiert.
 * - Anführungszeichen werden in `text` gefaltet (`foldQuotes`, längenerhaltend):
 *   „ “ ” « » gelten als `"`, ‚ ‘ ’ ‹ › als `'` — die KI schreibt sie selten im
 *   Buch-Stil. `raw` ist dieselbe Sicht ungefaltet (gleiche Indizes).
 * - Pro Text-Zeichen `text[i]` gilt: es stammt aus dem HTML-Bereich [starts[i], ends[i]).
 *   Ein Space aus Tag-Grenze/Whitespace-Lauf ist nullbreit an der Position des
 *   folgenden Zeichens (starts[i] === ends[i]).
 */
function _buildHtmlTextMap(html) {
  const chars = [];
  const starts = [];
  const ends = [];
  let pendingSpace = false;
  let emittedNonSpace = false;
  let i = 0;

  const markSpace = () => { if (emittedNonSpace) pendingSpace = true; };

  const pushChar = (ch, start, end) => {
    if (pendingSpace) {
      chars.push(' ');
      starts.push(start);
      ends.push(start);
      pendingSpace = false;
    }
    chars.push(ch);
    starts.push(start);
    ends.push(end);
    emittedNonSpace = true;
  };

  while (i < html.length) {
    const c = html[i];
    if (c === '<') {
      const gt = html.indexOf('>', i);
      if (gt === -1) break;
      markSpace();
      i = gt + 1;
      continue;
    }
    if (c === '&') {
      const semi = html.indexOf(';', i);
      if (semi !== -1 && semi - i <= 10) {
        const entity = html.slice(i, semi + 1);
        const decoded = _decodeHtmlEntity(entity);
        if (decoded != null) {
          for (const dc of decoded) {
            if (/\s/.test(dc)) markSpace();
            else pushChar(dc, i, semi + 1);
          }
          i = semi + 1;
          continue;
        }
      }
    }
    if (/\s/.test(c)) {
      markSpace();
      i++;
      continue;
    }
    pushChar(c, i, i + 1);
    i++;
  }
  const raw = chars.join('');
  return { text: foldQuotes(raw), raw, starts, ends };
}

// Exakter Roh-Treffer nur im Fliesstext: nicht in einem Tag (Attributwerte wie
// href/alt/data-*) und nicht mitten in einer Entity (`amp` in `&amp;`). Die
// Nadel selbst darf kein Markup-Zeichen tragen — dann entscheidet die Text-View.
function _exactInText(html, needle) {
  if (/[<>&]/.test(needle)) return -1;
  let from = 0;
  for (;;) {
    const idx = html.indexOf(needle, from);
    if (idx === -1) return -1;
    const inTag = html.lastIndexOf('<', idx) > html.lastIndexOf('>', idx);
    const amp = html.lastIndexOf('&', idx);
    const inEntity = amp !== -1 && amp > html.lastIndexOf(';', idx) && idx - amp <= 10
      && /^&[#a-zA-Z0-9]*$/.test(html.slice(amp, idx));
    if (!inTag && !inEntity) return idx;
    from = idx + 1;
  }
}

// Fundort von `needle` samt Text-View-Position (für den Wort-Diff-Ersatz).
// `map` ist null beim exakten Roh-Treffer (dann liegt kein Tag im Bereich).
function _locate(html, needle) {
  if (!html || !needle) return null;
  const trimmed = String(needle).trim();
  if (!trimmed) return null;
  // Ränder ohne Whitespace: der Bereich schliesst nie Leerraum am Rand ein,
  // sonst verklebte ein Ersatz ohne denselben Rand die Nachbarwörter.
  const exact = _exactInText(html, trimmed);
  if (exact !== -1) return { htmlStart: exact, htmlEnd: exact + trimmed.length, map: null };

  const normalized = normalizeMatchText(trimmed);
  if (!normalized) return null;
  const map = _buildHtmlTextMap(html);
  const idx = map.text.indexOf(normalized);
  if (idx === -1) return null;
  return {
    htmlStart: map.starts[idx], htmlEnd: map.ends[idx + normalized.length - 1],
    map, textStart: idx, textLen: normalized.length,
  };
}

/**
 * Sucht `needle` in `html`. Exakter Substring-Match im Fliesstext hat Vorrang
 * (nie in Attributen oder Entities); sonst toleranter Match über die Text-View
 * (Tags ignorieren, Entities dekodieren, Whitespace kollabieren, Anführungs-
 * zeichen falten). Ränder-Whitespace der Nadel zählt nicht mit. Gibt
 * { htmlStart, htmlEnd } zurück oder null.
 *
 * Typischer Fall: Chat-/Lektorat-KI sieht die Seite als Plaintext und
 * liefert `Er sagte das magische Wort.`, im HTML steht aber
 * `Er sagte <em>das magische</em> Wort.`. Der Tolerant-Match findet die
 * Stelle trotzdem; `replaceInHtml` ersetzt darin nur die geänderten Wörter.
 */
export function findInHtml(html, needle) {
  const m = _locate(html, needle);
  return m ? { htmlStart: m.htmlStart, htmlEnd: m.htmlEnd } : null;
}

/**
 * Zählt die nicht-überlappenden Vorkommen von `needle` in `html` über dieselbe
 * Text-View wie `findInHtml` (Tags ignorieren, Entities dekodieren, Whitespace
 * kollabieren, Anführungszeichen falten). Dient der Ambiguitäts-Erkennung vor
 * einer Ersetzung: `findInHtml` greift immer das erste Vorkommen, was bei
 * mehrdeutigen Phrasen die falsche Stelle treffen würde. Kommt der Text mehrfach
 * vor, kann statt still-falscher Ersetzung abgebrochen werden.
 */
export function countInHtml(html, needle) {
  if (!html || !needle) return 0;
  const normalized = normalizeMatchText(needle);
  if (!normalized) return 0;
  const { text } = _buildHtmlTextMap(html);
  let count = 0;
  let from = 0;
  let idx;
  while ((idx = text.indexOf(normalized, from)) !== -1) {
    count++;
    from = idx + normalized.length;
  }
  return count;
}

const _VOID_TAGS = new Set([
  'area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr',
]);

// Inline-Elemente, ueber die eine Ersetzung gefahrlos hinweggehen darf — ihre
// Tag-Balance haelt der Orphan-Schutz in `_splitOrphanTags`. Alles andere
// (p, li, h1-h6, blockquote, pre, table-Teile, div, figure …) ist eine
// Block-Grenze: ein Match, der sie kreuzt, wuerde beim Ersetzen Absatzstruktur
// zerreissen (verschachtelte/aufgespaltene Bloecke). Default-Deny: unbekannte
// Tags gelten als Block-Grenze, damit nichts stillschweigend korrumpiert.
const _INLINE_TAGS = new Set([
  'a','abbr','b','bdi','bdo','br','cite','code','data','dfn','em','i','kbd',
  'mark','q','rp','rt','ruby','s','samp','small','span','strong','sub','sup',
  'time','u','var','wbr',
]);

// True, wenn der Slice ein Nicht-Inline-Tag (Block-Grenze) enthaelt.
function _crossesBlockBoundary(slice) {
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
  let m;
  while ((m = tagRe.exec(slice))) {
    if (!_INLINE_TAGS.has(m[1].toLowerCase())) return true;
  }
  return false;
}

// True, wenn der Slice einen sichtbaren Zeilenumbruch <br> umschliesst. In der
// Text-View wird <br> — wie jedes Tag — zu einem Space (markSpace), sodass ein
// toleranter Match ihn ueberspannen kann. Beim Ersetzen ginge der <br> dann
// verloren: er ist ein Void-Tag, den `_splitOrphanTags` nicht als Waise erhaelt,
// und `korrektur` ist Fliesstext ohne Umbruch-Position. Ergebnis waere ein
// stillschweigend geloeschter Zeilenumbruch (Vers, Adresse, Strophe). Wie bei
// einer Block-Grenze bleibt der Text darum unveraendert statt korrumpiert.
function _crossesLineBreak(slice) {
  return /<br\b[^>]*>/i.test(slice);
}

// True, wenn der Slice ein VOLLSTAENDIG umschlossenes <a>…</a> enthaelt (Open
// UND Close im Bereich). Das href traegt Information, die die Plaintext-View der
// KI nie gesehen hat — beim Ersetzen fiele der Link ersatzlos weg (nur der
// sichtbare Linktext bliebe). Ein Waisen-<a> (Open oder Close ausserhalb) ist
// dagegen ungefaehrlich: `_splitOrphanTags` klebt den fehlenden Partner wieder
// an, der Link ueberlebt. Anker verschachteln nicht — depth-Zaehlung reicht.
function _containsBalancedAnchor(slice) {
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
  let depth = 0;
  let m;
  while ((m = tagRe.exec(slice))) {
    if (m[1].toLowerCase() !== 'a') continue;
    if (m[0].startsWith('</')) { if (depth > 0) return true; }
    else depth++;
  }
  return false;
}

// Ist dieses Open-Tag ein Marker-Span (Quellenangabe oder Querverweis)?
// Klasse UND Zeiger-Attribut muessen da sein — ein `span.cite` ohne `data-src`
// bzw. ein `span.xref` ohne `data-xref-id` ist Fremdmarkup und traegt keine
// Information, die der Ersatz verlieren koennte (gleiche Regel wie CITE_SEL /
// XREF_SEL in den beiden SSoT-Modulen). Klassen- und Attributnamen kommen aus
// eben diesen Modulen — dieses hier arbeitet parserfrei auf dem HTML-String und
// kann die CSS-Selektoren nicht anwenden, darf die Namen aber auch nicht
// abschreiben (harte Regel „Editor-Blockstruktur: Markup und Selektoren nur aus
// ihrer SSoT").
function _isMarkerSpanOpen(tagHtml) {
  const cls = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tagHtml);
  const classes = String(cls ? (cls[1] ?? cls[2]) : '').split(/\s+/);
  const hasAttr = (name) => new RegExp(`\\s${name}\\s*=`, 'i').test(tagHtml);
  if (classes.includes(CITE_CLASS) && hasAttr(CITE_ATTR_SRC)) return true;
  if (classes.includes(XREF_CLASS) && hasAttr(XREF_ATTR_ID)) return true;
  return false;
}

// True, wenn der Slice einen VOLLSTAENDIG umschlossenen Marker-Span enthaelt
// (Open UND Close im Bereich). Exakt dieselbe Ueberlegung wie beim Hyperlink
// eine Funktion weiter oben: `data-src` bzw. `data-xref`/`data-xref-id` sind die
// WAHRHEIT, der sichtbare Chip-Text ist nur ein Cache davon — und die Plaintext-
// View, aus der die KI ihren Vorschlag baut, hat den Zeiger nie gesehen. Beim
// Ersetzen faellt das Markup ersatzlos weg (`span` ist ein Inline-Tag, das Paar
// ist balanciert, also rettet auch `_splitOrphanTags` nichts) und zurueck bliebe
// toter Klartext: die Fundstelle verschwindet aus `source_citations` bzw.
// `xref_links`, das Quellenverzeichnis verliert den Beleg, und der Querverweis
// wird von keinem Ausgabeweg je wieder umnummeriert.
//
// Ein Waisen-Marker (Open oder Close ausserhalb des Slice) ist dagegen
// ungefaehrlich: `_splitOrphanTags` klebt den fehlenden Partner wieder an, der
// Zeiger ueberlebt — nur sein Text-Cache aendert sich, und den setzt ohnehin
// jeder Renderer frisch.
//
// Marker verschachteln nicht, aber ein gewoehnlicher `<span>` kann einen
// umschliessen (oder umgekehrt) — darum ein Stack statt einer Tiefenzahl.
function _containsBalancedMarker(slice) {
  const tagRe = /<\/?span\b[^>]*>/gi;
  const stack = [];
  let m;
  while ((m = tagRe.exec(slice))) {
    if (m[0].startsWith('</')) {
      if (stack.length && stack.pop()) return true;
    } else if (!/\/>$/.test(m[0])) {
      stack.push(_isMarkerSpanOpen(m[0]));
    }
  }
  return false;
}

/**
 * Findet im Slice Tags ohne Partner: Closes ohne vorheriges Open im Slice
 * (Open liegt VOR dem Slice, Tag muss nach dem Replacement erhalten bleiben),
 * bzw. Opens ohne nachfolgendes Close im Slice (Close liegt NACH dem Slice).
 * Self-closing/Void-Elemente werden ignoriert.
 */
function _splitOrphanTags(slice) {
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
  const stack = [];
  const orphanCloses = [];
  let m;
  while ((m = tagRe.exec(slice))) {
    const full = m[0];
    const tag = m[1].toLowerCase();
    if (_VOID_TAGS.has(tag) || /\/>$/.test(full)) continue;
    if (full.startsWith('</')) {
      if (stack.length && stack[stack.length - 1].tag === tag) stack.pop();
      else orphanCloses.push(full);
    } else {
      stack.push({ tag, full });
    }
  }
  return { orphanOpens: stack.map(s => s.full), orphanCloses };
}

// Ersatztext für den Fliesstext eines Text-Nodes: nur `&`, `<`, `>` maskieren.
// Anführungszeichen bleiben Zeichen (im Text-Inhalt brauchen sie kein Escape),
// damit die Anführungszeichen-Normalisierung nach dem Übernehmen und die
// Stats-Normalform sie als Zeichen sehen und nicht als `&quot;`.
function _escText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Ersatz für einen Bereich, dessen Waisen-Tags erhalten bleiben müssen. Liegt
// ein Close VOR einem Open im Bereich (`…</em> und <strong>…`), steht der Text
// zwischen beiden — sonst verschachtelte `<strong>X</em>` falsch.
function _withOrphans(removed, inserted) {
  if (!removed.includes('<')) return inserted;
  const { orphanOpens, orphanCloses } = _splitOrphanTags(removed);
  if (orphanOpens.length && orphanCloses.length) return orphanCloses.join('') + inserted + orphanOpens.join('');
  return orphanOpens.join('') + inserted + orphanCloses.join('');
}

// Token wie im Wort-Diff der Vorschlagskarten (chat/word-diff.js): Wörter (mit
// Bindestrich/Apostroph im Wort), Whitespace-Läufe, einzelne Satzzeichen.
const _TOKEN_RE = /[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*|\s+|[^\s\p{L}\p{N}]/gu;
const _DIFF_MAX_CELLS = 250000;

function _tokens(s) {
  const out = [];
  for (const m of s.matchAll(_TOKEN_RE)) {
    const v = /^\s/.test(m[0]) ? ' ' : m[0];
    out.push({ v, fold: foldQuotes(v), at: m.index, len: m[0].length });
  }
  return out;
}

// Token gleich? Gerade Anführungszeichen im Ersatz sind „egal" (die KI kennt
// den Buch-Stil nicht) — ein typografisches, das vom Text abweicht, ist dagegen
// eine gewollte Änderung (Lektorat: „falsche Anführungszeichen").
const _tokEq = (x, y) => x.v === y.v || x.fold === y.v;

// Geänderte Abschnitte zwischen den Token-Folgen `a` (Text) und `b` (Ersatz),
// per LCS: [{ aFrom, aTo, bFrom, bTo }] in Leserichtung. null = zu gross.
function _diffHunks(a, b) {
  const n = a.length;
  const m = b.length;
  if ((n + 1) * (m + 1) > _DIFF_MAX_CELLS) return null;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i][j] = _tokEq(a[i], b[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }
  const hunks = [];
  let cur = null;
  let i = 0;
  let j = 0;
  const open = () => { if (!cur) cur = { aFrom: i, aTo: i, bFrom: j, bTo: j }; };
  while (i < n || j < m) {
    if (i < n && j < m && _tokEq(a[i], b[j])) {
      if (cur) { hunks.push(cur); cur = null; }
      i++; j++;
    } else if (j >= m || (i < n && L[i + 1][j] >= L[i][j + 1])) {
      open(); i++; cur.aTo = i;
    } else {
      open(); j++; cur.bTo = j;
    }
  }
  if (cur) hunks.push(cur);
  return hunks;
}

// Leere Inline-Paare ohne Attribute, die das Löschen eines ganz ausgezeichneten
// Worts hinterlässt (`<em></em>`), fallen weg — nur im ersetzten Bereich.
const _EMPTY_INLINE_RE = /<(em|strong|b|i|u|s|mark|small|sub|sup|span)>(\s*)<\/\1>/gi;
function _dropEmptyInline(s) {
  let prev;
  do { prev = s; s = s.replace(_EMPTY_INLINE_RE, '$2'); } while (s !== prev);
  return s;
}

// Fenster für `_dropEmptyInline`: der ersetzte Bereich plus die Tags, die ihm
// unmittelbar anliegen (das `<em>` eines am Bereichsanfang gelöschten Worts
// steht vor dem Bereich).
function _tagRunBefore(html, pos) {
  while (pos > 0 && html[pos - 1] === '>') {
    const lt = html.lastIndexOf('<', pos - 1);
    if (lt === -1) break;
    pos = lt;
  }
  return pos;
}
function _tagRunAfter(html, pos) {
  while (html[pos] === '<') {
    const gt = html.indexOf('>', pos);
    if (gt === -1) break;
    pos = gt + 1;
  }
  return pos;
}

// Wort-Diff-Ersatz eines toleranten Treffers: nur die geänderten
// Token werden ersetzt, unveränderte Wörter bleiben samt Auszeichnung stehen
// (`Er sagte <em>das magische</em> Wort` → `das geheime Wort` ergibt
// `Er sagte <em>das geheime</em> Wort`). null = Diff nicht machbar.
function _replaceByWordDiff(html, loc, replacement) {
  const { map, textStart, textLen } = loc;
  const a = _tokens(map.raw.slice(textStart, textStart + textLen));
  const b = _tokens(replacement);
  const hunks = _diffHunks(a, b);
  if (!hunks) return null;
  const { starts, ends } = map;
  const base = loc.htmlStart;
  let mid = html.slice(loc.htmlStart, loc.htmlEnd);
  // Von hinten nach vorn: frühere Positionen bleiben gültig.
  for (let h = hunks.length - 1; h >= 0; h--) {
    const { aFrom, aTo, bFrom, bTo } = hunks[h];
    const p0 = textStart + (aFrom < a.length ? a[aFrom].at : textLen);
    // Start: hinter dem letzten unveränderten Zeichen — so fällt ein entfernter
    // Leerraum samt der Tags darin mit weg (Waisen-Tags rettet _withOrphans).
    let hs = p0 > textStart ? ends[p0 - 1] : loc.htmlStart;
    // Reine Einfügung hinter einem Leerraum: vor die öffnenden Tags des
    // folgenden Worts, nicht hinein (`Ein <em>roter</em>` + „grosser" →
    // `Ein grosser <em>roter</em>`, nicht kursiv).
    if (aTo === aFrom && p0 > textStart && starts[p0 - 1] === ends[p0 - 1]) {
      hs = Math.max(_tagRunBefore(html, hs), ends[p0 - 2] ?? loc.htmlStart, loc.htmlStart);
    }
    let he = hs;
    if (aTo > aFrom) {
      const last = a[aTo - 1];
      he = ends[textStart + last.at + last.len - 1];
    }
    const added = _escText(b.slice(bFrom, bTo).map(t => t.v).join(''));
    const removed = mid.slice(hs - base, he - base);
    mid = mid.slice(0, hs - base) + _withOrphans(removed, added) + mid.slice(he - base);
  }
  const lo = _tagRunBefore(html, loc.htmlStart);
  const hi = _tagRunAfter(html, loc.htmlEnd);
  const win = html.slice(lo, loc.htmlStart) + mid + html.slice(loc.htmlEnd, hi);
  return html.slice(0, lo) + _dropEmptyInline(win) + html.slice(hi);
}

/**
 * Ersetzt `needle` im HTML durch `replacement` (Klartext — wird für den
 * Fliesstext maskiert, nie als Markup eingesetzt). Position wie `findInHtml`;
 * Rand-Whitespace von Nadel und Ersatz zählt nicht (der Bereich schliesst ihn
 * nie ein, ein Ersatz mit eigenem Rand verdoppelte bzw. verlöre Leerraum).
 *
 * Beim toleranten Treffer (Inline-Tags, Entities, Whitespace oder eine
 * Anführungszeichen-Variante im Bereich) wird per Wort-Diff nur ersetzt, was
 * sich ändert — unveränderte Wörter behalten ihre Auszeichnung (`<em>`,
 * `<strong>` …) und ihre Anführungszeichen im Buch-Stil. Waisen-Tags innerhalb eines ersetzten Abschnitts
 * bleiben erhalten, sonst zerbricht die Tag-Balance. Ist der Diff zu gross,
 * wird der ganze Bereich ersetzt (mit demselben Waisen-Schutz).
 *
 * Kreuzt der Match dagegen eine BLOCK-Grenze (`</p><p>`, `</li><li>`, Heading,
 * Tabelle …), umschliesst er einen Zeilenumbruch (`<br>`), einen vollständigen
 * Hyperlink (`<a>…</a>`) ODER einen vollständigen Marker-Span (Quellenangabe,
 * Querverweis), wird NICHT ersetzt: eine Block-Grenzen-Ersetzung würde Absätze
 * zerstören, ein umspannter `<br>` würde als sichtbarer Zeilenumbruch ersatzlos
 * verschwinden, eine Link-Ersetzung würde das `href` verwerfen und eine
 * Marker-Ersetzung den Zeiger auf Quelle bzw. Verweisziel — alles drei
 * Information, die die KI-Plaintext-View nie gesehen hat. In allen Fällen bleibt
 * der Text unverändert statt korrumpiert.
 *
 * `replacement` selbst wird von rohen Zeilenumbrüchen (`\n`/`\r`) befreit, damit
 * kein Umbruch hinzukommt, den `original` nicht hatte.
 *
 * Gibt das neue HTML zurück, oder das Original wenn nichts gefunden bzw. der
 * Match eine Block-Grenze, einen `<br>`, einen Link oder einen Marker kreuzt.
 */
export function replaceInHtml(html, needle, replacement) {
  if (!html || !needle) return html;
  const m = _locate(html, needle);
  if (!m) return html;
  const removed = html.slice(m.htmlStart, m.htmlEnd);
  // Keinen Zeilenumbruch hinzufuegen: `korrektur` ist reiner Ersatz-Fliesstext.
  // Ein rohes \n darin (KI-Artefakt) wanderte sonst verbatim ins HTML und wuerde
  // in umbruch-erhaltenden Bloecken (<pre>, .poem) als sichtbarer Umbruch gerendert.
  const text = String(replacement ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (removed.includes('<')) {
    if (_crossesBlockBoundary(removed)) return html;
    if (_crossesLineBreak(removed)) return html;
    if (_containsBalancedAnchor(removed)) return html;
    if (_containsBalancedMarker(removed)) return html;
  }
  // Toleranter Treffer (Tags, Entities, Whitespace oder Anführungszeichen-
  // Variante im Bereich): per Wort-Diff ersetzen — so überleben Auszeichnung und
  // die Anführungszeichen des Buchs in unveränderten Wörtern.
  if (m.map) {
    const out = _replaceByWordDiff(html, m, text.replace(/\s+/g, ' '));
    if (out != null) return out;
  }
  return html.slice(0, m.htmlStart) + _withOrphans(removed, _escText(text)) + html.slice(m.htmlEnd);
}

/**
 * Fügt `insertion` DIREKT HINTER dem Fundort von `needle` ein, ohne den
 * gefundenen Bereich anzutasten. Gegenstück zu `replaceInHtml` für den Fall, in
 * dem nichts ersetzt, sondern etwas angehängt wird — der Belegvorschlag setzt so
 * den Kurzbeleg hinter einen unbelegten Satz.
 *
 * WARUM NICHT `replaceInHtml(html, satz, satz + beleg)`: `replaceInHtml` setzt
 * ausschliesslich maskierten KLARTEXT ein (eine Korrektur ist nie Markup) — der
 * Chip käme als sichtbarer Quelltext an. Und ein Satz, der schon eine
 * Quellenangabe umschliesst, wäre dort blockiert (`spansMarker`). Hier wird
 * ausschliesslich an einer Position gespleisst, es fällt nichts weg; `insertion`
 * ist vertrauenswürdiges Markup des Aufrufers.
 *
 * Der Einfügepunkt wandert über unmittelbar folgende SCHLIESSENDE Inline-Tags
 * hinweg: endet der Satz auf einem betonten Wort (`…<em>Satz.</em>`), gehört der
 * Beleg hinter das `</em>` und nicht hinein — sonst erbt der Chip die
 * Auszeichnung. Über eine Block-Grenze (`</p>`) wandert er NICHT: der Beleg
 * gehört in den Absatz, den er belegt.
 *
 * Gibt das HTML unverändert zurück, wenn `needle` nicht auffindbar ist. Die
 * Mehrdeutigkeits-Prüfung liegt beim Aufrufer (`countInHtml`) — `findInHtml`
 * greift immer das erste Vorkommen.
 */
export function insertAfterInHtml(html, needle, insertion) {
  if (!html || !needle || !insertion) return html;
  const m = findInHtml(html, needle);
  if (!m) return html;

  let at = m.htmlEnd;
  const closeRe = /^<\/([a-zA-Z][a-zA-Z0-9]*)\s*>/;
  for (;;) {
    const next = closeRe.exec(html.slice(at));
    if (!next || !_INLINE_TAGS.has(next[1].toLowerCase())) break;
    at += next[0].length;
  }

  // Kein roher Zeilenumbruch (gleiche Begründung wie in `replaceInHtml`): in
  // umbruch-erhaltenden Blöcken (`<pre>`, `.poem`) würde er sichtbar.
  const ins = String(insertion).replace(/[\r\n]+/g, ' ');
  return html.slice(0, at) + ins + html.slice(at);
}

/**
 * Warum eine `replaceInHtml`-Ersetzung ein No-Op wäre — zur Unterscheidung der
 * User-Meldung (Absatzgrenze vs. Link). Gibt `true`, wenn der Match einen
 * vollständigen `<a>…</a>` umschliesst (und deshalb übersprungen wird).
 */
export function matchSpansLink(html, needle) {
  if (!html || !needle) return false;
  const m = findInHtml(html, needle);
  if (!m) return false;
  return _containsBalancedAnchor(html.slice(m.htmlStart, m.htmlEnd));
}

/**
 * Pendant zu `matchSpansLink` für Marker-Spans: `true`, wenn der Match eine
 * vollständige Quellenangabe oder einen vollständigen Querverweis umschliesst
 * (und deshalb übersprungen wird).
 */
export function matchSpansMarker(html, needle) {
  if (!html || !needle) return false;
  const m = findInHtml(html, needle);
  if (!m) return false;
  return _containsBalancedMarker(html.slice(m.htmlStart, m.htmlEnd));
}

/**
 * Klassifiziert, WARUM eine `replaceInHtml`-Ersetzung ein No-Op war — damit die
 * User-Meldung die Wahrheit sagt statt pauschal „Link oder Absatzgrenze":
 *
 *   'notFound'    — `needle` steht nicht (mehr) im HTML. Kein Schutzmechanismus,
 *                   sondern ein veralteter Textbezug: die Stelle wurde inzwischen
 *                   umgeschrieben oder gelöscht. Braucht keine Nachkontrolle.
 *   'spansLink'   — der Match umschliesst ein vollständiges `<a>…</a>`; ersetzen
 *                   würde das `href` verwerfen.
 *   'spansMarker' — der Match umschliesst eine vollständige Quellenangabe oder
 *                   einen vollständigen Querverweis; ersetzen würde den Zeiger
 *                   (`data-src` bzw. `data-xref-id`) verwerfen und nur toten
 *                   Klartext zurücklassen.
 *   'boundary'    — der Match kreuzt eine Block-Grenze oder einen `<br>`.
 *
 * Nur für den No-Op-Fall gedacht; auf einer erfolgreich ersetzbaren Stelle
 * aufgerufen liefert es 'boundary' (der Aufrufer fragt dort nicht).
 * Reihenfolge = Entscheidungsbaum von chat.js#applyChatVorschlag.
 */
export function skipReason(html, needle) {
  if (!findInHtml(html, needle)) return 'notFound';
  if (matchSpansLink(html, needle)) return 'spansLink';
  if (matchSpansMarker(html, needle)) return 'spansMarker';
  return 'boundary';
}
