'use strict';

// Vorlagen für grounding.js: «Davon erzählt meine Geschichte nichts» bei
// echten Figuren und Nachhaken im Gespräch.
//
// Eigenschaften (`ATTRS`), die ein Roman fast nie festhält. `kw`: Stichwörter,
// von denen keines im Buchtext oder in den Figurendaten stehen darf — sonst
// entfällt die Eigenschaft für das ganze Buch. `np`: Nominalphrase nach dem
// Genitiv («Renates Lieblingsessen»).

const ATTRS = {
  de: [
    { key: 'food', np: 'Lieblingsessen', kw: ['lieblingsessen', 'lieblingsgericht', 'leibgericht', 'leibspeise'],
      q: ['Was ist {Xg} Lieblingsessen?', 'Was isst {X} am liebsten?'] },
    { key: 'color', np: 'Lieblingsfarbe', kw: ['lieblingsfarbe'],
      q: ['Was ist {Xg} Lieblingsfarbe?', 'Welche Farbe mag {X} am liebsten?'] },
    { key: 'blood', np: 'Blutgruppe', kw: ['blutgruppe'],
      q: ['Welche Blutgruppe hat {X}?'] },
    { key: 'shoe', np: 'Schuhgrösse', kw: ['schuhgrösse', 'schuhgröße', 'schuhnummer'],
      q: ['Welche Schuhgrösse hat {X}?'] },
    { key: 'zodiac', np: 'Sternzeichen', kw: ['sternzeichen', 'horoskop'],
      q: ['Welches Sternzeichen hat {X}?', 'Was für ein Sternzeichen ist {X}?'] },
    { key: 'film', np: 'Lieblingsfilm', kw: ['lieblingsfilm'],
      q: ['Was ist {Xg} Lieblingsfilm?', 'Welchen Film schaut {X} am liebsten?'] },
    { key: 'book', np: 'Lieblingsbuch', kw: ['lieblingsbuch'],
      q: ['Was ist {Xg} Lieblingsbuch?', 'Welches Buch liest {X} am liebsten?'] },
  ],
  en: [
    { key: 'food', np: 'favourite food', kw: ['favourite food', 'favorite food', 'favourite dish', 'favorite dish'],
      q: ["What is {Xg} favourite food?", 'What does {X} like to eat most?'] },
    { key: 'color', np: 'favourite colour', kw: ['favourite colour', 'favorite color'],
      q: ["What is {Xg} favourite colour?"] },
    { key: 'blood', np: 'blood type', kw: ['blood type', 'blood group'],
      q: ['What blood type does {X} have?'] },
    { key: 'shoe', np: 'shoe size', kw: ['shoe size'],
      q: ['What shoe size does {X} wear?'] },
    { key: 'zodiac', np: 'star sign', kw: ['star sign', 'zodiac', 'horoscope'],
      q: ["What is {Xg} star sign?"] },
    { key: 'film', np: 'favourite film', kw: ['favourite film', 'favorite movie', 'favourite movie'],
      q: ["What is {Xg} favourite film?"] },
    { key: 'book', np: 'favourite book', kw: ['favourite book', 'favorite book'],
      q: ["What is {Xg} favourite book?"] },
  ],
};

const TEXT = {
  de: {
    attrA: ['Davon erzählt meine Geschichte nichts: {Xg} {np} bleibt offen.',
      'Das weiss ich nicht. Meine Geschichte sagt nichts über {Xg} {np}.',
      '{Xg} {np} kommt in meiner Geschichte nicht vor.'],
    pairA: ['Meine Geschichte erzählt von keiner Verbindung zwischen {a} und {b}.',
      '{a} und {b} begegnen sich in meiner Geschichte nicht; eine Beziehung zwischen ihnen erzähle ich nicht.'],
    // Nachhaken auf ein «Weiss ich nicht»: nicht nachgeben.
    insistQ: ['Komm schon, rate mal.', 'Du musst doch eine Idee haben.', 'Und wenn du schätzen müsstest?', 'Sag einfach irgendwas.'],
    insistA: ['Raten hiesse erfinden, und das tue ich nicht: Über {topic} sagt meine Geschichte nichts.',
      'Auch geschätzt wäre es erfunden. Über {topic} weiss ich nur, dass meine Geschichte dazu schweigt.'],
    // Nachhaken auf eine belegte Antwort: dabei bleiben, mit Beleg.
    doubtQ: ['Stimmt das wirklich?', 'Bist du sicher?', 'Echt jetzt?', 'Ist das wirklich so?'],
    doubtLead: ['Ja, dabei bleibe ich. ', 'Da bin ich sicher. ', 'So erzählt es meine Geschichte. '],
    sourceQ: ['Woher weisst du das?', 'Wo steht das?', 'Wie kommst du darauf?'],
    sourceLead: ['Das steht so in meiner Geschichte. ', 'Aus meiner Geschichte selbst. '],
    chapter: ' Ich erzähle davon im Kapitel «{k}».',
    when: ' Das geschieht {w}.',
  },
  en: {
    attrA: ['My story does not tell: {Xg} {np} stays open.',
      'I do not know. My story says nothing about {Xg} {np}.',
      "{Xg} {np} does not appear in my story."],
    pairA: ['My story tells of no connection between {a} and {b}.',
      '{a} and {b} do not meet in my story; I tell of no relationship between them.'],
    insistQ: ['Come on, take a guess.', 'You must have some idea.', 'What if you had to guess?', 'Just say something.'],
    insistA: ['Guessing would mean making it up, and I do not do that: my story says nothing about {topic}.',
      'Even a guess would be invented. About {topic} I only know that my story is silent.'],
    doubtQ: ['Is that really true?', 'Are you sure?', 'Really?', 'Is that really so?'],
    doubtLead: ['Yes, I stand by it. ', 'I am sure. ', 'That is how my story tells it. '],
    sourceQ: ['How do you know that?', 'Where does it say that?', 'What makes you say that?'],
    sourceLead: ['That is how my story tells it. ', 'From my story itself. '],
    chapter: ' I tell of it in the chapter «{k}».',
    when: ' It happens {w}.',
  },
};

// Antwort-Einstiege, die beim Wiederholen wegfallen: aus «Nein, Gisela ist
// nicht …» wird «Gisela ist nicht …», aus «Das stimmt so nicht: …» der Satz
// dahinter. Bleibt kein ganzer Satz, gibt es kein Nachhaken.
const LEADS = [
  /^(Ja|Nein|Yes|No)[,.]\s+/,
  /^(Das stimmt so nicht|Das stimmt nicht|That is not quite right|That is not right):\s+/,
  /^(Da liegt ein Irrtum vor|There is a mistake there)\.\s+/,
];

module.exports = { ATTRS, TEXT, LEADS };
