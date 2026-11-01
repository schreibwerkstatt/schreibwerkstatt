'use strict';

const { hashSplit } = require('../../lib/names');
const { buildFigureBaseSamples, buildFigureMetaSamples } = require('./figures');
const { buildLocationSamples, buildLocationPassageSamples } = require('./locations');
const { buildSceneQASamples } = require('./scenes');
const { buildEventSamples } = require('./events');
const { buildEventLinkSamples } = require('./event-links');
const { loadEventData } = require('./event-data');
const { buildRelationSamples } = require('./relations');
const { buildFactSamples } = require('./facts');
const { buildFigurePassageSamples } = require('./passages');
const { buildWorldFactSamples } = require('./world-facts');
const { buildSongSamples } = require('./songs');
const { buildStorylineSamples } = require('./storylines');
const { buildFigureDepthSamples } = require('./depth');

// Umformulierungen derselben Frage pro Entität. Jede trägt dieselbe Antwort;
// mehr als zwei vervielfachen nur die Antwort (finalize.js deckelt sie auf
// `maxPerAnswer`), statt neues Wissen zu bringen.
const PARAPHRASES = 2;

// Fragevarianten, aus denen `pickVariants` pro Entität `PARAPHRASES` zieht —
// verschiedene Entitäten bekommen verschiedene Formulierungen.
function buildQuestionPools(langIsEn) {
  const figQuestions = langIsEn
    ? ['Who is {name}?', 'Tell me about {name}.', 'How would you describe {name}?',
       'What do I need to know about {name}?', 'What is {name} like?',
       "What's {name}'s story?", 'Give me a portrait of {name}.']
    : ['Wer ist {name}?', 'Erzähl mir von {name}.', 'Wie würdest du {name} beschreiben?',
       'Was sollte ich über {name} wissen?', 'Was für ein Mensch ist {name}?',
       'Was ist {name} für eine Figur?', 'Zeichne mir ein Bild von {name}.'];
  const ortQuestions = langIsEn
    ? ['What is {name}?', 'Describe {name}.', 'What kind of place is {name}?',
       'How does {name} feel?', 'Tell me about {name}.',
       'What should I imagine when I hear {name}?']
    : ['Was ist {name}?', 'Beschreibe {name}.', 'Was für ein Ort ist {name}?',
       'Wie wirkt {name}?', 'Erzähl mir von {name}.',
       'Was soll ich mir unter {name} vorstellen?'];
  const sceneQuestions = langIsEn
    ? ['What happens in «{titel}»?', 'Can you summarize the scene «{titel}»?',
       'What is «{titel}» about?', 'Tell me about the scene «{titel}».',
       "What's going on in «{titel}»?"]
    : ['Was passiert in «{titel}»?', 'Worum geht es in «{titel}»?',
       'Fasse die Szene «{titel}» zusammen.', 'Erzähl mir von der Szene «{titel}».',
       'Was spielt sich in «{titel}» ab?'];
  // Bedeutung/Wann/Wer/Wo fragt das Kernwissen (core-facts/events.js) mit
  // eigener Antwort; hier nur die Gesamtfrage mit der ganzen Ereigniskarte.
  const eventQuestions = langIsEn
    ? ['What happens around {ereignis}?', 'Tell me about {ereignis}.', 'What do you know about {ereignis}?']
    : ['Was weisst du über {ereignis}?', 'Erzähl mir von {ereignis}.', 'Was geschah bei {ereignis}?'];
  const chapterQuestions = langIsEn
    ? ['What happens in «{kapitel}»?', 'Summarize «{kapitel}» for me.',
       'Walk me through «{kapitel}».', 'What is «{kapitel}» about?']
    : ['Was passiert in «{kapitel}»?', 'Fasse «{kapitel}» zusammen.',
       'Was geschieht im Kapitel «{kapitel}»?', 'Worum geht es in «{kapitel}»?'];
  return { figQuestions, ortQuestions, sceneQuestions, eventQuestions, chapterQuestions };
}

