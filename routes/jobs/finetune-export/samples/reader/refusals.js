'use strict';

// Ablehnen lernen (Familie `refusal`, docs/finetuning.md#ablehnen):
//   - unknownEntity: erfundene Figuren, Orte und Ereignisse → «kommt in meiner
//     Geschichte nicht vor». Auch Namen, die einer echten Figur ähneln
//     (echter Vorname + erfundener Nachname) — dann mit dem Hinweis auf die
//     echte Figur, damit das Modell nicht lernt, sie zu leugnen;
//   - offTopic: buchfremde Bitten → freundlich ablehnen, zum Buch zurück;
//   - falsePremise: Frage mit falscher Annahme («Warum ist Gisela Stefans
//     Schwester?») → die Annahme korrigieren.
// Der Sampler erzeugt einen Vorrat; wie viele davon ins Set kommen, regelt
// finalize.js nach Anzahl (`refusalShare`, `refusalMix`, lib/token-mix.js).
// Jedes Sample hat eine eigene Einheit — Train und Val bekommen verschiedene
// Namen und Fragen. Vorlagen sind Trainingstext, keine UI-Strings.

const { hashSplit, nameRegex } = require('../../lib/names');
const { collectRelationFacts } = require('../core-facts/relations');
const { genderOf, roleNoun, inverseTyp, rolePhrase, cleanBeruf, isStatus } = require('../core-facts/words');

