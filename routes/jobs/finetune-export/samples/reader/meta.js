'use strict';

// Fragen zum Buch als Werk (Typ `metaQuestion`, Familie refusal,
// docs/finetuning.md#ablehnen-lernen): Titel, Autor, Jahr (erschienen oder,
// solange das Buch nicht fertig ist, «entstanden»), Verlag, Kapitelzahl und
// -namen, Genre, Schauplatz-Region, Zeitraum der Handlung — aus den
// Projektdaten (`book_publication`, `book_settings`, Buchbaum, Orte,
// Zeitstrahl). Ein fehlendes Feld führt zur ehrlichen Ablehnung, nicht zum
// Weglassen. Was das Buch nie weiss (weitere Werke, Entstehung, Auflage und
// Preise, Verfilmung, Biografie des Autors), lehnt es ab, ohne einen Titel,
// Verlag oder ein Jahr zu nennen — das Modell erfand sonst «weitere Bücher»
// und Entstehungsgeschichten. Kapitelnamen sind keine Bücher: «Ist «Der
// Vater» ein eigenes Buch?» → «Nein, «Der Vater» ist mein erstes Kapitel.»
//
// Je Frage eine eigene Einheit (`ref:meta:<thema>:<i>`), damit Val einzelne
// Fragen zurückhält, nicht ein ganzes Thema. Vorlagen: ./meta-text.js.

const { getPromptConfig } = require('../../../../../lib/prompts-loader');
const { META_TEXT } = require('./meta-text');

const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
const COUNTRY = { de: { ch: 'der Schweiz', de: 'Deutschland', at: 'Österreich' }, en: { ch: 'Switzerland', de: 'Germany', at: 'Austria' } };

const joinList = (items, langIsEn) => (items.length <= 1 ? items.join('')
  : items.slice(0, -1).join(', ') + (langIsEn ? ' and ' : ' und ') + items[items.length - 1]);

// Werte aus den Projektdaten; '' = unbekannt.
function metaValues(ctx) {
  const { langIsEn, displayName: book } = ctx;
  const lang = langIsEn ? 'en' : 'de';
  const pub = ctx.publication || {};
  const settings = ctx.bookSettings || {};
  const chapterKeys = (ctx.chapterKeys || []).filter(k => k !== 0);
  const chapters = chapterKeys.map(k => ctx.chapterNameByKey?.get(k)).filter(Boolean);
  const author = String(pub.author_name || pub.author || '').trim();
  const year = /^\d{4}$/.test(String(pub.year || '').trim()) ? String(pub.year).trim() : '';
  const genre = String(getPromptConfig()?.buchtypen?.[lang]?.[settings.buchtyp]?.label || '').trim();
  // Region: die Orte des Schauplatz-Lands mit den meisten Szenen.
  const home = String(ctx.homeLand || '').toLowerCase();
  const top = (ctx.locRows || [])
    .filter(l => !home || l.land === home)
    .map(l => ({ name: l.name, n: (ctx.scenesByLocPk?.get(l.pk) || []).length }))
    .filter(x => x.n >= 2 && x.name.length <= 30 && !/\s(der|des|von|im|am)\s/.test(x.name))
    .sort((a, b) => b.n - a.n).slice(0, 3).map(x => x.name);
  const country = COUNTRY[lang][home] || '';
  const region = top.length
    ? (langIsEn ? `around ${joinList(top, true)}${country ? ' in ' + country : ''}` : `rund um ${joinList(top, false)}${country ? ' in ' + country : ''}`)
    : '';
  // Zeitraum: sichere Jahre der persönlichen Ereignisse.
  const years = (ctx.events || []).filter(e => e.year && !e.unsure && String(e.typ).toLowerCase() !== 'extern').map(e => e.year).sort((a, b) => a - b);
  const quoted = chapters.map(c => `«${c}»`);
  const hero = [...(ctx.figRows || [])].filter(f => ctx.tierByFig?.get(f.fig_id) === 'main')
    .sort((a, b) => (ctx.figMentions?.get(b.fig_id) || 0) - (ctx.figMentions?.get(a.fig_id) || 0))[0];
  const idOf = langIsEn
    ? `I am «${book}»${author ? ` and I am by ${author}` : ''}.`
    : `Ich heisse «${book}»${author ? ` und stamme von ${author}` : ''}.`;
  return {
    book, author, year, genre, region, chapters,
    published: !!(year && (settings.is_finished === 1 || pub.isbn)),
    vars: {
      book, author, year, genre, region, idOf,
      subtitle: pub.subtitle ? ` – ${String(pub.subtitle).trim()}` : '',
      publisher: String(pub.publisher || '').trim(),
      chapters: chapterKeys.length ? String(chapterKeys.length) : '',
      chapterList: joinList(quoted, langIsEn), first: chapters[0] || '', last: chapters[chapters.length - 1] || '',
      middle: joinList(quoted.slice(1, -1), langIsEn),
      from: years.length >= 2 ? String(years[0]) : '', to: years.length >= 2 ? String(years[years.length - 1]) : '',
      authorRef: author,
      hero: hero ? (ctx.figNameInfo?.get(hero.fig_id)?.name || hero.name) : (langIsEn ? 'the main character' : 'die Hauptfigur'),
    },
  };
}