function buildAuthorChatHelpers(ctx) {
  const { samples, counts, opts, unifiedSys, voiceTargets } = ctx;
  const seed = opts.valSeed;

  // Deterministische Auswahl einer Paraphrase pro Entity — bei gleichem Seed
  // reproduzierbar. `pickVariants` liefert `count` Indizes ohne Dubletten.
  const pickVariants = (id, variants, count) => {
    if (variants.length <= count) return variants.map((_, i) => i);
    const seen = new Set();
    const out = [];
    for (let i = 0; i < count * 4 && out.length < count; i++) {
      const v = Math.floor(hashSplit(id + '|' + i, seed) * variants.length);
      if (seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
    return out;
  };

  // Viertes Argument: Kapitel-Schlüssel (`sourceKey`, wenn die Antwort
  // Buchtext wiedergibt) oder ein Objekt `{ sourceKey, voice, unit }`.
  // `unit` (`evt:12`, `fig:<fig_id>`, `loc:<loc_id>`, `scene:<id>`) ist die
  // Entität, mit der das Sample im Train/Val-Split wandert (lib/split.js);
  // ohne `unit` bleibt eine Fakten-Antwort im Train. `voice` ({ key, kind,
  // name }) meldet eine Analyse-Antwort für die Umschreibung im Buchton an
  // (KI-Augment `voiceRewrite`); alle Samples mit demselben key bekommen dort
  // dieselbe neue Antwort.
  const pushQA = (id, q, a, sourceKeyOrOpts, voiceArg) => {
    const o = sourceKeyOrOpts && typeof sourceKeyOrOpts === 'object'
      ? sourceKeyOrOpts
      : { sourceKey: sourceKeyOrOpts, voice: voiceArg };
    const { sourceKey, voice, unit } = o;
    const qq = (q || '').trim();
    const aa = (a || '').trim();
    if (qq.length < 4 || aa.length < 20) return;
    const sample = {
      id,
      type: 'authorChat',
      messages: [
        { role: 'system', content: unifiedSys },
        { role: 'user',   content: qq },
        { role: 'assistant', content: aa },
      ],
    };
    if (sourceKey) sample.sourceKey = sourceKey;
    if (unit) sample.unit = unit;
    if (voice && voiceTargets) {
      sample.voiceKey = voice.key;
      voiceTargets.set(voice.key, { kind: voice.kind, name: voice.name, text: aa });
    }
    samples.push(sample);
    counts.authorChat++;
  };

  return { pickVariants, pushQA };
}

function buildAuthorChatSamples(ctx) {
  const pools = buildQuestionPools(ctx.langIsEn);
  const helpers = buildAuthorChatHelpers(ctx);
  // ctx wird um helpers + pools erweitert; alle sub-modules greifen darauf zu.
  const baseCtx = { ...ctx, ...pools, ...helpers, PARAPHRASES };
  // Zeitstrahl einmal angereichert laden (index.js legt ihn vorab in ctx, weil
  // auch Szenen-Sampler und Kernwissen ihn brauchen): Szenen-, Ereignis- und
  // Figuren-Block teilen ihn.
  const subCtx = { ...baseCtx, ...(ctx.events ? {} : loadEventData(baseCtx)) };

  buildFigureBaseSamples(subCtx);          // Block 1+2: figuren composite + traits
  buildLocationSamples(subCtx);            // Block 3+4: orte einzeln + aggregate
  buildSceneQASamples(subCtx);             // Block 5: szenen
  buildEventSamples(subCtx);               // Block 6-11: zeitstrahl + tripel + paar
  buildEventLinkSamples(subCtx);           // Block 11b: buchstelle + szenen + strang + zeit
  buildRelationSamples(subCtx);            // Block 12-16: rel + cast + family + power + tag
  buildFigureMetaSamples(subCtx);          // Block 17+18+19: figEvt + figApp + figVoice
  buildFactSamples(subCtx);                // Block 20: chapter_extract_cache facts
  buildFigurePassageSamples(subCtx);       // Block 21: figPass + figPassCh
  buildLocationPassageSamples(subCtx);     // Block 22: ortPass
  buildWorldFactSamples(subCtx);           // Block 29: world_facts (extrahierte Welt-Lore)
  buildSongSamples(subCtx);                // Block 30: songs (Buch-Soundtrack)
  buildStorylineSamples(subCtx);           // Block 31: storylines (Erzählstränge)
  buildFigureDepthSamples(subCtx);         // Block 32: Tiefe-Felder (Motivation, Konflikt, Bogen …)
}

module.exports = { buildAuthorChatSamples, buildQuestionPools, PARAPHRASES };
