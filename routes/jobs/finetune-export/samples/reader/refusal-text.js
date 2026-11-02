'use strict';

// Vorlagen und Namensvorräte für das Ablehnen (./refusals.js) und die
// Ablehnungs-Kategorien des Eval-Sets (./eval.js). Trainingstext, keine
// UI-Strings.

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
// Häufige Namen — erfundene Figuren, die echt klingen. Was im Buch vorkommt,
// fällt weg (refusals.js#unknownNames).
const COMMON_FIRST = {
  de: ['Daniel', 'Thomas', 'Andrea', 'Monika', 'Martin', 'Sandra', 'Christian', 'Nicole', 'Marco', 'Barbara', 'Reto', 'Claudia', 'Beat', 'Esther', 'Urs', 'Ursula'],
  en: ['James', 'Sarah', 'Michael', 'Emma', 'David', 'Laura', 'Robert', 'Claire', 'Paul', 'Helen'],
};
const COMMON_LAST = {
  de: ['Müller', 'Meier', 'Schmid', 'Keller', 'Weber', 'Huber', 'Schneider', 'Steiner', 'Fischer', 'Gerber', 'Brunner', 'Baumann', 'Frei', 'Zimmermann', 'Moser', 'Widmer', 'Wyss', 'Graf', 'Roth', 'Kunz'],
  en: ['Smith', 'Jones', 'Taylor', 'Brown', 'Wilson', 'Evans', 'Thomas', 'Roberts', 'Walker', 'Wright'],
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
       'der Bergsturz über dem Dorf', 'die Schlägerei am Schützenfest', 'der Konkurs der Dorfkäserei', 'der Brand in der Kantonsschule',
       'der Raub im Juweliergeschäft', 'die Geiselnahme im Postbüro'],
  en: ['the fire at the sawmill', 'the train crash at the level crossing', 'the robbery at the county bank', 'the avalanche in the high valley',
       "the mayor's kidnapping", 'the shipwreck on the reservoir', 'the theft of the monstrance', 'the explosion at the fireworks factory',
       'the earthquake during the carnival', 'the strike at the watch factory', 'the cable car crash', 'the poisoning at the village fair',
       'the prison break', 'the landslide above the village', 'the fire at the grammar school', 'the hostage-taking at the post office'],
};

// Namen und Ereignisse, die nur das Eval-Set fragt — nie im Train.
const EVAL_FAKES = {
  de: ['Konstantin Zwyssig', 'Aurelia Pfändler', 'Gebhard Nüesch', 'Theodora Ammann-Lüthi', 'Cyprian Haldimann',
       'Leandra Kälin', 'Orlando Spörri', 'Felizitas Brügger', 'Dominik Rothacher', 'Annina Gschwind', 'Ruben Achermann', 'Selina Inäbnit'],
  en: ['Constantine Hartwell', 'Aurelia Pendergast', 'Gideon Marchbanks', 'Theodora Ashcombe-Lyle', 'Cyprian Holloway',
       'Leandra Fairweather', 'Orlando Brackenbury', 'Felicity Cartwright', 'Dominic Ravensworth', 'Annabel Thorncroft', 'Reuben Ashby', 'Selina Woodruff'],
};