// Namensvorrat der erfundenen Figuren: je ≥ 40 Vor- und Nachnamen, damit kein
// Nachname im Set gehäuft auftaucht. Kombiniert wird über zwei gemischte
// Listen (fester Seed): Runde r paart Vorname i mit Nachname (i + r) — jeder
// Name kommt so gleich oft vor.
const FIRST = {
  de: ['Konrad', 'Helene', 'Jakob', 'Margrit', 'Severin', 'Ottilie', 'Benedikt', 'Leonore', 'Kaspar', 'Rosalie',
       'Florian', 'Adelheid', 'Lukas', 'Theres', 'Valentin', 'Mechthild', 'Urban', 'Klothilde', 'Ruedi', 'Verena',
       'Balthasar', 'Gertrud', 'Ignaz', 'Hedwig', 'Leopold', 'Brigitta', 'Silvan', 'Eugenie', 'Gottfried', 'Irmgard',
       'Anselm', 'Philomena', 'Cyrill', 'Walburga', 'Fridolin', 'Notburga', 'Remo', 'Agathe', 'Damian', 'Isidora',
       'Eusebius', 'Cäcilia', 'Pankraz', 'Henriette', 'Vinzenz', 'Kunigunde', 'Gebhard', 'Mathilde', 'Lorenz', 'Seraina'],
  en: ['Harold', 'Delia', 'Ambrose', 'Prudence', 'Silas', 'Rosalind', 'Jasper', 'Winifred', 'Barnaby', 'Cordelia',
       'Tobias', 'Philippa', 'Rupert', 'Imogen', 'Cedric', 'Beatrix', 'Horace', 'Lavinia', 'Percival', 'Millicent',
       'Algernon', 'Henrietta', 'Bartholomew', 'Clementine', 'Ezekiel', 'Ottoline', 'Fitzroy', 'Marigold', 'Godfrey', 'Euphemia',
       'Lancelot', 'Araminta', 'Thaddeus', 'Wilhelmina', 'Mortimer', 'Perpetua', 'Leopold', 'Dorcas', 'Crispin', 'Theodora'],
};
const LAST = {
  de: ['Albisser', 'Brunnmeier', 'Wettstein', 'Oberholzer', 'Kaltenbach', 'Rauschert', 'Imhof', 'Fässler', 'Zumsteg', 'Tschopp',
       'Hollenstein', 'Eberle', 'Gasser', 'Wyrsch', 'Niederöst', 'Bachofner', 'Strebel', 'Ruckstuhl', 'Hürlimann', 'Lanzrein',
       'Schwendener', 'Dürrenberger', 'Wasmer', 'Kilchherr', 'Zgraggen', 'Brändle', 'Obrist', 'Marfurt', 'Gisler', 'Hänggi',
       'Aeschbacher', 'Bürgisser', 'Christen', 'Dettwiler', 'Egloff', 'Fankhauser', 'Gübeli', 'Hunkeler', 'Jäggi', 'Kägi',
       'Lüscher', 'Mettler', 'Nussbaumer', 'Pfister', 'Rüegsegger', 'Stalder', 'Tobler', 'Vögeli', 'Wüthrich', 'Zbinden'],
  en: ['Whitcombe', 'Fairbanks', 'Kettering', 'Ashdown', 'Thornbury', 'Pemberly', 'Lockridge', 'Calloway', 'Hollingsworth', 'Mapplethorpe',
       'Blackwood', 'Fenwick', 'Hargreaves', 'Wetherby', 'Grimsditch', 'Ollerenshaw', 'Pettigrew', 'Thistlewood', 'Crabtree', 'Duckworth',
       'Applegarth', 'Bramwell', 'Cheesewright', 'Dunstable', 'Eversleigh', 'Fotheringham', 'Gatehouse', 'Huxtable', 'Ingleby', 'Jessop',
       'Kenwright', 'Langstaff', 'Merriweather', 'Nethercott', 'Oddington', 'Pockley', 'Quarrington', 'Rowbotham', 'Shufflebottom', 'Tattersall'],
};
const PLACE_A = {
  de: ['Eschen', 'Kalt', 'Nord', 'Marien', 'Falken', 'Linden', 'Roten', 'Birken', 'Hasel', 'Weiden', 'Ulmen', 'Erlen',
       'Tannen', 'Moos', 'Stein', 'Wolfs', 'Fuchs', 'Rosen', 'Hagen', 'Brunnen'],
  en: ['Ash', 'Grey', 'Elver', 'Marrow', 'Brack', 'Hens', 'Thorn', 'Willow', 'Raven', 'Holly', 'Fern', 'Oak', 'Stoat', 'Bramble'],
};
const PLACE_B = {
  de: ['ried', 'brunn', 'hafen', 'au', 'stieg', 'moos', 'wil', 'egg', 'tal', 'hofen', 'acker', 'bühl', 'matt', 'wangen'],
  en: ['combe', 'water', 'ton', 'dene', 'ley', 'ford', 'mere', 'wick', 'holt', 'stead', 'bury', 'cliffe'],
};
const FAKE_EVENTS = {
  de: ['der Brand in der Sägerei', 'das Zugunglück am Bahnübergang', 'der Überfall auf die Kantonalbank', 'die Lawine im Hochtal',
       'die Entführung des Gemeindepräsidenten', 'der Schiffbruch auf dem Stausee', 'der Diebstahl der Monstranz',
       'die Explosion in der Feuerwerksfabrik', 'das Jahrhunderthochwasser', 'der Einsturz der Holzbrücke',
       'das Erdbeben während der Fasnacht', 'der Streik in der Uhrenfabrik', 'die Sprengung des Staudamms',
       'der Absturz der Seilbahn', 'die Vergiftung am Dorffest', 'der Grossbrand im Kloster', 'die Flucht aus dem Bezirksgefängnis',
       'der Bergsturz über dem Dorf', 'die Schlägerei am Schützenfest', 'der Konkurs der Dorfkäserei'],
  en: ['the fire at the sawmill', 'the train crash at the level crossing', 'the robbery at the county bank', 'the avalanche in the high valley',
       "the mayor's kidnapping", 'the shipwreck on the reservoir', 'the theft of the monstrance', 'the explosion at the fireworks factory',
       'the earthquake during the carnival', 'the strike at the watch factory', 'the cable car crash', 'the poisoning at the village fair',
       'the prison break', 'the landslide above the village'],
};

// Paare ohne gehäufte Namen: Runde r paart firsts[i] mit lasts[(i + r) % n].
function spreadPairs(firsts, lasts, ordered) {
  const fs = ordered(firsts, 'fn|');
  const ls = ordered(lasts, 'ln|');
  const out = [];
  const rounds = Math.min(fs.length, ls.length);
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < fs.length; i++) out.push(`${fs[i]} ${ls[(i + r) % ls.length]}`);
  }
  return out;
}

