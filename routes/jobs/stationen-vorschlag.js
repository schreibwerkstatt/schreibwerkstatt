'use strict';
// Berufsweg- und Hobby-Vorschlag (Job `stationen-vorschlag`, docs/figur-lebenslauf.md
// «Berufsweg und Hobbys»): schlägt je Figur Ausbildungen, Berufsstationen und
// Hobbys vor — jede mit wörtlichem Beleg aus dem Text.
//
// DREI SCHICHTEN wie beim Schulweg-Vorschlag (routes/jobs/schulweg-vorschlag.js):
//   1. deterministisch: Sätze mit Figur und Arbeits- bzw. Freizeitbegriff
//      (BERUF_RE / HOBBY_RE), je Thema eigene Auswahl, über das Buch verteilt.
//   2. das Modell: was die Stellen für diese Figur belegen, mit Zitat.
//   3. deterministisch: Zitat in einer Stelle der Figur, ein Wort der Tätigkeit
//      bzw. des Hobbys im Zitat, Jahreszahl und Monat nur, wenn sie im Zitat
//      stehen, nicht vor der Geburt, Ende nicht vor Beginn. Unbelegtes fällt
//      heraus und wird gezählt.
//
// SCHREIBT NUR Zeilen mit status 'vorschlag' (db/figure-stationen.js#replaceVorschlaege);
// jede gefragte Figur bekommt den Stand DIESES Laufs. Was der Autor hat oder
// übernommen hat, fasst der Job nie an; ein Vorschlag, der einer aktiven Zeile
// entspricht, fällt weg (`schonVorhanden`).

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
const { listFiguresForSchoolPath } = require('../../db/figure-school-paths');
const { listStationenForFigure, replaceVorschlaege } = require('../../db/figure-stationen');
const { resolveBirthsForFigures } = require('../../lib/figure-birth');
const { buildFigureNamePatterns } = require('../../lib/page-index');
const { buildNameIndex, foldWord } = require('../../lib/figure-age');
const { figureStationen } = require('../../lib/esm-bridge');
const stellenLib = require('./shared/figure-stellen');

// Arbeits- und Ausbildungsbegriffe (CH + DE, etwas EN). Wortanfang umlaut-sicher.
// STARK benennt Erwerb/Ausbildung, SCHWACH nur ein Arbeitsumfeld.
const _B = '(?<![A-Za-zÄÖÜäöüß])';
const _BERUF_STARK = 'arbeite|arbeitet|Arbeitgeber|Arbeitsplatz|Arbeitsstelle|angestellt|Anstellung|Job(?![A-Za-zäöü])|Jobs(?![A-Za-zäöü])'
  + '|Beruf|beruflich|Lehre(?![rn])|Lehrling|Lehrstelle|Lehrjahr|Lehrabschluss|Lehrmeister|Stift(?![A-Za-zäöü])|Ausbildung|Studium|studier'
  + '|Praktikum|Praktikant|Volontariat|Weiterbildung|gekündigt|Kündigung|entlassen|arbeitslos|befördert|Beförderung'
  + '|pensioniert|Pensionierung|Ruhestand|Rente(?![A-Za-zäöü])|Rentner|selbständig|selbstständig|gegründet|Firma|Betrieb'
  + '|works? as|worked as|employ|hired|fired|retired|apprentice|career';
