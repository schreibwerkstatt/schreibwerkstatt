'use strict';

const { figureTypePhrase, genderOf } = require('../core-facts/words');
const { relationAnswers } = require('../core-facts/relations');
const { declineName, capFirst, contract } = require('../core-facts/naming');
const { joinList } = require('../core-facts/events');
const { SCHICHT_PROSA } = require('./figures');

// Block 12-16: Cast-Aggregate + Familien + Macht + Tags
function buildRelationSamples(ctx) {
  const { langIsEn, figRows, figById, figRelRows, pushQA, displayName } = ctx;
  // Eigenname, nach dem man fragt (core-facts/naming.js) — Rollenfiguren
  // und mehrdeutige Namen tragen keine Beziehungs- und Attributfragen.
  const proper = (id) => ctx.figNameInfo?.get(id)?.proper !== false;

  // Einzelbeziehungen («Wie steht A zu B?», beide Richtungen) stehen als
  // Kernwissen in ../core-facts/relations.js; hier bleiben die Sammellisten.

  // ── Cast-Aggregate (Figurentyp-Übersicht) ────────────────────────────
  // Gruppiert Figuren nach figures.typ (Hauptfigur, Nebenfigur, Statist, …).
  // Liefert Gesamt-Übersichten („Wer sind die Hauptfiguren?") und Per-Figur-
  // Rollen-Q&A („Welche Rolle spielt X im Buch?").
  {
    const figsByType = new Map(); // typLower → { label, items }
    for (const f of figRows) {
      const typRaw = (f.typ || '').trim();
      if (!typRaw) continue;
      const key = typRaw.toLowerCase();
      if (!figsByType.has(key)) figsByType.set(key, { label: typRaw, items: [] });
      figsByType.get(key).items.push(f);
    }

    // Buchweite Gesamtübersicht
    const totalFigs = figRows.length;
    if (totalFigs > 0) {
      const breakdown = [...figsByType.entries()]
        .sort((a, b) => b[1].items.length - a[1].items.length)
        .map(([, g]) => `${g.items.length}× ${g.label}`)
        .join(', ');
      pushQA('authorChat|cast-count',
        langIsEn ? 'How many characters are in the book?' : 'Wie viele Figuren hat das Buch?',
        breakdown
          ? (langIsEn
              ? `${totalFigs} characters in total (${breakdown}).`
              : `Insgesamt ${totalFigs} Figuren (${breakdown}).`)
          : (langIsEn ? `${totalFigs} characters in total.` : `Insgesamt ${totalFigs} Figuren.`));
    }

    // Per Typ: Liste der Figuren mit kurzer Beschreibung
    for (const [key, group] of figsByType) {
      const names = group.items.map(f => f.name);
      if (!names.length) continue;
      const labelLow = group.label.toLowerCase();
      const richLines = group.items.slice(0, 20).map(f => {
        const desc = (f.beschreibung || '').trim();
        const short = desc ? desc.split(/(?<=[.!?])\s/)[0] : '';
        return short ? `${f.name} — ${short}` : f.name;
      }).join('; ');

      // Mehrere Frageparaphrasen pro Typ
      const typeQs = langIsEn
        ? [`Who are the ${labelLow}s in the book?`,
           `Which characters are ${labelLow}s?`,
           `List the ${labelLow}s.`]
        : [`Wer sind die ${group.label}n des Romans?`,
           `Welche Figuren sind ${group.label}n?`,
           `Nenne mir die ${group.label}n.`];
      for (let qi = 0; qi < typeQs.length; qi++) {
        pushQA('authorChat|cast-type|' + key + '|' + qi, typeQs[qi], richLines || names.join(', '));
      }

      // Pro Figur dieser Typ-Klasse: Rollen-Q&A
      for (const f of group.items) {
        const phrase = figureTypePhrase(f.typ, genderOf(f), langIsEn);
        if (!phrase || !proper(f.fig_id)) continue;
        const name = ctx.figNameInfo?.get(f.fig_id)?.name || f.name;
        const head = /^\p{Lu}/u.test(name)
          ? (langIsEn ? `${name} is ${phrase} in «${displayName}».` : `${name} ist ${phrase} in «${displayName}».`)
          : (langIsEn ? `In «${displayName}», ${name} is ${phrase}.` : `In «${displayName}» ist ${name} ${phrase}.`);
        pushQA('authorChat|cast-figType|' + f.fig_id,
          langIsEn ? `What role does ${name} play in the book?` : `Welche Rolle spielt ${declineName(name, 'nom') || name} im Roman?`,
          head);
      }
    }
  }

  // ── Familien-Aggregate (verwandtschaftliche Beziehungen) ─────────────
  // Heuristik: figure_relations.typ matched gegen Familien-Keywords.
  // Verbundene Komponenten = Familien. Pro Figur Familien-Übersicht.
  {
    const familyKeywordsDe = ['vater','mutter','sohn','tochter','kind','ehepartner','ehemann','ehefrau','frau','mann',
      'geschwister','bruder','schwester','onkel','tante','neffe','nichte','cousin','cousine',
      'grossvater','grossmutter','grosseltern','opa','oma','schwiegervater','schwiegermutter',
      'schwiegersohn','schwiegertochter','stiefvater','stiefmutter','stiefsohn','stieftochter',
      'halbbruder','halbschwester','familie','verwandt','verlobt','verlobte','verlobter','adoptiert','pflege'];
    const familyKeywordsEn = ['father','mother','son','daughter','child','spouse','husband','wife',
      'sibling','brother','sister','uncle','aunt','nephew','niece','cousin',
      'grandfather','grandmother','grandparent','stepfather','stepmother','stepson','stepdaughter',
      'half-brother','half-sister','family','relative','fiance','fiancee','adopted'];
    const isFamilyTyp = (typ) => {
      const t = (typ || '').toLowerCase();
      if (!t) return false;
      return familyKeywordsDe.some(k => t.includes(k)) || familyKeywordsEn.some(k => t.includes(k));
    };
    const familyRels = figRelRows.filter(r => isFamilyTyp(r.typ));

    if (familyRels.length) {
      // Union-Find über Familien-Komponenten
      const parent = new Map();
      const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
      const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
      for (const f of figRows) parent.set(f.fig_id, f.fig_id);
      for (const r of familyRels) {
        if (parent.has(r.from_fig_id) && parent.has(r.to_fig_id)) union(r.from_fig_id, r.to_fig_id);
      }
      const families = new Map(); // root → [fig_id]
      for (const f of figRows) {
        if (!parent.has(f.fig_id)) continue;
        const root = find(f.fig_id);
        if (!families.has(root)) families.set(root, []);
        families.get(root).push(f.fig_id);
      }
      // Nur Familien mit ≥2 Mitgliedern, die auch wirklich Familien-Relations haben
      const familyRoots = [...families.entries()].filter(([root, members]) => {
        if (members.length < 2) return false;
        const memberSet = new Set(members);
        return familyRels.some(r => memberSet.has(r.from_fig_id) && memberSet.has(r.to_fig_id));
      });

      // Familien-relevante Figuren-Map (für Per-Figur-Antworten)
      const familyByFig = new Map();
      for (const [root, members] of familyRoots) {
        for (const m of members) familyByFig.set(m, root);
      }

      // Pro Familie: Mitgliederliste + Beziehungs-Aufzählung
      for (const [root, members] of familyRoots) {
        const memberSet = new Set(members);
        const memberNames = members.map(id => figById.get(id)?.name).filter(Boolean);
        // Je Beziehung ein ganzer Satz aus dem Kernwissen («Gisela ist
        // Stefans Mutter.»), nie die Rohform «Gisela ↔ Stefan: kind».
        const lines = (ctx.relationFacts || [])
          .filter(r => memberSet.has(r.a.fig_id) && memberSet.has(r.b.fig_id))
          .map(r => relationAnswers({ X: r.a, Y: r.b, typY: r.typ, desc: '' }, langIsEn)[0])
          .filter(Boolean);
        const rootName = figById.get(root)?.name || memberNames[0] || root;
        const answer = (langIsEn
          ? `The family around ${rootName}: ${joinList(memberNames, true)}. ${lines.slice(0, 8).join(' ')}`
          : `Zur Familie um ${rootName} gehören ${joinList(memberNames, false)}. ${lines.slice(0, 8).join(' ')}`).trim();
        pushQA('authorChat|family|' + root,
          langIsEn ? `Describe the family around ${rootName}.` : `Beschreibe die Familie um ${rootName}.`,
          answer);
        pushQA('authorChat|family-rel|' + root,
          langIsEn ? `What are the family relationships in this group?` : `Wie sind die Familienverhältnisse hier?`,
          answer);
      }

      // Buchweite Familien-Übersicht
      if (familyRoots.length) {
        const overview = familyRoots.map(([root, members]) => {
          const rootName = figById.get(root)?.name || root;
          const others = members.map(id => figById.get(id)?.name).filter(Boolean);
          return `${rootName}-Familie (${others.join(', ')})`;
        }).join('; ');
        pushQA('authorChat|family-overview',
          langIsEn ? 'How are the families structured in the book?' : 'Wie sind die Familienverhältnisse im Buch?',
          overview);
      }

      // Per Figur: persönliche Familien-Antwort
      for (const f of figRows) {
        const root = familyByFig.get(f.fig_id);
        if (!root) continue;
        const personal = [];
        for (const r of familyRels) {
          const isFrom = r.from_fig_id === f.fig_id;
          const isTo   = r.to_fig_id   === f.fig_id;
          if (!isFrom && !isTo) continue;
          const otherId = isFrom ? r.to_fig_id : r.from_fig_id;
          const otherName = figById.get(otherId)?.name;
          if (!otherName) continue;
          const t = (r.typ || '').trim();
          const d = (r.beschreibung || '').trim();
          personal.push(`${otherName} (${t}${d ? ' — ' + d : ''})`);
        }
        if (!personal.length) continue;
        pushQA('authorChat|family-fig|' + f.fig_id,
          langIsEn ? `Who are ${f.name}'s family members?` : `Wer gehört zur Familie von ${f.name}?`,
          personal.slice(0, 10).join(', '));
      }
    }
  }

  // ── Macht-/Hierarchie-Aggregate ──────────────────────────────────────
  // Quellen: figures.sozialschicht (statisch) + figure_relations.typ
  // (Macht-Keywords). Liefert Per-Figur-Antworten und buchweite Übersicht.
  {
    const powerKeywordsDe = ['vorgesetzt','untergeb','chef','mitarbeit','herr ','herrin','diener','dienstmagd',
      'meister','schüler','lehrling','lehrer','anführer','gefolg','sklave','sklavin','knecht','magd',
      'herrscher','untertan','könig','königin','vasall','mentor','protegé','wache','leibwache','komman'];
    const powerKeywordsEn = ['superior','subordinate','boss','employee','master','servant','apprentice',
      'teacher','leader','follower','slave','ruler','subject','vassal','mentor','guard','commander'];
    const isPowerTyp = (typ) => {
      const t = (typ || '').toLowerCase();
      if (!t) return false;
      return powerKeywordsDe.some(k => t.includes(k)) || powerKeywordsEn.some(k => t.includes(k));
    };
    const powerRels = figRelRows.filter(r => isPowerTyp(r.typ));

    // Per Figur: sozialschicht
    const bySchicht = new Map();
    for (const f of figRows) {
      const s = (f.sozialschicht || '').trim();
      if (!s) continue;
      if (!bySchicht.has(s)) bySchicht.set(s, []);
      bySchicht.get(s).push(f);
      const prosa = SCHICHT_PROSA[s.toLowerCase()];
      if (!prosa || !proper(f.fig_id)) continue;
      pushQA('authorChat|schicht-fig|' + f.fig_id,
        langIsEn ? `Which social class does ${f.name} belong to?` : `In welcher gesellschaftlichen Schicht steht ${f.name}?`,
        langIsEn ? `${f.name} belongs to ${prosa.en}.` : contract(`${f.name} gehört zu ${prosa.de}.`));
    }
    // Per Schicht: Zugehörige Figuren
    for (const [schicht, members] of bySchicht) {
      if (members.length < 1) continue;
      const names = members.map(f => f.name).join(', ');
      pushQA('authorChat|schicht|' + schicht.toLowerCase(),
        langIsEn ? `Which characters belong to the ${schicht}?` : `Welche Figuren gehören zur ${schicht}?`,
        names);
    }

    // Buchweite Macht-Übersicht
    const lines = [];
    if (bySchicht.size) {
      const sortedSchichten = [...bySchicht.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([s, m]) => `${s}: ${m.map(f => f.name).join(', ')}`);
      lines.push(...sortedSchichten);
    }
    if (powerRels.length) {
      const relLines = powerRels.slice(0, 15).map(r => {
        const a = figById.get(r.from_fig_id)?.name;
        const b = figById.get(r.to_fig_id)?.name;
        if (!a || !b) return null;
        const t = (r.typ || '').trim();
        const d = (r.beschreibung || '').trim();
        return `${a} → ${b}: ${t}${d ? ' (' + d + ')' : ''}`;
      }).filter(Boolean);
      lines.push(...relLines);
    }
    if (lines.length) {
      const overview = lines.join('; ');
      pushQA('authorChat|power-overview',
        langIsEn ? 'How are power dynamics structured in the book?' : 'Wie sind die Machtverhältnisse im Buch?',
        overview);
      pushQA('authorChat|hierarchy-overview',
        langIsEn ? 'Describe the hierarchy in the book.' : 'Beschreibe die Hierarchie im Buch.',
        overview);
    }

    // Pro Macht-Beziehung: dedizierte Frage (über Standard-Beziehungs-Q&A hinaus)
    for (const r of powerRels) {
      const a = figById.get(r.from_fig_id)?.name;
      const b = figById.get(r.to_fig_id)?.name;
      if (!a || !b) continue;
      const t = (r.typ || '').trim();
      const d = (r.beschreibung || '').trim();
      if (!t && !d) continue;
      // Nur mit Beschreibung, und nur zwischen benannten Figuren: das rohe
      // Typwort («vorgesetzter: …») ist kein Satz.
      if (!d || !proper(r.from_fig_id) || !proper(r.to_fig_id)) continue;
      const answer = capFirst(d);
      pushQA('authorChat|power-rel|' + r.from_fig_id + '|' + r.to_fig_id,
        langIsEn ? `What is the power relationship between ${a} and ${b}?` : `In welchem Machtverhältnis stehen ${a} und ${b}?`,
        answer);
    }
  }

  // ── Tag-Aggregate (Figuren mit Eigenschaft X) ────────────────────────
  // Reverse-Lookup: pro Tag alle Figuren, die ihn tragen. Erlaubt Fragen
  // wie "Welche Figuren sind mutig?" — das aktuelle Per-Figur-Sample
  // beantwortet nur die Gegenrichtung.
  {
    const figsByTag = new Map(); // tagLower → { label, names }
    for (const f of figRows) {
      if (!f.tags_csv) continue;
      for (const raw of f.tags_csv.split(',')) {
        const tag = raw.trim();
        if (!tag) continue;
        const key = tag.toLowerCase();
        if (!figsByTag.has(key)) figsByTag.set(key, { label: tag, names: [] });
        figsByTag.get(key).names.push(f.name);
      }
    }
    for (const [key, group] of figsByTag) {
      if (group.names.length < 1) continue;
      pushQA('authorChat|tag|' + key,
        langIsEn ? `Which characters are ${group.label}?` : `Welche Figuren sind ${group.label}?`,
        group.names.join(', '));
    }
  }
}

module.exports = { buildRelationSamples };
