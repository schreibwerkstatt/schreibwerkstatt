'use strict';

const { datOf, isOwnLifeEvent } = require('../core-facts/words');
const { whenAdverb, joinList } = require('../core-facts/events');

const { eventDetailParts, eventWhen, leadSafe } = require('./event-data');

// Enum-Werte der Analyse (figures.sozialschicht) als Prosa —
// das Modell soll «gehobenes Bürgertum» lernen, nicht den Schlüssel
// «gehobenes_buergertum» (und in englischen Büchern nicht das deutsche Wort).
// Kein UI-String: das ist Trainingstext wie die übrigen Antwort-Vorlagen dieses
// Samplers. «andere»/«unbekannt» tragen keine Information → kein Sample.
const SCHICHT_PROSA = {
  wirtschaftselite:     { de: 'der Wirtschaftselite', en: 'the economic elite' },
  gehobenes_buergertum: { de: 'dem gehobenen Bürgertum', en: 'the upper middle class' },
  mittelschicht:        { de: 'der Mittelschicht', en: 'the middle class' },
  arbeiterschicht:      { de: 'der Arbeiterschicht', en: 'the working class' },
  migrantenmilieu:      { de: 'dem Migrantenmilieu', en: 'a migrant milieu' },
  prekariat:            { de: 'dem Prekariat', en: 'the precariat' },
  unterwelt:            { de: 'der Unterwelt', en: 'the criminal underworld' },
};

// Block 1+2: Figuren-Composite + Trait-Q&A
function buildFigureBaseSamples(ctx) {
  const { langIsEn, figRows, pushQA, pickVariants, PARAPHRASES } = ctx;

  // «Wer ist X?», Beruf, Schicht und Familie stehen als Kernwissen mit
  // Varianten in ../core-facts/figures.js; hier bleiben Vergleich, Rolle,
  // Eigenschaften und Lebensereignisse.

  // ── Roleplay-/Selbstvorstellung-Frame ─────────────────────────────────
  // „Stelle dich als X vor" → Ich-Form Beschreibung. Trainiert Personae-
  // Aktivierung und Voice-Capture. Composite-Antwort als Basis, vorne
  // angepasste Einleitung.
  for (const f of figRows) {
    const desc = (f.beschreibung || '').trim();
    if (!desc) continue;
    const intro = langIsEn
      ? `I am ${f.name}.${f.beruf ? ' ' + f.beruf + '.' : ''} ${desc}`
      : `Ich bin ${f.name}.${f.beruf ? ' ' + f.beruf + '.' : ''} ${desc}`;
    pushQA('authorChat|figRole|' + f.fig_id,
      langIsEn ? `Introduce yourself as ${f.name}.` : `Stelle dich als ${f.name} vor.`,
      intro, { unit: 'fig:' + f.fig_id });
  }

  // ── Figur-vs-Figur-Vergleich (gleicher typ) ──────────────────────────
  // Pro Paar gleiche Kategorie (Hauptfigur/Nebenfigur/…): Vergleich auf
  // Ebene Beschreibung+Tags+Beruf. Lehrt Differenzierung statt Konflation.
  // Bewusst auf die ersten 6 je Typ gedeckelt: die Paare wachsen quadratisch
  // (60 Nebenfiguren → 1770 Vergleichs-Samples), und die Vergleiche würden den
  // Datensatz dominieren, ohne neue Fakten zu tragen — jede Figur hat ihre
  // eigenen Samples oben.
  const byTyp = new Map();
  for (const f of figRows) {
    const t = (f.typ || '').trim().toLowerCase();
    if (!t) continue;
    if (!byTyp.has(t)) byTyp.set(t, []);
    byTyp.get(t).push(f);
  }
  for (const [, group] of byTyp) {
    if (group.length < 2) continue;
    for (let i = 0; i < Math.min(group.length, 6); i++) {
      for (let j = i + 1; j < Math.min(group.length, 6); j++) {
        const A = group[i];
        const B = group[j];
        const aDesc = (A.beschreibung || '').split(/(?<=[.!?])\s/)[0] || '';
        const bDesc = (B.beschreibung || '').split(/(?<=[.!?])\s/)[0] || '';
        if (!aDesc || !bDesc) continue;
        // Ganze Sätze statt «Stefan: … Renate: …»; nennt eine Beschreibung
        // ihre Figur nicht, steht der Name davor.
        const about = (F, d) => (d.includes(F.name) ? d : (langIsEn ? `About ${F.name}: ${d}` : `Zu ${F.name}: ${d}`));
        const answer = `${about(A, aDesc)} ${about(B, bDesc)}`;
        pushQA('authorChat|figCmp|' + A.fig_id + '|' + B.fig_id,
          langIsEn ? `What distinguishes ${A.name} from ${B.name}?` : `Was unterscheidet ${A.name} von ${B.name}?`,
          answer);
      }
    }
  }

  // ── Figuren-Charaktereigenschaften (Tags) ────────────────────────────
  // Ein Satz mit den drei tragenden Eigenschaften, nie die ganze Tag-Liste
  // («Renate ist: abwesend, abweisend, …»): diese Form übernähme das Modell
  // genau für «Was ist Renate für ein Mensch?».
  for (const f of figRows) {
    const answers = traitAnswers(f, langIsEn);
    if (!answers.length) continue;
    const traitQs = langIsEn
      ? [`What traits does ${f.name} have?`, `How would you characterize ${f.name}?`,
         `Describe ${f.name}'s personality.`, `What is ${f.name} like as a person?`]
      : [`Welche Eigenschaften hat ${f.name}?`, `Wie würdest du ${f.name} charakterisieren?`,
         `Beschreibe den Charakter von ${f.name}.`, `Was zeichnet ${f.name} charakterlich aus?`];
    const idxs = pickVariants('figTraits|' + f.fig_id, traitQs, PARAPHRASES);
    idxs.forEach((idx, k) => {
      pushQA('authorChat|figTraits|' + f.fig_id + '|' + idx, traitQs[idx], answers[k % answers.length], { unit: 'fig:' + f.fig_id });
    });
  }
}

