'use strict';
// Schulweg-Vorschlag (Job `schulweg-vorschlag`, docs/figur-lebenslauf.md
// «Schullaufbahn»): schlägt je Figur einen Weg des Buch-Schulsystems vor und
// sammelt ausdrückliche Klassenangaben («1999 war Anna in der 3. Bez») — beides
// mit wörtlichem Beleg aus dem Text.
//
// DREI SCHICHTEN wie bei der Alters-Analyse (routes/jobs/figur-alter.js):
//   1. deterministisch: Sätze, in denen die Figur (bzw. als einzige im Satz davor)
//      und ein Schulbegriff vorkommen (SCHOOL_RE), gekappt; starke Begriffe (Bez,
//      Kanti, Matur …) vor schwachen (Klasse, Schule …), dann über das Buch verteilt.
//   2. das Modell: welcher der ERLAUBTEN Weg-Keys ist belegt (Schema-Enum pro Buch),
//      und welche Klassenangaben mit Jahreszahl stehen im Text.
//   3. deterministisch: Zitat in der genannten (sonst einer) Stelle der Figur
//      nachschlagen, Schulbegriff im Zitat, Einschulungsjahr nur mit der Jahreszahl
//      im Zitat und nahe am Einschulungsalter, Repetition nur mit Repetitionswort,
//      Klassenangabe nur mit Jahr UND Klassennummer im Zitat. Unbelegtes fällt
//      heraus und wird gezählt.
//
// SCHREIBT NUR `figure_school_paths.vorschlag_json` und `klassenangaben_json`.
// Figuren mit Autor-Schulweg (source 'autor') bekommen keinen Weg-Vorschlag, aber
// ihre Klassenangaben — gerade dort ist ein Widerspruch zum Text ein Befund. Ob
// eine Angabe der Rechnung widerspricht, entscheidet das Lesen
// (school-path.js#pruefeKlassenangabe), damit ein später geänderter Weg sofort
// neu bewertet wird; das Job-Ergebnis zählt die Widersprüche dieses Stands.

const express = require('express');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError, jsonBody, jobAbortControllers,
  aiCall, getPrompts, getBookPrompts,
  loadOrderedBookContents, loadPageContents, htmlToTextForPrompt,
  chunkLimitsFor, tps, bundleBlocks,
  startBookJob, komplettRunningPrecheck,
  applyTierAiOverrides,
} = require('./shared');
const { resolveProvider } = require('../../lib/ai');
const { getBookSettings, getBookSchulsystem } = require('../../db/book-settings');
const { activeBookSchulsystem } = require('../../lib/buchtyp');
const { listFiguresForSchoolPath, setSchoolPathJobErgebnis } = require('../../db/figure-school-paths');
const { resolveBirthsForFigures } = require('../../lib/figure-birth');
const { buildFigureNamePatterns } = require('../../lib/page-index');
const { buildNameIndex, foldWord } = require('../../lib/figure-age');
const stellenLib = require('./shared/figure-stellen');
const { schoolPath } = require('../../lib/esm-bridge');
const { schoolLabel } = require('../../lib/school-labels');

// Schulbegriffe (CH + DE). Wortanfang umlaut-sicher; Endungen frei („Bezirksschüler",
// „Gymnasiastin"). Kurzformen nur mit Wortende, sonst trifft „Sek" die Sekunde.
// STARK benennt eine Schulart oder einen Abschluss, SCHWACH nur, dass es um Schule geht.
const _SCHOOL_STARK = 'Bez(?![A-Za-zäöü])|Bezirksschul|Bezirkssch|Kanti|Kantonsschul|Gymi|Gymnasi|Matur|Abitur|Abi(?![A-Za-zäöü])'
  + '|Primar|Grundschul|Sek(?![A-Za-zäöü])|Seki(?![A-Za-zäöü])|Sekundarschul|Realschul|Hauptschul|Oberschul|Oberstufe'
  + '|Untergym|Obergym|Kindergarten|Kindsgi|eingeschult|Einschulung|Lehre(?![rn])|Lehrling|Lehrstelle|Lehrjahr'
  + '|Berufsschul|repetier|sitzengeblieben|sitzenbleib|Ehrenrunde';
