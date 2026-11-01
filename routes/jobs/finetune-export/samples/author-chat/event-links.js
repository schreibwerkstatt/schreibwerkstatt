'use strict';

const { nameRegex } = require('../../lib/names');

// Block 11b: Ereignisse ↔ Buchtext, Szenen, Handlungsstrang, Art und Zeit.
// Ergänzt ./events.js um die Verknüpfungen aus ./event-data.js.
function buildEventLinkSamples(ctx) {
  const { langIsEn, events, eventsBySceneId, sceneRows, pushQA } = ctx;

  const evtLine = (e) => `${e.datum ? e.datum + ': ' : ''}${e.ereignis}${e.bedeutung ? ' (' + e.bedeutung + ')' : ''}`;
  const sceneLabel = (s) => '«' + s.titel + '»' + (s.seite ? (langIsEn ? ` (section ${s.seite})` : ` (Abschnitt ${s.seite})`) : '');

  for (const e of events) {
    const { i, ereignis } = e;
    const unit = 'evt:' + i;

    // ── Buchstelle: wie das Ereignis erzählt ist ──────────────────────
    // Antwort ist wörtlicher Buchtext. Erzählen aus Figurensicht gibt es nur
    // mit dieser Passage als Ziel und nur für Figuren, die darin vorkommen —
    // ohne zugeordnete Passage fällt die Aufgabe weg, eine Faktenkarte ist
    // nie die Antwort auf eine Erzählbitte.
    if (e.excerpt) {
      const { text, page } = e.excerpt;
      const src = 'ch:' + (page.chapter_id ?? 0);
      pushQA('authorChat|evtText|' + i,
        langIsEn ? `How is «${ereignis}» told in the book?` : `Wie ist «${ereignis}» im Buch erzählt?`,
        text, { sourceKey: src, unit });
      for (const fg of e.figs) {
        if (!fg.names.some(n => nameRegex(n).test(text))) continue;
        pushQA('authorChat|evtTextFig|' + i + '|' + fg.key,
          langIsEn ? `Tell «${ereignis}» from ${fg.name}'s point of view.` : `Erzähle «${ereignis}» aus der Sicht von ${fg.name}.`,
          text, { sourceKey: src, unit });
      }
    }

    // ── Szenen ────────────────────────────────────────────────────────
    if (e.scenes.length) {
      pushQA('authorChat|evtScene|' + i,
        langIsEn ? `In which scene does «${ereignis}» happen?` : `In welcher Szene passiert «${ereignis}»?`,
        e.scenes.map(sceneLabel).join(', '), { unit });
      for (const s of e.scenes) {
        const komm = (s.kommentar || '').trim();
        if (!komm) continue;
        pushQA('authorChat|evtSceneDetail|' + i + '|' + s.id,
          langIsEn ? `What happens in the scene «${s.titel}» during «${ereignis}»?` : `Was passiert in der Szene «${s.titel}» bei «${ereignis}»?`,
          komm, { unit });
      }
    }

    // ── Handlungsstrang ───────────────────────────────────────────────
    if (e.storyline) {
      pushQA('authorChat|evtSl|' + i,
        langIsEn ? `Which storyline does «${ereignis}» belong to?` : `Zu welchem Handlungsstrang gehört «${ereignis}»?`,
        langIsEn ? `«${ereignis}» belongs to the storyline «${e.storyline}».` : `«${ereignis}» gehört zum Handlungsstrang «${e.storyline}».`, { unit });
    }

    // ── Zeit: Spanne und Tag der Handlung ─────────────────────────────
    if (e.end) {
      pushQA('authorChat|evtSpan|' + i,
        langIsEn ? `How long does «${ereignis}» last?` : `Wie lange dauert «${ereignis}»?`,
        langIsEn ? `«${ereignis}» lasts ${e.datum}.` : `«${ereignis}» dauert ${e.datum}.`, { unit });
      pushQA('authorChat|evtEnd|' + i,
        langIsEn ? `When does «${ereignis}» end?` : `Wann endet «${ereignis}»?`,
        langIsEn ? `«${ereignis}» ends in ${e.end}.` : `Ende von «${ereignis}»: ${e.end}.`, { unit });
    }
    if (e.storyDay) {
      pushQA('authorChat|evtDay|' + i,
        langIsEn ? `On which day of the story does «${ereignis}» happen?` : `An welchem Tag der Handlung passiert «${ereignis}»?`,
        langIsEn ? `«${ereignis}» happens on day ${e.storyDay} of the story.` : `«${ereignis}» passiert am Tag ${e.storyDay} der Handlung.`, { unit });
    }

    // ── Geburt / Tod einer Figur ──────────────────────────────────────
    // Betroffen ist die Figur, die im Ereignistext genannt ist, sonst die
    // einzige beteiligte — bei einer Geburt sind die Eltern oft mit dabei.
    if ((e.subtyp === 'geburt' || e.subtyp === 'tod') && e.datum) {
      const named = e.figs.filter(f => f.names.some(n => nameRegex(n).test(ereignis)));
      const subjects = named.length ? named : (e.figs.length === 1 ? e.figs : []);
      for (const fg of subjects) {
        const q = e.subtyp === 'geburt'
          ? (langIsEn ? `When is ${fg.name} born?` : `Wann wird ${fg.name} geboren?`)
          : (langIsEn ? `When does ${fg.name} die?` : `Wann stirbt ${fg.name}?`);
        const verb = e.subtyp === 'geburt'
          ? (langIsEn ? 'is born' : 'wird geboren')
          : (langIsEn ? 'dies' : 'stirbt');
        pushQA('authorChat|evtLife|' + e.subtyp + '|' + i + '|' + fg.key, q,
          `${fg.name} ${verb}: ${e.datum}.` + (e.kapitel.length ? (langIsEn ? ` Chapter: ${e.kapitel.join(', ')}.` : ` Kapitel: ${e.kapitel.join(', ')}.`) : ''), { unit });
      }
    }
  }

  // ── Szene → Ereignisse ──────────────────────────────────────────────
  for (const s of sceneRows) {
    const items = eventsBySceneId.get(s.id) || [];
    if (!items.length || !s.titel) continue;
    const list = items.map(evtLine).join(' · ');
    pushQA('authorChat|sceneEvts|' + s.id,
      langIsEn ? `Which events belong to the scene «${s.titel}»?` : `Welche Ereignisse gehören zur Szene «${s.titel}»?`,
      list);
  }

  // ── Ereignisse je Art (Subtyp) ──────────────────────────────────────
  const bySubtyp = new Map();
  for (const e of events) {
    if (!e.subtypLabel) continue;
    if (!bySubtyp.has(e.subtyp)) bySubtyp.set(e.subtyp, { label: e.subtypLabel, items: [] });
    bySubtyp.get(e.subtyp).items.push(e);
  }
  for (const [key, group] of bySubtyp) {
    const list = group.items.map(evtLine).join(' · ');
    pushQA('authorChat|evtsBySubtyp|' + key,
      langIsEn ? `Which events of the kind «${group.label}» happen in the book?` : `Welche Ereignisse der Art «${group.label}» gibt es im Buch?`,
      list);
  }
}

module.exports = { buildEventLinkSamples };