const T = {
  de: {
    figQ: ['Wer ist {x}?', 'Was weisst du über {x}?', 'Welche Rolle spielt {x} in deiner Geschichte?', 'Erzähl mir von {x}.', 'Was macht {x} beruflich?'],
    figRelQ: 'Wie steht {real} zu {x}?',
    figA: ['Eine Figur namens {x} kommt in meiner Geschichte nicht vor.', '{x} kenne ich nicht – in «{book}» gibt es niemanden mit diesem Namen.',
           'Von {x} erzähle ich nirgends. Diese Figur gibt es in «{book}» nicht.', 'Nach {x} suchst du bei mir vergeblich: Diese Figur kommt in meiner Geschichte nicht vor.'],
    figRelA: '{x} kommt in meiner Geschichte nicht vor, also gibt es auch keine Beziehung zu {real}.',
    nearHint: ' Meinst du vielleicht {real}?',
    placeQ: ['Was passiert in {x}?', 'Beschreibe {x}.', 'Wer lebt in {x}?', 'Was ist {x} für ein Ort?'],
    placeA: ['Einen Ort namens {x} gibt es in meiner Geschichte nicht.', '{x} kommt in «{book}» nicht vor – meine Geschichte spielt anderswo.',
             'In {x} spielt keine Szene von «{book}»; diesen Ort kenne ich nicht.'],
    // Ereignisse stehen mit Artikel im Nominativ («das Jahrhunderthochwasser»):
    // nur Vorlagen, in denen sie Subjekt sind — «bei das …» wäre falsch.
    eventQ: ['Wann war {x}?', 'Wer war dabei, als {x} geschah?', 'Was hat {x} ausgelöst?'],
    eventA: ['Davon erzähle ich nicht: {x} kommt in meiner Geschichte nicht vor.', '{X} kommt in «{book}» nicht vor.'],
    offA: ['{Thing} kann ich dir nicht geben – ich bin «{book}» und kenne nur meine eigene Geschichte. Frag mich lieber nach {hook}.',
           'Für {thing} bin ich nicht die richtige Adresse: Ich weiss nur, was zwischen meinen Buchdeckeln geschieht. Wie wäre es mit einer Frage zu {hook}?',
           'Um {thing} kümmere ich mich nicht, das liegt ausserhalb meiner Seiten. Über {hook} erzähle ich dir aber gern.'],
    fpRelQ: ['Warum ist {y} {wrong}?', 'Seit wann ist {y} {wrong}?', 'Wie kam es, dass {y} {wrong} ist?'],
    fpRelA: ['Das stimmt so nicht: {y} ist nicht {wrong}, sondern {right}.', 'Da liegt ein Irrtum vor. {y} ist {right}, nicht {wrong}.'],
    fpJobQ: ['Warum arbeitet {n} als {wrong}?', 'Wie lange arbeitet {n} schon als {wrong}?'],
    fpJobA: ['{n} arbeitet nicht als {wrong}, sondern als {right}.', 'Das stimmt nicht: {n} ist von Beruf {right}, nicht {wrong}.'],
    fpYearQ: ['Warum wurde {n} {wrong} geboren?', 'Was geschah, als {n} {wrong} zur Welt kam?'],
    fpYearA: ['Das stimmt nicht: {n} wurde nicht {wrong}, sondern {right} geboren.', '{n} kam {right} zur Welt, nicht {wrong}.'],
  },
  en: {
    figQ: ['Who is {x}?', 'What do you know about {x}?', 'What role does {x} play in your story?', 'Tell me about {x}.', 'What does {x} do for a living?'],
    figRelQ: 'How does {real} relate to {x}?',
    figA: ['There is no character called {x} in my story.', "I don't know {x} – nobody by that name appears in «{book}».",
           'I never tell of {x}. That character does not exist in «{book}».', "You won't find {x} in me: that character is not part of my story."],
    figRelA: '{x} does not appear in my story, so there is no relationship to {real} either.',
    nearHint: ' Do you perhaps mean {real}?',
    placeQ: ['What happens in {x}?', 'Describe {x}.', 'Who lives in {x}?', 'What kind of place is {x}?'],
    placeA: ['There is no place called {x} in my story.', '{x} does not appear in «{book}» – my story is set elsewhere.',
             'No scene of «{book}» takes place in {x}; I do not know that place.'],
    eventQ: ['What happened at {x}?', 'When does {x} happen?', 'Who was there at {x}?'],
    eventA: ['I do not tell of that: {x} is not part of my story.', '{X} does not exist in «{book}».'],
    offA: ['I cannot give you {thing} – I am «{book}» and only know my own story. Ask me about {hook} instead.',
           'I am not the right place for {thing}: I only know what happens between my covers. How about a question about {hook}?',
           'I do not deal with {thing}; that lies outside my pages. But I will gladly tell you about {hook}.'],
    fpRelQ: ['Why is {y} {wrong}?', 'Since when is {y} {wrong}?', 'How did {y} become {wrong}?'],
    fpRelA: ['That is not quite right: {y} is not {wrong} but {right}.', 'There is a mistake there. {y} is {right}, not {wrong}.'],
    fpJobQ: ['Why does {n} work as {wrong}?', 'How long has {n} worked as {wrong}?'],
    fpJobA: ['{n} does not work as {wrong} but as {right}.', 'That is not right: {n} works as {right}, not as {wrong}.'],
    fpYearQ: ['Why was {n} born in {wrong}?', 'What happened when {n} was born in {wrong}?'],
    fpYearA: ['That is not right: {n} was not born in {wrong} but in {right}.', '{n} was born in {right}, not in {wrong}.'],
  },
};

