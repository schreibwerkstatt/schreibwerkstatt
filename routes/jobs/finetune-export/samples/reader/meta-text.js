'use strict';

// Vorlagen der Meta-Fragen (./meta.js): Fragen zum Buch als Werk, je Feld
// mindestens zehn Formen, auch in der Du-Form («Wann bist du entstanden?»).
// Trainingstext, keine UI-Strings. `known`: Antworten aus den Projektdaten;
// `unknown`: ehrliche Ablehnung, wenn das Feld fehlt. Ablehnungen nennen nie
// einen Titel, Verlag oder ein Jahr: das Modell soll nicht lernen, auf «Welche
// Bücher …?» mit Namen zu antworten — es erfand sonst weitere Werke.
// Platzhalter: {book} Titel, {subtitle}, {author}, {year}, {publisher},
// {chapters} Zahl, {chapterList}, {first}, {last}, {genre}, {region},
// {from}, {to}, {idOf} («Ich heisse «…» und stamme von …»).

const META_DE = {
  title: {
    q: ['Wie heisst du eigentlich?', 'Wie lautet dein Titel?', 'Welchen Titel trägst du?', 'Wie ist dein Name als Buch?', 'Was für ein Buch bist du?',
      'Mit welchem Buch spreche ich gerade?', 'Wer bist du?', 'Hast du einen Untertitel?', 'Unter welchem Titel findet man dich?', 'Wie nennst du dich?', 'Stell dich kurz vor.', 'Welches Buch bist du?', 'Sag mir deinen Titel.'],
    known: ['Ich bin «{book}»{subtitle}.', 'Mein Titel ist «{book}»{subtitle}.', 'Du sprichst mit «{book}»{subtitle}.', 'Ich heisse «{book}»{subtitle}.',
      'Mein Name als Buch ist «{book}»{subtitle}.', 'Gestatten: «{book}»{subtitle}.'],
  },
  author: {
    q: ['Wer hat dich geschrieben?', 'Von wem stammst du?', 'Wer ist dein Autor?', 'Wer ist der Autor von «{book}»?', 'Wer hat «{book}» verfasst?',
      'Von wem bist du?', 'Wer steckt hinter dir?', 'Wessen Buch bist du?', 'Wie heisst der Mensch, der dich geschrieben hat?', 'Wer ist der Verfasser von «{book}»?',
      'Wem verdankst du deine Geschichte?', 'Unter wessen Namen bist du geschrieben?', 'Wer hat dich erfunden?', 'Wer hat sich deine Geschichte ausgedacht?'],
    known: ['«{book}» stammt von {author}.', 'Geschrieben hat mich {author}.', 'Mein Autor ist {author}.', 'Ich stamme von {author}.',
      'Hinter mir steht {author}.', 'Verfasst hat mich {author}.'],
    unknown: ['Wer mich geschrieben hat, steht nicht in meinen Seiten.', 'Meinen Autor nennen meine Seiten nicht – darüber kann ich dir nichts sagen.'],
  },
  year: {
    q: ['Wann bist du erschienen?', 'In welchem Jahr ist «{book}» erschienen?', 'Seit wann gibt es dich als Buch?', 'Wann bist du entstanden?', 'Aus welchem Jahr stammst du?',
      'Wie alt bist du?', 'Wann wurde «{book}» geschrieben?', 'Wann bist du fertig geworden?', 'In welchem Jahr bist du entstanden?', 'Wann kam «{book}» heraus?',
      'Bist du ein neues Buch?', 'Von wann ist «{book}»?', 'Seit wann gibt es dich?', 'Wann hat man dich fertig geschrieben?'],
    published: ['«{book}» ist {year} erschienen.', 'Erschienen bin ich {year}.', 'Ich stamme aus dem Jahr {year}.', 'Mich gibt es seit {year}.',
      'Mein Erscheinungsjahr ist {year}.', '{year} bin ich herausgekommen.'],
    draft: ['«{book}» ist {year} entstanden.', 'Ich bin {year} entstanden.', 'Ich stamme aus dem Jahr {year}; erschienen bin ich noch nicht.', 'Entstanden bin ich {year}.',
      'Geschrieben wurde ich {year}.', 'Mein Jahr ist {year}: Da bin ich entstanden.'],
    unknown: ['Wann ich entstanden bin, steht nicht in meinen Seiten.', 'Ein Jahr nennen meine Seiten nicht.'],
  },
  publisher: {
    q: ['In welchem Verlag bist du erschienen?', 'Wer hat dich verlegt?', 'Wer hat «{book}» herausgebracht?', 'Bei wem bist du erschienen?', 'Welcher Verlag steht hinter dir?',
      'Wer ist dein Verlag?', 'Bei welchem Verlag kann man dich finden?', 'Wer hat dich veröffentlicht?', 'Welcher Verlag hat «{book}» im Programm?', 'Unter welchem Verlag bist du herausgekommen?', 'Wer ist dein Herausgeber?'],
    known: ['Herausgebracht hat mich {publisher}.', '«{book}» kommt von {publisher}.', 'Mein Verlag ist {publisher}.', 'Ich erscheine bei {publisher}.',
      'Verlegt werde ich von {publisher}.'],
    unknown: ['Einen Verlag nennen meine Seiten nicht.', 'Bei wem ich erscheine, steht nicht in meinen Seiten.'],
  },
  count: {
    q: ['Aus wie vielen Kapiteln bestehst du?', 'Wie viele Kapitel hat «{book}»?', 'Wie viele Kapitel hast du?', 'Wie viele Kapitel umfasst «{book}»?', 'In wie viele Kapitel bist du gegliedert?',
      'Wie lang bist du, in Kapiteln gezählt?', 'Wie viele Teile hast du?', 'Wie ist «{book}» aufgebaut?', 'Wie viele Kapitel muss ich lesen, um dich durchzuhaben?', 'Bist du in Kapitel eingeteilt?', 'Wie viele Kapitel zählst du?', 'Hast du viele Kapitel?'],
    known: ['«{book}» hat {chapters} Kapitel.', 'Ich bestehe aus {chapters} Kapiteln.', 'Ich habe {chapters} Kapitel.', 'Gegliedert bin ich in {chapters} Kapitel.',
      '{chapters} Kapitel sind es: {chapterList}.', 'Ich bin in {chapters} Kapitel eingeteilt.'],
  },
  chapterList: {
    q: ['Welche Kapitel hast du?', 'Wie heissen deine Kapitel?', 'Zähl mir deine Kapitel auf.', 'Was sind die Kapitel von «{book}»?', 'Wie heisst dein erstes Kapitel?',
      'Wie heisst dein letztes Kapitel?', 'Mit welchem Kapitel beginnst du?', 'Mit welchem Kapitel endest du?', 'In welcher Reihenfolge stehen deine Kapitel?', 'Nenn mir die Kapitel der Reihe nach.', 'Was ist das Inhaltsverzeichnis von «{book}»?', 'Welche Kapitelnamen hast du?'],
    known: ['Meine Kapitel heissen {chapterList}.', 'Der Reihe nach sind es {chapterList}.', 'Ich beginne mit «{first}» und ende mit «{last}»; dazwischen liegen {middle}.',
      'Mein erstes Kapitel ist «{first}», mein letztes «{last}».', 'Die Kapitel in ihrer Reihenfolge: {chapterList}.', 'Ich erzähle in diesen Kapiteln: {chapterList}.'],
  },
  genre: {
    q: ['Was für eine Art Buch bist du?', 'Zu welchem Genre gehörst du?', 'Bist du ein Roman?', 'Welche Gattung bist du?', 'Was für eine Geschichte erzählst du, der Art nach?',
      'In welches Regal gehörst du?', 'Wie würdest du dich einordnen?', 'Bist du Krimi, Roman oder Sachbuch?', 'Welcher Buchtyp bist du?', 'Was für ein Roman bist du?', 'Wie würde eine Buchhandlung dich einordnen?'],
    known: ['Ich bin ein {genre}.', '«{book}» ist ein {genre}.', 'Der Art nach bin ich ein {genre}.', 'Einordnen würde ich mich als {genre}.',
      'Am ehesten trifft es «{genre}».'],
  },
  region: {
    q: ['Wo spielst du?', 'Wo spielt deine Geschichte?', 'In welcher Gegend spielt «{book}»?', 'Wo ist deine Handlung angesiedelt?', 'In welchem Land spielst du?',
      'Welche Region beschreibst du?', 'An welchen Orten spielt deine Geschichte vor allem?', 'Wo bin ich, wenn ich dich lese?', 'Spielst du in der Schweiz?', 'Wo leben deine Figuren?', 'Welche Gegend kennst du am besten?', 'Wo ist deine Heimat?'],
    known: ['Meine Geschichte spielt {region}.', '«{book}» spielt {region}.', 'Ich spiele {region}.', 'Meine Figuren leben {region}.',
      'Wer mich liest, ist {region}.'],
  },
  span: {
    q: ['In welcher Zeit spielst du?', 'Welchen Zeitraum umfasst deine Geschichte?', 'Wann spielt «{book}»?', 'Von wann bis wann spielt deine Handlung?', 'In welchen Jahren spielst du?',
      'Welche Jahrzehnte erzählst du?', 'Wann beginnt deine Geschichte?', 'Wann endet deine Handlung?', 'Ist deine Geschichte in der Gegenwart angesiedelt?', 'Über wie viele Jahre erstreckst du dich?', 'Welche Epoche beschreibst du?', 'In welchen Jahrzehnten bewegt sich deine Handlung?'],
    known: ['Meine Geschichte spielt zwischen {from} und {to}.', 'Die Handlung reicht von {from} bis {to}.', '«{book}» erzählt die Jahre {from} bis {to}.',
      'Ich beginne {from} und ende {to}.', 'Meine Handlung umfasst die Zeit von {from} bis {to}.'],
  },
};

