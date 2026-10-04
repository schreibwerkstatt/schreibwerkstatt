'use strict';

const { hashSplit } = require('../../lib/names');

// Enum-Werte der Analyse (figures.sozialschicht / figures.geschlecht) als Prosa —
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
const GESCHLECHT_PROSA = {
  'männlich': { de: 'männlich', en: 'male' },
  maennlich:  { de: 'männlich', en: 'male' },
  weiblich:   { de: 'weiblich', en: 'female' },
  divers:     { de: 'divers', en: 'non-binary' },
};

// Block 1+2: Figuren-Composite + Trait-Q&A
function buildFigureBaseSamples(ctx) {
  const { langIsEn, opts, figRows, figQuestions, pushQA, pickVariants } = ctx;
  const seed = opts.valSeed;

  // ── Figuren-Q&A ────────────────────────────────────────────────────────
  // Composite answer: beschreibung als Rückgrat + ein angehängter Satz zu
  // Beruf/Geschlecht/Tags (so die Antwort wie Prosa klingt und nicht wie CSV).
  for (const f of figRows) {
    const desc = (f.beschreibung || '').trim();
    if (!desc) continue;
    const extras = [];
    if (f.beruf) extras.push(langIsEn ? `Occupation: ${f.beruf}.` : `Beruf: ${f.beruf}.`);
    if (f.tags_csv) {
      const tags = f.tags_csv.split(',').map(t => t.trim()).filter(Boolean).slice(0, 4).join(', ');
      if (tags) extras.push(langIsEn ? `Traits: ${tags}.` : `Eigenschaften: ${tags}.`);
    }
    const answer = [desc, ...extras].join(' ');
    // Alle Paraphrasen pro Figur → gleiche Fakten mehrmals sehen → bessere
    // Memorisierung der Buchwelt (Ziel: Figur als «Realität» akzeptieren).
    const idxs = pickVariants('fig|' + f.fig_id, figQuestions, figQuestions.length);
    for (const idx of idxs) {
      const q = figQuestions[idx].replace('{name}', f.name);
      pushQA('authorChat|fig|' + f.fig_id + '|' + idx, q, answer);
    }
    // Zusatz-Frage mit Kurzname als Zielnamen (wenn vorhanden), damit das
    // Modell beide Namen-Varianten kennt.
    if (f.kurzname && f.kurzname !== f.name && f.kurzname.trim().length >= 2) {
      const altIdx = Math.floor(hashSplit('figAlt|' + f.fig_id, seed) * figQuestions.length);
      const q = figQuestions[altIdx].replace('{name}', f.kurzname);
      pushQA('authorChat|figAlt|' + f.fig_id, q, answer);
    }
  }

  // ── Einzel-Felder als gezielte Q&A ───────────────────────────────────
  // Composite-Antwort enthält Felder als Anhang, aber gezielte Fragen ziehen
  // dann nicht direkt — eigene Samples pro Feld zwingen Modell, jedes Attribut
  // separat zu memorisieren.
  for (const f of figRows) {
    if (f.beruf) {
      pushQA('authorChat|figBeruf|' + f.fig_id,
        langIsEn ? `What does ${f.name} do for a living?` : `Was macht ${f.name} beruflich?`,
        langIsEn ? `${f.name} works as: ${f.beruf}.` : `${f.name} arbeitet als ${f.beruf}.`);
      pushQA('authorChat|figBeruf2|' + f.fig_id,
        langIsEn ? `What is ${f.name}'s profession?` : `Welchen Beruf hat ${f.name}?`,
        f.beruf);
    }
    const geschl = GESCHLECHT_PROSA[String(f.geschlecht || '').trim().toLowerCase()];
    if (geschl) {
      pushQA('authorChat|figGeschl|' + f.fig_id,
        langIsEn ? `What is ${f.name}'s gender?` : `Welches Geschlecht hat ${f.name}?`,
        langIsEn ? `${f.name} is ${geschl.en}.` : `${f.name} ist ${geschl.de}.`);
    }
    const schicht = SCHICHT_PROSA[String(f.sozialschicht || '').trim().toLowerCase()];
    if (schicht) {
      pushQA('authorChat|figSchicht|' + f.fig_id,
        langIsEn ? `Which social class does ${f.name} come from?` : `Aus welcher gesellschaftlichen Schicht stammt ${f.name}?`,
        langIsEn ? `${f.name} comes from ${schicht.en}.` : `${f.name} stammt aus ${schicht.de}.`);
    }
  }

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
      intro);
    pushQA('authorChat|figRole2|' + f.fig_id,
      langIsEn ? `Speak as ${f.name} for a moment.` : `Sprich einen Moment lang als ${f.name}.`,
      intro);
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
        const answer = langIsEn
          ? `${A.name}: ${aDesc} ${B.name}: ${bDesc}`
          : `${A.name}: ${aDesc} ${B.name}: ${bDesc}`;
        pushQA('authorChat|figCmp|' + A.fig_id + '|' + B.fig_id,
          langIsEn ? `What distinguishes ${A.name} from ${B.name}?` : `Was unterscheidet ${A.name} von ${B.name}?`,
          answer);
      }
    }
  }

  // ── Figuren-Charaktereigenschaften (Tags) ────────────────────────────
  // Pro Figur ein dediziertes Trait-Sample, damit "Wie ist X charakterlich?"
  // direkt auf figure_tags zielt (nicht nur als Anhang in der Composite-Antwort).
  for (const f of figRows) {
    if (!f.tags_csv) continue;
    const tags = f.tags_csv.split(',').map(t => t.trim()).filter(Boolean);
    if (!tags.length) continue;
    const tagList = tags.join(', ');
    const traitQs = langIsEn
      ? [`What traits does ${f.name} have?`, `How would you characterize ${f.name}?`,
         `Describe ${f.name}'s personality.`, `What is ${f.name} like as a person?`]
      : [`Welche Eigenschaften hat ${f.name}?`, `Wie würdest du ${f.name} charakterisieren?`,
         `Beschreibe den Charakter von ${f.name}.`, `Was zeichnet ${f.name} charakterlich aus?`];
    const idxs = pickVariants('figTraits|' + f.fig_id, traitQs, traitQs.length);
    const answer = langIsEn
      ? `${f.name} is: ${tagList}.`
      : `${f.name} ist: ${tagList}.`;
    for (const idx of idxs) {
      pushQA('authorChat|figTraits|' + f.fig_id + '|' + idx, traitQs[idx], answer);
    }
  }
}

