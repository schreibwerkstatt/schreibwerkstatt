'use strict';
// KI-Stub für die Landing-Screenshots.
//
// Die Screenshots zeigen die ECHTE Oberfläche mit dem ECHTEN Beispielbuch —
// nur die Modellantworten sind handgeschrieben, sonst gäbe es ohne API-Key
// keine Findings, keine Bewertung und keinen Chat. Der Stub ersetzt
// `lib/ai.callAI` / `callAIChat` / `callAIWithTools` via require.cache (gleiches
// Muster wie tests/integration/_helpers/mock-ai.js) und wird VOR dem Server-Boot
// installiert.
//
// Dispatch über das JSON-Schema des Calls, nicht über Prompt-Text: die
// Schema-Keys sind stabile Konstanten ('fehler' = Lektorat, 'vorschlaege' =
// Chat, 'gesamtnote' = Bewertung), der Prompt-Wortlaut ändert sich dagegen bei
// jeder Prompt-Überarbeitung.
//
// Die Inhalte sind an den Originaltext des Beispielbuchs gebunden: jedes
// `original` (Lektorat) und jedes Zitat (Bewertung) ist eine zeichengenaue
// Stelle aus «Die Verwandlung». Sonst fände das Lektorat die Stelle nicht und
// die Bewertung verwürfe das Zitat — der Screenshot zeigte eine leere Liste.

const path = require('path');

// ── Kafka-Stellen (Originaltext des Beispielbuchs) ────────────────────────────
// Wortlaut identisch zu lib/demo-book.js. Zitate/Zeilen müssen zeichengenau
// stimmen: das Lektorat positioniert über `original`, die Bewertung verwirft
// nicht auffindbare Belege (lib/quote-verify.js).
const STELLEN = {
  verwandelt:
    'fand er sich in seinem Bett zu einem ungeheueren Ungeziefer verwandelt',
  keinTraum: 'Es war kein Traum.',
  menschenzimmer: 'nur etwas zu kleines Menschenzimmer',
  bettdecke:
    'die Bettdecke, zum gänzlichen Niedergleiten bereit, kaum noch erhalten konnte',
  ausbreitet:
    'eine auseinandergepackte Musterkollektion von Tuchwaren ausgebreitet war',
  // Satz 1 des zweiten Absatzes
  wasIst:
    '„Was ist mit mir geschehen?", dachte er.',
  familie:
    'Die Verwandlung hatte den Haushalt der Familie Samsa von einem Tag auf den anderen verändert.',
};

// ── Lektorat: Befunde für den Abschnitt «Die Verwandlung» ─────────────────────
const LEKTORAT = {
  fehler: [
    {
      typ: 'schwaches_verb',
      original: STELLEN.verwandelt,
      korrektur: 'fand er sich in seinem Bett als ungeheueres Ungeziefer wieder',
      erklaerung: '«fand er sich … verwandelt» ist eine Zustandsbeschreibung ohne Richtung. «wieder» macht die Rückkehr zum alten Ich lesbar.',
    },
    {
      typ: 'fuellwort',
      original: STELLEN.keinTraum,
      korrektur: 'Er träumte nicht.',
      erklaerung: 'Der Satz gehört in Gregors Bewusstsein, nicht in die Erzählerkommentarebene.',
    },
    {
      typ: 'pleonasmus',
      original: STELLEN.menschenzimmer,
      korrektur: 'ein etwas zu kleines Menschenzimmer',
      erklaerung: '«nur» und «etwas» verstärken dasselbe; eines davon genügt.',
    },
    {
      typ: 'passiv',
      original: STELLEN.ausbreitet,
      korrektur: 'eine auseinandergepackte Musterkollektion von Tuchwaren ausgebreitet lag',
      erklaerung: 'Passive Konstruktion. «lag» trägt das Bild stärker und macht die Ruhe des Zimmers hörbar.',
    },
    {
      typ: 'satzbau',
      original: STELLEN.bettdecke,
      korrektur: 'die Bettdecke, bereit zum gänzlichen Niedergleiten, kaum noch halten konnte',
      erklaerung: 'Der eingeschobene Infinitivsatz macht den Nebensatz verschachtelt. Die Klammer lässt sich kürzer fassen.',
    },
  ],
  szenen: [
    {
      titel: 'Das Erwachen',
      wertung: 'stark',
      kommentar: 'Der erste Satz setzt Verwandlung und Routine in einem Atemzug. Die Bildtafel am Ende der Szene gibt die Welt preis, die Gregor verliert.',
    },
    {
      titel: 'Das Zimmer',
      wertung: 'mittel',
      kommentar: 'Der Blick auf die Wände trägt, schiebt sich aber zwischen den beiden Sätzen. Der Abschnitt könnte enger an Gregors Wahrnehmung bleiben.',
    },
  ],
  stilanalyse:
    'Der Einstieg arbeitet mit einem langen, eingebetteten Nebensatz («auf dessen Höhe sich die Bettdecke … kaum noch erhalten konnte»). Das ist der richtige Rhythmus für Kafkas Blick, trägt aber nur, wenn die Satzlänge nicht weiter wächst. Die Bilder sind konkret und bleiben im Raum — kein Beiwerk, kein Vergleich.',
  fazit:
    'Fünf Befunde, alle stilistisch. Der Einstieg ist tragfähig; die Arbeit liegt in der Satzgrenze, nicht im Bild. Nichts muss umgebaut werden.',
};