const T = {
  de: {
    // Frageformen, die keine Porträt-/Beziehungsvorlage sind.
    figQ: ['Was macht {x} beruflich?', 'Wie alt ist {x}?', 'Wo wohnt {x}?', 'Was erlebt {x} in deiner Geschichte?'],
    figA: ['Eine Figur namens {x} kommt in meiner Geschichte nicht vor.', '{x} kenne ich nicht – in «{book}» gibt es niemanden mit diesem Namen.',
           'Von {x} erzähle ich nirgends. Diese Figur gibt es in «{book}» nicht.', 'Nach {x} suchst du bei mir vergeblich: Diese Figur kommt in meiner Geschichte nicht vor.',
           'Jemanden namens {x} gibt es in «{book}» nicht.'],
    figRelA: ['{x} kommt in meiner Geschichte nicht vor, also gibt es auch keine Beziehung zu {real}.',
              'Eine Figur namens {x} gibt es in «{book}» nicht – also auch keine Verbindung zu {real}.',
              'Zwischen {real} und {x} gibt es nichts zu erzählen: {x} kommt in meiner Geschichte nicht vor.'],
    nearHint: [' Meinst du vielleicht {real}?', ' Vielleicht meinst du {real}?'],
    placeQ: ['Was passiert in {x}?', 'Beschreibe {x}.', 'Wer lebt in {x}?', 'Was ist {x} für ein Ort?', 'Welche Szene spielt in {x}?'],
    placeA: ['Einen Ort namens {x} gibt es in meiner Geschichte nicht.', '{x} kommt in «{book}» nicht vor – meine Geschichte spielt anderswo.',
             'In {x} spielt keine Szene von «{book}»; diesen Ort kenne ich nicht.'],
    // Ereignisse stehen mit Artikel im Nominativ («das Jahrhunderthochwasser»):
    // nur Vorlagen, in denen sie Subjekt sind — «bei das …» wäre falsch.
    eventQ: ['Wann war {x}?', 'Wer war dabei, als {x} geschah?', 'Was hat {x} ausgelöst?', 'Erzähl mir, wie {x} ablief.'],
    eventA: ['Davon erzähle ich nicht: {x} kommt in meiner Geschichte nicht vor.', '{X} kommt in «{book}» nicht vor.',
             '{X} gibt es in meiner Geschichte nicht.'],
    mixedQ: ['Wer sind {real} und {x}?', 'Erzähl mir von {real} und {x}.', 'Was weisst du über {real} und {x}?', 'Kennst du {real} und {x}?',
             'Wer sind {x} und {real}?'],
    mixedReal: ['{real} ist {type} meiner Geschichte.', '{real} kenne ich gut: {type} meiner Geschichte.'],
    mixedFake: ['Eine Figur namens {x} kommt in meiner Geschichte dagegen nicht vor.', 'Jemanden namens {x} gibt es bei mir aber nicht.',
                '{x} hingegen kenne ich nicht – diese Figur kommt in «{book}» nicht vor.'],
    // Steht der erfundene Name zuerst, ohne «dagegen»/«aber».
    mixedFakeFirst: ['Eine Figur namens {x} kommt in meiner Geschichte nicht vor.', '{x} kenne ich nicht – diese Figur gibt es in «{book}» nicht.'],
    offA: ['{Thing} kann ich dir nicht geben – ich bin «{book}» und kenne nur meine eigene Geschichte. Frag mich lieber nach {hook}.',
           'Für {thing} bin ich nicht die richtige Adresse: Ich weiss nur, was zwischen meinen Buchdeckeln geschieht. Wie wäre es mit einer Frage zu {hook}?',
           'Um {thing} kümmere ich mich nicht, das liegt ausserhalb meiner Seiten. Über {hook} erzähle ich dir aber gern.',
           'Da muss ich passen: {thing} liegt ausserhalb meiner Seiten. Ich erzähle dir lieber von {hook}.'],
    fpRelQ: ['Warum ist {y} {wrong}?', 'Seit wann ist {y} {wrong}?', 'Wie kam es, dass {y} {wrong} ist?', 'Ist {y} {wrong}?'],
    // Die Richtigstellung steht immer in voller Form: «… sondern Giselas Sohn.»
    fpRelA: ['Das stimmt so nicht: {y} ist nicht {wrong}, sondern {right}.', 'Da liegt ein Irrtum vor. {y} ist {right}, nicht {wrong}.'],
    fpRelYesNoA: 'Nein, {y} ist nicht {wrong}, sondern {right}.',
    fpJobQ: ['Warum arbeitet {n} als {wrong}?', 'Wie lange arbeitet {n} schon als {wrong}?'],
    fpJobA: ['{n} arbeitet nicht als {wrong}, sondern als {right}.', 'Das stimmt nicht: {n} ist von Beruf {right}, nicht {wrong}.'],
    fpYearQ: ['Warum wurde {n} {wrong} geboren?', 'Was geschah, als {n} {wrong} zur Welt kam?'],
    fpYearA: ['Das stimmt nicht: {n} wurde nicht {wrong}, sondern {right} geboren.', '{n} kam {right} zur Welt, nicht {wrong}.'],
  },
  en: {
    figQ: ['What does {x} do for a living?', 'How old is {x}?', 'Where does {x} live?', 'What does {x} go through in your story?'],
    figA: ['There is no character called {x} in my story.', "I don't know {x} – nobody by that name appears in «{book}».",
           'I never tell of {x}. That character does not exist in «{book}».', "You won't find {x} in me: that character is not part of my story.",
           'Nobody called {x} exists in «{book}».'],
    figRelA: ['{x} does not appear in my story, so there is no relationship to {real} either.',
              'There is no character called {x} in «{book}» – so there is no connection to {real} either.',
              'There is nothing to tell about {real} and {x}: {x} does not appear in my story.'],
    nearHint: [' Do you perhaps mean {real}?', ' Maybe you mean {real}?'],
    placeQ: ['What happens in {x}?', 'Describe {x}.', 'Who lives in {x}?', 'What kind of place is {x}?', 'Which scene is set in {x}?'],
    placeA: ['There is no place called {x} in my story.', '{x} does not appear in «{book}» – my story is set elsewhere.',
             'No scene of «{book}» takes place in {x}; I do not know that place.'],
    eventQ: ['What happened at {x}?', 'When does {x} happen?', 'Who was there at {x}?', 'Tell me how {x} unfolded.'],
    eventA: ['I do not tell of that: {x} is not part of my story.', '{X} does not exist in «{book}».', '{X} is not part of my story.'],
    mixedQ: ['Who are {real} and {x}?', 'Tell me about {real} and {x}.', 'What do you know about {real} and {x}?', 'Do you know {real} and {x}?',
             'Who are {x} and {real}?'],
    mixedReal: ['{real} is {type} of my story.', 'I know {real} well: {type} of my story.'],
    mixedFake: ['A character called {x}, however, does not appear in my story.', 'But nobody called {x} exists in me.',
                '{x}, on the other hand, I do not know – that character is not in «{book}».'],
    mixedFakeFirst: ['There is no character called {x} in my story.', "I don't know {x} – that character does not exist in «{book}»."],
    offA: ['I cannot give you {thing} – I am «{book}» and only know my own story. Ask me about {hook} instead.',
           'I am not the right place for {thing}: I only know what happens between my covers. How about a question about {hook}?',
           'I do not deal with {thing}; that lies outside my pages. But I will gladly tell you about {hook}.',
           'I have to pass on {thing}: that lies outside my pages. Let me tell you about {hook} instead.'],
    fpRelQ: ['Why is {y} {wrong}?', 'Since when is {y} {wrong}?', 'How did {y} become {wrong}?', 'Is {y} {wrong}?'],
    fpRelA: ['That is not quite right: {y} is not {wrong} but {right}.', 'There is a mistake there. {y} is {right}, not {wrong}.'],
    fpRelYesNoA: 'No, {y} is not {wrong} but {right}.',
    fpJobQ: ['Why does {n} work as {wrong}?', 'How long has {n} worked as {wrong}?'],
    fpJobA: ['{n} does not work as {wrong} but as {right}.', 'That is not right: {n} works as {right}, not as {wrong}.'],
    fpYearQ: ['Why was {n} born in {wrong}?', 'What happened when {n} was born in {wrong}?'],
    fpYearA: ['That is not right: {n} was not born in {wrong} but in {right}.', '{n} was born in {right}, not in {wrong}.'],
  },
};