const _SCHOOL_SCHWACH = 'Klasse|Ausbildung|Schulzeit|Schulweg|Schule';
const _B = '(?<![A-Za-zÄÖÜäöüß])';
const SCHOOL_RE = new RegExp(`${_B}(?:${_SCHOOL_STARK}|${_SCHOOL_SCHWACH})`, 'iu');
const SCHOOL_STARK_RE = new RegExp(`${_B}(?:${_SCHOOL_STARK})`, 'iu');
const REPETITION_RE = /repetier|wiederhol|sitzen ?(?:ge)?blieb|sitzenbleib|ehrenrunde/i;

// Ordinalzahl-Stämme für Klassenangaben in Worten («in der dritten Klasse»).
const ORDINAL_STAEMME = ['erst', 'zweit', 'dritt', 'viert', 'fünft', 'sechst', 'siebt', 'acht', 'neunt', 'zehnt', 'elft', 'zwölft'];

const MAX_STELLEN_PRO_FIGUR = 8;
const MAX_KLASSENANGABEN_PRO_FIGUR = 6;
const MIN_ZITAT_CHARS = 8;
const BUNDLE_SHARE = 0.5;
// Antwort-Deckel des KI-Calls und geschätzte Antwort je Figur: ein Weg-Vorschlag
// (Zitat + Begründung) ~150 Tokens, jede Stelle kann eine Klassenangabe tragen.
// Bündel bis OUT_SHARE des Deckels, damit der Call nicht am Cap reisst (Prod
// 2026-10: ein Bündel mit 30 Figuren riss).
const MAX_OUT_TOKENS = 4000;
const OUT_SHARE = 0.6;
const OUT_TOK_PRO_FIGUR = 120;
const OUT_TOK_PRO_STELLE = 25;
// Einschulungsjahr aus dem Text: höchstens so weit vom eingestellten
// Einschulungsalter entfernt (Rückstellung, früh eingeschult).
const EINSCHULUNG_TOLERANZ = 2;

/** Kandidatensätze je Figur mit Schulbegriff (geteilte Mechanik: shared/figure-stellen.js). */
function collectStellen(pageTexts, nameIndex) {
  return stellenLib.collectStellen(pageTexts, nameIndex, SCHOOL_RE);
}

/** Stellen einer Figur: starke Schulbegriffe zuerst, über das Buch verteilt. */
function pickStellen(list, max = MAX_STELLEN_PRO_FIGUR) {
  return stellenLib.pickStellen(list, max, SCHOOL_STARK_RE);
}

/** Zitat prüfen: lang genug, in einer Stelle der Figur, mit Schulbegriff. */
function _belegtesZitat(v, ctx) {
  const zitat = typeof v?.zitat === 'string' ? v.zitat.trim() : '';
  if (zitat.length < MIN_ZITAT_CHARS) return null;
  const treffer = stellenLib.findeStelle(zitat, ctx.stellen, v.stelle, ctx.figIndex ?? -1);
  if (!treffer || !SCHOOL_RE.test(zitat)) return null;
  return { zitat, treffer };
}