// ── Abschnitts-Chat: eine Antwort mit einer Textersetzung ────────────────────
const CHAT = {
  antwort:
    'Der erste Satz trägt die Szene, aber er stellt den Zustand fest, statt ihn zu zeigen. Zwei Eingriffe würden genügen: das Verb «wieder» macht die Rückkehr zum alten Ich lesbar, und der Nebensatz mit «erhalten konnte» lässt sich kürzer fassen, ohne das Bild zu verlieren. Beides ist Textersetzung — du entscheidest, ob du es übernimmst.',
  vorschlaege: [
    {
      original: STELLEN.verwandelt,
      ersatz: 'fand er sich in seinem Bett als ungeheueres Ungeziefer wieder',
      begruendung: '«wieder» zeigt die Rückkehr zum alten Ich; die Zustandsfeststellung «fand er sich … verwandelt» verliert daran Wirkung.',
    },
    {
      original: STELLEN.bettdecke,
      ersatz: 'die Bettdecke, bereit zum gänzlichen Niedergleiten, kaum noch halten konnte',
      begruendung: 'Kürzerer Nebensatz: der Infinitiv bleibt, die Verschachtelung geht.',
    },
  ],
  titel_varianten: [
    'Satzbau des Einstiegs',
    'Der erste Satz des Kapitels',
    'Rückkehr ins Zimmer',
  ],
  ideen: [],
};

