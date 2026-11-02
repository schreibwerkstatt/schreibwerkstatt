'use strict';

// Block 32: Tiefe-Felder der Komplettanalyse je Figur (figures.rolle/motivation/
// konflikt/arc|entwicklung/hintergrund/aeusseres/stimme/schluesselzitate,
// docs/komplett.md). Sie tragen das Innenleben — was eine Figur will, was ihr
// fehlt, womit sie ringt, wie sie sich wandelt — und sind für Leser- wie Autor-
// Modell das Wissen, das «Wer ist X?» allein nicht abdeckt.
// Analyse-Prosa wird für die Umschreibung im Buchton angemeldet (`voice`);
// Schlüsselzitate sind Buchtext und bleiben wörtlich.

const FIELDS = {
  rolle: {
    de: ['Welche Rolle spielt {name} in der Geschichte?', 'Wofür steht {name} in der Handlung?'],
    en: ['What role does {name} play in the story?', 'What is {name}\'s function in the plot?'],
  },
  motivation: {
    de: ['Was treibt {name} an?', 'Was will {name} eigentlich?', 'Was fehlt {name} innerlich?'],
    en: ['What drives {name}?', 'What does {name} really want?', 'What is {name} missing inside?'],
  },
  konflikt: {
    de: ['Womit ringt {name}?', 'Welche Konflikte trägt {name} aus?'],
    en: ['What is {name} struggling with?', 'What conflicts does {name} face?'],
  },
  arc: {
    de: ['Wie verändert sich {name} im Lauf der Geschichte?', 'Welche Entwicklung macht {name} durch?'],
    en: ['How does {name} change over the story?', 'What journey does {name} go through?'],
  },
  hintergrund: {
    de: ['Woher kommt {name}?', 'Was ist die Vorgeschichte von {name}?'],
    en: ['Where does {name} come from?', 'What is {name}\'s backstory?'],
  },
  aeusseres: {
    de: ['Wie sieht {name} aus?', 'Beschreibe das Äussere von {name}.'],
    en: ['What does {name} look like?', 'Describe {name}\'s appearance.'],
  },
  stimme: {
    de: ['Wie spricht {name}?', 'Wie redet {name} mit anderen?'],
    en: ['How does {name} speak?', 'How does {name} talk to others?'],
  },
};
const INNER = {
  de: ['Was geht in {name} vor?', 'Wie sieht es in {name} innen aus?'],
  en: ['What is going on inside {name}?', 'What is {name}\'s inner life like?'],
};
const QUOTES = {
  de: ['Welche Sätze aus dem Buch prägen {name}?', 'Zitiere eine Stelle, die {name} ausmacht.'],
  en: ['Which lines from the book define {name}?', 'Quote a passage that captures {name}.'],
};

const fill = (tpl, name) => tpl.replace(/\{name\}/g, name);
const FACETED_FIELDS = ['motivation', 'konflikt', 'arc', 'hintergrund'];

function parseJson(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return fallback; }
}

// Bogen als Prosa: Anfang, Wendepunkte, Ende in Lesereihenfolge. Ohne `arc`
// (ältere Analysen, lokale Provider) die Freitext-Spalte `entwicklung`.
function arcProse(f) {
  const a = parseJson(f.arc, null);
  if (a && typeof a === 'object') {
    const parts = [a.anfang, ...(Array.isArray(a.wendepunkte) ? a.wendepunkte : []), a.ende]
      .map(p => String(p || '').trim()).filter(Boolean);
    if (parts.length) return parts.join(' ');
  }
  return String(f.entwicklung || '').trim();
}

// Die Analyse soll unbelegte Felder leer lassen, füllt sie aber teils mit einer
// Leerformel («Kein expliziter Konflikt.», «unbekannt»). Als Antwort brächte
// das dem Modell die Formel bei; kurze Verneinungs-Sätze gelten darum als leer.
const PLACEHOLDER = new RegExp([
  '^keine?n?\\b.{0,40}\\b(explizit|erkennbar|belegt|genannt|bekannt|angegeben|beschrieben)',
  '^(nicht (belegt|bekannt|erkennbar|genannt|beschrieben)|unbekannt|unklar)\\b',
  '^no\\b.{0,30}\\b(explicit|clear|known|stated|evident|described)',
  '^(unknown|not (stated|known|described)|none|n/a)\\b',
].join('|'), 'i');
const isPlaceholder = (t) => t.length < 80 && PLACEHOLDER.test(t);

function figureDepth(f) {
  const text = (v) => {
    const t = String(v || '').trim();
    return isPlaceholder(t) ? '' : t;
  };
  return {
    rolle: text(f.rolle), motivation: text(f.motivation), konflikt: text(f.konflikt),
    arc: text(arcProse(f)), hintergrund: text(f.hintergrund), aeusseres: text(f.aeusseres), stimme: text(f.stimme),
    zitate: (parseJson(f.schluesselzitate, []) || []).map(z => String(z || '').trim()).filter(Boolean),
  };
}

function buildFigureDepthSamples(ctx) {
  const { langIsEn, figRows, pushQA } = ctx;
  const lang = langIsEn ? 'en' : 'de';
  for (const f of figRows) {
    if (!f.name) continue;
    const d = figureDepth(f);
    // Hauptfiguren mit Innenleben-Facetten (core-facts/psyche.js): Motivation,
    // Konflikt, Bogen und Hintergrund stehen dort je Facette, hier nicht noch
    // einmal als ganzer Block.
    const faceted = ctx.psycheFigIds?.has(f.fig_id);
    if (faceted) for (const k of FACETED_FIELDS) d[k] = '';
    for (const [field, pools] of Object.entries(FIELDS)) {
      const answer = d[field];
      if (!answer) continue;
      const voice = { key: `depth|${f.fig_id}|${field}`, kind: 'figure', name: f.name };
      pools[lang].forEach((q, i) => pushQA(`authorChat|figDepth|${f.fig_id}|${field}|${i}`, fill(q, f.name), answer, undefined, voice));
    }
    if (d.motivation && d.konflikt) {
      const answer = `${d.motivation} ${d.konflikt}`;
      const voice = { key: `depth|${f.fig_id}|inner`, kind: 'figure', name: f.name };
      INNER[lang].forEach((q, i) => pushQA(`authorChat|figInner|${f.fig_id}|${i}`, fill(q, f.name), answer, undefined, voice));
    }
    // Schlüsselzitate einzeln: jedes ist eine eigene Erinnerung an den Text.
    d.zitate.forEach((z, i) => {
      const q = QUOTES[lang][i % QUOTES[lang].length];
      pushQA(`authorChat|figQuote|${f.fig_id}|${i}`, fill(q, f.name), z);
    });
  }
}

module.exports = { buildFigureDepthSamples, figureDepth, arcProse };