/** Schicht 3: Vorschlag prüfen. Liefert { vorschlag } oder { verworfen: grund }. */
function verifyVorschlag(v, ctx) {
  const { system, sp, geburtsjahr } = ctx;
  const weg = typeof v?.weg === 'string' ? v.weg : '';
  if (!sp.wegKeys(system).includes(weg)) return { verworfen: 'weg' };
  const beleg = _belegtesZitat(v, ctx);
  if (!beleg) return { verworfen: 'zitat' };
  const { zitat, treffer } = beleg;

  const vorschlag = {
    weg,
    zitat: zitat.slice(0, 400),
    page_id: treffer.page_id ?? null,
    begruendung: typeof v.begruendung === 'string' ? v.begruendung.trim().slice(0, 400) : null,
  };
  const ej = Number(v.einschulung_jahr);
  const alter = system.einschulungsalter;
  if (Number.isInteger(ej) && zitat.includes(String(ej))
      && (geburtsjahr == null || Math.abs(ej - geburtsjahr - alter) <= EINSCHULUNG_TOLERANZ)) {
    vorschlag.einschulung_jahr = ej;
  }
  if (v.repetition_stufe && REPETITION_RE.test(zitat)) {
    const [rep] = sp.normalizeRepetitionen([{ stufe: v.repetition_stufe, klasse: v.repetition_klasse }], system, weg);
    if (rep) vorschlag.repetition = rep;
  }
  return { vorschlag };
}

/** Klassennummer im Zitat: als Ziffer («3. Bez», «3. Klasse») oder als Wort
 *  («dritten Klasse»). */
function _klasseImZitat(zitat, klasse) {
  if (new RegExp(`(?<![0-9])${klasse}(?![0-9])`).test(zitat)) return true;
  const stamm = ORDINAL_STAEMME[klasse - 1];
  return !!stamm && new RegExp(`${_B}${stamm}(?:e[nrms]?)(?![A-Za-zäöüß])`, 'iu').test(zitat);
}

/** Schicht 3 für Klassenangaben: Jahr und Klassennummer müssen im Zitat stehen,
 *  die Stufe im System. Liefert { angabe } oder { verworfen: grund }. */
function verifyKlassenangabe(k, ctx) {
  const { system } = ctx;
  const jahr = Number(k?.jahr), klasse = Number(k?.klasse);
  const stufe = typeof k?.stufe === 'string' ? k.stufe : '';
  if (!system.stufen[stufe] || !Number.isInteger(klasse) || klasse < 1 || klasse > 15) return { verworfen: 'klasse' };
  if (!Number.isInteger(jahr) || jahr < 1000 || jahr > 2999) return { verworfen: 'klasse' };
  const beleg = _belegtesZitat(k, ctx);
  if (!beleg) return { verworfen: 'zitat' };
  const { zitat, treffer } = beleg;
  if (!zitat.includes(String(jahr)) || !_klasseImZitat(zitat, klasse)) return { verworfen: 'klasse' };
  const monat = Number(k.monat);
  return {
    angabe: {
      jahr,
      ...(Number.isInteger(monat) && monat >= 1 && monat <= 12 ? { monat } : {}),
      stufe, klasse,
      zitat: zitat.slice(0, 400),
      page_id: treffer.page_id ?? null,
    },
  };
}

const _parseReps = (json) => { try { return JSON.parse(json || '[]') || []; } catch { return []; } };

/** Entspricht der Vorschlag dem, was die Figur schon hat? Dann ist er kein
 *  Vorschlag, nur Wiederholung des übernommenen Stands. */
function _schonUebernommen(v, f) {
  if (!f.source || v.weg !== f.weg) return false;
  if (v.einschulung_jahr != null && v.einschulung_jahr !== f.einschulung_jahr) return false;
  if (v.repetition && !_parseReps(f.repetitionen_json).some(r => r.stufe === v.repetition.stufe && r.klasse === v.repetition.klasse)) return false;
  return true;
}