// ── Buchbewertung ────────────────────────────────────────────────────────────
const REVIEW = {
  zusammenfassung:
    'Ein starker Einstieg, der die Verwandlung nicht erklärt, sondern geschehen lässt. Der Rückzug in den eigenen Körper trägt die erste Hälfte; die zweite Hälfte lebt vom Gegensatz zwischen der bürgerlichen Fassade der Familie und dem Ungeziefer darin.',
  struktur:
    'Zwei Kapitel, je zwei bis drei Abschnitte, mit einem klaren Bruch zwischen dem Erwachen und dem Rückzug. Die Anordnung ist schlüssig; die Familie bleibt lange im Hintergrund, was die Isolation des Protagonisten spürbar macht, den Text aber im ersten Drittel etwas dünn wirken lässt.',
  stil:
    'Satzbau und Bilderwelt sind stark und eigenständig. Der lange Nebensatz ist Signatur, kein Schliff. Schwächer sind die Passivketten in der Zustandsbeschreibung — dort verliert die Sprache an Tempo.',
  plot:
    'Der Wendepunkt liegt beim Apfel, danach führt jede Szene zur Ausgrenzung. Die drei Untermieter markieren den Verlust des Arbeitsplatzes, das Ende den der Existenz. Klar und ohne Umwege.',
  figuren:
    'Gregor trägt die Handlung allein; die Familie ist gruppiert, Grete ist die einzige Figur mit eigener Bewegung. Sie trägt das Kapitel, ohne zur Gegenspielerin zu werden.',
  dramaturgie:
    'Der Bogen steigt ruhig an: vom verschlossenen Zimmer über den Apfel bis zur letzten Stimme. Der Ausgang ist emotional abrupt, aber nicht unvorbereitet.',
  pacing:
    'Der erste Abschnitt ist der langsamste, die beiden folgenden der schnellste. Der Rhythmus passt zur Erzählung, kippt aber im letzten Abschnitt, wo zwei Todesdiagnosen direkt aufeinanderfolgen.',
  thema:
    'Entmenschlichung und die gesellschaftliche Brauchbarkeit des Menschen stehen im Zentrum — durchgehend und ohne Aussprache.',
  staerken: [
    'Der erste Satz: Zustand und Routine in einem.',
    'Konkrete, körperliche Bilder ohne Beiwerk.',
    'Die Familie bleibt kontrolliert im Hintergrund — die Verwandlung wirkt dadurch stärker.',
  ],
  schwaechen: [
    'Passivketten bremsen die Zustandsbeschreibungen im ersten Kapitel.',
    'Das zweite Kapitel verdichtet seine Szenen stärker als das erste — der Apfel wirkt dadurch etwas telegraphiert.',
    'Grete bleibt stärker eine Funktion als eine Person.',
  ],
  empfehlungen: [
    { prio: 'hoch', kategorie: 'stil', text: 'Passivketten im ersten Kapitel auflösen: der erste Satz darf nicht in Zustandsfeststellung kippen.' },
    { prio: 'mittel', kategorie: 'figuren', text: 'Grete an mindestens einer Stelle eine eigene, nicht reaktive Entscheidung geben.' },
    { prio: 'mittel', kategorie: 'pacing', text: 'Im letzten Abschnitt eine Szene Luft lassen zwischen den beiden Todesdiagnosen.' },
    { prio: 'niedrig', kategorie: 'mikro', text: 'Zwei Stellen mit «nur» prüfen — das Wort trägt im Text an anderer Stelle mehr.' },
  ],
  beispielzitate: [
    {
      kind: 'staerke',
      zitat: 'Als Gregor Samsa eines Morgens aus unruhigen Träumen erwachte, fand er sich in seinem Bett zu einem ungeheueren Ungeziefer verwandelt.',
      kommentar: 'Der erste Satz macht aus einer Katastrophe einen Morgenanfang.',
    },
    {
      kind: 'staerke',
      zitat: 'Die drei Zimmerherren waren ernste Männer.',
      kommentar: 'Drei Wörter, und die Atmosphäre der fremden Ordnung steht.',
    },
    {
      kind: 'schwaeche',
      zitat: 'Gregor verfolgte alle Geräusche durch die geschlossene Tür.',
      kommentar: 'Hier wird das Gehörte benannt statt gezeigt — die Szene verliert einen Tick theatralischer Dichte.',
    },
  ],
  fazit:
    'Ein Buch, das seine Stärke aus der Ruhe holt. Handwerklich sauber, sprachlich sehr eigenständig — mit einer klaren Baustelle: die Passivketten im ersten Kapitel.',
  gesamtnote: 4.5,
  gesamtnote_begruendung:
    'Starke Stimme und sauberer Aufbau, zwei gezielte Schwächen (Passiv, Figurendichte). Über dem Durchschnitt, mit klarer Tendenz nach oben.',
};

// ── Kapitelanalyse (Multi-Pass-Zwischenstufe; greift nur bei langen Büchern) ─
const CHAPTER_ANALYSIS = {
  themen: 'Verwandlung, Arbeit, Familie',
  stil: 'Nüchtern, körpernah, langer Nebensatz als Signatur',
  funktion_kurz: 'Trägt die Exposition und etabliert das Verhältnis von Gregor zur Familie.',
  dramaturgie_kurz: 'Der Bogen steigt vom verschlossenen Zimmer zum ersten Widerspruch.',
  pacing_kurz: 'Ruhig, mit einem deutlichen Gefälle zum Kapitelende.',
  kohaerenz_kurz: 'Zeitfolge und Raumbezüge bleiben sauber.',
  perspektive_kurz: 'Durchgehend in Gregors Wahrnehmung, ohne Erzählerkommentar.',
  figuren_kurz: 'Die Familie bleibt im Hintergrund; Grete bewegt sich als Einzige.',
  staerken: ['Konkretes Bildmaterial', 'Sicherer Perspektivwechsel'],
  schwaechen: ['Passivketten in der Zustandsbeschreibung'],
  zitate: [{ kind: 'staerke', zitat: 'Es war kein Traum.', kommentar: 'Erkenntnis in einem Satz.' }],
};