// Block 17+18+19: Lebensereignisse + Auftritte + Dialogstil
function buildFigureMetaSamples(ctx) {
  const { langIsEn, figRows, eventsByFigPk, appearancesByFigPk, dialogsByFigure, pushQA } = ctx;

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
      const parts = [e.ereignis];
      if (e.datum)     parts.push(langIsEn ? `(${e.datum})` : `(${e.datum})`);
      if (e.bedeutung) parts.push('— ' + e.bedeutung);
      const answer = parts.join(' ');
      pushQA('authorChat|figEvt|' + f.fig_id + '|' + j,
        langIsEn
          ? `What happens to ${f.name} ${e.datum ? `around ${e.datum}` : `during the story`}?`
          : `Was passiert mit ${f.name}${e.datum ? ` (${e.datum})` : ' im Verlauf der Geschichte'}?`,
        answer);
    }
    const allEvtsList = evts.slice(0, 8)
      .map(e => `${e.datum ? e.datum + ': ' : ''}${e.ereignis}${e.bedeutung ? ' (' + e.bedeutung + ')' : ''}`)
      .join(' · ');
    pushQA('authorChat|figAllEvt|' + f.fig_id,
      langIsEn ? `What are the key moments in ${f.name}'s story?` : `Welche Schlüsselmomente erlebt ${f.name}?`,
      allEvtsList);
  }

  // ── Figuren-Auftritte (Kapitel-Liste) ────────────────────────────────
  for (const f of figRows) {
    const chs = appearancesByFigPk.get(f.pk) || [];
    if (!chs.length) continue;
    const answer = chs.join(', ');
    pushQA('authorChat|figApp|' + f.fig_id,
      langIsEn ? `In which chapters does ${f.name} appear?` : `In welchen Kapiteln taucht ${f.name} auf?`,
      langIsEn ? `${f.name} appears in: ${answer}.` : `${f.name} kommt vor in: ${answer}.`);
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

module.exports = { buildFigureBaseSamples, buildFigureMetaSamples };
