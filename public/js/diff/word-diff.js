// Wort-Diff zweier Klartexte — der eine Wort-Diff aller Diff-Ansichten
// (Chat-Vorschläge, Konflikt-Auflösung, Abschnitts-Historie, Fassungen,
// Kommentar-Leisten); Markierung und Rendering: diff-parts.js.
//
// Pure (kein DOM, kein Alpine) und synchron — verglichen wird je Absatz bzw.
// Vorschlag, ein LCS über Wort-Token reicht. jsdiff (lazy-libs.js#loadDiff)
// springt nur ein, wo die Tabelle zu gross wird (diff-parts.js#wordParts).
//
// Ausgabe: [{ t: 'eq'|'del'|'add', v: string }] — benachbarte Teile gleicher Art
// sind zusammengefasst, Whitespace zwischen zwei Änderungen hängt am Gleichtext.
// `null`, wenn die Eingabe zu gross für die quadratische Tabelle ist (Aufrufer
// zeigt dann die zwei Blöcke bzw. nimmt jsdiff).

const MAX_CELLS = 250000;

// Wörter (inkl. Apostroph im Wort), Whitespace-Läufe und einzelne Satzzeichen
// als eigene Token: so bleibt „Haus," → „Haus." eine Ein-Zeichen-Änderung statt
// eines ganzen Wortwechsels. Der Bindestrich ist ebenfalls ein eigenes Token,
// damit „E-Mail-Postfach" → „Mail-Postfach" nur „E-" markiert;
// _joinCompounds hält ein komplett ersetztes Kompositum wieder zusammen.
const TOKEN_RE = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*|\s+|[^\s\p{L}\p{N}]/gu;

export function tokenize(s) {
  return String(s ?? '').match(TOKEN_RE) || [];
}

export function wordDiff(a, b) {
  const x = tokenize(a);
  const y = tokenize(b);
  const n = x.length;
  const m = y.length;
  if ((n + 1) * (m + 1) > MAX_CELLS) return null;

  // Gewichtete LCS von hinten: L[i][j] = bestes Gewicht für x[i..], y[j..].
  // Ein Wort-Treffer wiegt mehr als alle Whitespace-Treffer zusammen — sonst
  // gleicht „a b X c" vs. „a Y b c" die Leerzeichen statt des Worts „b" ab
  // (gleich viele Token), und ein unverändertes Wort erscheint als gelöscht +
  // eingefügt. Whitespace zählt 1, damit er unter gleichwertigen Wegen Gleichtext
  // bleibt statt an der Änderung zu hängen.
  const WORD = n + m + 1;
  const w = (tok) => (/^\s+$/.test(tok) ? 1 : WORD);
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const skip = Math.max(L[i + 1][j], L[i][j + 1]);
      L[i][j] = x[i] === y[j] ? Math.max(L[i + 1][j + 1] + w(x[i]), skip) : skip;
    }
  }

  const out = [];
  const push = (t, v) => {
    const last = out[out.length - 1];
    if (last && last.t === t) last.v += v;
    else out.push({ t, v });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j] && L[i][j] === L[i + 1][j + 1] + w(x[i])) { push('eq', x[i]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) { push('del', x[i]); i++; }
    else { push('add', y[j]); j++; }
  }
  while (i < n) push('del', x[i++]);
  while (j < m) push('add', y[j++]);
  return _joinCompounds(_attachWhitespace(out));
}

// Reiner Whitespace als eigene Änderung („ " gelöscht, „ " eingefügt) liest sich
// als Rauschen: ein del+add-Paar aus blossem Whitespace wird Gleichtext.
function _attachWhitespace(parts) {
  const out = parts.map(p => ({ ...p }));
  for (let k = 0; k < out.length - 1; k++) {
    const a = out[k];
    const b = out[k + 1];
    if (a.t === 'del' && b.t === 'add' && /^\s+$/.test(a.v) && /^\s+$/.test(b.v)) {
      out.splice(k, 2, { t: 'eq', v: b.v });
    }
  }
  const merged = [];
  for (const p of out) {
    const last = merged[merged.length - 1];
    if (last && last.t === p.t) last.v += p.v;
    else merged.push(p);
  }
  return merged;
}

// Ein Bindestrich als Gleichtext zwischen zwei Änderungen im selben Wort
// („Ost-West" → „Nord-Süd") zerlegte das Kompositum in zwei Marken. Steht er auf
// beiden Seiten mitten im Wort, wandert er in die Änderung, und das Wort wird
// als Ganzes markiert.
const _WORD_END = /[\p{L}\p{N}]$/u;
const _WORD_START = /^[\p{L}\p{N}]/u;

function _joinCompounds(parts) {
  const out = [];
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k];
    if (p.t === 'eq' && p.v === '-') {
      let b = out.length;
      while (b > 0 && out[b - 1].t !== 'eq') b--;
      let e = k + 1;
      while (e < parts.length && parts[e].t !== 'eq') e++;
      const before = out.slice(b);
      const after = parts.slice(k + 1, e);
      const side = (run, t) => run.filter(x => x.t === t).map(x => x.v).join('');
      const [dB, aB, dA, aA] = [side(before, 'del'), side(before, 'add'), side(after, 'del'), side(after, 'add')];
      if (_WORD_END.test(dB) && _WORD_END.test(aB) && _WORD_START.test(dA) && _WORD_START.test(aA)) {
        out.length = b;
        out.push({ t: 'del', v: `${dB}-${dA}` }, { t: 'add', v: `${aB}-${aA}` });
        k = e - 1;
        continue;
      }
    }
    out.push(p);
  }
  return out;
}