const _BERUF_SCHWACH = 'Büro|Werkstatt|Schicht|Kollege|Kollegin|Chef(?![A-Za-zäöü])|Chefin|Lohn|Gehalt|Stelle(?![n])|Geschäft|Praxis|Kanzlei|Fabrik|verdient|Feierabend|Kunden';
const _HOBBY_STARK = 'Hobby|Hobbies|Freizeit|Verein|Klub|Club|Training|trainier|Mannschaft|Chor(?![A-Za-zäöü])|Pfadi|Pfadfinder|Turnverein|Jungwacht|Blauring|Musikunterricht|Musikschule|Probe(?![A-Za-zäöü])|hobby|practice';
const _HOBBY_SCHWACH = 'Fussball|Fußball|Handball|Eishockey|Unihockey|Tennis|reitet|Reiten|Reitstunde|schwimm|jogg|Ski(?![A-Za-zäöü])|Skifahr|Snowboard|kletter|wander|Velo|Radfahr|Fischen|fischt|angelt|Schach'
  + '|Klavier|Gitarre|Geige|Cello|Schlagzeug|Flöte|Trompete|Saxophon|Akkordeon|malt(?![A-Za-zäöü])|Malen|zeichnet|Zeichnen|sammelt|Sammlung|Briefmarken'
  + '|töpfer|strickt|häkel|gärtner|fotografier|Theatergruppe|Tanzkurs|tanzt|Ballett|Yoga|Judo|Karate|Boxen|Modellbau|Modelleisenbahn|Computerspiel|gamt|zockt';
const BERUF_RE = new RegExp(`${_B}(?:${_BERUF_STARK}|${_BERUF_SCHWACH})`, 'iu');
const BERUF_STARK_RE = new RegExp(`${_B}(?:${_BERUF_STARK})`, 'iu');
const HOBBY_RE = new RegExp(`${_B}(?:${_HOBBY_STARK}|${_HOBBY_SCHWACH})`, 'iu');
const HOBBY_STARK_RE = new RegExp(`${_B}(?:${_HOBBY_STARK})`, 'iu');

const MAX_BERUF_STELLEN = 8;
const MAX_HOBBY_STELLEN = 6;
const MAX_PRO_FIGUR = { berufe: 10, hobbys: 8 };
const MIN_ZITAT_CHARS = 8;
const BUNDLE_SHARE = 0.5;
const MAX_OUT_TOKENS = 6000;
const OUT_SHARE = 0.6;
const OUT_TOK_PRO_FIGUR = 60;
const OUT_TOK_PRO_STELLE = 70;

const MONATE = [
  ['januar', 'jänner', 'january', 'jan'], ['februar', 'feber', 'february', 'feb'], ['märz', 'maerz', 'march', 'mär'],
  ['april', 'apr'], ['mai', 'may'], ['juni', 'june', 'jun'], ['juli', 'july', 'jul'], ['august', 'aug'],
  ['september', 'sept', 'sep'], ['oktober', 'october', 'okt', 'oct'], ['november', 'nov'], ['dezember', 'december', 'dez', 'dec'],
];

/** Monat im Zitat genannt (Wort oder «5.1998» / «05/1998»)? */
function monatImZitat(zitat, monat, jahr) {
  const z = String(zitat).toLowerCase();
  if (MONATE[monat - 1]?.some(n => new RegExp(`${_B}${n}(?![a-zäöü])`, 'iu').test(z))) return true;
  return jahr != null && new RegExp(`(?<![0-9])0?${monat}[./]\\s?${jahr}`).test(z);
}

/** Trägt das Zitat ein Wort des Eintrags? Stammvergleich (erste 5 Zeichen), damit
 *  «Schreinerin» ↔ «Schreinerlehre» und «Klavier» ↔ «Klavierstunden» greifen. */
function wortImZitat(text, zitat) {
  const z = foldWord(zitat);
  const words = String(text || '').split(/[^A-Za-zÀ-ÿ]+/).filter(w => w.length >= 4);
  return words.some(w => z.includes(foldWord(w).slice(0, Math.min(5, w.length))));
}

const _txt = (v, max = 200) => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s.slice(0, max) : null;
};