// ── Dispatch ─────────────────────────────────────────────────────────────────

function _systemText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) return system.map(s => (typeof s === 'string' ? s : (s?.text || ''))).join('\n');
  return system?.text || '';
}

function _schemaKeys(schema) {
  return schema ? Object.keys(schema.properties || {}) : [];
}

/** Antwortobjekt → Response-Shape von `callAI`/`callAIChat`. */
function _response(obj) {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return {
    text,
    truncated: false,
    tokensIn: Math.ceil(text.length / 4),
    tokensOut: Math.ceil(text.length / 4),
    cacheReadIn: 0,
    cacheCreationIn: 0,
    cacheCreation1hIn: 0,
    provider: 'claude',
    model: 'claude-sonnet-5',
    genDurationMs: 1400,
  };
}

/** Schema-Keys → Antwort. Der erste passende Ast gewinnt. */
function _answer(schemaKeys) {
  const k = new Set(schemaKeys);
  if (k.has('fehler')) return LEKTORAT;
  if (k.has('vorschlaege')) return CHAT;
  if (k.has('titel')) return { titel: 'Satzbau des Einstiegs' };
  if (k.has('gesamtnote')) return REVIEW;
  if (k.has('themen')) return CHAPTER_ANALYSIS;
  return null;
}

/** Passt die Antwort zum angefragten Schema? Unbekannte Antworten fliegen raus. */
function _filterBySchema(obj, schemaKeys) {
  if (!obj || !schemaKeys.length) return obj;
  const out = {};
  for (const k of schemaKeys) if (k in obj) out[k] = obj[k];
  // Pflichtfelder, die das Schema verlangt, aber die Antwort nicht hat → leer
  // ergänzen, sonst schlägt der Validator im Job fehl.
  return out;
}

async function callAI(prompt, system, onProgress, _maxTok, _signal, _provider, jsonSchema) {
  const schemaKeys = _schemaKeys(jsonSchema);
  const obj = _answer(schemaKeys);
  if (!obj) {
    throw new Error(`landing-shots: keine Mock-Antwort für Schema [${schemaKeys.join(', ')}] (system: ${_systemText(system).slice(0, 120)})`);
  }
  const res = _response(_filterBySchema(obj, schemaKeys));
  if (typeof onProgress === 'function') onProgress({ chars: res.text.length, tokIn: res.tokensIn });
  return res;
}

async function callAIChat(messages, system, onProgress, _maxTok, _signal, _provider, jsonSchema) {
  return callAI(
    Array.isArray(messages) ? messages.map(m => m?.content || '').join('\n') : String(messages || ''),
    system, onProgress, _maxTok, _signal, _provider, jsonSchema,
  );
}

// Tool-Use wird für die Screenshots nicht gebraucht: die agentischen Chats
// (Buch-/Recherche-/Plot-Chat) laufen in der Screenshot-Session nicht.
async function callAIWithTools() {
  throw new Error('landing-shots: Tool-Use wird von den Landing-Screenshots nicht gebraucht');
}

/**
 * Installiert den Stub in `require.cache` — muss VOR jedem `require('lib/ai')`
 * laufen. Danach sehen alle Server-Module den Stub, nicht den echten Provider.
 */
function install() {
  const aiPath = path.resolve(__dirname, '..', '..', 'lib', 'ai.js');
  const realAi = require(aiPath);
  require.cache[require.resolve(aiPath)] = {
    id: aiPath,
    filename: aiPath,
    loaded: true,
    exports: { ...realAi, callAI, callAIChat, callAIWithTools },
    children: [],
    paths: [],
  };
}

module.exports = { install, STELLEN, LEKTORAT, CHAT, REVIEW, CHAPTER_ANALYSIS };
