'use strict';
// Prüfung EINER Seite — gemeinsamer Kern von Seiten-Lektorat (runCheckJob) und
// Buch-Lektorat (runBatchCheckJob): Kontext laden → Cache-Signatur → Cache oder
// KI-Analyse → Nachbearbeitung → History-Eintrag. Beide Jobs teilen damit
// Signatur, Prompt und Cache: eine Seite, die das Buch-Lektorat gerade geprüft
// hat, ist für das Seiten-Lektorat ein Cache-Treffer und umgekehrt.

const crypto = require('crypto');
const {
  db, getBookLocale, getBookSettings, getChapterFigures, getChapterFigureRelations, getChapterLocations,
  getPageMotifs,
  loadLektoratCache, saveLektoratCache,
} = require('../../db/schema');
const { getPrompts, getBookPrompts, htmlToTextForPrompt, contentHttpError } = require('./shared');
const contentStore = require('../../lib/content-store');
const { resolveProvider, effectiveProviderClass } = require('../../lib/ai');
const { narrativeLabels } = require('./narrative-labels');
const { effectiveTextsorte } = require('../../db/textsorte');
const { lektoratAnalyze, applyLektoratAiOverrides } = require('./lektorat-split');
const { lastParagraph, firstParagraph, findPreviousPage, findNextPage } = require('./lektorat-context');
const { finalizeFehler, effectiveStylisticCap, _runSig } = require('./lektorat-filter');
const userDictionary = require('../../db/user-dictionary');
const { MAX_PROMPT_WORDS, dictionaryWordsOnPage, dropDictionaryFindings } = require('./lektorat-dictionary');

function _sigHash(obj) {
  return crypto.createHash('sha1').update(JSON.stringify(obj ?? null)).digest('hex').slice(0, 12);
}

// Traegt die Seite Quellennachweise? Steuert den Beleg-Schutzblock im Prompt
// (siehe prompts/blocks.js#_buildBelegBlock). Indizierter Lookup auf dem
// abgeleiteten Fund-Index — in Buechern ohne Quellen kostenlos.
const _stmtHasCites = db.prepare('SELECT 1 AS x FROM source_citations WHERE page_id = ? LIMIT 1');
function _pageHasCitations(pageId) {
  try { return !!_stmtHasCites.get(parseInt(pageId, 10)); }
  catch { return false; }
}