async function runSchulwegVorschlagJob(jobId, bookId, userEmail, { nachKatalog = false } = {}) {
  const logger = makeJobLogger(jobId);
  // Stufe «leicht» (shared/model-tier.js) — vor chunkLimitsFor, die liest das Bag-Modell.
  applyTierAiOverrides(jobId, 'schulweg-vorschlag', resolveProvider({ userEmail }), logger);
  const { buildSchulwegSystemPrompt, buildSchulwegPrompt, buildSchulwegSchema } = await getPrompts(userEmail);
  const { perChunk: PER_CHUNK_LIMIT } = chunkLimitsFor(resolveProvider({ userEmail }));

  try {
    const signal = () => jobAbortControllers.get(jobId)?.signal;
    const throwIfAborted = () => {
      if (signal()?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    };

    updateJob(jobId, { statusText: 'job.phase.schulwegCollect', progress: 4 });
    const sp = await schoolPath();
    const system = sp.resolveSchulsystem(await activeBookSchulsystem(bookId));
    if (!system) {
      // Von der Komplettanalyse eingereiht: «nichts zu tun» ist kein Fehler des Users.
      if (nachKatalog) return completeJob(jobId, { skipped: 'job.error.schulwegNoSystem' });
      throw i18nError('job.error.schulwegNoSystem');
    }
    const lang = getBookSettings(bookId, userEmail)?.language || 'de';

    // Gefragt werden Figuren, deren Schulstufe sich rechnen lässt: mit Geburt oder
    // mit Einschulungs-Override. Figuren mit Autor-Schulweg nur nach Klassenangaben.
    const alle = listFiguresForSchoolPath(bookId, userEmail);
    const births = resolveBirthsForFigures(bookId, userEmail, alle);
    const figuren = [];
    let ohneJahr = 0, autor = 0;
    for (const f of alle) {
      const birth = births.get(f.id) || null;
      if (!birth && f.einschulung_jahr == null) { ohneJahr++; continue; }
      if (f.source === 'autor') autor++;
      figuren.push({ ...f, geburt: birth, geburtsjahr: birth?.y ?? null });
    }
    if (!figuren.length) {
      // Von der Komplettanalyse eingereiht: «nichts zu tun» ist kein Fehler des Users.
      if (nachKatalog) return completeJob(jobId, { skipped: 'job.error.schulwegNoFiguren' });
      throw i18nError('job.error.schulwegNoFiguren');
    }

    const { chMap, pages } = await loadOrderedBookContents(bookId);
    const contents = await loadPageContents(pages, chMap, 1, null, signal(), { keepHtml: true });
    const pageTexts = contents.filter(p => p.html || p.text)
      .map(p => ({ page_id: p.id, text: htmlToTextForPrompt(String(p.html || p.text || '').replace(/\s+/g, ' ')) }));
    throwIfAborted();

    const nameIndex = buildNameIndex(figuren.map(f => ({ id: f.id, patterns: buildFigureNamePatterns(f.name, f.kurzname, f.weitere_namen) })));
    const byFig = nameIndex ? collectStellen(pageTexts, nameIndex) : new Map();
    const blocks = figuren
      .map(f => ({ fig: f, stellen: pickStellen(byFig.get(f.id) || []) }))
      .filter(b => b.stellen.length)
      .map(b => ({
        ...b,
        chars: b.stellen.reduce((n, s) => n + s.satz.length, 0) + 60,
        outEst: OUT_TOK_PRO_FIGUR + b.stellen.length * OUT_TOK_PRO_STELLE,
      }));

    // Modell bekommt Wege und Stufen in der Buchsprache, gelesen aus den Locale-Dateien.
    const stufenKeys = Object.keys(system.stufen);
    const wege = system.wege.map(w => ({
      key: w.key,
      label: schoolLabel(sp.wegLabelKey(w.key), lang),
      stufen: w.stufen.map(s => schoolLabel(sp.stufeLabelKey(s), lang)),
    }));
    const stufen = stufenKeys.map(k => ({ key: k, label: schoolLabel(sp.stufeLabelKey(k), lang) }));
    const schema = buildSchulwegSchema(sp.wegKeys(system), stufenKeys);
    const systemPrompt = buildSchulwegSystemPrompt();
    const { BUCH_KONTEXT } = await getBookPrompts(bookId, userEmail);

    const queue = bundleBlocks(blocks, {
      charBudget: Math.max(4000, Math.floor(PER_CHUNK_LIMIT * BUNDLE_SHARE)),
      outBudget: MAX_OUT_TOKENS * OUT_SHARE,
    });

    // Name → Figur. Kurzname nur, wenn eindeutig (wie bei der Alters-Analyse).
    const shortCount = new Map();
    for (const f of figuren) { const k = foldWord(f.kurzname); if (k) shortCount.set(k, (shortCount.get(k) || 0) + 1); }
    const nameLookup = new Map();
    for (const f of figuren) { const k = foldWord(f.name); if (k && !nameLookup.has(k)) nameLookup.set(k, f); }
    for (const f of figuren) { const k = foldWord(f.kurzname); if (k && shortCount.get(k) === 1 && !nameLookup.has(k)) nameLookup.set(k, f); }

    const tok = { in: 0, out: 0, ms: 0 };
    const verworfen = { weg: 0, zitat: 0, figur: 0, klasse: 0 };
    const vorschlaege = new Map();
    const klassenangaben = new Map();
    let schonUebernommen = 0;
    const AI_FROM = 15, AI_TO = 92;
    let done = 0;
    logger.info(`Schulweg-Vorschlag Start: book=${bookId} figuren=${figuren.length} mitStellen=${blocks.length} stellen=${blocks.reduce((n, b) => n + b.stellen.length, 0)} buendel=${queue.length} ohneJahr=${ohneJahr} autor=${autor}`);

    while (queue.length) {
      throwIfAborted();
      const bundle = queue.shift();
      const total = done + queue.length + 1;
      updateJob(jobId, { statusText: 'job.phase.schulwegAsk', statusParams: { done: done + 1, total }, progress: AI_FROM + Math.floor((done / total) * (AI_TO - AI_FROM)) });
      const ctxOf = new Map(bundle.map((b, i) => [b.fig.id, { stellen: b.stellen, figIndex: i, system, sp, geburtsjahr: b.fig.geburtsjahr }]));
      let result;
      try {
        result = await aiCall(jobId, tok,
          buildSchulwegPrompt({
            wege, stufen, buchKontext: BUCH_KONTEXT,
            figuren: bundle.map(b => ({
              name: b.fig.name,
              geburtsjahr: b.fig.geburtsjahr,
              wegFest: b.fig.source === 'autor' ? schoolLabel(sp.wegLabelKey(sp.figurWeg(system, b.fig)), lang) : null,
              stellen: b.stellen.map(s => s.satz),
            })),
          }),
          systemPrompt,
          AI_FROM + Math.floor((done / total) * (AI_TO - AI_FROM)),
          AI_FROM + Math.floor(((done + 1) / total) * (AI_TO - AI_FROM)),
          3000, 0.25, MAX_OUT_TOKENS, undefined, schema,
        );
      } catch (e) {
        if (e?.message === 'job.error.aiTruncated' && bundle.length > 1) {
          const mid = Math.ceil(bundle.length / 2);
          queue.unshift(bundle.slice(0, mid), bundle.slice(mid));
          logger.warn(`Schulweg-Vorschlag: Bündel mit ${bundle.length} Figuren am Output-Cap abgeschnitten – wird geteilt.`);
          continue;
        }
        throw e;
      }
      if (!Array.isArray(result?.vorschlaege)) throw i18nError('job.error.schulwegMissing');
      for (const v of result.vorschlaege) {
        const fig = nameLookup.get(foldWord(v?.figur));
        if (!fig || !ctxOf.has(fig.id)) { verworfen.figur++; continue; }
        if (fig.source === 'autor' || vorschlaege.has(fig.id)) continue; // Autor hat entschieden; höchstens einer pro Figur
        const r = verifyVorschlag(v, ctxOf.get(fig.id));
        if (r.verworfen) { verworfen[r.verworfen]++; continue; }
        if (_schonUebernommen(r.vorschlag, fig)) { schonUebernommen++; continue; }
        vorschlaege.set(fig.id, r.vorschlag);
      }
      for (const k of (Array.isArray(result.klassenangaben) ? result.klassenangaben : [])) {
        const fig = nameLookup.get(foldWord(k?.figur));
        if (!fig || !ctxOf.has(fig.id)) { verworfen.figur++; continue; }
        const r = verifyKlassenangabe(k, ctxOf.get(fig.id));
        if (r.verworfen) { verworfen[r.verworfen]++; continue; }
        const list = klassenangaben.get(fig.id) || [];
        const dup = list.some(a => a.jahr === r.angabe.jahr && a.stufe === r.angabe.stufe && a.klasse === r.angabe.klasse);
        if (!dup && list.length < MAX_KLASSENANGABEN_PRO_FIGUR) list.push(r.angabe);
        klassenangaben.set(fig.id, list);
      }
      done++;
    }

    // Letzter Abbruch-Punkt vor dem Schreiben: ein Teilstand ersetzt keine Vorschläge.
    throwIfAborted();
    const stamp = new Date().toISOString();
    // Jede gefragte Figur bekommt den Stand DIESES Laufs: ein neuer Vorschlag oder
    // keiner, die Klassenangaben dieses Laufs — ein alter, nicht mehr belegter
    // Stand bliebe sonst stehen.
    let widersprueche = 0;
    for (const f of figuren) {
      const v = vorschlaege.get(f.id);
      const ka = klassenangaben.get(f.id) || [];
      setSchoolPathJobErgebnis(f.id, { vorschlag: v ? { ...v, created_at: stamp } : null, klassenangaben: ka });
      const figur = { weg: f.weg, einschulung_jahr: f.einschulung_jahr, repetitionen: _parseReps(f.repetitionen_json) };
      for (const angabe of ka) {
        if (sp.pruefeKlassenangabe({ geburt: f.geburt, system, figur, angabe })?.urteil === 'widerspruch') widersprueche++;
      }
    }
    const nAngaben = [...klassenangaben.values()].reduce((n, l) => n + l.length, 0);

    logger.info(`Schulweg-Vorschlag fertig: book=${bookId} vorschlaege=${vorschlaege.size} klassenangaben=${nAngaben} widersprueche=${widersprueche} schonUebernommen=${schonUebernommen} verworfen(weg=${verworfen.weg} zitat=${verworfen.zitat} figur=${verworfen.figur} klasse=${verworfen.klasse})`);
    completeJob(jobId, {
      figuren: figuren.length, mitStellen: blocks.length, vorschlaege: vorschlaege.size,
      klassenangaben: nAngaben, widersprueche, schonUebernommen,
      ohneJahr, autor, verworfen, tokensIn: tok.in, tokensOut: tok.out,
    }, tps(tok), `${vorschlaege.size}/${figuren.length}`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Schulweg-Vorschlag Fehler book=${bookId}: ${e.message}`, { stack: e.cause?.stack || e.stack });
    failJob(jobId, e);
  }
}

const schulwegVorschlagRouter = express.Router();

// 'editor': der Lauf legt Vorschläge an Figuren ab.
schulwegVorschlagRouter.post('/schulweg-vorschlag', jsonBody, (req, res) => startBookJob(req, res, {
  type: 'schulweg-vorschlag', minRole: 'editor', label: 'job.label.schulwegVorschlag',
  // Synchron (startBookJob wartet nicht): nur «gibt es eins»; den Buchtyp prüft der
  // Lauf selbst über activeBookSchulsystem. Läuft eine Komplettanalyse → 409.
  precheck: (bookId, userEmail) => (getBookSchulsystem(bookId)
    ? komplettRunningPrecheck(bookId, userEmail)
    : 'SCHULSYSTEM_MISSING'),
  run: (jobId, { bookId, userEmail }) => runSchulwegVorschlagJob(jobId, bookId, userEmail),
}));

module.exports = {
  schulwegVorschlagRouter, runSchulwegVorschlagJob,
  verifyVorschlag, verifyKlassenangabe, collectStellen, pickStellen, SCHOOL_RE,
};