/** Schicht 3: einen Eintrag prüfen. Liefert { row } oder { verworfen: grund }. */
function verifyStation(kind, v, ctx) {
  const main = kind === 'berufe' ? 'taetigkeit' : 'hobby';
  const text = _txt(v?.[main]);
  if (!text) return { verworfen: 'feld' };
  const zitat = typeof v?.zitat === 'string' ? v.zitat.trim() : '';
  if (zitat.length < MIN_ZITAT_CHARS) return { verworfen: 'zitat' };
  const treffer = stellenLib.findeStelle(zitat, ctx.stellen, v.stelle, ctx.figIndex ?? -1);
  if (!treffer) return { verworfen: 'zitat' };
  if (!wortImZitat(text, zitat)) return { verworfen: 'feld' };

  const row = {
    [main]: text,
    ort: _txt(v.ort),
    zitat: zitat.slice(0, 400),
    page_id: treffer.page_id ?? null,
    begruendung: _txt(v.begruendung, 400),
  };
  if (kind === 'berufe') {
    row.art = v.art === 'ausbildung' ? 'ausbildung' : 'beruf';
    row.arbeitgeber = _txt(v.arbeitgeber);
  }
  // Jahr nur aus dem Zitat, plausibel und nicht vor der Geburt; Monat nur mit Jahr
  // und genannt. Ein gestrichenes Jahr verwirft den Eintrag nicht — er wird undatiert.
  for (const [jk, mk] of [['von_jahr', 'von_monat'], ['bis_jahr', 'bis_monat']]) {
    const j = Number(v[jk]);
    const ok = Number.isInteger(j) && j >= 1000 && j <= 2999 && zitat.includes(String(j))
      && (ctx.geburtsjahr == null || j >= ctx.geburtsjahr);
    if (!ok) { if (v[jk] != null) ctx.verworfen.jahr++; row[jk] = null; row[mk] = null; continue; }
    row[jk] = j;
    const m = Number(v[mk]);
    row[mk] = Number.isInteger(m) && m >= 1 && m <= 12 && monatImZitat(zitat, m, j) ? m : null;
  }
  if (row.von_jahr != null && row.bis_jahr != null
      && (row.bis_jahr < row.von_jahr || (row.bis_jahr === row.von_jahr && row.bis_monat && row.von_monat && row.bis_monat < row.von_monat))) {
    ctx.verworfen.jahr++;
    row.bis_jahr = null; row.bis_monat = null;
  }
  return { row };
}

const _key = (kind, r) => `${foldWord(kind === 'berufe' ? r.taetigkeit : r.hobby)}|${r.von_jahr ?? ''}`;

