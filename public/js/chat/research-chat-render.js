// Pure Renderer für den Recherche-Chat: nimmt eine Assistant-Nachricht mit
// `<cite index="N-…">TEXT</cite>`-Markern + die Trefferdokumente und liefert
// HTML mit klickbaren Quell-Superscripts. Aus research-chat.js extrahiert, damit
// die Marker-Logik (Sentinels, Regex-Pässe, Index-Auflösung) Unit-testbar ist —
// Alpine-Key `renderChatMarkdown`/`escHtml`/`t` werden injiziert, kein glob-Import.
//
// Konsument: research-chat.js#_renderResearchAnswer delegiert dünn an
// renderResearchAnswer (Live-Export an der Alpine-Methode erhalten, Templates
// binden `this._renderResearchAnswer(msg)`).

// Private-Use-Sentinels für Inline-Zitatmarker: überleben escHtml + die
// Markdown-Transforms unverändert und werden NACH dem Render durch das
// Superscript-HTML ersetzt. Kollusionsfrei in echtem Chat-/Markdown-Text.
// Definiert per String.fromCharCode statt Literale, weil der Write/Lese-Weg
// PUA-Chars manchmal literal fallen lässt — so sind sie robust.
const CITE_OPEN = String.fromCharCode(0xE010);
const CITE_CLOSE = String.fromCharCode(0xE011);
// `<cite index="4-4,4-5">…</cite>` — das Modell schreibt diese Marker als
// Klartext in die final_answer-Antwort (claude.ai-Zitatformat). Die erste Zahl
// jedes Komma-Teils ist der Dokument-Index, die zweite ein Satz-Index (ignoriert).
const CITE_TAG_RE = /<cite\b[^>]*\bindex="([^"]*)"[^>]*>([\s\S]*?)<\/cite>/gi;
const CITE_INDEX_ONLY_RE = /<cite\b[^>]*\bindex="([^"]*)"[^>]*>/gi;
// `[3]` / `[1, 4]` — Belegformat des Suchwegs SearXNG (routes/jobs/research-web-tools.js):
// die Zahl ist das `nr` des Treffers, also derselbe 1-basierte Index wie bei den
// cite-Markern. Kein `(` dahinter: `[3](url)` ist ein Markdown-Link, kein Beleg.
// Das Leerzeichen davor gehört dazu: der Marker hängt wie bei cite direkt am Wort.
const BRACKET_CITE_RE = /[ \t]*\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\](?!\()/g;

// Gilt das [n]-Format für diesen Text? Nur ohne cite-Marker — die Anthropic-
// Antwort bleibt unverändert, auch wenn sie zufällig «[2]» enthält.
function _usesBracketCites(text, sources) {
  return sources.length > 0 && !/<cite\b/i.test(text);
}

// Treffer-Nummern aus `[n]`-Belegen, nur gültige (1..Anzahl Treffer), distinkt.
function _bracketDocNums(inner, sources) {
  return parseCiteDocNums(inner).filter(n => n >= 1 && n <= sources.length);
}

// Dokument-Indizes aus einem `index="4-4,4-5"`-String: erste Zahl pro Komma-Teil
// (= Dokument), Satz-Index dahinter ignoriert. Distinkt, Reihenfolge erhalten.
export function parseCiteDocNums(idxStr) {
  const nums = [];
  for (const part of String(idxStr || '').split(',')) {
    const n = parseInt(part.trim(), 10); // parseInt stoppt am '-' → führende Zahl
    if (Number.isFinite(n) && !nums.includes(n)) nums.push(n);
  }
  return nums;
}

// 1-basiertes Mapping Modell-Index → gesammeltes Trefferdokument. Einzige Stelle
// der Basis-Annahme (falls je off-by-one, hier zentral korrigierbar).
export function resolveSource(sources, n) {
  return sources[n - 1] || null;
}

// Distinkte, in der Antwort tatsächlich zitierte Quellen — für die Quellenliste
// unter der Antwort. Sortiert nach Index, je URL nur einmal. Pure Variante der
// researchCitedSources-Alpine-Methode (Test + Konsument teilen sie sich).
export function citedSources(text, sources) {
  if (!sources.length) return [];
  const nums = [];
  let m;
  CITE_INDEX_ONLY_RE.lastIndex = 0;
  while ((m = CITE_INDEX_ONLY_RE.exec(text))) {
    for (const n of parseCiteDocNums(m[1])) if (!nums.includes(n)) nums.push(n);
  }
  if (_usesBracketCites(text, sources)) {
    BRACKET_CITE_RE.lastIndex = 0;
    while ((m = BRACKET_CITE_RE.exec(text))) {
      for (const n of _bracketDocNums(m[1], sources)) if (!nums.includes(n)) nums.push(n);
    }
  }
  nums.sort((a, b) => a - b);
  const seen = new Set();
  const out = [];
  for (const n of nums) {
    const src = resolveSource(sources, n);
    if (src && src.url && !seen.has(src.url)) {
      seen.add(src.url);
      out.push({ n, url: src.url, title: src.title || src.url });
    }
  }
  return out;
}

/**
 * Quellenliste unter der Antwort. Bevorzugt die vom Modell in `final_answer.quellen`
 * benannten, serverseitig gegen die Web-Treffer geprüften Belege
 * (`context_info.answer_sources`, nummeriert in ihrer Reihenfolge); ohne sie die
 * aus den cite-Markern abgeleitete Liste (Fallback, Nummer = Treffer-Index).
 */
export function displaySources(text, sources, answerSources) {
  if (Array.isArray(answerSources) && answerSources.length) {
    return answerSources
      .filter(s => s && s.url)
      .map((s, i) => ({ n: i + 1, url: s.url, title: s.title || s.url }));
  }
  return citedSources(text, Array.isArray(sources) ? sources : []);
}

// Platzhalter des Loops für „keine Antwort" (routes/jobs/agentic-chat.js). Mit
// Vorschlägen ist das kein Fehlschlag — Server-Pendant: research-chat-helpers.js.
const EMPTY_MARKERS = new Set(['__i18n:chat.errors.maxIterReached__', '__i18n:chat.errors.emptyAnswer__']);
export const PROPOSALS_ONLY_MARKER = '__i18n:recherche.chat.proposalsOnly__';

/** Antworttext, der angezeigt wird: leerer/Abbruch-Text + Vorschläge → eigener Hinweis. */
export function effectiveAnswerText(text, proposalCount) {
  const t = String(text || '').trim();
  if (proposalCount > 0 && (!t || EMPTY_MARKERS.has(t))) return PROPOSALS_ONLY_MARKER;
  return String(text || '');
}

/**
 * Rendert eine Assistant-Antwort in HTML. Ersetzt `<cite index="N-…">TEXT</cite>`
 * durch TEXT + klickbaren Superscript-Marker [N] (verlinkt auf das N-te Treffer-
 * dokument); ohne cite-Marker ebenso die `[N]`-Belege des Suchwegs SearXNG.
 * Ohne Quellen werden die Tags still entwrapt. Sentinels umgehen den
 * XSS-Escape von renderChatMarkdown; das injizierte HTML escaped url/title selbst.
 *
 * @param {object} opts
 * @param {string} opts.text        Text der Nachricht (oder `__i18n:key__`).
 * @param {Array}  opts.sources     Trefferdokumente (1-basiert, aus context_info).
 * @param {(s:string)=>string} opts.renderChatMarkdown  Markdown-Renderer (escaped).
 * @param {(s:string)=>string} opts.escHtml             XSS-Escape (nur für url/title).
 * @param {(key:string)=>string} [opts.t]                i18n-Resolver für `__i18n:`-Marker.
 * @returns {string} HTML-String.
 */
export function renderResearchAnswer({ text, sources, answerSources, proposalCount = 0, renderChatMarkdown, escHtml, t }) {
  const txt = effectiveAnswerText(text, proposalCount);
  const srcs = Array.isArray(sources) ? sources : [];
  const ans = Array.isArray(answerSources) ? answerSources.filter(a => a && a.url) : [];
  const i18nMatch = /^__i18n:([a-zA-Z0-9_.-]+)__$/.exec(txt);
  if (i18nMatch) {
    const resolved = t ? t(i18nMatch[1]) : i18nMatch[1];
    return renderChatMarkdown(resolved);
  }

  let transformed = txt.replace(CITE_TAG_RE, (_full, idxStr, inner) => {
    if (!srcs.length) return inner; // nichts zu verlinken → Tag entfernen
    const marks = parseCiteDocNums(idxStr)
      .map(n => `${CITE_OPEN}${n}${CITE_CLOSE}`).join('');
    return inner + marks;
  });
  // Defensiv: etwaige Rest-cite-Tags (ohne index / Fragmente) entwrappen.
  transformed = transformed.replace(/<\/?cite\b[^>]*>/gi, '');
  // Suchweg SearXNG: `[n]`-Belege auf denselben Marker-Pfad. Unbekannte Nummern
  // bleiben als Text stehen (nichts, worauf man verlinken könnte).
  if (_usesBracketCites(txt, srcs)) {
    transformed = transformed.replace(BRACKET_CITE_RE, (full, inner) => {
      const nums = _bracketDocNums(inner, srcs);
      return nums.length ? nums.map(n => `${CITE_OPEN}${n}${CITE_CLOSE}`).join('') : full;
    });
  }

  let html = renderChatMarkdown(transformed);
  html = html.replace(new RegExp(`${CITE_OPEN}(\\d+)${CITE_CLOSE}`, 'g'), (_s, nStr) => {
    const n = parseInt(nStr, 10);
    // Mit geprüften Belegen: Marker über die Treffer-Position (doc_nums) auf die
    // Nummer der Quellenliste abbilden, damit Text und Liste dieselbe Zahl tragen.
    if (ans.length) {
      const i = ans.findIndex(a => Array.isArray(a.doc_nums) && a.doc_nums.includes(n));
      if (i >= 0) {
        const a = ans[i];
        return `<sup class="chat-cite"><a href="${escHtml(a.url)}" target="_blank" rel="noopener noreferrer" data-tip="${escHtml(a.title || a.url)}">${i + 1}</a></sup>`;
      }
      // Zitierter Treffer, den das Modell nicht als Beleg benannt hat: verlinken,
      // aber ohne Nummer — sie gäbe es in der Liste nicht.
      const loose = resolveSource(srcs, n);
      if (loose && loose.url) {
        return `<sup class="chat-cite chat-cite--loose"><a href="${escHtml(loose.url)}" target="_blank" rel="noopener noreferrer" data-tip="${escHtml(loose.title || loose.url)}">↗</a></sup>`;
      }
      return '';
    }
    const src = resolveSource(srcs, n);
    if (src && src.url) {
      return `<sup class="chat-cite"><a href="${escHtml(src.url)}" target="_blank" rel="noopener noreferrer" data-tip="${escHtml(src.title || src.url)}">${n}</a></sup>`;
    }
    return `<sup class="chat-cite chat-cite--dim">${n}</sup>`;
  });
  return html;
}