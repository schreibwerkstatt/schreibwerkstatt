'use strict';
// Schulweg-Vorschlag (Job `schulweg-vorschlag`, docs/figur-lebenslauf.md
// «Schullaufbahn»): schlägt je Figur einen Weg des Buch-Schulsystems vor — mit
// wörtlichem Beleg aus dem Text.
//
// DREI SCHICHTEN wie bei der Alters-Analyse (routes/jobs/figur-alter.js):
//   1. deterministisch: Sätze, in denen die Figur (bzw. im Satz davor) und ein
//      Schulbegriff vorkommen (SCHOOL_RE), gekappt und über das Buch verteilt.
//   2. das Modell: welcher der ERLAUBTEN Weg-Keys ist belegt (Schema-Enum pro Buch).
//   3. deterministisch: Zitat in den vorgelegten Stellen nachschlagen, Schulbegriff
//      im Zitat, Einschulungsjahr nur mit der Jahreszahl im Zitat, Repetition nur
//      mit Repetitionswort im Zitat. Unbelegtes fällt heraus und wird gezählt.
//
// SCHREIBT NUR `figure_school_paths.vorschlag_json`. Figuren, deren Schulweg der
// Autor gesetzt hat (source 'autor'), werden gar nicht erst gefragt; Weg,
// Einschulungsjahr und Repetitionen übernimmt erst der Autor per Knopf.

const express = require('express');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError, jsonBody, jobAbortControllers,
  aiCall, getPrompts, getBookPrompts,
  loadOrderedBookContents, loadPageContents, htmlToTextForPrompt,
  chunkLimitsFor, tps,
  startBookJob,
} = require('./shared');
const { resolveProvider } = require('../../lib/ai');
const { getBookSettings, getBookSchulsystem } = require('../../db/book-settings');
const { listFiguresForSchoolPath, setSchoolPathVorschlag } = require('../../db/figure-school-paths');
const { listFigureAges } = require('../../db/figure-ages');
const { birthCandidates, resolveBirth } = require('../../lib/figure-birth');
const { buildFigureNamePatterns } = require('../../lib/page-index');
const { buildNameIndex, figuresInText, splitSentences, trimSatz, foldWord } = require('../../lib/figure-age');
const { schoolPath } = require('../../lib/esm-bridge');
const { schoolLabel } = require('../../lib/school-labels');

// Schulbegriffe (CH + DE). Wortanfang umlaut-sicher; Endungen frei („Bezirksschüler",
// „Gymnasiastin"). Kurzformen nur mit Wortende, sonst trifft „Sek" die Sekunde.
const SCHOOL_RE = new RegExp(
  '(?<![A-Za-zÄÖÜäöüß])(?:'
  + 'Bez(?![A-Za-zäöü])|Bezirksschul|Bezirkssch|Kanti|Kantonsschul|Gymi|Gymnasi|Matur|Abitur|Abi(?![A-Za-zäöü])'
  + '|Primar|Grundschul|Sek(?![A-Za-zäöü])|Seki(?![A-Za-zäöü])|Sekundarschul|Realschul|Hauptschul|Oberschul|Oberstufe'
  + '|Untergym|Obergym|Kindergarten|Kindsgi|Klasse|eingeschult|Einschulung|Lehre(?![rn])|Lehrling|Lehrstelle|Lehrjahr'
  + '|Berufsschul|Ausbildung|repetier|sitzengeblieben|sitzenbleib|Ehrenrunde|Schulzeit|Schulweg|Schule'
  + ')', 'iu');
const REPETITION_RE = /repetier|wiederhol|sitzen ?(?:ge)?blieb|sitzenbleib|ehrenrunde/i;

const MAX_STELLEN_PRO_FIGUR = 8;
const SATZ_MAX = 320;
const MIN_ZITAT_CHARS = 8;
const BUNDLE_SHARE = 0.5;