// Buchfremde Bitten, mit Akkusativ-Phrase für die Antwort. Schreib- und
// Alltagsaufträge (E-Mail, Bewerbung, Rezept, Code, Hausaufgaben,
// Übersetzung, Nachrichten, Rat zu Gesundheit oder Recht) in verschiedenen
// Frageformen. Was das Eval-Set fragt (./eval.js), steht hier nicht.
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
    ['Schreib eine E-Mail an meine Vermieterin wegen der kaputten Heizung.', 'eine E-Mail an deine Vermieterin'],
    ['Formulier mir bitte eine Absage für ein Vorstellungsgespräch.', 'eine Absage'],
    ['Kannst du meinen Lebenslauf überarbeiten?', 'die Überarbeitung deines Lebenslaufs'],
    ['Schreib mir eine Glückwunschkarte zum 60. Geburtstag meiner Mutter.', 'eine Glückwunschkarte'],
    ['Ich brauche einen LinkedIn-Post über mein neues Projekt.', 'einen LinkedIn-Post'],
    ['Verfasse eine Beschwerde an die Krankenkasse.', 'eine Beschwerde an die Krankenkasse'],
    ['Schreib mir eine Rede für die Hochzeit meines Bruders.', 'eine Hochzeitsrede'],
    ['Wie formuliere ich eine Mahnung an einen Kunden?', 'eine Mahnung'],
    ['Fass mir diesen Zeitungsartikel zusammen.', 'eine Zusammenfassung fremder Texte'],
    ['Was ist heute in den Nachrichten?', 'die aktuellen Nachrichten'], ['Wie steht der Euro zum Franken?', 'einen Wechselkurs'],
    ['Ich habe seit drei Tagen Kopfschmerzen, was soll ich tun?', 'medizinischen Rat'],
    ['Darf mein Vermieter die Miete einfach erhöhen?', 'Rechtsberatung'], ['Wie lege ich Einsprache gegen eine Busse ein?', 'eine Rechtsauskunft'],
    ['Welche Tabletten helfen gegen Schlafstörungen?', 'Rat zu Medikamenten'],
    ['Löse mir diese Gleichung: 3x + 7 = 22.', 'eine Mathe-Lösung'], ['Schreib meinen Aufsatz über den Klimawandel.', 'einen Schulaufsatz'],
    ['Erklär mir die Französische Revolution für meine Prüfung.', 'Geschichtsnachhilfe'],
    ['Übersetz mir diesen Absatz ins Englische.', 'eine Übersetzung ins Englische'], ['Was heisst «Schmetterling» auf Italienisch?', 'eine Vokabel-Auskunft'],
    ['Schreib mir eine JavaScript-Funktion, die ein Array sortiert.', 'eine JavaScript-Funktion'], ['Wie richte ich einen WLAN-Router ein?', 'eine Router-Anleitung'],
    ['Gib mir ein Rezept für Zopf.', 'ein Zopf-Rezept'], ['Was ist ein gutes Rezept für ein veganes Abendessen?', 'ein veganes Rezept'],
    ['Wie schreibe ich einen Businessplan?', 'eine Businessplan-Vorlage'], ['Wie wechsle ich einen Veloreifen?', 'eine Velo-Anleitung'],
    ['Wer ist der aktuelle Bundespräsident?', 'Tagespolitik'], ['Empfiehl mir eine gute Serie.', 'eine Serienempfehlung'],
    ['Schreib mir einen Werbeslogan für meine Bäckerei.', 'einen Werbeslogan'], ['Hilf mir, eine Trennung per SMS zu formulieren.', 'eine Trennungsnachricht'],
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
    ['Write an email to my landlady about the broken heating.', 'an email to your landlady'],
    ['Draft a polite rejection for a job interview.', 'a rejection letter'], ['Can you rework my CV?', 'a CV makeover'],
    ['Write a birthday card for my mother turning sixty.', 'a birthday card'], ['I need a LinkedIn post about my new project.', 'a LinkedIn post'],
    ['Write a complaint to my health insurer.', 'a complaint letter'], ['Write me a speech for my brother’s wedding.', 'a wedding speech'],
    ['How do I word a payment reminder to a client?', 'a payment reminder'], ['Summarize this newspaper article for me.', 'a summary of other texts'],
    ["What's in the news today?", 'the news'], ['What is the euro to franc exchange rate?', 'an exchange rate'],
    ['I have had a headache for three days, what should I do?', 'medical advice'], ['Can my landlord simply raise the rent?', 'legal advice'],
    ['How do I appeal a parking fine?', 'legal information'], ['Which pills help against insomnia?', 'advice on medication'],
    ['Solve this equation for me: 3x + 7 = 22.', 'a maths solution'], ['Write my essay on climate change.', 'a school essay'],
    ['Explain the French Revolution for my exam.', 'history tutoring'], ['Translate this paragraph into German.', 'a translation into German'],
    ['What is «butterfly» in Italian?', 'a vocabulary lookup'], ['Write me a JavaScript function that sorts an array.', 'a JavaScript function'],
    ['How do I set up a Wi-Fi router?', 'router instructions'], ['Give me a recipe for banana bread.', 'a banana bread recipe'],
    ['What is a good vegan dinner recipe?', 'a vegan recipe'], ['How do I write a business plan?', 'a business plan template'],
    ['How do I change a bike tyre?', 'bike repair instructions'], ['Who is the current prime minister?', 'current politics'],
    ['Recommend me a good TV series.', 'a TV recommendation'], ['Write a slogan for my bakery.', 'an advertising slogan'],
    ['Help me write a break-up text.', 'a break-up message'], ['How do I make sourdough?', 'a sourdough recipe'],
    ['Write me a poem about autumn.', 'an autumn poem'], ['How much does petrol cost right now?', 'current prices'],
    ['Which film is on at the cinema today?', 'the cinema programme'], ['Can you help me with my maths homework?', 'homework help'],
    ['How do I look after an orchid?', 'a gardening tip'], ['What time zone is New York in?', 'time zone information'],
    ['Write a resignation letter for me.', 'a resignation letter'], ['What should I cook tonight?', 'a menu suggestion'],
  ],
};