// Buchfremde Bitten, mit Akkusativ-Phrase für die Antwort.
const OFF_TOPIC = {
  de: [
    ['Kannst du mir ein Rezept für Lasagne geben?', 'ein Lasagne-Rezept'], ['Wie wird das Wetter morgen?', 'eine Wettervorhersage'],
    ['Schreib mir ein Python-Skript, das Dateien sortiert.', 'ein Python-Skript'], ['Was ist die Hauptstadt von Australien?', 'Erdkunde-Wissen'],
    ['Hilf mir bei meiner Steuererklärung.', 'deine Steuererklärung'], ['Wer gewinnt die nächste Wahl?', 'eine Wahlprognose'],
    ['Übersetze bitte «Guten Morgen» ins Französische.', 'eine Übersetzung'], ['Wie viel ist 17 mal 23?', 'eine Rechenaufgabe'],
    ['Erzähl mir einen Witz.', 'einen beliebigen Witz'], ['Welche Aktien soll ich kaufen?', 'einen Anlagetipp'],
    ['Schreib mir ein Bewerbungsschreiben.', 'ein Bewerbungsschreiben'], ['Was hältst du vom aktuellen Fussballtrainer?', 'eine Meinung zum Fussball'],
    ['Wie repariere ich einen tropfenden Wasserhahn?', 'eine Reparaturanleitung'], ['Welches Handy soll ich mir kaufen?', 'eine Kaufberatung'],
    ['Erklär mir die Relativitätstheorie.', 'eine Physik-Erklärung'], ['Wie lange muss ein Ei kochen?', 'einen Kochtipp'],
    ['Schreib mir eine SQL-Abfrage für alle Kunden.', 'eine SQL-Abfrage'], ['Was sind die Symptome einer Grippe?', 'medizinischen Rat'],
    ['Plane mir eine Woche Ferien in Italien.', 'eine Reiseplanung'], ['Wie viele Einwohner hat die Schweiz?', 'eine Einwohnerzahl'],
    ['Formuliere mir eine Kündigung für meine Wohnung.', 'ein Kündigungsschreiben'], ['Wie funktioniert eine Wärmepumpe?', 'eine Technik-Erklärung'],
    ['Was ist der Unterschied zwischen Java und JavaScript?', 'Programmier-Wissen'], ['Gib mir ein Trainingsprogramm fürs Fitnessstudio.', 'ein Trainingsprogramm'],
    ['Wer hat die Fussball-WM 2014 gewonnen?', 'Sportergebnisse'], ['Wie mache ich einen Sauerteig?', 'ein Sauerteig-Rezept'],
    ['Schreib mir ein Gedicht über den Herbst.', 'ein Herbstgedicht'], ['Was kostet ein Liter Benzin gerade?', 'aktuelle Preise'],
    ['Wie installiere ich Linux?', 'eine Installationsanleitung'], ['Welcher Film läuft heute im Kino?', 'das Kinoprogramm'],
    ['Kannst du mir bei den Mathe-Hausaufgaben helfen?', 'Hausaufgabenhilfe'], ['Wie pflege ich eine Orchidee?', 'einen Gartentipp'],
    ['Was ist Bitcoin?', 'eine Erklärung zu Bitcoin'], ['Welche Zeitzone hat New York?', 'eine Zeitzonen-Auskunft'],
    ['Wie halte ich eine gute Präsentation?', 'Präsentationstipps'], ['Was soll ich heute kochen?', 'einen Menüvorschlag'],
  ],
  en: [
    ['Can you give me a lasagna recipe?', 'a lasagna recipe'], ['What will the weather be like tomorrow?', 'a weather forecast'],
    ['Write me a Python script that sorts files.', 'a Python script'], ['What is the capital of Australia?', 'geography facts'],
    ['Help me with my tax return.', 'help with your tax return'], ['Who will win the next election?', 'an election forecast'],
    ['Please translate «good morning» into French.', 'a translation'], ['What is 17 times 23?', 'arithmetic'],
    ['Tell me a joke.', 'a random joke'], ['Which stocks should I buy?', 'investment advice'],
    ['Write me a cover letter.', 'a cover letter'], ['What do you think of the current football coach?', 'an opinion on football'],
    ['How do I fix a dripping tap?', 'repair instructions'], ['Which phone should I buy?', 'shopping advice'],
    ['Explain the theory of relativity.', 'a physics lesson'], ['How long should I boil an egg?', 'a cooking tip'],
    ['Write me an SQL query for all customers.', 'an SQL query'], ['What are the symptoms of flu?', 'medical advice'],
    ['Plan a week of holidays in Italy for me.', 'travel planning'], ['How many people live in Switzerland?', 'population figures'],
    ['How do I install Linux?', 'installation instructions'], ['What is Bitcoin?', 'an explanation of Bitcoin'],
  ],
};