const _norm = (s) => String(s ?? '').toLowerCase()
  .replace(/[«»„“”‚‘’"'`´]/g, '"').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();

/** Satz um den Schulbegriff auf SATZ_MAX kappen (an Wortgrenzen). */
function _clip(text) {
  const t = trimSatz(text);
  if (t.length <= SATZ_MAX) return t;
  const m = SCHOOL_RE.exec(t);
  const at = m ? m.index : 0;
  let start = Math.max(0, at - Math.floor(SATZ_MAX / 2));
  const sp = t.lastIndexOf(' ', start);
  if (sp > 0 && start - sp < 20) start = sp + 1;
  return t.slice(start, start + SATZ_MAX).replace(/\s\S*$/, '');
}

/** Gleichmässig über den Buchbogen verteilt auswählen (erste + letzte immer). */
function _spread(list, max) {
  if (list.length <= max) return list;
  const out = [];
  for (let i = 0; i < max; i++) out.push(list[Math.round((i * (list.length - 1)) / (max - 1))]);
  return [...new Set(out)];
}

/** Schicht 1: Kandidatensätze je Figur. */
function collectStellen(pageTexts, nameIndex) {
  const byFig = new Map();
  for (const { text, page_id } of pageTexts) {
    const sents = splitSentences(text);
    for (let i = 0; i < sents.length; i++) {
      const cur = sents[i].text;
      if (!SCHOOL_RE.test(cur)) continue;
      let ids = figuresInText(cur, nameIndex);
      let satz = cur;
      if (!ids.length && i > 0) {
        ids = figuresInText(sents[i - 1].text, nameIndex);
        satz = `${sents[i - 1].text} ${cur}`;
      }
      for (const id of ids) {
        if (!byFig.has(id)) byFig.set(id, []);
        byFig.get(id).push({ satz: _clip(satz), page_id });
      }
    }
  }
  return byFig;
}

/** Schicht 3: Vorschlag prüfen. Liefert { vorschlag } oder { verworfen: grund }. */
function verifyVorschlag(v, { stellen, system, sp, geburtsjahr }) {
  const weg = typeof v?.weg === 'string' ? v.weg : '';
  if (!sp.wegKeys(system).includes(weg)) return { verworfen: 'weg' };
  const zitat = typeof v?.zitat === 'string' ? v.zitat.trim() : '';
  if (zitat.length < MIN_ZITAT_CHARS) return { verworfen: 'zitat' };
  const nz = _norm(zitat);
  const treffer = stellen.find(s => _norm(s.satz).includes(nz));
  if (!treffer) return { verworfen: 'zitat' };
  if (!SCHOOL_RE.test(zitat)) return { verworfen: 'zitat' };

  const vorschlag = {
    weg,
    zitat: zitat.slice(0, 400),
    page_id: treffer.page_id ?? null,
    begruendung: typeof v.begruendung === 'string' ? v.begruendung.trim().slice(0, 400) : null,
  };
  const ej = Number(v.einschulung_jahr);
  if (Number.isInteger(ej) && zitat.includes(String(ej))
      && (geburtsjahr == null || (ej >= geburtsjahr + 3 && ej <= geburtsjahr + 10))) {
    vorschlag.einschulung_jahr = ej;
  }
  if (v.repetition_stufe && REPETITION_RE.test(zitat)) {
    const wegStufen = system.wege.find(w => w.key === weg)?.stufen || [];
    const [rep] = sp.normalizeRepetitionen([{ stufe: v.repetition_stufe, klasse: v.repetition_klasse }], system);
    if (rep && wegStufen.includes(rep.stufe)) vorschlag.repetition = rep;
  }
  return { vorschlag };
}

async function runSchulwegVorschlagJob(jobId, bookId, userEmail) {
  const logger = makeJobLogger(jobId);
  const { buildSchulwegSystemPrompt, buildSchulwegPrompt, buildSchulwegSchema } = await getPrompts(userEmail);
  const { perChunk: PER_CHUNK_LIMIT } = chunkLimitsFor(resolveProvider({ userEmail }));

  try {
    const signal = () => jobAbortControllers.get(jobId)?.signal;
    const throwIfAborted = () => {
      if (signal()?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    };

    updateJob(jobId, { statusText: 'job.phase.schulwegCollect', progress: 4 });
    const sp = await schoolPath();
    const system = sp.resolveSchulsystem(getBookSchulsystem(bookId));
    if (!system) throw i18nError('job.error.schulwegNoSystem');
    const lang = getBookSettings(bookId, userEmail)?.language || 'de';

    // Nur Figuren mit Geburtsjahr (ohne kann die Rechnung den Weg nicht nutzen)
    // und ohne Autor-Schulweg (der Autor hat entschieden).
    const ages = new Map(listFigureAges(bookId, userEmail || '').map(a => [a.fig_id, a]));
    const figuren = [];
    let ohneJahr = 0, autor = 0;
    for (const f of listFiguresForSchoolPath(bookId, userEmail)) {
      if (f.source === 'autor') { autor++; continue; }
      const { birth } = resolveBirth(birthCandidates(bookId, userEmail || '', { id: f.id, geburtstag: f.geburtstag }, ages.get(f.fig_id)?.geburtsjahr ?? null));
      if (!birth) { ohneJahr++; continue; }
      figuren.push({ ...f, geburtsjahr: birth.y });
    }
    if (!figuren.length) throw i18nError('job.error.schulwegNoFiguren');

    const { chMap, pages } = await loadOrderedBookContents(bookId);
    const contents = await loadPageContents(pages, chMap, 1, null, signal(), { keepHtml: true });
    const pageTexts = contents.filter(p => p.html || p.text)
      .map(p => ({ page_id: p.id, text: htmlToTextForPrompt(String(p.html || p.text || '').replace(/\s+/g, ' ')) }));
    throwIfAborted();

    const nameIndex = buildNameIndex(figuren.map(f => ({ id: f.id, patterns: buildFigureNamePatterns(f.name, f.kurzname) })));
    const byFig = nameIndex ? collectStellen(pageTexts, nameIndex) : new Map();
    const blocks = figuren
      .map(f => ({ fig: f, stellen: _spread(byFig.get(f.id) || [], MAX_STELLEN_PRO_FIGUR) }))
      .filter(b => b.stellen.length)
      .map(b => ({ ...b, chars: b.stellen.reduce((n, s) => n + s.satz.length, 0) + 60 }));

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

    const budget = Math.max(4000, Math.floor(PER_CHUNK_LIMIT * BUNDLE_SHARE));
    const queue = [];
    let cur = [], curChars = 0;
    for (const b of blocks) {
      if (cur.length && curChars + b.chars > budget) { queue.push(cur); cur = []; curChars = 0; }
      cur.push(b); curChars += b.chars;
    }
    if (cur.length) queue.push(cur);

    // Name → Figur. Kurzname nur, wenn eindeutig (wie bei der Alters-Analyse).
    const shortCount = new Map();
    for (const f of figuren) { const k = foldWord(f.kurzname); if (k) shortCount.set(k, (shortCount.get(k) || 0) + 1); }
    const nameLookup = new Map();
    for (const f of figuren) { const k = foldWord(f.name); if (k && !nameLookup.has(k)) nameLookup.set(k, f); }
    for (const f of figuren) { const k = foldWord(f.kurzname); if (k && shortCount.get(k) === 1 && !nameLookup.has(k)) nameLookup.set(k, f); }

    const tok = { in: 0, out: 0, ms: 0 };
    const verworfen = { weg: 0, zitat: 0, figur: 0 };
    const vorschlaege = new Map();
    const AI_FROM = 15, AI_TO = 92;
    let done = 0;
    logger.info(`Schulweg-Vorschlag Start: book=${bookId} figuren=${figuren.length} mitStellen=${blocks.length} buendel=${queue.length} ohneJahr=${ohneJahr} autor=${autor}`);

    while (queue.length) {
      throwIfAborted();
      const bundle = queue.shift();
      const total = done + queue.length + 1;
      updateJob(jobId, { statusText: 'job.phase.schulwegAsk', statusParams: { done: done + 1, total }, progress: AI_FROM + Math.floor((done / total) * (AI_TO - AI_FROM)) });
      const stellenOf = new Map(bundle.map(b => [b.fig.id, b.stellen]));
      let result;
      try {
        result = await aiCall(jobId, tok,
          buildSchulwegPrompt({
            wege, stufen, buchKontext: BUCH_KONTEXT,
            figuren: bundle.map(b => ({ name: b.fig.name, geburtsjahr: b.fig.geburtsjahr, stellen: b.stellen.map(s => s.satz) })),
          }),
          systemPrompt,
          AI_FROM + Math.floor((done / total) * (AI_TO - AI_FROM)),
          AI_FROM + Math.floor(((done + 1) / total) * (AI_TO - AI_FROM)),
          2000, 0.25, 4000, undefined, schema,
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
        if (!fig || !stellenOf.has(fig.id)) { verworfen.figur++; continue; }
        if (vorschlaege.has(fig.id)) continue; // höchstens einer pro Figur
        const r = verifyVorschlag(v, { stellen: stellenOf.get(fig.id), system, sp, geburtsjahr: fig.geburtsjahr });
        if (r.verworfen) { verworfen[r.verworfen]++; continue; }
        vorschlaege.set(fig.id, r.vorschlag);
      }
      done++;
    }

    // Letzter Abbruch-Punkt vor dem Schreiben: ein Teilstand ersetzt keine Vorschläge.
    throwIfAborted();
    const stamp = new Date().toISOString();
    // Jede gefragte Figur bekommt den Stand DIESES Laufs: ein neuer Vorschlag oder
    // keiner — ein alter, nicht mehr belegter Vorschlag bliebe sonst stehen.
    for (const f of figuren) {
      const v = vorschlaege.get(f.id);
      setSchoolPathVorschlag(f.id, v ? { ...v, created_at: stamp } : null);
    }

    logger.info(`Schulweg-Vorschlag fertig: book=${bookId} vorschlaege=${vorschlaege.size} verworfen(weg=${verworfen.weg} zitat=${verworfen.zitat} figur=${verworfen.figur})`);
    completeJob(jobId, {
      figuren: figuren.length, mitStellen: blocks.length, vorschlaege: vorschlaege.size,
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
  precheck: (bookId) => (getBookSchulsystem(bookId) ? null : 'SCHULSYSTEM_MISSING'),
  run: (jobId, { bookId, userEmail }) => runSchulwegVorschlagJob(jobId, bookId, userEmail),
}));

module.exports = { schulwegVorschlagRouter, runSchulwegVorschlagJob, verifyVorschlag, collectStellen, SCHOOL_RE };