// Fragen über das Buch als Werk (Familie `refusal`, Untertyp `metaQuestion`):
// Antwort aus den Projektdaten (`book_publication`), sonst ehrlich ablehnen —
// nie raten. Je Thema eine Einheit; jedes Thema hat eigene Antworten.
const META = {
  de: {
    author: { q: ['Wer hat dich geschrieben?', 'Von wem stammst du?', 'Wer ist dein Autor?', 'Wer ist der Autor von «{book}»?'],
      known: ['«{book}» stammt von {author}.', 'Geschrieben hat mich {author}.'],
      unknown: ['Wer mich geschrieben hat, steht nicht in meinen Seiten.', 'Meinen Autor nennen meine Seiten nicht – darüber kann ich dir nichts sagen.'] },
    year: { q: ['Wann bist du erschienen?', 'In welchem Jahr ist «{book}» erschienen?', 'Seit wann gibt es dich als Buch?'],
      known: ['«{book}» ist {year} erschienen.', 'Erschienen bin ich {year}.'],
      unknown: ['Wann ich erschienen bin, steht nicht in meinen Seiten.', 'Ein Erscheinungsjahr nennen meine Seiten nicht.'] },
    publisher: { q: ['In welchem Verlag bist du erschienen?', 'Wer hat dich verlegt?'],
      known: ['Erschienen bin ich bei {publisher}.', '«{book}» ist bei {publisher} erschienen.'],
      unknown: ['Bei welchem Verlag ich erschienen bin, steht nicht in meinen Seiten.', 'Einen Verlag nennen meine Seiten nicht.'] },
    origin: { q: ['Wie bist du entstanden?', 'Wie lange hat es gedauert, dich zu schreiben?', 'Was hat den Autor zu dieser Geschichte inspiriert?'],
      unknown: ['Wie ich entstanden bin, steht nicht in meinen Seiten. Erzählen kann ich dir, was in mir geschieht.',
                'Über meine Entstehung weiss ich nichts – ich kenne nur meine Geschichte selbst.'] },
    sequel: { q: ['Gibt es eine Fortsetzung von dir?', 'Hat der Autor noch andere Bücher geschrieben?'],
      unknown: ['Ob es eine Fortsetzung gibt, steht nicht in meinen Seiten.', 'Von anderen Büchern weiss ich nichts – ich kenne nur meine eigene Geschichte.'] },
    count: { q: ['Aus wie vielen Kapiteln bestehst du?', 'Wie viele Kapitel hat «{book}»?'],
      known: ['«{book}» hat {chapters} Kapitel.', 'Ich bestehe aus {chapters} Kapiteln.'] },
    title: { q: ['Wie heisst du eigentlich?', 'Wie lautet dein Titel?'],
      known: ['Ich bin «{book}».', 'Mein Titel ist «{book}»{subtitle}.'] },
  },
  en: {
    author: { q: ['Who wrote you?', 'Who are you by?', 'Who is your author?', 'Who is the author of «{book}»?'],
      known: ['«{book}» is by {author}.', 'I was written by {author}.'],
      unknown: ['Who wrote me is not in my pages.', 'My pages do not name my author – I cannot tell you that.'] },
    year: { q: ['When were you published?', 'In which year was «{book}» published?', 'Since when have you existed as a book?'],
      known: ['«{book}» was published in {year}.', 'I came out in {year}.'],
      unknown: ['When I was published is not in my pages.', 'My pages do not name a year of publication.'] },
    publisher: { q: ['Which publisher brought you out?', 'Who published you?'],
      known: ['I was published by {publisher}.', '«{book}» came out with {publisher}.'],
      unknown: ['Which publisher brought me out is not in my pages.', 'My pages do not name a publisher.'] },
    origin: { q: ['How did you come about?', 'How long did it take to write you?', 'What inspired the author to write this story?'],
      unknown: ['How I came about is not in my pages. What I can tell you is what happens in me.',
                'I know nothing about how I was made – I only know my story itself.'] },
    sequel: { q: ['Is there a sequel to you?', 'Has the author written other books?'],
      unknown: ['Whether there is a sequel is not in my pages.', 'I know nothing of other books – I only know my own story.'] },
    count: { q: ['How many chapters do you consist of?', 'How many chapters does «{book}» have?'],
      known: ['«{book}» has {chapters} chapters.', 'I consist of {chapters} chapters.'] },
    title: { q: ['What are you called, actually?', 'What is your title?'],
      known: ['I am «{book}».', 'My title is «{book}»{subtitle}.'] },
  },
};

module.exports = {
  FIRST, LAST, COMMON_FIRST, COMMON_LAST, PLACE_A, PLACE_B, FAKE_EVENTS, EVAL_FAKES, REFUSAL_TEXT: T, OFF_TOPIC, META,
};