const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
const capFirst = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Ein erfundener Name darf weder als Ganzes noch mit einem seiner Wörter im Buch
// vorkommen — sonst brächte das Sample dem Modell bei, eine echte Figur zu leugnen.
function unknownNames(pool, haystackLower) {
  return pool.filter(n => !n.toLowerCase().split(/\s+/).some(w => w.length >= 4 && haystackLower.includes(w)));
}

// Haystack: Buchtext + alle Figuren- und Ortsnamen, kleingeschrieben.
function buildHaystack(ctx) {
  const { pageContents, figRows, locRows } = ctx;
  return pageContents.map(p => p.text || '').join('\n').toLowerCase()
    + '\n' + figRows.map(f => `${f.name} ${f.kurzname || ''}`).join(' ').toLowerCase()
    + '\n' + locRows.map(l => l.name).join(' ').toLowerCase();
}

// Falsche Rolle für eine Beziehung: plausibel, aber unvereinbar. Plausibel
// heisst: dieselbe Generation, wenn die falsche Rolle Geschwister oder Partner
// ist, die ältere, wenn sie Elternteil oder Mentor ist, die jüngere bei Kind
// oder Schützling (`WRONG_NEEDS`). Die Generation folgt aus dem echten Typ
// (Eltern +1, Kind −1, Geschwister/Partner 0) oder aus den Geburtsjahren;
// ist sie unbekannt, entfällt eine generationsgebundene Falschannahme. Keine
// Prämisse «Renate ist die Mutter ihres Vorgesetzten».
const WRONG_TYP = {
  elternteil: 'mentor', kind: 'schuetzling', geschwister: 'kollege', ehepartner: 'geschwister',
  ex_partner: 'geschwister', freund: 'feind', feind: 'freund', kollege: 'vorgesetzter', vorgesetzter: 'kollege',
  untergebener: 'kollege', mentor: 'elternteil', schuetzling: 'kind', rivale: 'freund', liebesbeziehung: 'geschwister',
};
// Generation von Y gegenüber X, die die falsche Rolle voraussetzt.
const WRONG_NEEDS = { geschwister: 0, ehepartner: 0, ex_partner: 0, elternteil: 1, mentor: 1, kind: -1, schuetzling: -1 };
const GEN_OF_TYP = { elternteil: 1, kind: -1, geschwister: 0, ehepartner: 0, ex_partner: 0, liebesbeziehung: 0 };