// Höchstens drei Eigenschaften, die für die Figur tragend sind: zuerst die,
// die Beschreibung, Motivation, Konflikt oder Entwicklung aufgreifen, dann in
// der Reihenfolge der Analyse. Doppelte fallen weg; im Deutschen nur
// Adjektive (klein geschrieben) — «Renate ist Pflichtbewusstsein» wäre kein
// Satz. Wo ein Satz der Analyse eine davon trägt, folgt er als Beleg.
const TRAITS_MAX = 3;
function traitAnswers(f, langIsEn) {
  const seen = new Set();
  const tags = String(f.tags_csv || '').split(',').map(t => t.trim()).filter(t => {
    const k = t.toLowerCase();
    if (!t || seen.has(k)) return false;
    seen.add(k);
    return langIsEn || /^\p{Ll}/u.test(t);
  });
  if (!tags.length) return [];
  const sources = [f.beschreibung, f.motivation, f.konflikt, f.arc].filter(Boolean).join(' ').toLowerCase();
  const stem = (t) => t.toLowerCase().slice(0, Math.max(4, t.length - 2));
  const picked = tags.map((t, i) => [t, sources.includes(stem(t)) ? 0 : 1, i])
    .sort((a, b) => a[1] - b[1] || a[2] - b[2]).slice(0, TRAITS_MAX).map(([t]) => t);
  const list = joinList(picked, langIsEn);
  const sentences = [f.konflikt, f.beschreibung].filter(Boolean).join(' ').split(/(?<=[.!?])\s+/);
  const proof = sentences.find(x => x.length <= 220 && picked.some(t => x.toLowerCase().includes(stem(t)))) || '';
  const tail = proof ? ' ' + proof.trim() : '';
  return langIsEn
    ? [`${f.name} is ${list}.${tail}`, `Above all, ${f.name} is ${list}.`]
    : [`${f.name} ist ${list}.${tail}`, `Charakterlich ist ${f.name} vor allem ${list}.`];
}