async function runStationenVorschlagJob(jobId, bookId, userEmail, { nachKatalog = false } = {}) {
  const logger = makeJobLogger(jobId);
  // Stufe «leicht» (shared/model-tier.js) — vor chunkLimitsFor, die liest das Bag-Modell.
  applyTierAiOverrides(jobId, 'stationen-vorschlag', resolveProvider({ userEmail }), logger);
  const { buildStationenSystemPrompt, buildStationenPrompt, buildStationenSchema } = await getPrompts(userEmail);
  const { perChunk: PER_CHUNK_LIMIT } = chunkLimitsFor(resolveProvider({ userEmail }));

  try {
    const signal = () => jobAbortControllers.get(jobId)?.signal;
    const throwIfAborted = () => {
      if (signal()?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    };

    updateJob(jobId, { statusText: 'job.phase.stationenCollect', progress: 4 });
    const { stationTitel } = await figureStationen();
    const figuren = listFiguresForSchoolPath(bookId, userEmail);
    if (!figuren.length) {
      // Von der Komplettanalyse eingereiht: «nichts zu tun» ist kein Fehler des Users.
      if (nachKatalog) return completeJob(jobId, { skipped: 'job.error.stationenNoFiguren' });
      throw i18nError('job.error.stationenNoFiguren');
    }
    const births = resolveBirthsForFigures(bookId, userEmail, figuren);

    const { chMap, pages } = await loadOrderedBookContents(bookId);
    const contents = await loadPageContents(pages, chMap, 1, null, signal(), { keepHtml: true });
    const pageTexts = contents.filter(p => p.html || p.text)
      .map(p => ({ page_id: p.id, text: htmlToTextForPrompt(String(p.html || p.text || '').replace(/\s+/g, ' ')) }));
    throwIfAborted();

    const nameIndex = buildNameIndex(figuren.map(f => ({ id: f.id, patterns: buildFigureNamePatterns(f.name, f.kurzname, f.weitere_namen) })));
    const berufStellen = nameIndex ? stellenLib.collectStellen(pageTexts, nameIndex, BERUF_RE) : new Map();
    const hobbyStellen = nameIndex ? stellenLib.collectStellen(pageTexts, nameIndex, HOBBY_RE) : new Map();

    const aktiv = new Map(figuren.map(f => [f.id, {
      berufe: listStationenForFigure('berufe', f.id, { nurAktiv: true }),
      hobbys: listStationenForFigure('hobbys', f.id, { nurAktiv: true }),
    }]));

    const blocks = figuren.map(f => {
      const seen = new Set();
      const stellen = [
        ...stellenLib.pickStellen(berufStellen.get(f.id) || [], MAX_BERUF_STELLEN, BERUF_STARK_RE),
        ...stellenLib.pickStellen(hobbyStellen.get(f.id) || [], MAX_HOBBY_STELLEN, HOBBY_STARK_RE),
      ].filter(s => (seen.has(s.satz) ? false : (seen.add(s.satz), true)));
      return { fig: { ...f, geburtsjahr: births.get(f.id)?.y ?? null }, stellen };
    }).filter(b => b.stellen.length).map(b => ({
      ...b,
      chars: b.stellen.reduce((n, s) => n + s.satz.length, 0) + 120,
      outEst: OUT_TOK_PRO_FIGUR + b.stellen.length * OUT_TOK_PRO_STELLE,
    }));

    const systemPrompt = buildStationenSystemPrompt();
    const schema = buildStationenSchema();
    const { BUCH_KONTEXT } = await getBookPrompts(bookId, userEmail);
    const queue = bundleBlocks(blocks, {
      charBudget: Math.max(4000, Math.floor(PER_CHUNK_LIMIT * BUNDLE_SHARE)),
      outBudget: MAX_OUT_TOKENS * OUT_SHARE,
    });

    // Name → Figur. Kurzname nur, wenn eindeutig (wie Schulweg/Alter).
    const shortCount = new Map();
    for (const f of figuren) { const k = foldWord(f.kurzname); if (k) shortCount.set(k, (shortCount.get(k) || 0) + 1); }
    const nameLookup = new Map();
    for (const f of figuren) { const k = foldWord(f.name); if (k && !nameLookup.has(k)) nameLookup.set(k, f); }
    for (const f of figuren) { const k = foldWord(f.kurzname); if (k && shortCount.get(k) === 1 && !nameLookup.has(k)) nameLookup.set(k, f); }

    const tok = { in: 0, out: 0, ms: 0 };
    const verworfen = { zitat: 0, feld: 0, figur: 0, jahr: 0 };
    const ergebnis = new Map(); // figures.id → { berufe: [], hobbys: [] }
    let schonVorhanden = 0;
    const AI_FROM = 15, AI_TO = 92;
    let done = 0;
    logger.info(`Stationen-Vorschlag Start: book=${bookId} figuren=${figuren.length} mitStellen=${blocks.length} stellen=${blocks.reduce((n, b) => n + b.stellen.length, 0)} buendel=${queue.length}`);

    while (queue.length) {
      throwIfAborted();
      const bundle = queue.shift();
      const total = done + queue.length + 1;
      updateJob(jobId, { statusText: 'job.phase.stationenAsk', statusParams: { done: done + 1, total }, progress: AI_FROM + Math.floor((done / total) * (AI_TO - AI_FROM)) });
      const ctxOf = new Map(bundle.map((b, i) => [b.fig.id, { stellen: b.stellen, figIndex: i, geburtsjahr: b.fig.geburtsjahr, verworfen }]));
      let result;
      try {
        result = await aiCall(jobId, tok,
          buildStationenPrompt({
            buchKontext: BUCH_KONTEXT,
            figuren: bundle.map(b => ({
              name: b.fig.name,
              geburtsjahr: b.fig.geburtsjahr,
              bekannt: {
                berufe: aktiv.get(b.fig.id).berufe.map(s => stationTitel('berufe', s)),
                hobbys: aktiv.get(b.fig.id).hobbys.map(s => stationTitel('hobbys', s)),
              },
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
          logger.warn(`Stationen-Vorschlag: Bündel mit ${bundle.length} Figuren am Output-Cap abgeschnitten – wird geteilt.`);
          continue;
        }
        throw e;
      }
      if (!Array.isArray(result?.berufe) && !Array.isArray(result?.hobbys)) throw i18nError('job.error.stationenMissing');
      for (const kind of ['berufe', 'hobbys']) {
        for (const v of (Array.isArray(result[kind]) ? result[kind] : [])) {
          const fig = nameLookup.get(foldWord(v?.figur));
          if (!fig || !ctxOf.has(fig.id)) { verworfen.figur++; continue; }
          const r = verifyStation(kind, v, ctxOf.get(fig.id));
          if (r.verworfen) { verworfen[r.verworfen]++; continue; }
          const k = _key(kind, r.row);
          if (aktiv.get(fig.id)[kind].some(s => _key(kind, s) === k)) { schonVorhanden++; continue; }
          const e = ergebnis.get(fig.id) || { berufe: [], hobbys: [] };
          if (e[kind].length < MAX_PRO_FIGUR[kind] && !e[kind].some(x => _key(kind, x) === k)) e[kind].push(r.row);
          ergebnis.set(fig.id, e);
        }
      }
      done++;
    }

    // Letzter Abbruch-Punkt vor dem Schreiben: ein Teilstand ersetzt keine Vorschläge.
    throwIfAborted();
    let nBerufe = 0, nHobbys = 0;
    for (const f of figuren) {
      const e = ergebnis.get(f.id) || { berufe: [], hobbys: [] };
      replaceVorschlaege('berufe', f.id, e.berufe);
      replaceVorschlaege('hobbys', f.id, e.hobbys);
      nBerufe += e.berufe.length;
      nHobbys += e.hobbys.length;
    }

    logger.info(`Stationen-Vorschlag fertig: book=${bookId} berufe=${nBerufe} hobbys=${nHobbys} schonVorhanden=${schonVorhanden} verworfen(zitat=${verworfen.zitat} feld=${verworfen.feld} figur=${verworfen.figur} jahr=${verworfen.jahr})`);
    completeJob(jobId, {
      figuren: figuren.length, mitStellen: blocks.length, berufe: nBerufe, hobbys: nHobbys,
      schonVorhanden, verworfen, tokensIn: tok.in, tokensOut: tok.out,
    }, tps(tok), `${nBerufe + nHobbys}`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Stationen-Vorschlag Fehler book=${bookId}: ${e.message}`, { stack: e.cause?.stack || e.stack });
    failJob(jobId, e);
  }
}

const stationenVorschlagRouter = express.Router();

// 'editor': der Lauf legt Vorschläge an Figuren ab.
stationenVorschlagRouter.post('/stationen-vorschlag', jsonBody, (req, res) => startBookJob(req, res, {
  type: 'stationen-vorschlag', minRole: 'editor', label: 'job.label.stationenVorschlag',
  // Läuft eine Komplettanalyse → 409 (sie schreibt den Figurenstamm gerade neu).
  precheck: komplettRunningPrecheck,
  run: (jobId, { bookId, userEmail }) => runStationenVorschlagJob(jobId, bookId, userEmail),
}));

module.exports = {
  stationenVorschlagRouter, runStationenVorschlagJob,
  verifyStation, monatImZitat, wortImZitat, BERUF_RE, HOBBY_RE,
};
