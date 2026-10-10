'use strict';
const { nameTokens, salutationGender } = require('../../../lib/name-normalize');

const crypto = require('crypto');

/** Reduziert KI-Ref (String oder {name,id,…}-Objekt) auf einen blanken Namen.
 *  KI liefert in figuren_namen/orte_namen/issue.figuren etc. gelegentlich Objekte
 *  statt Strings — ohne Normalisierung würde `[object Object]` durch die Pipeline
 *  laufen oder `n?.toLowerCase()` werfen. */
function _refToString(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') {
    const s = v.name || v.titel || v.label || v.fig_id || v.loc_id || v.id;
    return s ? String(s).trim() || null : null;
  }
  return null;
}

/** Passt der zu erwartende Output einer Konsolidierung noch unter das Output-Cap?
 *  Liefert `{ estOut, cap, fits }`; pure.
 *
 *  **Why:** Eine Konsolidierung schreibt die eingespeisten Felder praktisch vollständig
 *  zurück — dedupliziert zwar, ergänzt dafür JSON-Schlüssel und Anführungszeichen. Der
 *  Prompt ist damit der beste verfügbare Schätzer für die Antwortlänge. Reisst der Call
 *  am Cap, wirft `aiCall` `job.error.aiTruncated`, das ganze Ergebnis ist verloren und
 *  der Aufrufer fällt auf seinen regelbasierten Merge zurück — die Generierung ist zu
 *  dem Zeitpunkt aber bereits bezahlt. Bei einem lokalen Modell mit 20–30 tok/s sind
 *  das für ein 32K-Cap rund 20 Minuten für ein verworfenes Ergebnis. Vorher zu fragen
 *  ändert am ERGEBNIS nichts (derselbe Fallback), spart aber die Wartezeit — und macht
 *  im Log sichtbar, an welchem Wert es lag.
 *
 *  `reserve` (Default 0.9) hält Luft für den Schätzfehler in beide Richtungen. Bewusst
 *  grosszügig: ein fälschlich übersprungener Call kostet Qualität, ein fälschlich
 *  geführter nur Zeit — im Zweifel also lieber rufen. */
// `dataText`: nur die eingespeisten Daten (JSON der Figuren/Orte/Ereignisse) — DAS schreibt
// eine Konsolidierung zurück, nicht Schema, Regeln und Aufgabentext des Prompts. Ohne
// `dataText` wird der ganze Prompt geschätzt (Rückfall); das überschätzt um den statischen
// Teil und zwang kleine Kataloge unnötig auf den regelbasierten Fallback.
function consolidationFitsCap({ promptText, dataText, charsPerToken, cap, reserve = 0.9 }) {
  const cpt = Number(charsPerToken) > 0 ? Number(charsPerToken) : 4;
  const capN = Number(cap) > 0 ? Number(cap) : 0;
  const basis = dataText != null ? dataText : promptText;
  const estOut = Math.ceil(String(basis || '').length / cpt);
  // Ohne brauchbares Cap nicht raten — dann lieber rufen (bisheriges Verhalten).
  if (!capN) return { estOut, cap: capN, fits: true };
  return { estOut, cap: capN, fits: estOut <= capN * reserve };
}

/** Extrahiert ein Feld aus settledAll-Ergebnissen in das Kapitel-Array-Format. */
function extractField(settled, chunkTexts, field) {
  return settled.map((r, i) => ({
    kapitel: chunkTexts[i].chunk.name,
    [field]: r.status === 'fulfilled' ? (r.value?.[field] || []) : [],
  }));
}

/** Löst Klarnamen einer Entität (Song/Ort) gegen die kanonische Figurenliste zu fig_ids auf –
 *  identisches Muster wie remapSzenen (exakt, dann lowercase-Fallback). Nicht auflösbare
 *  Namen werden verworfen. Ergebnis dedupliziert. Songs UND Orte referenzieren Figuren über
 *  Namen (nicht fig_id), weil der Extraktions-Pass A1s ID-Namespace nicht teilt. */