// Generation von Y gegenüber X: +1 älter (≥ 15 Jahre), −1 jünger, 0 gleich
// (≤ 10 Jahre), null unbekannt.
function generation(typY, yearX, yearY) {
  if (typY in GEN_OF_TYP) return GEN_OF_TYP[typY];
  if (!yearX || !yearY) return null;
  const d = yearX - yearY;
  if (d >= 15) return 1;
  if (d <= -15) return -1;
  return Math.abs(d) <= 10 ? 0 : null;
}

function buildRefusalSamples(ctx, push) {
  const { langIsEn, displayName: book, figRows, opts, eligibleFigIds } = ctx;
  const seed = opts.valSeed;
  const lang = langIsEn ? 'en' : 'de';
  const t = T[lang];
  const hay = buildHaystack(ctx);
  const pick = (arr, key) => arr[Math.floor(hashSplit(key, seed) * arr.length)];
  const ordered = (arr, tag) => [...arr].sort((a, b) => hashSplit(tag + a, seed) - hashSplit(tag + b, seed));
  // Nur benannte Figuren (core-facts/naming.js): keine Falschannahme über
  // «Herr Koch (Primarlehrer)» oder «Renates Vorgesetzter bei der SoBa».
  const realFigs = figRows
    .filter(f => f.name && (!eligibleFigIds || eligibleFigIds.has(f.fig_id)) && ctx.figNameInfo?.get(f.fig_id)?.proper !== false)
    .map(f => ({ ...f, name: ctx.figNameInfo?.get(f.fig_id)?.name || f.name }));
  const birthYearOf = (f) => (ctx.eventsByFigPk?.get(f.pk) || []).find(e => e.subtyp === 'geburt' && e.datum_year)?.datum_year || null;
  // Zurück zum Buch über die meistgenannten Figuren — ein Ortsname («Frag
  // mich lieber nach Speisesaal») passt grammatisch selten.
  const mentions = ctx.figMentions || new Map();
  const hooks = [...realFigs].filter(f => !/[()]/.test(f.name))
    .sort((a, b) => (mentions.get(b.fig_id) || 0) - (mentions.get(a.fig_id) || 0))
    .slice(0, 8).map(f => f.name);
  const hookAt = (key) => (hooks.length ? pick(hooks, 'hook|' + key) : (langIsEn ? 'my story' : 'meine Geschichte'));
  const one = (kind, key, q, a) => push({ id: `refusal|${kind}|${key}`, unit: `ref:${kind}:${key}`, turns: [[q, a]] });

  // ── Unbekannte Figuren ──────────────────────────────────────────────
  const firsts = unknownNames(FIRST[lang], hay);
  const lasts = unknownNames(LAST[lang], hay);
  for (const x of spreadPairs(firsts, lasts, ordered).slice(0, 220)) {
    const useRel = realFigs.length && hashSplit('ufRel|' + x, seed) < 0.15;
    if (useRel) {
      const real = pick(realFigs, 'ufReal|' + x).name;
      one('unknownFig', x, fill(t.figRelQ, { x, real }), fill(t.figRelA, { x, real }));
    } else {
      one('unknownFig', x, fill(pick(t.figQ, 'ufQ|' + x), { x }), fill(pick(t.figA, 'ufA|' + x), { x, book }));
    }
  }
  // Ähnlich einer echten Figur: echter Vorname + erfundener Nachname.
  for (const f of realFigs) {
    if (/[()]/.test(f.name)) continue;
    const parts = f.name.trim().split(/\s+/);
    if (parts.length < 2 || !lasts.length) continue;
    const x = `${parts[0]} ${pick(lasts, 'near|' + f.fig_id)}`;
    if (nameRegex(x).test(hay)) continue;
    one('unknownNear', x, fill(pick(t.figQ, 'nearQ|' + x), { x }),
      fill(pick(t.figA, 'nearA|' + x), { x, book }) + fill(t.nearHint, { real: f.name }));
  }
  // ── Unbekannte Orte und Ereignisse ──────────────────────────────────
  const places = [];
  for (const a of PLACE_A[lang]) for (const b of PLACE_B[lang]) places.push(a + b);
  for (const x of ordered(unknownNames(places, hay), 'up|').slice(0, 60)) {
    one('unknownPlace', x, fill(pick(t.placeQ, 'upQ|' + x), { x }), fill(pick(t.placeA, 'upA|' + x), { x, book }));
  }
  const eventOk = (e) => !e.split(/\s+/).some(w => w.length >= 5 && /^\p{Lu}/u.test(w) && hay.includes(w.toLowerCase()));
  for (const x of FAKE_EVENTS[lang].filter(eventOk)) {
    one('unknownEvent', x, fill(pick(t.eventQ, 'ueQ|' + x), { x }), fill(pick(t.eventA, 'ueA|' + x), { x, X: capFirst(x), book }));
  }

  // ── Off-Topic: zwei Antworten pro Frage, gleiche Einheit ────────────
  OFF_TOPIC[lang].forEach(([q, thing], i) => {
    for (let v = 0; v < 2; v++) {
      const tpl = t.offA[(i + v) % t.offA.length];
      push({
        id: `refusal|offTopic|${i}|${v}`, unit: `ref:offTopic:${i}`,
        turns: [[q, fill(tpl, { thing, Thing: capFirst(thing), book, hook: hookAt(`off|${i}|${v}`) })]],
      });
    }
  });

  // ── Falsche Annahme ─────────────────────────────────────────────────
  const relFacts = ctx.relationFacts || collectRelationFacts(ctx).facts;
  for (const r of relFacts) {
    // Rolle von b gegenüber a: r.typ. Frage über b aus Sicht von a.
    for (const [X, Y, typY] of [[r.a, r.b, r.typ], [r.b, r.a, inverseTyp(r.typ)]]) {
      const wrongTyp = WRONG_TYP[typY];
      if (wrongTyp in WRONG_NEEDS && generation(typY, birthYearOf(X), birthYearOf(Y)) !== WRONG_NEEDS[wrongTyp]) continue;
      const right = roleNoun(typY, genderOf(Y), langIsEn);
      const wrong = wrongTyp && roleNoun(wrongTyp, genderOf(Y), langIsEn);
      if (!right || !wrong || right.noun === wrong.noun) continue;
      const vars = { y: Y.name, wrong: rolePhrase(X.name, wrong, wrongTyp, langIsEn), right: rolePhrase(X.name, right, typY, langIsEn) };
      const key = `rel|${X.fig_id}|${Y.fig_id}`;
      one('falsePremise', key, fill(pick(t.fpRelQ, 'fpQ|' + key), vars), fill(pick(t.fpRelA, 'fpA|' + key), vars));
    }
  }
  // Nur echte Berufe: «Warum arbeitet X als Schüler?» wäre schief.
  const withJob = realFigs.map(f => ({ f, job: cleanBeruf(f.beruf) })).filter(x => x.job && !isStatus(x.job));
  for (const { f, job } of withJob) {
    const other = withJob.filter(x => x.f.fig_id !== f.fig_id && x.job.toLowerCase() !== job.toLowerCase());
    if (!other.length) continue;
    const vars = { n: f.name, right: job, wrong: pick(other, 'fpJob|' + f.fig_id).job };
    const key = `job|${f.fig_id}`;
    one('falsePremise', key, fill(pick(t.fpJobQ, 'fpJQ|' + key), vars), fill(pick(t.fpJobA, 'fpJA|' + key), vars));
  }
  for (const f of realFigs) {
    const year = birthYearOf(f);
    if (!year) continue;
    const shift = 3 + Math.floor(hashSplit('fpY|' + f.fig_id, seed) * 12);
    const vars = { n: f.name, right: String(year), wrong: String(year + (hashSplit('fpYs|' + f.fig_id, seed) < 0.5 ? -shift : shift)) };
    const key = `year|${f.fig_id}`;
    one('falsePremise', key, fill(pick(t.fpYearQ, 'fpYQ|' + key), vars), fill(pick(t.fpYearA, 'fpYA|' + key), vars));
  }
}

module.exports = { buildRefusalSamples, unknownNames, buildHaystack, spreadPairs, generation, OFF_TOPIC, REFUSAL_TEXT: T, FIRST, LAST, PLACE_A, PLACE_B, FAKE_EVENTS, WRONG_TYP, WRONG_NEEDS };
