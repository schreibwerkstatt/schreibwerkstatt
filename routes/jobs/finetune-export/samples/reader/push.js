'use strict';

// Sample-Bau des Leser-Modells. Jedes Leser-Sample hat Typ `reader` (eigene
// Zeile in Statistik und Typ-Balance) und trägt optional:
//   - `sourceKey`: Kapitel-Schlüssel, wenn die Antwort Buchtext wiedergibt
//     (Train/Val-Split pro Kapitel, siehe finalize.js);
//   - `unit`: Einheit im Train/Val-Split (lib/split.js), z.B. `ref:offTopic:3`;
//   - `convKey`: Gesprächsthema (`fig:<fig_id>` …), aus dem conversations.js
//     mehrzügige Gespräche zusammensetzt;
//   - `factIds`: Kernfakten, die das Sample prüft (Falschannahme → `rel:…`),
//     zählen in `coreFactVariants` mit;
//   - `form`: Frageform einer Ablehnung (`portrait`, `relation`) — misst die
//     Kontrastpaare (lib/export-stats.js#refusalPortraitRatio);
//   - `persona`: Name der Figur, wenn die Antworten ihre Ich-Form sind
//     (lib/answer-lint.js#personaThirdPerson prüft sie);
//   - `voice`: Anmeldung für die Umschreibung im Buchton (KI-Augment
//     `voiceRewrite`, gleicher Mechanismus wie author-chat/index.js#pushQA).
function makeReaderPush(ctx) {
  const { samples, counts, unifiedSys, voiceTargets } = ctx;
  return function pushReader({ id, turns, sourceKey, convKey, voice, unit, factIds, form, persona }) {
    const msgs = [{ role: 'system', content: unifiedSys }];
    for (const [q, a] of turns) {
      const qq = String(q || '').trim();
      const aa = String(a || '').trim();
      if (qq.length < 4 || aa.length < 2) return false;
      msgs.push({ role: 'user', content: qq }, { role: 'assistant', content: aa });
    }
    const sample = { id, type: 'reader', messages: msgs };
    if (sourceKey) sample.sourceKey = sourceKey;
    if (convKey) sample.convKey = convKey;
    if (unit) sample.unit = unit;
    if (factIds?.length) sample.factIds = factIds;
    if (form) sample.form = form;
    if (persona) sample.persona = persona;
    if (voice && voiceTargets && turns.length === 1) {
      sample.voiceKey = voice.key;
      voiceTargets.set(voice.key, { kind: voice.kind, name: voice.name, text: String(turns[0][1]).trim() });
    }
    samples.push(sample);
    counts.reader = (counts.reader || 0) + 1;
    return true;
  };
}

module.exports = { makeReaderPush };
