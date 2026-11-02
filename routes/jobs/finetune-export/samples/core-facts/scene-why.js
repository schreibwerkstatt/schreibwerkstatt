'use strict';

// Warum in einer Szene (Typ `sceneWhy`, docs/finetuning.md#warum-familie):
// «Warum handelt Stefan in der Szene «…» so?», «Was treibt Stefan in der Szene
// «…» an?», «Wie fühlt sich …?», «Was bedeutet die Szene «…» für …?». Die
// Szene selbst trägt keine Motiv- oder Konfliktfelder (`figure_scenes` hat nur
// Titel, Wertung und Lektoratskommentar — beides ist kein Inhalt); die Antwort
// kommt aus dem Ereignis der Szene, an dem die Figur beteiligt ist, und ihrem
// Lebensabschnitt (why-parts.js: Bedeutung, Lage, Vorgeschichte, höchstens ein
// passender Profil-Teilsatz). Ohne Ereignis mit Bedeutung keine Frage.
//
// Für jede Hauptfigur einer Szene eine Karte `scene:<id>:why:<fig>`, je Frage
// eine eigene Fassung; Einheit `scene:<id>`, Kernwissen.

const { declineName, isRoleName } = require('./naming');
const { escapeRe } = require('../../lib/names');
const { joinList } = require('./events');
const {
  isPersonal, bedeutungFor, meaningFrames, situation, precedingEvents, precedingSentences,
  profileClause, profileFrames, composeAnswers, stemsOf,
} = require('./why-parts');

const Q = {
  de: [
    'Warum handelt {X} in der Szene «{s}» so?',
    'Was treibt {X:akk} in der Szene «{s}» an?',
    'Wie fühlt sich {X} in der Szene «{s}»?',
    'Was bedeutet die Szene «{s}» für {X:akk}?',
  ],
  en: [
    'Why does {X} act like that in the scene «{s}»?',
    'What drives {X} in the scene «{s}»?',
    'How does {X} feel in the scene «{s}»?',
    'What does the scene «{s}» mean for {X}?',
  ],
};

function buildSceneWhy(ctx, emitCard) {
  const { langIsEn, sceneRows = [], figsByScene = new Map(), eventsBySceneId = new Map(), figRows = [] } = ctx;
  const figById = new Map(figRows.map(f => [f.fig_id, f]));
  const tpl = Q[langIsEn ? 'en' : 'de'];
  let built = 0;
  for (const s of sceneRows) {
    if (!s.titel) continue;
    for (const figId of figsByScene.get(s.id) || []) {
      if (ctx.tierByFig?.get(figId) !== 'main') continue;
      const fig = figById.get(figId);
      if (!fig || isRoleName(fig.name) || ctx.figNameInfo?.get(figId)?.ambiguous) continue;
      const X = ctx.figNameInfo?.get(figId)?.name || fig.name;
      // Szene ↔ Ereignis hängen nur über den Abschnitt zusammen; trägt er
      // mehrere Ereignisse, muss der Szenentitel Stichwörter mit dem Ereignis
      // teilen, sonst wäre die Deutung die eines anderen Geschehens.
      const all = eventsBySceneId.get(s.id) || [];
      const evs = all.filter(e => isPersonal(e) && e.bedeutung && e.figs.some(f => f.fig_id === figId));
      const titleStems = stemsOf(s.titel);
      const score = (e) => stemsOf(e.ereignis + ' ' + e.bedeutung).filter(st => titleStems.includes(st)).length;
      const ranked = evs.map(e => ({ e, n: score(e) })).sort((a, b) => b.n - a.n);
      const e = ranked[0] && (ranked[0].n > 0 || all.length === 1) ? ranked[0].e : null;
      if (!e) continue;
      // Ein führendes «Er»/«Sie» der Bedeutung meint die Figur am Titelanfang.
      const titleIsX = new RegExp('^' + escapeRe(X) + '(?![\\p{L}])', 'u').test(e.ereignis);
      const rawBed = String(e.bedeutung).trim();
      const bed = titleIsX || !/^(Er|Sie|He|She)\s/.test(rawBed) ? bedeutungFor(rawBed, X, langIsEn) : '';
      // Die Szene steht in jeder Fassung: mehrere Szenen eines Abschnitts teilen
      // ein Ereignis, die Antworten sollen es nicht.
      const leads = langIsEn
        ? [`In «${s.titel}», «${e.ereignis}» happens.`, `The scene «${s.titel}» belongs to «${e.ereignis}».`]
        : [`In «${s.titel}» geschieht «${e.ereignis}».`, `Die Szene «${s.titel}» gehört zu «${e.ereignis}».`];
      const answers = composeAnswers({
        meaning: meaningFrames(bed, X, e.ereignis, langIsEn),
        sit: situation(ctx, fig, e, X),
        prev: precedingSentences(precedingEvents(ctx, fig, e), X, langIsEn, joinList),
        prof: profileFrames(profileClause(fig, e, X, langIsEn), X, langIsEn),
      }).map((a, i) => `${leads[i % 2]} ${a}`).filter(a => a.length <= 560);
      if (!answers.length) continue;
      const akk = langIsEn ? X : declineName(X, 'akk') || X;
      const questions = tpl.map(t => t.replace('{X:akk}', akk).replace('{X}', X).replace('{s}', s.titel));
      if (emitCard({
        id: `scene:${s.id}:why:${figId}`, kind: 'scene', unit: 'scene:' + s.id, core: true, tier: 'main',
        subject: s.titel, fields: { figur: X, ereignis: e.ereignis },
      }, { task: 'sceneWhy', questions, answers, distinct: true, count: questions.length })) built++;
    }
  }
  ctx.sceneWhyCards = built;
  return built;
}

module.exports = { buildSceneWhy };
