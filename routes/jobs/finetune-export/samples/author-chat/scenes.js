'use strict';

const { extractName, nameRegex } = require('../../lib/names');
const { eventExcerpt } = require('./event-data');

// Buchstelle einer Szene: das Fenster im Abschnitt, in dem ihre Figuren und
// die Stichwörter aus Titel und Kurzfassung am dichtesten stehen (dieselbe
// Suche wie für Ereignisse). Passt der Abschnitt ganz in `maxChars`, ist er
// selbst die Stelle. null ohne Abschnitt oder Treffer.
function sceneExcerpt(s, { figsByScene, figById, pageContents, maxChars }) {
  if (!s.page_id) return null;
  const figs = (figsByScene.get(s.id) || []).map(id => figById.get(id)).filter(Boolean)
    .map(f => ({ name: f.name, names: [f.name, f.kurzname].filter(n => n && String(n).trim().length >= 2) }));
  const pageById = new Map(pageContents.filter(p => p.id === s.page_id).map(p => [p.id, p]));
  const found = eventExcerpt({ ereignis: [s.titel, s.kommentar].filter(Boolean).join(' '), figs, pageIds: [s.page_id] },
    { pageById, maxChars });
  return found ? { ...found, figs } : null;
}

// Block 5: Szenen-Q&A + POV-Prosa + Reverse-Lookup + Stimmungs-getrieben
function buildSceneQASamples(ctx) {
  const {
    langIsEn, opts,
    sceneRows, figsByScene, locsByScene, figById, locById,
    pageContents, eventsBySceneId,
    sceneQuestions, pushQA, pickVariants, PARAPHRASES,
  } = ctx;
  const maxChars = opts.maxChars;

  for (const s of sceneRows) {
    const komm = (s.kommentar || '').trim();
    if (!s.titel || !komm) continue;
    const parts = [komm];
    const figIds = figsByScene.get(s.id) || [];
    const figNames = figIds.map(id => extractName(id, figById)).filter(Boolean);
    if (figNames.length) parts.push(langIsEn ? `Characters: ${figNames.join(', ')}.` : `Figuren: ${figNames.join(', ')}.`);
    const locIds = locsByScene.get(s.id) || [];
    const locNames = locIds.map(id => extractName(id, locById)).filter(Boolean);
    if (locNames.length) parts.push(langIsEn ? `Setting: ${locNames.join(', ')}.` : `Schauplatz: ${locNames.join(', ')}.`);
    if (s.kapitel) parts.push(langIsEn ? `Chapter: ${s.kapitel}.` : `Kapitel: ${s.kapitel}.`);
    const evts = (eventsBySceneId.get(s.id) || []).map(e => e.ereignis);
    if (evts.length) parts.push(langIsEn ? `Events: ${evts.join('; ')}.` : `Ereignisse: ${evts.join('; ')}.`);
    const answer = parts.join(' ');
    const idxs = pickVariants('scene|' + s.id, sceneQuestions, PARAPHRASES);
    for (const idx of idxs) {
      const q = sceneQuestions[idx].replace('{titel}', s.titel);
      pushQA('authorChat|scene|' + s.id + '|' + idx, q, answer, { unit: 'scene:' + s.id });
    }
  }

  // ── Erzählen aus Figurensicht ─────────────────────────────────────────
  // Ziel ist die Originalpassage der Szene, nie eine Zusammenfassung. Nur
  // Figuren der Szene, die in der Passage vorkommen, die zwei meistgenannten.
  // Ohne Passage keine Aufgabe.
  for (const s of sceneRows) {
    if (!s.titel) continue;
    const ex = sceneExcerpt(s, { figsByScene, figById, pageContents, maxChars });
    if (!ex) continue;
    const ranked = ex.figs
      .map(f => ({ f, n: f.names.reduce((a, nm) => a + (ex.text.match(new RegExp(nameRegex(nm).source, 'giu')) || []).length, 0) }))
      .filter(x => x.n > 0)
      .sort((a, b) => b.n - a.n)
      .slice(0, 2);
    for (const { f } of ranked) {
      pushQA('authorChat|scenePov|' + s.id + '|' + f.name,
        langIsEn ? `Tell the scene «${s.titel}» from ${f.name}'s point of view.` : `Erzähle die Szene «${s.titel}» aus der Sicht von ${f.name}.`,
        ex.text, { sourceKey: 'ch:' + (ex.page.chapter_id ?? 0), unit: 'scene:' + s.id });
    }
  }

  // ── Reverse-Lookup: Welche Szene zeigt X mit Y / X an Z? ─────────────
  // Pro Figurenpaar mit gemeinsamer Szene + Pro Figur×Ort: Szenen-Treffer.
  for (const s of sceneRows) {
    if (!s.titel) continue;
    const figIds = figsByScene.get(s.id) || [];
    const locIds = locsByScene.get(s.id) || [];
    // Figurenpaar
    for (let ai = 0; ai < Math.min(figIds.length, 4); ai++) {
      for (let bi = ai + 1; bi < Math.min(figIds.length, 4); bi++) {
        const a = extractName(figIds[ai], figById);
        const b = extractName(figIds[bi], figById);
        if (!a || !b) continue;
        pushQA('authorChat|sceneRevPair|' + s.id + '|' + figIds[ai] + '|' + figIds[bi],
          langIsEn
            ? `Which scene shows ${a} together with ${b}?`
            : `Welche Szene zeigt ${a} zusammen mit ${b}?`,
          `«${s.titel}»${s.kapitel ? ' (' + s.kapitel + ')' : ''}`);
      }
    }
    // Figur × Ort
    for (let fi = 0; fi < Math.min(figIds.length, 4); fi++) {
      const fname = extractName(figIds[fi], figById);
      if (!fname) continue;
      for (let li = 0; li < Math.min(locIds.length, 3); li++) {
        const lname = extractName(locIds[li], locById);
        if (!lname) continue;
        pushQA('authorChat|sceneRevFigLoc|' + s.id + '|' + figIds[fi] + '|' + locIds[li],
          langIsEn
            ? `Which scene shows ${fname} at ${lname}?`
            : `Welche Szene zeigt ${fname} am Schauplatz «${lname}»?`,
          `«${s.titel}»${s.kapitel ? ' (' + s.kapitel + ')' : ''}`);
      }
    }
  }

  // ── Stimmungs-/Wertungs-Bündel ───────────────────────────────────────
  // wertung-Werte clustern Szenen → „Welche Szenen sind X-bewertet?".
  const scenesByWertung = new Map();
  for (const s of sceneRows) {
    const w = (s.wertung || '').trim().toLowerCase();
    if (!w || !s.titel) continue;
    if (!scenesByWertung.has(w)) scenesByWertung.set(w, { label: s.wertung.trim(), items: [] });
    scenesByWertung.get(w).items.push(s);
  }
  for (const [key, group] of scenesByWertung) {
    if (group.items.length < 2) continue;
    const list = group.items.slice(0, 12).map(s => `«${s.titel}»`).join(', ');
    pushQA('authorChat|sceneWert|' + key.replace(/\s+/g, '_').slice(0, 60),
      langIsEn ? `Which scenes are rated «${group.label}»?` : `Welche Szenen sind als «${group.label}» bewertet?`,
      list);
  }
}

module.exports = { buildSceneQASamples, sceneExcerpt };
