'use strict';

const { splitAtSentence, clipAtSentence, tailFromSentence, chunkAtSentence } = require('../lib/text');
const { extractName } = require('../lib/names');
const { sceneExcerpt } = require('./author-chat/scenes');

function buildSceneSamples(ctx) {
  const {
    samples, counts, opts, langIsEn, unifiedSys,
    bookIdInt, userEmail, bookName,
    pageContents, pageTextById, pageChapterById,
    sceneRows, figsByScene, locsByScene,
    figById, locById,
    chapterKeys, chapterFullTextByKey, chapterNameByKey,
    pagesByChapter,
    figRows, locRows, appearancesByFigPk, chaptersByLocPk,
    eventsBySceneId = new Map(),
  } = ctx;
  const { minChars, maxFullChars, fulltext } = opts;
  // Ziele schon im Sampler auf den Antwort-Deckel des Typs schneiden
  // (`maxAnswerChars.sceneWrite`, finalize.js kürzt sonst bzw. verwirft
  // «Teil N von M»-Stücke): lieber mehr kurze Teile als abgeschnittene.
  const writeCap = Number(opts.maxAnswerChars?.sceneWrite) || Infinity;
  const maxChars = Math.min(opts.maxChars, writeCap);
  const fullChars = Math.min(maxFullChars, writeCap);
  const eventLine = (scenes) => [...new Set(scenes.flatMap(sc => (eventsBySceneId.get(sc.id) || []).map(e => e.ereignis)))].join('; ');

  // Seite → Kapitel-Schlüssel (für Train/Val-Split auf Quell-Ebene, siehe
  // finalize.js — alle Ableitungen eines Kapitels landen im selben Split).
  const pageChById = new Map(pageContents.map(p => [p.id, p.chapter_id ?? 0]));

  const scenesByPageId = new Map();
  for (const s of sceneRows) {
    if (!s.page_id) continue;
    if (!scenesByPageId.has(s.page_id)) scenesByPageId.set(s.page_id, []);
    scenesByPageId.get(s.page_id).push(s);
  }
  for (const [pageId, scenes] of scenesByPageId) {
    const txt = pageTextById.get(pageId);
    if (!txt || txt.length < minChars) continue;
    const completion = clipAtSentence(txt, maxChars);
    const meta = [];
    const titel = [...new Set(scenes.map(s => s.titel).filter(Boolean))].join(' / ');
    if (titel) meta.push((langIsEn ? 'Title: ' : 'Titel: ') + titel);
    const kapitel = scenes[0].kapitel || pageChapterById.get(pageId);
    if (kapitel) meta.push((langIsEn ? 'Chapter: ' : 'Kapitel: ') + kapitel);
    const figIds = [...new Set(scenes.flatMap(s => figsByScene.get(s.id) || []))];
    const figNames = figIds.map(id => extractName(id, figById)).filter(Boolean);
    if (figNames.length) meta.push((langIsEn ? 'Characters: ' : 'Figuren: ') + figNames.join(', '));
    const locIds = [...new Set(scenes.flatMap(s => locsByScene.get(s.id) || []))];
    const locNames = locIds.map(id => extractName(id, locById)).filter(Boolean);
    if (locNames.length) meta.push((langIsEn ? 'Location: ' : 'Schauplatz: ') + locNames.join(', '));
    // Inhalt aus den verknüpften Ereignissen; `kommentar` ist Lektorat.
    const evts = eventLine(scenes);
    if (evts) meta.push((langIsEn ? 'What happens: ' : 'Was geschieht: ') + evts);
    if (meta.length === 0) continue;
    const instr = (langIsEn
      ? 'Write a scene with the following parameters:\n'
      : 'Schreibe eine Szene mit folgenden Vorgaben:\n') + meta.join('\n');
    samples.push({
      id: 'scene|' + pageId,
      type: 'scene',
      sourceKey: 'ch:' + (pageChById.get(pageId) ?? 0),
      messages: [
        { role: 'system', content: unifiedSys },
        { role: 'user', content: instr },
        { role: 'assistant', content: completion },
      ],
    });
    counts.scene++;
  }

  // ── Szene schreiben aus Kapitel- und Figurenkontext ──────────────────
  // Trägt ein Abschnitt mehrere Szenen, bekommt jede ihre eigene Aufgabe:
  // Kapitel, Figuren und Kurzfassung der Szene plus der Vorlauf davor → die
  // Originalpassage der Szene. Bei einer Szene pro Abschnitt deckt das
  // Abschnitts-Sample oben dasselbe ab.
  for (const [pageId, scenes] of scenesByPageId) {
    if (scenes.length < 2) continue;
    const pageText = pageTextById.get(pageId) || '';
    for (const s of scenes) {
      if (!s.titel) continue;
      const ex = sceneExcerpt(s, { figsByScene, figById, pageContents, maxChars, eventsBySceneId });
      if (!ex) continue;
      const at = pageText.indexOf(ex.text);
      const lead = at > 0 ? tailFromSentence(pageText.slice(0, at).trim(), 400) : '';
      const meta = [];
      const kapitel = s.kapitel || pageChapterById.get(pageId);
      if (kapitel) meta.push((langIsEn ? 'Chapter: ' : 'Kapitel: ') + kapitel);
      if (ex.figs.length) meta.push((langIsEn ? 'Characters: ' : 'Figuren: ') + ex.figs.map(f => f.name).join(', '));
      const evts = eventLine([s]);
      if (evts) meta.push((langIsEn ? 'What happens: ' : 'Was geschieht: ') + evts);
      const instr = (langIsEn
        ? `Write the scene «${s.titel}» in the author's style.\n`
        : `Schreibe die Szene «${s.titel}» im Stil des Autors.\n`)
        + meta.join('\n')
        + (lead ? '\n\n' + (langIsEn ? 'What comes before:\n' : 'Davor:\n') + lead : '');
      samples.push({
        id: 'sceneWrite|' + s.id,
        type: 'scene',
        sourceKey: 'ch:' + (pageChById.get(pageId) ?? 0),
        messages: [
          { role: 'system', content: unifiedSys },
          { role: 'user', content: instr },
          { role: 'assistant', content: ex.text },
        ],
      });
      counts.scene++;
    }
  }

  // ── Alle Seiten als Meta→Text (unabhängig vom Scene-Mapping) ─────────
  // Der User will den gesamten Buchinhalt internalisiert — jede Seite
  // erhält ein Sample „Seite «X», Kapitel «Y»: schreibe den Inhalt" →
  // Seitentext. Das doppelt sich bewusst mit dem Szenen-Block (dort
  // metadaten-reicher), hier einfacher und vollständig deckend.
  // Abschnitte über `maxChars` laufen in Satzgrenzen-Teilen durch: ein harter
  // Zeichen-Schnitt brächte dem Modell bei, mitten im Wort aufzuhören, und der
  // Rest des Abschnitts fehlte in allen Samples dieses Blocks.
  for (const p of pageContents) {
    if (!p.text || p.text.length < minChars) continue;
    const pageCh = 'ch:' + (p.chapter_id ?? 0);
    const metaParts = [];
    if (bookName) metaParts.push(langIsEn ? `Book: «${bookName}»` : `Buch: «${bookName}»`);
    if (p.chapter) metaParts.push(langIsEn ? `Chapter: «${p.chapter}»` : `Kapitel: «${p.chapter}»`);
    if (p.title)   metaParts.push(langIsEn ? `Section: «${p.title}»` : `Abschnitt: «${p.title}»`);
    const prefix = metaParts.length ? metaParts.join(' · ') + '\n\n' : '';
    const chunks = chunkAtSentence(p.text, maxChars);
    const total = chunks.length;

    for (let ci = 0; ci < total; ci++) {
      const completion = chunks[ci];
      const idSuffix = ci ? '|c' + ci : '';
      if (completion.length < 80) continue;
      const instr = total === 1
        ? (langIsEn ? 'Write the content of this section:\n' : 'Schreibe den Inhalt dieses Abschnitts:\n')
          + metaParts.join('\n')
        : (langIsEn
            ? `Write part ${ci + 1} of ${total} of this section:\n`
            : `Schreibe Teil ${ci + 1} von ${total} dieses Abschnitts:\n`)
          + metaParts.join('\n')
          + (ci > 0
            ? '\n\n' + (langIsEn ? 'Continues from:\n' : 'Anschluss an:\n') + tailFromSentence(chunks[ci - 1], 300)
            : '');
      samples.push({
        id: 'page|' + p.id + idSuffix,
        type: 'scene',
        sourceKey: pageCh,
        // „Teil N von M" gekappt wäre ein falsches Teilstück
        ...(total > 1 ? { noTruncate: true } : {}),
        messages: [
          { role: 'system', content: unifiedSys },
          { role: 'user', content: instr },
          { role: 'assistant', content: completion },
        ],
      });
      counts.scene++;

      // ── Sliding-Window: Cuts über den ganzen Teil ─────────────────────
      // Anfang/Mitte/Ende, damit das Modell nicht nur eröffnen, sondern auch
      // zur Hälfte und am Ende weiterschreiben lernt.
      if (completion.length >= minChars * 2) {
        for (const cut of [0.1, 0.25, 0.4, 0.55, 0.7, 0.85]) {
          const [opening, rest] = splitAtSentence(completion, cut);
          if (opening.length < 80 || rest.length < 120) continue;
          samples.push({
            id: 'pageCont|' + p.id + '|' + Math.round(cut * 100) + idSuffix,
            type: 'scene',
            sourceKey: pageCh,
            messages: [
              { role: 'system', content: unifiedSys },
              { role: 'user', content: (langIsEn
                ? 'Continue this passage:\n\n'
                : 'Setze diese Passage fort:\n\n') + prefix + opening },
              { role: 'assistant', content: rest },
            ],
          });
          counts.scene++;
        }
      }

      // ── Cloze-Vervollständigung: Mittelteil herausschneiden ────────────
      // Lehrt Inferenz innerhalb einer Passage, multipliziert vorhandenen
      // Buchtext um Faktor 3 ohne neue Inhalte. Schnitt an Satzgrenzen, damit
      // Output nicht mit Halbsatz beginnt.
      if (completion.length >= minChars * 3) {
        const [head, midTail] = splitAtSentence(completion, 0.33);
        const [mid, tail]    = splitAtSentence(midTail, 0.5);
        if (head.length >= 80 && mid.length >= 80 && tail.length >= 80) {
          const gap = '\n\n[…]\n\n';
          samples.push({
            id: 'pageCloze|' + p.id + idSuffix,
            type: 'scene',
            sourceKey: pageCh,
            messages: [
              { role: 'system', content: unifiedSys },
              { role: 'user', content: (langIsEn
                ? 'Fill in the missing middle section of this passage:\n\n'
                : 'Vervollständige den fehlenden Mittelteil dieser Passage:\n\n') + prefix + head + gap + tail },
              { role: 'assistant', content: mid },
            ],
          });
          counts.scene++;
        }
      }
    }
  }

  // ── Multi-Page-Continuation: N Vorseiten → nächste Seite ─────────────
  // Lange Kontextfenster ausnutzen (Mistral 128k). Lehrt Konsistenz über
  // Seitengrenzen hinweg: gleiche Figurenbestand, Tempus, POV.
  const pagesByChapterArr = [...pagesByChapter.values()];
  for (const pages of pagesByChapterArr) {
    if (pages.length < 2) continue;
    for (let i = 1; i < pages.length; i++) {
      const cur = pages[i];
      if (!cur.text || cur.text.length < minChars) continue;
      const prevSlice = pages.slice(Math.max(0, i - 2), i);
      const ctxText = prevSlice.map(p => p.text).join('\n\n');
      if (ctxText.length < minChars) continue;
      const ctxCapped = tailFromSentence(ctxText, maxFullChars);
      const completion = clipAtSentence(cur.text, maxChars);
      samples.push({
        id: 'pageMulti|' + cur.id,
        type: 'scene',
        sourceKey: 'ch:' + (cur.chapter_id ?? 0),
        messages: [
          { role: 'system', content: unifiedSys },
          { role: 'user', content: (langIsEn
            ? 'Here are the previous sections. Write the next section:\n\n'
            : 'Hier die vorherigen Abschnitte. Schreibe den nächsten Abschnitt:\n\n') + ctxCapped },
          { role: 'assistant', content: completion },
        ],
      });
      counts.scene++;
    }
  }

  // ── Kapitel-Anfänge mit vollem Metadaten-Kontext (#4) ────────────────
  // Pro Kapitel: Prompt kombiniert Kapitelname + Figuren (aus
  // figure_appearances), Orte (aus location_chapters) + Vorgänger-Ausklang →
  // Completion = Kapitelanfang. Lehrt, wie Kapitel in genau diesem Buch
  // begonnen werden, mit welcher Besetzung und Stimmung. Keine
  // Kapitelbewertung (chapter_reviews) im Prompt: ihre «Zusammenfassung» ist
  // ein Gesamteindruck des Lektorats, keine Inhaltsangabe.
  // figures per chapter via figure_appearances.chapter_name
  const figsByChName = new Map();
  for (const f of figRows) {
    for (const ch of (appearancesByFigPk.get(f.pk) || [])) {
      if (!figsByChName.has(ch)) figsByChName.set(ch, []);
      figsByChName.get(ch).push(f.name);
    }
  }
  // locations per chapter via location_chapters
  const locsByChName = new Map();
  for (const l of locRows) {
    for (const ch of (chaptersByLocPk.get(l.pk) || [])) {
      if (!locsByChName.has(ch)) locsByChName.set(ch, []);
      locsByChName.get(ch).push(l.name);
    }
  }

  for (let ci = 0; ci < chapterKeys.length; ci++) {
    const k = chapterKeys[ci];
    const text = chapterFullTextByKey.get(k) || '';
    if (text.length < 400) continue;
    const name = chapterNameByKey.get(k);
    const opening = clipAtSentence(text, Math.min(3000, maxChars));
    if (opening.length < 200) continue;
    const metaLines = [];
    if (bookName) metaLines.push(langIsEn ? `Book: «${bookName}»` : `Buch: «${bookName}»`);
    metaLines.push(langIsEn ? `Chapter: «${name}»` : `Kapitel: «${name}»`);
    const chFigs = (figsByChName.get(name) || []).slice(0, 10);
    if (chFigs.length) metaLines.push(langIsEn ? `Cast: ${chFigs.join(', ')}` : `Figuren: ${chFigs.join(', ')}`);
    const chLocs = (locsByChName.get(name) || []).slice(0, 6);
    if (chLocs.length) metaLines.push(langIsEn ? `Settings: ${chLocs.join(', ')}` : `Schauplätze: ${chLocs.join(', ')}`);
    // Vorgänger-Ausklang: letzte 400 Zeichen des vorherigen Kapitels
    if (ci > 0) {
      const prevText = chapterFullTextByKey.get(chapterKeys[ci - 1]) || '';
      if (prevText.length > 200) {
        const prevTail = tailFromSentence(prevText, 400);
        metaLines.push((langIsEn
          ? `Previous chapter ended with: `
          : `Vorheriges Kapitel endete mit: `) + prevTail);
      }
    }
    const instr = (langIsEn
      ? 'Begin this chapter in the author\'s style:\n'
      : 'Beginne dieses Kapitel im Stil des Autors:\n') + metaLines.join('\n');
    samples.push({
      id: 'chapOpen|' + k,
      type: 'scene',
      sourceKey: 'ch:' + k,
      messages: [
        { role: 'system', content: unifiedSys },
        { role: 'user',   content: instr },
        { role: 'assistant', content: opening },
      ],
    });
    counts.scene++;
  }

  // ── Voll-Kapitel-Samples (chunked nach maxFullChars) ─────────────────
  // Lange Kapitel werden in Slices ≤maxFullChars gesplittet (an Satzgrenzen),
  // jeder Slice = eigenes Sample mit Part-Label + Vorgänger-Tail als
  // Continuity-Kontext. `maxFullChars` leitet index.js aus `maxSeqTokens` ab,
  // damit die Slices ins Sequenz-Budget passen (4096 → ~8000 chars DE).
  // Generiert: (a) chunked-fulltext, (b) Sliding-Window-Cuts auf 1. Slice,
  // (c) Kapitel→Kapitel-Continuation mit gestutztem Vorgänger-Tail.
  if (fulltext) {
    for (let ci = 0; ci < chapterKeys.length; ci++) {
      const k = chapterKeys[ci];
      const text = chapterFullTextByKey.get(k) || '';
      if (text.length < 600) continue;
      const name = chapterNameByKey.get(k);

      const metaLines = [];
      if (bookName) metaLines.push(langIsEn ? `Book: «${bookName}»` : `Buch: «${bookName}»`);
      metaLines.push(langIsEn ? `Chapter: «${name}»` : `Kapitel: «${name}»`);
      const chFigs = (figsByChName.get(name) || []).slice(0, 12);
      if (chFigs.length) metaLines.push(langIsEn ? `Cast: ${chFigs.join(', ')}` : `Figuren: ${chFigs.join(', ')}`);
      const chLocs = (locsByChName.get(name) || []).slice(0, 8);
      if (chLocs.length) metaLines.push(langIsEn ? `Settings: ${chLocs.join(', ')}` : `Schauplätze: ${chLocs.join(', ')}`);

      // (a) Voll-Kapitel chunked. Jeder Slice eigenständiges Sample. Bei
      // total>1 enthält Prompt Part-Label + Vorgänger-Tail (300 chars) als
      // Continuity-Anker, damit Modell die Kette als zusammenhängenden
      // Kapitelfluss lernt statt isolierte Schnipsel.
      const slices = chunkAtSentence(text, fullChars);
      const total = slices.length;
      for (let si = 0; si < total; si++) {
        const slice = slices[si];
        if (slice.length < 200) continue;
        const partLabel = total > 1
          ? (langIsEn ? `Part: ${si + 1} of ${total}` : `Teil: ${si + 1} von ${total}`)
          : null;
        const sliceMeta = partLabel ? [...metaLines, partLabel] : metaLines;
        const ctxTail = si > 0 ? tailFromSentence(slices[si - 1], 300) : '';
        const ctxBlock = ctxTail
          ? '\n\n' + (langIsEn ? 'Continues from:\n' : 'Anschluss an:\n') + ctxTail
          : '';
        const instr = total === 1
          ? (langIsEn
              ? 'Write this entire chapter in the author\'s style:\n'
              : 'Schreibe das ganze Kapitel im Stil des Autors:\n') + sliceMeta.join('\n')
          : (langIsEn
              ? `Write part ${si + 1} of ${total} of this chapter in the author's style:\n`
              : `Schreibe Teil ${si + 1} von ${total} dieses Kapitels im Stil des Autors:\n`)
            + sliceMeta.join('\n') + ctxBlock;
        samples.push({
          id: total > 1 ? 'chapFullChunk|' + k + '|' + si : 'chapFull|' + k,
          type: 'scene',
          sourceKey: 'ch:' + k,
          noTruncate: true, // „Teil N von M" gekappt wäre ein falsches Teilstück
          messages: [
            { role: 'system', content: unifiedSys },
            { role: 'user', content: instr },
            { role: 'assistant', content: slice },
          ],
        });
        counts.scene++;
      }

      // (b) Sliding-Window-Cuts auf 1. Slice (oder ganzem Kapitel, falls
      // nicht gechunkt). Bei mehreren Slices liegen die Cuts „innerhalb
      // Teil 1" — die Folge-Slices werden bereits durch (a) abgedeckt.
      const baseSlice = slices[0];
      for (const cut of [0.1, 0.25, 0.4, 0.55, 0.7, 0.85]) {
        const [head, rest] = splitAtSentence(baseSlice, cut);
        if (head.length < 200 || rest.length < 200) continue;
        samples.push({
          id: 'chapCont|' + k + '|' + Math.round(cut * 100),
          type: 'scene',
          sourceKey: 'ch:' + k,
          messages: [
            { role: 'system', content: unifiedSys },
            { role: 'user', content: (langIsEn
              ? 'Continue this chapter:\n\n'
              : 'Setze dieses Kapitel fort:\n\n') + metaLines.join(' · ') + '\n\n' + head },
            { role: 'assistant', content: rest },
          ],
        });
        counts.scene++;
      }

      // (c) Kapitel→Kapitel-Continuation: gestutzter Vorgänger-Tail
      // (maxFullChars/2) + Anfang Kapitel N → Rest Kapitel N. Tail-Cap
      // hält Sample im seqlen-Budget auch bei kleinem maxFullChars.
      if (ci > 0) {
        const prevK = chapterKeys[ci - 1];
        const prevText = chapterFullTextByKey.get(prevK) || '';
        const prevName = chapterNameByKey.get(prevK);
        if (prevText.length >= 400) {
          const prevTailCap = Math.max(800, Math.floor(maxFullChars / 2));
          const prevCapped = tailFromSentence(prevText, prevTailCap);
          const [chHead, chRest] = splitAtSentence(baseSlice, 0.1);
          if (chHead.length >= 100 && chRest.length >= 200) {
            const ctxLabel = langIsEn
              ? `Previous chapter «${prevName}» ended:\n${prevCapped}\n\nNew chapter «${name}» begins:\n${chHead}`
              : `Vorheriges Kapitel «${prevName}» endete:\n${prevCapped}\n\nNeues Kapitel «${name}» beginnt:\n${chHead}`;
            samples.push({
              id: 'chapBridge|' + k,
              type: 'scene',
              sourceKey: 'ch:' + k,
              messages: [
                { role: 'system', content: unifiedSys },
                { role: 'user', content: (langIsEn
                  ? 'Write the rest of the new chapter, picking up from where it begins:\n\n'
                  : 'Schreibe das neue Kapitel weiter, knüpfend an den Anfang:\n\n') + ctxLabel },
                { role: 'assistant', content: chRest },
              ],
            });
            counts.scene++;
          }
        }
      }
    }
  }
}

module.exports = { buildSceneSamples };