// Block 17+18+19: Lebensereignisse + Auftritte + Dialogstil
function buildFigureMetaSamples(ctx) {
  const { langIsEn, figRows, eventsByFigPk, appearancesByFigPk, dialogsByFigure, pushQA,
          chMap, storylineNameById } = ctx;

  // ── Figuren-Lebensereignisse ─────────────────────────────────────────
  // Pro figure_events-Eintrag ein gezielter Fakt + eine aggregierte Antwort
  // für „Was erlebt X im Buch?". Die Aggregat-Antwort bleibt bei 8 Momenten: sie
  // ist eine Zusammenfassung (jedes Ereignis hat sein eigenes Sample), und eine
  // Antwort mit 50 Einträgen wäre kein „Schlüsselmoment" mehr.
  for (const f of figRows) {
    const evts = eventsByFigPk.get(f.pk) || [];
    if (!evts.length) continue;
    for (let j = 0; j < evts.length; j++) {
      const e = evts[j];
      const ereignis = (e.ereignis || '').trim().replace(/[.\s]+$/, '');
      if (!ereignis) continue;
      const kapitel = (e.chapter_id != null && chMap[e.chapter_id]) || '';
      const when = eventWhen(e, langIsEn).when;
      const parts = [leadSafe(ereignis) + '.', ...eventDetailParts(e, {
        langIsEn,
        chapterNames: kapitel ? [kapitel] : [],
        storyline: storylineNameById.get(e.storyline_id) || '',
      })];
      if (e.bedeutung) parts.push((langIsEn ? 'Why it matters: ' : 'Bedeutung: ') + e.bedeutung);
      const answer = parts.join(' ');
      pushQA('authorChat|figEvt|' + f.fig_id + '|' + j,
        langIsEn
          ? `What happens to ${f.name} ${when ? `around ${when}` : `during the story`}?`
          : `Was passiert mit ${f.name}${when ? ` (${when})` : ' im Verlauf der Geschichte'}?`,
        answer, { unit: 'fig:' + f.fig_id });
      if (kapitel) {
        pushQA('authorChat|figEvtCh|' + f.fig_id + '|' + j,
          langIsEn ? `In which chapter does ${f.name} experience «${ereignis}»?` : `In welchem Kapitel erlebt ${f.name} «${ereignis}»?`,
          langIsEn ? `${f.name} experiences «${ereignis}» in chapter «${kapitel}».` : `${f.name} erlebt «${ereignis}» im Kapitel «${kapitel}».`, { unit: 'fig:' + f.fig_id });
      }
      if (when) {
        pushQA('authorChat|figEvtWhen|' + f.fig_id + '|' + j,
          langIsEn ? `When does ${f.name} experience «${ereignis}»?` : `Wann erlebt ${f.name} «${ereignis}»?`,
          whenAdverb(when, langIsEn)
            ? (langIsEn ? `${f.name} experiences «${ereignis}» ${whenAdverb(when, true)}.` : `${f.name} erlebt «${ereignis}» ${whenAdverb(when, false)}.`)
            : (langIsEn ? `The time of «${ereignis}»: ${when}.` : `Zeitpunkt von «${ereignis}»: ${when}.`), { unit: 'fig:' + f.fig_id });
      }
      // Nur die eigene Geburt/der eigene Tod — an den Eltern hängt auch
      // «Geburt von Stefan» (words.js#isOwnLifeEvent).
      if (when && (e.subtyp === 'geburt' || e.subtyp === 'tod') && isOwnLifeEvent(f, e)) {
        pushQA('authorChat|figLife|' + e.subtyp + '|' + f.fig_id,
          e.subtyp === 'geburt'
            ? (langIsEn ? `When was ${f.name} born?` : `Wann wurde ${f.name} geboren?`)
            : (langIsEn ? `When did ${f.name} die?` : `Wann ist ${f.name} gestorben?`),
          `${f.name}, ${e.subtyp === 'geburt' ? (langIsEn ? 'born' : 'geboren') : (langIsEn ? 'died' : 'gestorben')}: ${when}.`, { unit: 'fig:' + f.fig_id });
      }
    }
    const allEvtsList = (langIsEn ? `The key moments in ${f.name}'s story: ` : `Die Schlüsselmomente in der Geschichte von ${datOf(f.name)}: `)
      + evts.slice(0, 8).map(e => `${e.ereignis}${e.datum ? ' (' + e.datum + ')' : ''}`).join('; ') + '.';
    pushQA('authorChat|figAllEvt|' + f.fig_id,
      langIsEn ? `What are the key moments in ${f.name}'s story?` : `Welche Schlüsselmomente erlebt ${f.name}?`,
      allEvtsList, { unit: 'fig:' + f.fig_id });
  }

  // ── Figuren-Auftritte (Kapitel-Liste) ────────────────────────────────
  for (const f of figRows) {
    const chs = appearancesByFigPk.get(f.pk) || [];
    if (!chs.length) continue;
    const answer = chs.join(', ');
    pushQA('authorChat|figApp|' + f.fig_id,
      langIsEn ? `In which chapters does ${f.name} appear?` : `In welchen Kapiteln taucht ${f.name} auf?`,
      langIsEn ? `${f.name} appears in: ${answer}.` : `${f.name} kommt vor in: ${answer}.`, { unit: 'fig:' + f.fig_id });
  }

  // ── Figuren-Dialogstil: wie spricht X? ───────────────────────────────
  // Wenn wir Zitate einer Figur gesammelt haben, aggregieren wir die
  // prägnantesten als Sprach-Portrait. Nimmt die mittleren Längen (nicht
  // zu kurz, nicht zu lang) — die eigentlichen Stimm-Träger.
  //
  // Gruppiert pro Kapitel: die Antwort ist wörtlicher Buchtext und braucht den
  // `sourceKey` ihres Kapitels (Train/Val-Split auf Quell-Ebene), und die Frage
  // nennt das Kapitel — sonst stünden mehrere Samples mit identischer Frage und
  // verschiedenen Antworten im Datensatz.
  for (const f of figRows) {
    const entries = dialogsByFigure.get(f.name.toLowerCase()) || [];
    const altEntries = (f.kurzname && f.kurzname !== f.name)
      ? (dialogsByFigure.get(f.kurzname.toLowerCase()) || [])
      : [];
    const seenQ = new Set();
    const byChapter = new Map();
    for (const e of [...entries, ...altEntries]) {
      if (seenQ.has(e.quote)) continue;
      if (e.quote.length < 20 || e.quote.length > 220) continue;
      seenQ.add(e.quote);
      const chKey = e.chapterId ?? '';
      if (!byChapter.has(chKey)) byChapter.set(chKey, []);
      byChapter.get(chKey).push(e);
    }
    for (const [chKey, combined] of byChapter) {
      const chapter = combined[0].chapter || '';
      const where = chapter ? (langIsEn ? ` in «${chapter}»` : ` in «${chapter}»`) : '';
      // Alle Zitate verwenden, in Sechsergruppen (eine Antwort bleibt lesbar,
      // die Zahl der Samples wächst linear mit den Zitaten).
      for (let k = 0; k * 6 < combined.length; k++) {
        const group = combined.slice(k * 6, k * 6 + 6);
        if (group.length < 2) break;
        const sample = group.map(e => `\u201E${e.quote}\u201C`).join(' · ');
        const part = k ? (langIsEn ? ` (more, ${k + 1})` : ` (weitere, ${k + 1})`) : '';
        pushQA('authorChat|figVoice|' + f.fig_id + (chKey !== '' ? '|ch' + chKey : '') + (k ? '|' + k : ''),
          (langIsEn
            ? `How does ${f.name} speak${where}? Show me a few lines.`
            : `Wie spricht ${f.name}${where}? Zeig mir ein paar Sätze.`) + part,
          sample,
          chKey !== '' ? 'ch:' + chKey : undefined);
      }
    }
  }
}

module.exports = { buildFigureBaseSamples, buildFigureMetaSamples, SCHICHT_PROSA };