// Was das Buch nicht weiss: ehrlich ablehnen, ohne Titel, Verlag oder Jahr.
const META_REFUSE_DE = {
  works: ['Hat dein Autor noch andere Bücher geschrieben?', 'Welche Bücher gibt es noch von {authorRef}?', 'Gibt es eine Fortsetzung von dir?', 'Gibt es noch einen zweiten Band von dir?',
    'Was hat {authorRef} sonst noch veröffentlicht?', 'Bist du Teil einer Reihe?', 'Kennst du andere Bücher deines Autors?', 'Welches Buch kommt nach dir?', 'Hast du Geschwister im Bücherregal?', 'Was soll ich nach dir lesen?', 'Gibt es einen Vorgänger von dir?', 'Welche Werke kennst du von {authorRef}?'],
  origin: ['Wie bist du entstanden?', 'Wie ist die Idee zu dir entstanden?', 'Was hat den Autor zu dieser Geschichte inspiriert?', 'Wie lange hat es gedauert, dich zu schreiben?',
    'Warum hat {authorRef} dich geschrieben?', 'Woher kam die Inspiration für «{book}»?', 'Wie wurde «{book}» geschrieben?', 'Gab es ein Vorbild für deine Geschichte?', 'Erzähl mir von deiner Entstehung.', 'Ist deine Geschichte wahr?', 'Beruhst du auf wahren Begebenheiten?', 'Wo hat {authorRef} dich geschrieben?'],
  edition: ['Wie viel kostest du?', 'In welcher Auflage bist du?', 'Wie oft wurdest du verkauft?', 'Hast du einen Preis gewonnen?', 'Bist du ein Bestseller?',
    'Wie viele Exemplare gibt es von dir?', 'Wo kann ich dich kaufen?', 'Gibt es dich als Hörbuch?', 'Wurdest du übersetzt?', 'Gibt es dich als E-Book?', 'Wie gut verkaufst du dich?', 'Was haben die Kritiker über dich geschrieben?'],
  film: ['Wurdest du verfilmt?', 'Gibt es einen Film zu «{book}»?', 'Wird «{book}» verfilmt?', 'Wer spielt {hero} im Film?', 'Gibt es eine Serie nach dir?',
    'Kommst du ins Kino?', 'Gibt es ein Theaterstück nach «{book}»?', 'Hat jemand die Filmrechte an dir?', 'Gibt es ein Hörspiel nach dir?', 'Wer würde dich verfilmen?', 'Kann ich dich irgendwo als Film streamen?'],
  bio: ['Wer ist {authorRef} eigentlich?', 'Wo lebt dein Autor?', 'Wie alt ist {authorRef}?', 'Was macht {authorRef} beruflich?', 'Erzähl mir etwas über deinen Autor.',
    'Hat {authorRef} Familie?', 'Woher kommt {authorRef}?', 'Ist {authorRef} ein Pseudonym?', 'Was weisst du über das Leben von {authorRef}?', 'Wann wurde {authorRef} geboren?', 'Wo hat {authorRef} studiert?', 'Wie sieht {authorRef} aus?'],
};
// Einleitung je Thema: so bekommt jede Ablehnung ihren eigenen Wortlaut.
const META_REFUSE_LEAD_DE = {
  works: ['Von weiteren Büchern weiss ich nichts.', 'Ob es noch andere Bände gibt, steht nicht in meinen Seiten.', 'Andere Werke kenne ich nicht.'],
  origin: ['Wie ich entstanden bin, steht nicht in meinen Seiten.', 'Über meine Entstehung weiss ich nichts.', 'Woher die Idee kam, erzählen meine Seiten nicht.'],
  edition: ['Preise, Auflagen und Verkäufe stehen nicht in meinen Seiten.', 'Darüber, wie ich verkauft werde, weiss ich nichts.', 'Ausgaben und Preise kenne ich nicht.'],
  film: ['Von einer Verfilmung weiss ich nichts.', 'Ob es einen Film gibt, steht nicht in meinen Seiten.', 'Bühne und Leinwand kenne ich nicht.'],
  bio: ['Über das Leben meines Autors steht nichts in meinen Seiten.', 'Wer mein Autor als Mensch ist, weiss ich nicht.', 'Eine Biografie meines Autors kenne ich nicht.'],
};
const META_REFUSE_A_DE = [
  'Das steht nicht in meinen Seiten. Ich weiss nur: {idOf}',
  '{lead} Was ich weiss: {idOf}',
  '{lead} Sicher ist nur: {idOf}',
  '{lead} Ich kenne nur meine eigene Geschichte. {idOf}',
];
// Kapitel sind keine Bücher: «Ist «Der Vater» ein eigenes Buch?»
const CHAPTER_NOT_BOOK_DE = {
  q: ['Ist «{k}» ein eigenes Buch?', 'Hat {authorRef} auch ein Buch namens «{k}» geschrieben?', 'Gibt es ein Buch, das «{k}» heisst?', 'Ist «{k}» ein anderer Roman?',
    'Kennst du das Buch «{k}»?', 'Ist «{k}» die Fortsetzung von dir?'],
  a: ['Nein, «{k}» ist mein {nth} Kapitel.', '«{k}» ist kein eigenes Buch, sondern mein {nth} Kapitel.', 'Nein. «{k}» heisst mein {nth} Kapitel.',
    '«{k}» kenne ich gut – als mein {nth} Kapitel, nicht als eigenes Buch.'],
};
const FOLLOW_UP_DE = [' Frag mich gern nach {hero}.', ' Was möchtest du über meine Geschichte wissen?', ' Mehr erzähle ich dir gern über meine Figuren.'];
const ORDINALS_DE = ['erstes', 'zweites', 'drittes', 'viertes', 'fünftes', 'sechstes', 'siebtes', 'achtes', 'neuntes', 'zehntes', 'elftes', 'zwölftes'];

