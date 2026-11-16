'use strict';
// Misst, wie viele ZEICHEN deutscher Buchtext pro Token braucht — gegen den
// echten Tokenizer des jeweiligen Claude-Modells (`/v1/messages/count_tokens`,
// kostenlos, kein Inferenz-Call). NICHT Teil von `npm test`: braucht einen
// konfigurierten Claude-Key und schickt Textproben an die API.
//
//   npm run calibrate:tokens -- --book 3
//   npm run calibrate:tokens -- --file /pfad/probe.txt --models claude-opus-4-8,claude-sonnet-4-6
//
// WARUM es das gibt: `ai.chars_per_token` (Default 3 Claude / 4 lokal) und die
// Modell-Rate `_claudeCharsPerToken` (2.5 fuer Opus 4.7+/Sonnet 5+/Fable) sind
// Heuristiken. Aus ihnen faellt das gesamte Zeichen-Budget (INPUT_BUDGET_CHARS,
// Single-Pass-/Chunk-Grenzen der Komplettanalyse). Ein zu HOHER Wert packt zu
// viel Text in den Prompt → Kontext-Overflow mitten im Job; ein zu tiefer
// zerlegt ein Buch ohne Not in Chunks. Nach jedem Modellwechsel neu messen.
//
// Die Annahme kommt aus `_claudeCharsPerToken` selbst (lib/ai/config.js) — das
// Skript baut sie NICHT nach, sonst prueft es seine eigene Kopie statt den Code,
// der die Budgets rechnet.

const fs = require('fs');
const path = require('path');

const SAMPLE_CHARS = 20000;   // Basisprobe; gemessen wird gegen die doppelte Laenge.
const COLLECT_CHARS = 60000;  // So viel Buchtext wird eingesammelt (Reserve fuer den Schnitt).

// Konstanter Request-Overhead (System-Wrapper, Rollen-Marker) faellt heraus,
// indem zwei Laengen gemessen und die DIFFERENZ gerechnet wird: der Overhead
// steckt in beiden Messungen gleich drin. Ohne das misst eine kurze Probe
// systematisch zu wenig Zeichen pro Token.
async function countTokens(apiKey, model, text) {
  const resp = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: text }] }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`count_tokens ${resp.status} fuer '${model}': ${body.slice(0, 300)}`);
  }
  const json = await resp.json();
  if (!Number.isFinite(json?.input_tokens)) throw new Error(`count_tokens: kein input_tokens fuer '${model}'`);
  return json.input_tokens;
}