function _remapFigNames(names, figNameToId, figNameToIdLower) {
  const out = [];
  const seen = new Set();
  for (const n of (names || [])) {
    const name = _refToString(typeof n === 'object' && n ? (n.name ?? n) : n);
    if (!name) continue;
    const id = figNameToId?.[name] || figNameToIdLower?.[name.toLowerCase()] || null;
    if (id && !seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}

/**
 * Baut den System-Block mit dem Buchtext, der über mehrere Claude-Calls gecached wird.
 * Byte-identische Formatierung in Phase 1 Pass A/B und Phase 8 Kontinuität,
 * damit der Cache-Prefix-Match greift (erster cache_control-Breakpoint).
 */
function buildBookSystemBlockText(bookName, pageCount, fullBookText) {
  return `Buch: «${bookName}»\n\nBuchtext (${pageCount} Abschnitte):\n\n${fullBookText}`;
}

/** Multi-Pass-Pendant zu buildBookSystemBlockText: der Kapiteltext eines Chunks als
 *  vorderster System-Block, damit Basis- und Gap-Pass desselben Chunks ihn aus dem
 *  Cache lesen statt ihn im User-Turn je Pass neu zu bezahlen. */
function buildChapterSystemBlockText(bookName, chapterName, pageCount, chText) {
  return `Buch: «${bookName}»\n\nKapitel «${chapterName}» (${pageCount} Abschnitte):\n\n${chText}`;
}

/**
 * Settings-Anteil der Cache-Signatur (language/region/buchtyp/buch_kontext).
 * SSoT für Single-Pass (buildBookPagesSig) UND Multi-Pass-Chunk-Keys: beide müssen
 * bei Buchtyp-/Kontext-Wechsel invalidieren, weil diese Settings via
 * getLocalePromptsForBook (Block «VORRANGIGE ANGABEN DES AUTORS») in den
 * Extraktions-Prompt fliessen und das Ergebnis verändern.
 */
function bookSettingsSigPart(bookSettings) {
  const s = bookSettings || {};
  return `${s.language || ''}:${s.region || ''}:${s.buchtyp || ''}:${s.buch_kontext || ''}`;
}

/**
 * Signatur aller Seiten eines Buchs für den Single-Pass-Cache der Phase 1.
 * Berücksichtigt page_id, page-updated_at, chapter_id, chapter-Name sowie
 * buchtyp/buch_kontext/language – ändert sich eins davon, wird der Cache
 * invalidiert, weil die entsprechenden Prompts andere Ergebnisse liefern.
 * `cacheVersion` (model+prompts-Version) hängt zusätzlich an, damit Modell-
 * oder Schema-Änderungen alte Caches automatisch invalidieren.
 */
function buildBookPagesSig(pageContents, bookSettings, cacheVersion) {
  const pagesPart = pageContents
    .map(p => `${p.id}:${p.updated_at || ''}|${p.chapter_id ?? ''}:${p.chapter ?? ''}`)
    .sort()
    .join('|');
  return `${pagesPart}||${bookSettingsSigPart(bookSettings)}||${cacheVersion || ''}`;
}

// Mindestgrösse eines Belegzitats. Kürzere «Zitate» (ein Kapitelname, ein Begriff,
// «Ja») taugen weder als Beleg noch als Fabrikations-Nachweis — sie gelten als «kein
// Zitat»: keine Beleg-Prüfung, keine Ortung über den Wortlaut.
const STELLE_QUOTE_MIN_CHARS = 12;
const STELLE_QUOTE_MIN_WORDS = 3;

// Zitat-Paare in Suchreihenfolge. Jedes gefundene Paar wird im Arbeitsstring maskiert,
// bevor die nächste Form sucht — sonst läse «“…”» das schliessende “ eines deutschen
// „…“ als Öffner, und «"…"» fände das Innere eines schon erkannten Zitats noch einmal.
// Die Guillemet-Richtung («…» vs. »…«, ‹…› vs. ›…‹) entscheidet das erste Zeichen im
// String; die Gegenrichtung fände sonst den Zwischenraum zweier Zitate («A» und «B»
// → «» und «»).
function _quotePairs(s) {
  const firstOf = (a, b) => {
    const ia = s.indexOf(a), ib = s.indexOf(b);
    if (ia < 0) return ib < 0 ? null : 'rev';
    return (ib < 0 || ia < ib) ? 'fwd' : 'rev';
  };
  const guil = firstOf('«', '»');
  const single = firstOf('‹', '›');
  const pairs = [];
  if (guil === 'fwd') pairs.push(/«([^«»]+)»/g); else if (guil === 'rev') pairs.push(/»([^«»]+)«/g);
  if (single === 'fwd') pairs.push(/‹([^‹›]+)›/g); else if (single === 'rev') pairs.push(/›([^‹›]+)‹/g);
  pairs.push(/„([^„“”]+)[“”]/g, /‚([^‚‘’]+)‘/g, /“([^“”„]+)”/g, /"([^"]+)"/g);
  return pairs;
}

// Ein Zitat, das direkt hinter «Kapitel»/«Abschnitt»/«Chapter»/«Teil» (ggf. mit Nummer,
// aber ohne Doppelpunkt) steht, ist vermutlich ein Kapitel-Titel («Kapitel «Die Flucht»:
// «Marek lag reglos»»). Weich: es zählt nur, wenn sonst kein Zitat bleibt — «Kapitel 3
// «Marek lag reglos …»» ohne Doppelpunkt ist ebenso denkbar.
const _TITLE_LEAD = /(?:kapitel|kap\.|abschnitt|unterkapitel|teil|chapter|ch\.|section|part)(?:\s+\d+)?\s*$/i;

function _normTitle(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Extrahiert das wörtliche Zitat aus einem stelle_a/stelle_b-String.
 *  Sammelt alle Zitat-Paare («…», »…«, „…“, “…”, "…", ‹…›, ›…‹, ‚…‘), verwirft
 *  Kapitel-Titel (direkt hinter «Kapitel …» bzw. gleich einem Namen aus `kapitel`) und
 *  Zitate unter der Mindestgrösse und nimmt das längste. Innere Zitate (ein „…“ in
 *  einem «…») schneiden das äussere nicht ab. Leer, wenn kein taugliches Zitat da ist.
 *  Geteilt von der Verify-Stufe (job-shared.js) und der Beleg-Prüfung beim Speichern
 *  (remap.js).
 *  @param {string} stelle
 *  @param {{kapitel?: string[]}} [opts]  Kapitelnamen des Befunds (Titel-Ausschluss) */
function _stelleQuote(stelle, { kapitel = null } = {}) {
  let work = String(stelle || '');
  if (!work) return '';
  const titles = new Set((kapitel || []).map(k => _normTitle(_refToString(k))).filter(Boolean));
  const quotes = [];
  const titleLike = [];
  for (const re of _quotePairs(work)) {
    const snapshot = work;
    work = work.replace(re, (whole, inner, offset) => {
      const text = inner.trim();
      // Exakter Kapitelname des Befunds: nie ein Beleg.
      if (!titles.has(_normTitle(text))) {
        (_TITLE_LEAD.test(snapshot.slice(0, offset)) ? titleLike : quotes).push(text);
      }
      return ' '.repeat(whole.length);
    });
  }
  const longest = (list) => {
    let best = '';
    for (const c of list) {
      if (c.length < STELLE_QUOTE_MIN_CHARS) continue;
      if (c.split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).length < STELLE_QUOTE_MIN_WORDS) continue;
      if (c.length > best.length) best = c;
    }
    return best;
  };
  return longest(quotes) || longest(titleLike);
}

/** Misst Wall-Clock pro Pipeline-Segment. `mark(label)` loggt die Dauer seit dem
 *  letzten Mark sofort (Live-Fortschritt + Lokalisierung, falls ein Job in einer
 *  Phase hängt) und sammelt sie für `summary()` (eine konsolidierte Zeile am
 *  Job-Ende). Date.now() konsistent mit _jobDurationFmt; Sekunden-Auflösung reicht
 *  für die mehrsekündigen Phasen. Parallel laufende Phasen (P2+P3, P6+P8) erscheinen
 *  als ein Segment mit ihrer gemeinsamen Wall-Clock-Dauer. */
function makePhaseTimer(log) {
  const segments = [];
  let last = Date.now();
  return {
    mark(label) {
      const now = Date.now();
      const secs = (now - last) / 1000;
      last = now;
      segments.push(`${label}=${secs.toFixed(1)}s`);
      log.info(`Phase «${label}» – ${secs.toFixed(1)}s`);
    },
    summary() { return segments.join(' '); },
  };
}

/** Führt eine nicht-kritische Phase aus – Fehler werden geloggt, nicht geworfen.
 *  Optionaler `warnings`-Sink + `warnKey`: bei Fehlschlag wird `{ key: warnKey }`
 *  gesammelt, damit die Degradierung im Job-Result user-sichtbar wird. */
async function runNonCritical(label, fn, log, { warnings = null, warnKey = null } = {}) {
  try {
    return await fn();
  } catch (e) {
    log.warn(`${label} fehlgeschlagen (ignoriert): ${e.message}`);
    if (warnings && warnKey) warnings.push({ key: warnKey });
    return null;
  }
}

/**
 * Baut Name→ID Lookup-Maps für konsolidierte Figuren.
 * Enthält kanonischen Namen, Kurznamen und Token-Fallback für Phase-1-Namen.
 * Wenn das Modell in Phase 1 einen anderen Namen verwendet als Phase 2
 * (z.B. nur Nachname, Titel+Name), wird per Token-Matching die eindeutig
 * passende Phase-2-Figur gesucht. Nur bei eindeutigem Match.
 */
function buildFigNameLookup(figuren, chapterFiguren, chapterAssignments, chapterSzenen, log, jobId, aliasMap = null) {
  // Vollnamen zuerst und erste-gewinnt; Kurznamen und im Merge aufgegangene Namen
  // (`__aliasNamen`, figuren-merge/dedup.js) erst danach und nur, wo kein Vollname
  // steht — sonst überschriebe der Kurzname «Anna» von «Anna Weber» die eigenständige
  // Figur «Anna».
  const nameToId = {};
  for (const f of figuren) {
    if (f.name && !(f.name in nameToId)) nameToId[f.name] = f.id;
  }
  for (const f of figuren) {
    for (const alt of [f.kurzname, ...(f.__aliasNamen || [])]) {
      if (alt && alt !== f.name && !(alt in nameToId)) nameToId[alt] = f.id;
    }
  }
  const nameToIdLower = {};
  for (const [k, v] of Object.entries(nameToId)) {
    const lk = k.toLowerCase();
    if (!(lk in nameToIdLower)) nameToIdLower[lk] = v;
  }
  // Alias-Cluster (F3): Namen, die auf einen kanonischen Namen vereinheitlicht wurden, weiter
  // auflösbar halten — sonst droppt eine Szene/Event, die noch den Alias-Namen trägt, im Remap.
  if (aliasMap) {
    for (const [aliasLower, canon] of Object.entries(aliasMap)) {
      const id = nameToId[canon] || nameToIdLower[String(canon).toLowerCase()];
      if (id && !nameToIdLower[aliasLower]) nameToIdLower[aliasLower] = id;
    }
  }

  // Geschlecht je Figur (Feld, sonst Anrede im Namen) — der Token-Fallback darf
  // «Frau Weber» nicht an «Herrn Weber» oder an die Tochter «Anna Weber» (weiblich, aber
  // ohne Anrede-Beleg) binden, nur weil sie das einzige «weber» im Katalog ist.
  const genderById = new Map();
  const _gKey = (g) => {
    const v = String(g || '').toLowerCase();
    if (/^(m|männlich|maennlich|male|mann)$/.test(v)) return 'm';
    if (/^(w|f|weiblich|female|frau)$/.test(v)) return 'f';
    return null;
  };
  for (const fig of figuren) genderById.set(fig.id, _gKey(fig.geschlecht) || salutationGender(fig.name) || null);

  function tryTokenFallback(name) {
    // KI liefert figur_name gelegentlich als Objekt statt String. Call-Sites
    // normalisieren via _refToString; dieser Guard macht den Helper zusätzlich
    // aufrufer-unabhängig robust (sonst würde name.toLowerCase() auf einem Objekt werfen
    // und den gesamten Job nach bereits gespeichertem Katalog killen).
    if (typeof name !== 'string') return;
    if (!name || nameToId[name] || nameToIdLower[name.toLowerCase()]) return;
    // Anrede/Titel zählen nicht als Namens-Token («Frau», «Herr», «Dr.»), sonst trüge
    // «Frau» allein einen Treffer. Die Anrede liefert stattdessen das Geschlecht.
    const tokens = new Set(nameTokens(name).filter(t => t.length > 2));
    if (!tokens.size) return;
    const wantGender = salutationGender(name);
    const seen = new Set();
    const matches = [];
    for (const [canon, fid] of Object.entries(nameToId)) {
      if (seen.has(fid)) continue;
      const canonTokens = nameTokens(canon).filter(t => t.length > 2);
      const overlap = canonTokens.filter(t => tokens.has(t)).length;
      if (!overlap) continue;
      // Nur der Nachname gemeinsam und eine Anrede im Namen: das Geschlecht muss belegt
      // passen. Ein einzelnes geteiltes Token ohne Anrede bindet nur, wenn es der ganze
      // gesuchte Name ist (Kurzform «Weber» → «Anna Weber»), nicht ein Teil davon.
      if (wantGender) {
        const g = genderById.get(fid);
        if (g !== wantGender) continue;
      } else if (overlap < 2 && tokens.size > 1) {
        continue;
      }
      seen.add(fid); matches.push(fid);
    }
    if (matches.length === 1) {
      nameToId[name] = matches[0];
      nameToIdLower[name.toLowerCase()] = matches[0];
      log.info(`Phase-1-Name «${name}» → ${matches[0]} (Token-Fallback)`);
    }
  }

  for (const { figuren: chFigs } of (chapterFiguren || []))
    for (const f1 of (chFigs || [])) tryTokenFallback(f1.name);
  for (const { assignments: chAss } of (chapterAssignments || []))
    for (const a of (chAss || [])) tryTokenFallback(_refToString(a?.figur_name));
  // Szenen-Namen ebenfalls einbeziehen: eine Szenenfigur «Gerold», die nur als
  // Teilname zu «Gerold Brunner» existiert, soll im Remap auflösen statt droppen.
  for (const { szenen: chSz } of (chapterSzenen || []))
    for (const s of (chSz || []))
      for (const n of (s?.figuren_namen || [])) tryTokenFallback(_refToString(n));

  return { figNameToId: nameToId, figNameToIdLower: nameToIdLower };
}

/** Coverage-Self-Audit (F2): wählt bis zu `n` gleichmässig über das Buch verteilte,
 *  nicht-leere Kapitel als Stichprobe und baut je Kapitel den Prüftext (auf
 *  `maxCharsPerChapter` gedeckelt — die Stichprobe misst Recall, nicht Vollextraktion).
 *  Deterministisch (kein Zufall) → reproduzierbar. Pure, testbar. */
function sampleChapters(groups, groupOrder, n, maxCharsPerChapter = 40000) {
  if (!groups || !groupOrder || n <= 0) return [];
  const nonEmpty = groupOrder.filter(k => {
    const g = groups.get(k);
    return g && (g.pages || []).some(p => (p.text || '').trim());
  });
  if (!nonEmpty.length) return [];
  const count = Math.min(n, nonEmpty.length);
  const idxs = new Set();
  for (let i = 0; i < count; i++) {
    idxs.add(Math.min(nonEmpty.length - 1, Math.floor((i + 0.5) * nonEmpty.length / count)));
  }
  return [...idxs].map(i => {
    const g = groups.get(nonEmpty[i]);
    let chText = (g.pages || []).map(p => `### ${p.title}\n${p.text}`).join('\n\n---\n\n');
    if (chText.length > maxCharsPerChapter) chText = chText.slice(0, maxCharsPerChapter);
    return { name: g.name, chText };
  });
}

/** Coverage-Self-Audit (F2): aggregiert die Per-Stichprobe-Ergebnisse zu einem Recall-Score
 *  = erkannte / (erkannte + fehlende). null, wenn die Stichprobe keine Entitäten enthielt.
 *  Pure, testbar. */
function computeCoverageScore(samples) {
  let erkannt = 0, fehlend = 0;
  const missFig = [], missOrt = [];
  for (const s of (samples || [])) {
    erkannt += (Number(s?.erkannte_figuren) || 0) + (Number(s?.erkannte_orte) || 0);
    const mf = (s?.fehlende_figuren || []).filter(Boolean);
    const mo = (s?.fehlende_orte || []).filter(Boolean);
    fehlend += mf.length + mo.length;
    missFig.push(...mf); missOrt.push(...mo);
  }
  const denom = erkannt + fehlend;
  return {
    score: denom > 0 ? Math.round((erkannt / denom) * 100) / 100 : null,
    erkannt, fehlend,
    missingFiguren: [...new Set(missFig)].slice(0, 20),
    missingOrte: [...new Set(missOrt)].slice(0, 20),
  };
}

/** Konsolidierungs-Checkpoint (F5): deterministische Signatur des assemblierten Phase-1-
 *  Katalogs + der konsolidierungs-relevanten Parameter. Ist sie unverändert, kann P2–P8
 *  (die teuren Konsolidierungs-/Urteil-Calls) übersprungen werden — der DB-Katalog ist dann
 *  bereits korrekt. `flags` enthält alles, was das Konsolidierungs-/Kontinuitäts-ERGEBNIS
 *  beeinflusst, aber NICHT in der Extraktion (cacheVersion) steckt (Konsolidierungs-Modell,
 *  Alias-/Attribut-Check-Toggles). JSON.stringify(chapters) ist bei Cache-HITs byte-stabil
 *  (genau der Fall, in dem das Short-Circuit greifen soll). Pure, testbar. */
function buildConsolidationSig(chapters, cacheVersion, flags = {}) {
  return crypto.createHash('sha256')
    .update(String(cacheVersion || ''))
    .update('|flags:' + JSON.stringify(flags))
    .update('|catalog:' + JSON.stringify(chapters || {}))
    .digest('hex');
}

module.exports = {
  _refToString, _remapFigNames, extractField, consolidationFitsCap,
  buildBookSystemBlockText, buildChapterSystemBlockText, buildBookPagesSig, bookSettingsSigPart,
  _stelleQuote, STELLE_QUOTE_MIN_CHARS, STELLE_QUOTE_MIN_WORDS,
  makePhaseTimer,
  runNonCritical, buildFigNameLookup,
  sampleChapters, computeCoverageScore, buildConsolidationSig,
};