// Antwortvorlagen eines Feldes, [] wenn das Feld fehlt und es keine Ablehnung gibt.
function answersFor(topic, def, v) {
  const has = {
    title: true, author: !!v.author, publisher: !!v.vars.publisher, count: !!v.vars.chapters,
    chapterList: v.chapters.length >= 2, genre: !!v.genre, region: !!v.region, span: !!v.vars.from,
  };
  if (topic === 'year') return v.year ? (v.published ? def.published : def.draft) : def.unknown;
  if (has[topic]) return def.known;
  return def.unknown || [];
}

function buildMetaSamples(ctx, push) {
  const { langIsEn } = ctx;
  const T = META_TEXT[langIsEn ? 'en' : 'de'];
  const v = metaValues(ctx);
  const one = (topic, i, q, a) => push({ id: `refusal|meta|${topic}|${i}`, unit: `ref:meta:${topic}:${i}`, turns: [[q, a]] });
  let n = 0;
  for (const [topic, def] of Object.entries(T.fields)) {
    const answers = answersFor(topic, def, v);
    // «Wie heisst dein erstes/letztes Kapitel?» braucht die passende Antwort.
    def.q.forEach((tpl, i) => {
      let a = answers[i % Math.max(1, answers.length)];
      if (topic === 'chapterList' && /erstes|beginnst|first/i.test(tpl)) a = langIsEn ? 'My first chapter is «{first}».' : 'Mein erstes Kapitel heisst «{first}».';
      if (topic === 'chapterList' && /letztes|endest|last/i.test(tpl)) a = langIsEn ? 'My last chapter is «{last}».' : 'Mein letztes Kapitel heisst «{last}».';
      if (!a) return;
      // Ab der zweiten Runde durch die Vorlagen ein Anschluss ans Gespräch,
      // damit keine Antwort öfter steht, als das Antwort-Budget erlaubt.
      const round = Math.floor(i / Math.max(1, answers.length));
      if (round > 0) a += T.followUp[(round - 1 + i) % T.followUp.length];
      if (one(topic, i, fill(tpl, v.vars), fill(a, v.vars))) n++;
    });
  }
  for (const [topic, qs] of Object.entries(T.refuse)) {
    qs.forEach((tpl, i) => {
      // Ablehnung = Vorlage × Einleitung des Themas: jede Frage ihr eigener Wortlaut.
      const leads = T.refuseLead[topic] || [''];
      const a = T.refuseA[i % T.refuseA.length].replace('{lead}', leads[Math.floor(i / T.refuseA.length + i) % leads.length]);
      // Ohne Autornamen keine Frage, die ihn nennt.
      if (!v.author && tpl.includes('{authorRef}')) return;
      if (one('no-' + topic, i, fill(tpl, v.vars), fill(a, v.vars))) n++;
    });
  }
  v.chapters.forEach((k, ci) => {
    const nth = T.ordinals[ci];
    if (!nth) return;
    T.chapterNotBook.q.forEach((tpl, i) => {
      const a = T.chapterNotBook.a[(ci + i) % T.chapterNotBook.a.length];
      if (one('chapterBook', `${ci}|${i}`, fill(tpl, { ...v.vars, k }), fill(a, { ...v.vars, k, nth }))) n++;
    });
  });
  ctx.metaSampleCount = n;
  return n;
}

module.exports = { buildMetaSamples, metaValues, answersFor };