function parseArgs(argv) {
  const out = { book: null, file: null, models: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--book')   out.book = parseInt(argv[++i], 10);
    else if (a === '--file')   out.file = argv[++i];
    else if (a === '--models') out.models = String(argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
  }
  return out;
}

// Seiten UEBER DEN BUCHBOGEN verteilt einsammeln, nicht die ersten N: Vorwort,
// Klappentext und Widmung tokenisieren anders als Erzaehlprosa.
async function bookSample(bookId) {
  const contentStore = require('../lib/content-store');
  const { htmlToPlainText } = require('../lib/html-text');
  const pages = await contentStore.listPages(bookId, {});
  if (!pages.length) throw new Error(`Buch ${bookId} hat keine Seiten.`);
  const step = Math.max(1, Math.floor(pages.length / 40));
  const picked = pages.filter((_, i) => i % step === 0);
  const loaded = await contentStore.loadPagesBatch(picked, {});
  let text = '';
  for (const pd of loaded) {
    text += htmlToPlainText(pd?.html || pd?.content || '') + '\n\n';
    if (text.length >= COLLECT_CHARS) break;
  }
  return text;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const appSettings = require('../lib/app-settings');
  const { _claudeCharsPerToken, CHARS_PER_TOKEN } = require('../lib/ai');

  const apiKey = appSettings.get('ai.claude.api_key');
  if (!apiKey) {
    console.error('\n  Kein Claude-API-Key konfiguriert (ai.claude.api_key). Abgebrochen.');
    console.error('  count_tokens kostet nichts, braucht aber einen gueltigen Key.\n');
    process.exit(2);
  }

  let raw;
  if (args.file) {
    raw = fs.readFileSync(path.resolve(args.file), 'utf8');
  } else if (Number.isInteger(args.book) && args.book > 0) {
    raw = await bookSample(args.book);
  } else {
    console.error('\n  Textquelle fehlt: --book <id> (Seiten ueber den Buchbogen verteilt) oder --file <pfad>.\n');
    process.exit(2);
  }

  const text = raw.replace(/\s+/g, ' ').trim();
  if (text.length < SAMPLE_CHARS * 2) {
    console.error(`\n  Zu wenig Text: ${text.length} Zeichen, gebraucht werden ${SAMPLE_CHARS * 2}.`);
    console.error('  Eine kurze Probe misst vor allem den Request-Overhead.\n');
    process.exit(2);
  }
  const sampleA = text.slice(0, SAMPLE_CHARS);
  const sampleB = text.slice(0, SAMPLE_CHARS * 2);
  const words = sampleB.split(/\s+/).filter(Boolean).length;

  const models = args.models && args.models.length
    ? args.models
    : [...new Set([
        appSettings.get('ai.claude.model') || 'claude-sonnet-5-5',
        appSettings.get('ai.claude.model.tier.max'),
        appSettings.get('ai.claude.model.tier.standard'),
      ].filter(Boolean))];

  console.log(`\n  Kalibrierung chars/token · Probe ${SAMPLE_CHARS} vs. ${SAMPLE_CHARS * 2} Zeichen`);
  console.log(`  Quelle: ${args.file ? args.file : 'Buch ' + args.book} · globaler ai.chars_per_token: ${CHARS_PER_TOKEN}\n`);
  console.log('  Modell                          gemessen   Annahme   Urteil');
  console.log('  ' + '-'.repeat(68));

  let optimistic = false;
  for (const model of models) {
    let line;
    try {
      const [t1, t2] = [await countTokens(apiKey, model, sampleA), await countTokens(apiKey, model, sampleB)];
      const delta = t2 - t1;
      if (delta <= 0) throw new Error('Messung unbrauchbar (Differenz <= 0)');
      const measured = SAMPLE_CHARS / delta;
      const wordsPerTok = (words / 2) / delta;
      const assumed = _claudeCharsPerToken(model);
      // Das Budget rechnet Tokens × cpt = Zeichen. Liegt die ANNAHME ueber dem
      // gemessenen Wert, passen weniger Zeichen ins Fenster als angenommen →
      // Overflow. Darunter ist nur verschenkter Kontext.
      const devPct = ((assumed - measured) / measured) * 100;
      const verdict = devPct > 2
        ? `ZU OPTIMISTISCH (+${devPct.toFixed(0)}% → Overflow-Risiko)`
        : devPct < -10 ? `konservativ (${devPct.toFixed(0)}% → Kontext verschenkt)` : 'passt';
      if (devPct > 2) optimistic = true;
      line = `  ${model.padEnd(30)}  ${measured.toFixed(2).padStart(7)}   ${String(assumed).padStart(7)}   ${verdict}`;
      line += `\n  ${''.padEnd(30)}  ${wordsPerTok.toFixed(2).padStart(7)} Woerter/Token`;
    } catch (e) {
      line = `  ${model.padEnd(30)}  FEHLER: ${e.message}`;
    }
    console.log(line);
  }

  console.log('\n  Anpassen: `ai.chars_per_token` (Admin → Provider) bzw. _MODERN_CLAUDE_CHARS_PER_TOKEN');
  console.log('  in lib/ai/config.js. Beide Werte sind Boot-frozen → App-Neustart noetig.\n');
  process.exit(optimistic ? 1 : 0);
}

main().catch(err => { console.error('\n  Fehlgeschlagen:', err.message, '\n'); process.exit(1); });