// Letzter History-Eintrag dieser Seite (für History-Insert-Dedup).
const _lastPageCheckStmt = db.prepare(`
  SELECT id, errors_json FROM page_checks
   WHERE page_id = ? AND user_email IS ?
   ORDER BY checked_at DESC, id DESC
   LIMIT 1
`);
const _insertPageCheckStmt = db.prepare(`INSERT INTO page_checks
  (page_id, book_id, chapter_id, checked_at, error_count, errors_json, szenen_json, stilanalyse, fazit, model, user_email)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

// Lokale Provider (ollama/llama) bekommen einen deutlich abgespeckten Lektorat-Prompt:
// kein Nachbarseiten-Kontext (Seiten-Roundtrips gespart), keine Figuren-Beziehungen,
// kein POV-/Tempus-Block. Alle Einsparungen auch in public/js/prompts.js (_isLocal).
// Klassen-SSoT: lib/ai/config.js#effectiveProviderClass (openai-compat flippt via
// Cloud-Schalter auf 'cloud'). Am EFFEKTIVEN Provider dieses Users (KI-Profil vor
// globalem ai.provider) — an der Instanz-Einstellung gelesen bekaeme im
// Mischbetrieb der falsche User den abgemagerten Prompt.
const _isLocalProvider = (userEmail) => effectiveProviderClass(
  userEmail === undefined ? {} : { userEmail }
) === 'local';

// Lauf-Konstanten eines Jobs: alles, was für jede geprüfte Seite gleich ist.
async function prepareLektoratRun(bookId, userEmail, logger) {
  const prompts = await getPrompts(userEmail);
  const book = await getBookPrompts(bookId, userEmail);
  const effectiveProvider = resolveProvider({ userEmail });
  const { model, cacheSuffix } = applyLektoratAiOverrides(effectiveProvider, logger);
  const locale = bookId ? getBookLocale(bookId, userEmail) : 'de-CH';
  return {
    bookId, userEmail, prompts, effectiveProvider, model, locale,
    langCode: (locale || 'de-CH').split('-')[0],
    cacheVersion: `${model}:${prompts.PROMPTS_VERSION || ''}${cacheSuffix}`,
    system: book.SYSTEM_LEKTORAT_BLOCKS,
    stopwords: book.STOPWORDS,
    erklaerungRule: book.ERKLAERUNG_RULE,
    korrekturRegeln: book.KORREKTUR_REGELN,
    bookSettings: bookId ? getBookSettings(bookId, userEmail) : null,
    // Benutzer-Wörterbuch des prüfenden Users (Buch- + globale Einträge, passende
    // Locale) — dieselbe Menge, die den LanguageTool-Spellcheck filtert.
    dictSet: userDictionary.getCheckSet(userEmail, bookId, locale),
    local: _isLocalProvider(userEmail),
  };
}

// Absatz-Lader für Nachbarseiten mit Cache pro page_id ({ first, last }), damit
// das Buch-Lektorat dieselbe Seite nicht mehrfach lädt. Fehlschlag → null (kein
// Kontext, nicht kritisch). `htmlToTextForPrompt` ist Pflicht, nicht Geschmack:
// die Absatz-Helfer splitten auf `\n{2,}` – aus der einzeiligen Variante können
// sie keinen Absatz schneiden und liefern stattdessen 600 Zeichen Rohtext.
function makeNeighbourLoader() {
  const cache = new Map();
  const load = async (page) => {
    if (!page) return null;
    if (cache.has(page.id)) return cache.get(page.id);
    try {
      const t = htmlToTextForPrompt((await contentStore.loadPage(page.id)).html);
      const paras = { first: firstParagraph(t), last: lastParagraph(t) };
      cache.set(page.id, paras);
      return paras;
    } catch { return null; }
  };
  load.remember = (pageId, text) => cache.set(pageId, { first: firstParagraph(text), last: lastParagraph(text) });
  return load;
}

// Erlaubte Fehlertypen. SSoT ist das Buchtyp-Profil in
// public/js/prompts/lektorat-typen.js – dieselbe Funktion, die das Typ-Enum des
// Prompts baut. Damit kann der Server nie mehr Typen akzeptieren, als der Prompt
// überhaupt angefragt hat.
function _validTypen(run, textsorte) {
  return new Set(run.prompts.lektoratTypen(run.bookSettings?.buchtyp || null, { local: run.local, textsorte }));
}

// Prüft eine Seite. `pages` = Seitenliste des Buchs (für Nachbarseiten), null
// ohne Buchkontext. `neighbourParas` aus makeNeighbourLoader(). `chapterNameOf`
// liefert den Kapitelnamen zu einer chapter_id. `fromPct`/`toPct` nur beim
// Seiten-Lektorat (feiner Fortschritt über die Teil-Calls); der Batch steuert den
// Balken über den Seitenzähler.
// Rückgabe: { empty: true } oder { pd, html, fehler, szenen, stilanalyse, fazit,
//   checkId, historyDedup, cached }.
async function checkOnePage(run, {
  jobId, tok, pageId, pages = null, neighbourParas = null, chapterNameOf = () => null,
  fromPct = null, toPct = null, onCacheHit = null,
}) {
  const { bookId, userEmail, local, bookSettings, locale, langCode } = run;
  const pd = await contentStore.loadPage(pageId).catch(e => { throw contentHttpError(e); });
  const html = pd.html;
  // Absatz-erhaltende Variante statt des kompakten `htmlToText`:
  // die Dialogformat-Regel „Sprecherwechsel → neuer Absatz" prüft gegen
  // Absatzgrenzen, die hier als `\n\n` sichtbar bleiben — die kompakte
  // Variante ebnet jede Grenze ein, so dass jeder Sprecherwechsel als
  // fehlender Umbruch gemeldet wird. Frontend findInHtml/replaceInHtml
  // normalisieren `\s+` → ' ' beim Match, so dass `\n\n` in `original`
  // sicher ist (und cross-block-Ersetzungen schon durch die Block-Grenze
  // des Merge-Guards abgewiesen werden).
  const text = htmlToTextForPrompt(html).trim();
  if (!text) return { empty: true, pd };

  // Kapitelkontext: Figuren, Beziehungen, Schauplätze (falls Komplettanalyse
  // gelaufen ist), geplante Soll-Motive. Lokale Provider: Beziehungen und Motive
  // weglassen – die Prompt-Blöcke werden für _isLocal ohnehin gedroppt.
  const figuren            = bookId ? getChapterFigures(bookId, pd.chapter_id, userEmail) : [];
  const figurenBeziehungen = (!local && bookId) ? getChapterFigureRelations(bookId, pd.chapter_id, userEmail) : [];
  const orte               = bookId ? getChapterLocations(bookId, pd.chapter_id, userEmail) : [];
  const motive             = (!local && bookId) ? getPageMotifs(bookId, pd.chapter_id, pageId, userEmail) : [];
  // Quellennachweise: auch lokal relevant (kleine Modelle korrigieren
  // Klammer-Einschuebe besonders gern weg).
  const hatBelege          = _pageHasCitations(pageId);
  const chapterName        = pd.chapter_id ? (chapterNameOf(pd.chapter_id) || null) : null;
  // Wörterbuch-Wörter dieser Seite: Prompt-Liste + Backstop (lektorat-dictionary.js).
  const woerterbuch        = dictionaryWordsOnPage(run.dictSet, text);

  // Nachbarseiten: letzter Absatz der Vorseite, erster der Folgeseite als
  // Lesekontext. Lokale Provider: komplett überspringen – der Block wird für
  // _isLocal im Prompt ohnehin gedroppt.
  let previousExcerpt = null;
  let nextExcerpt = null;
  if (!local && pages && neighbourParas) {
    neighbourParas.remember?.(pageId, text);
    const [prev, next] = await Promise.all([
      neighbourParas(findPreviousPage(pages, pageId, pd.chapter_id)),
      neighbourParas(findNextPage(pages, pageId, pd.chapter_id)),
    ]);
    previousExcerpt = prev?.last || null;
    nextExcerpt = next?.first || null;
  }
  const neighbour = { text, excerpts: [previousExcerpt, nextExcerpt] };

  // Geltende Textsorte der Seite (Override vor Buch-Default). Ausserhalb des
  // journalistischen Profils bleibt sie null und aendert nichts.
  const textsorte = effectiveTextsorte(pageId, bookSettings);
  const validTypen = _validTypen(run, textsorte);

  // Cache nur mit bookId (FK auf books). Die Signatur deckt alle Inputs ab, die
  // den Output formen: Seitentext, Kapitelkontext, Erzähl-/Buchtyp-Labels (der
  // Buchtyp wählt das Fehlertyp-Profil), Textsorte (schneidet das Typ-Set im
  // journalistischen Profil), Stil-/Regel-Strings, Nachbarauszüge, Modell/Prompt-
  // Version und die Lauf-Parameter aus _runSig.
  const ctxSig = bookId ? _sigHash({
    upd: pd.updated_at || '',
    text_sha: crypto.createHash('sha1').update(text).digest('hex').slice(0, 16),
    fig: figuren, ort: orte, bez: figurenBeziehungen, mot: motive,
    nar: narrativeLabels(bookSettings),
    ts: textsorte,
    sw: run.stopwords, er: run.erklaerungRule, kr: run.korrekturRegeln,
    stp: bookSettings?.stilprofil || '',
    pe: previousExcerpt, ne: nextExcerpt, cn: chapterName, pn: pd.name, cv: run.cacheVersion, lc: langCode,
    bl: hatBelege,
    // Nur gesetzt, wenn die Seite Wörterbuch-Wörter trägt: ein leeres `wb` würde
    // jede bestehende Cache-Zeile ohne Grund invalidieren.
    ...(woerterbuch.length ? { wb: woerterbuch } : {}),
    ..._runSig(local, text.length),
  }) : null;
  // Nachbearbeitung für frische und gecachte Ergebnisse, plus Wörterbuch-Backstop
  // (greift auch für Wörter jenseits von MAX_PROMPT_WORDS, die der Prompt nicht sah).
  const finalize = (fehler) => dropDictionaryFindings(finalizeFehler(fehler, locale, validTypen, neighbour), woerterbuch);
  const cached = ctxSig ? loadLektoratCache(bookId, userEmail, pageId, ctxSig, run.effectiveProvider) : null;

  let result;
  if (cached) {
    onCacheHit?.();
    result = cached;
    // Re-Validate + Dedup auf dem Cache-Pfad: ältere Cache-Rows können Duplikate,
    // das tote `kontext`-Feld oder 1:1-Vorschläge (== Original) enthalten.
    if (Array.isArray(result?.fehler)) result.fehler = finalize(result.fehler);
  } else {
    result = await lektoratAnalyze({
      jobId, tok, text, local, prompts: run.prompts, system: run.system,
      buchtyp: bookSettings?.buchtyp || null,
      fromPct, toPct,
      promptOpts: {
        stopwords: run.stopwords,
        erklaerungRule: run.erklaerungRule,
        korrekturRegeln: run.korrekturRegeln,
        figuren, figurenBeziehungen, orte, motive, hatBelege,
        woerterbuch: woerterbuch.slice(0, MAX_PROMPT_WORDS),
        // Wirksame Obergrenze skaliert mit der Textlänge – derselbe Wert wie im Backstop.
        stylisticCap: effectiveStylisticCap(text.length),
        pageName: pd.name, chapterName,
        ...narrativeLabels(bookSettings),
        textsorte,
        previousExcerpt, nextExcerpt,
        langCode,
      },
    });
    result.fehler = finalize(result.fehler);
    if (ctxSig) saveLektoratCache(bookId, userEmail, pageId, ctxSig, result, run.effectiveProvider);
  }

  const fehler = result.fehler || [];
  const szenen = Array.isArray(result?.szenen) ? result.szenen : [];
  const errorsJson = JSON.stringify(fehler);

  // History-Insert-Dedup: gleicher errors_json wie jüngster Eintrag → kein neuer Row.
  // Verhindert wiederholte "Prüfen"-Klicks ohne Page-Edit, die identische Findings
  // produzieren (typisch bei Cache-HIT).
  const lastCheck = _lastPageCheckStmt.get(parseInt(pageId, 10), userEmail || null);
  const historyDedup = !!(lastCheck && lastCheck.errors_json === errorsJson);
  const checkId = historyDedup
    ? lastCheck.id
    : _insertPageCheckStmt.run(parseInt(pageId, 10), parseInt(bookId, 10) || null, pd.chapter_id || null,
      new Date().toISOString(), fehler.length, errorsJson,
      szenen.length > 0 ? JSON.stringify(szenen) : null,
      result.stilanalyse || null, result.fazit || null, run.model, userEmail || null).lastInsertRowid;

  return {
    pd, html, fehler, szenen,
    stilanalyse: result.stilanalyse || null,
    fazit: result.fazit || null,
    checkId, historyDedup, cached: !!cached,
  };
}

module.exports = { prepareLektoratRun, makeNeighbourLoader, checkOnePage };