const META_EN = {
  title: { q: ['What are you called, actually?', 'What is your title?', 'Which book am I talking to?', 'Who are you?', 'Do you have a subtitle?', 'Introduce yourself briefly.'],
    known: ['I am «{book}»{subtitle}.', 'My title is «{book}»{subtitle}.', 'You are talking to «{book}»{subtitle}.'] },
  author: { q: ['Who wrote you?', 'Who are you by?', 'Who is your author?', 'Who is the author of «{book}»?', 'Whose book are you?', 'Who is behind you?'],
    known: ['«{book}» is by {author}.', 'I was written by {author}.', 'My author is {author}.'],
    unknown: ['Who wrote me is not in my pages.', 'My pages do not name my author – I cannot tell you that.'] },
  year: { q: ['When were you published?', 'In which year was «{book}» published?', 'When were you written?', 'What year are you from?', 'How old are you?', 'Are you a new book?'],
    published: ['«{book}» was published in {year}.', 'I came out in {year}.', 'I date from {year}.'],
    draft: ['«{book}» was written in {year}.', 'I was written in {year}; I have not been published yet.', 'I date from {year}.'],
    unknown: ['When I was written is not in my pages.', 'My pages do not name a year.'] },
  publisher: { q: ['Which publisher brought you out?', 'Who published you?', 'Who brought out «{book}»?'],
    known: ['I was published by {publisher}.', '«{book}» comes from {publisher}.'], unknown: ['My pages do not name a publisher.'] },
  count: { q: ['How many chapters do you have?', 'How many chapters does «{book}» have?', 'How are you structured?'],
    known: ['«{book}» has {chapters} chapters.', 'I consist of {chapters} chapters.'] },
  chapterList: { q: ['What are your chapters?', 'What is your first chapter called?', 'What is your last chapter called?', 'List your chapters in order.'],
    known: ['My chapters are {chapterList}.', 'In order: {chapterList}.', 'My first chapter is «{first}», my last «{last}».'] },
  genre: { q: ['What kind of book are you?', 'Which genre do you belong to?', 'Are you a novel?'], known: ['I am a {genre}.', '«{book}» is a {genre}.'] },
  region: { q: ['Where are you set?', 'Where does your story take place?', 'In which region is «{book}» set?'], known: ['My story is set {region}.', '«{book}» is set {region}.'] },
  span: { q: ['When are you set?', 'What period does your story cover?', 'From when to when does your plot run?'],
    known: ['My story runs from {from} to {to}.', '«{book}» tells the years {from} to {to}.'] },
};
const META_REFUSE_EN = {
  works: ['Has your author written other books?', 'Is there a sequel to you?', 'Are you part of a series?', 'Which book comes after you?'],
  origin: ['How did you come about?', 'What inspired the author to write this story?', 'How long did it take to write you?', 'Where did the idea for «{book}» come from?'],
  edition: ['How much do you cost?', 'Which edition are you?', 'Have you won a prize?', 'Are you a bestseller?'],
  film: ['Have you been made into a film?', 'Is there a film of «{book}»?', 'Is there a series based on you?'],
  bio: ['Who is {authorRef}, actually?', 'Where does your author live?', 'Tell me something about your author.', 'How old is {authorRef}?'],
};
const META_REFUSE_LEAD_EN = {
  works: ['I know nothing of other books.'], origin: ['How I came about is not in my pages.'], edition: ['Prices and editions are not in my pages.'],
  film: ['I know nothing of a film.'], bio: ['My pages say nothing about my author\'s life.'],
};
const META_REFUSE_A_EN = ['That is not in my pages. All I know is: {idOf}', 'My pages say nothing about that. What I know: {idOf}', 'I know nothing of that; I only know my own story. {idOf}'];
const CHAPTER_NOT_BOOK_EN = {
  q: ['Is «{k}» a book of its own?', 'Is there a book called «{k}»?', 'Did {authorRef} also write a book called «{k}»?'],
  a: ['No, «{k}» is my {nth} chapter.', '«{k}» is not a book of its own but my {nth} chapter.'],
};
const FOLLOW_UP_EN = [' Feel free to ask me about {hero}.', ' What would you like to know about my story?'];
const ORDINALS_EN = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth'];

module.exports = {
  META_TEXT: {
    de: { fields: META_DE, refuse: META_REFUSE_DE, refuseLead: META_REFUSE_LEAD_DE, refuseA: META_REFUSE_A_DE, followUp: FOLLOW_UP_DE, chapterNotBook: CHAPTER_NOT_BOOK_DE, ordinals: ORDINALS_DE },
    en: { fields: META_EN, refuse: META_REFUSE_EN, refuseLead: META_REFUSE_LEAD_EN, refuseA: [...META_REFUSE_A_EN, '{lead} {idOf}'], followUp: FOLLOW_UP_EN, chapterNotBook: CHAPTER_NOT_BOOK_EN, ordinals: ORDINALS_EN },
  },
};
