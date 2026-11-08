'use strict';
// Pure Songs-Merges der Phase 3: Within-Run-Dedup nach Titel+Interpret, Figuren-Rollen,
// regelbasierter Fallback, Rückholen weggelassener Songs. Ohne DB-Writes, ohne KI.
// Aufrufer: ../orte.js.
const { songKey, songTitleKey, normInterpret, SONG_FIG_ROLLEN } = require('../../../../../db/songs');
const { _remapFigNames } = require('../../utils');
const { unionKapitel, fillEmpty, copyKap, findOmitted, filterSources } = require('../../../../../lib/entity-match/merge-fields');

// Beim Zusammenführen gewinnt der aussagekräftigere Kontext: ein Song, der irgendwo als
// Leitmotiv markiert ist, bleibt Leitmotiv, auch wenn ein anderes Kapitel ihn nur erwähnt.
const SONG_KONTEXT_RANG = { leitmotiv: 5, spielt: 4, 'hört': 3, diegetisch: 2, 'erwähnt': 1 };
const _kontextRang = k => SONG_KONTEXT_RANG[k] || 0;

/** Figuren-Refs eines Songs auf { fig_id, kontext_typ } normalisieren (String = fig_id
 *  ohne Rolle) und je fig_id zusammenfassen; die erste belegte Rolle bleibt. */
function _mergeSongFiguren(target, src) {
  for (const f of (src || [])) {
    const fig_id = typeof f === 'object' && f ? f.fig_id : f;
    if (!fig_id) continue;
    const kontext_typ = (typeof f === 'object' && f && f.kontext_typ) || null;
    const hit = target.find(x => x.fig_id === fig_id);
    if (!hit) target.push({ fig_id, kontext_typ });
    else if (!hit.kontext_typ && kontext_typ) hit.kontext_typ = kontext_typ;
  }
  return target;
}

function _mergeSong(ex, s, opts) {
  _mergeSongFiguren(ex.figuren, s.figuren);
  unionKapitel(ex, s.kapitel, opts);
  if (_kontextRang(s.kontext_typ) > _kontextRang(ex.kontext_typ)) ex.kontext_typ = s.kontext_typ;
  fillEmpty(ex, s, ['interpret', 'genre', 'beschreibung', 'stimmung', 'erste_erwaehnung']);
}

/** Songs eines Laufs nach Titel+Interpret (songKey, dieselbe Identitaet wie im
 *  Schreibpfad) zusammenfuehren: Figuren vereinigt, Kapitel vereinigt (je Kapitel die
 *  hoehere Haeufigkeit, mit `sumKapitel` die Summe), leere Textfelder aus spaeteren
 *  Vorkommen gefuellt, Kontext nach Rang. Ein Eintrag ohne Interpret geht im einzigen
 *  gleichnamigen Eintrag mit Interpret auf; gibt es mehrere (Cover-Versionen), bleibt er
 *  getrennt. Vergibt die lauf-interne id `song_1…N` neu — sie ist KEINE Identitaet (die
 *  stellt saveSongsToDb ueber songKey her), nur muss sie innerhalb des Laufs eindeutig
 *  sein. Die Eingabe bleibt unveraendert. */
function dedupeSongsWithinRun(songs, { sumKapitel = false } = {}) {
  const opts = { sum: sumKapitel };
  const byKey = new Map();
  for (const s of (songs || [])) {
    const k = songKey(s);
    if (!k) continue;
    const ex = byKey.get(k);
    if (!ex) {
      byKey.set(k, { ...s, figuren: _mergeSongFiguren([], s.figuren), kapitel: (s.kapitel || []).map(copyKap) });
    } else {
      _mergeSong(ex, s, opts);
    }
  }
  const byTitle = new Map();
  for (const [k, s] of byKey) {
    const t = songTitleKey(s);
    (byTitle.get(t) ?? byTitle.set(t, []).get(t)).push(k);
  }
  for (const keys of byTitle.values()) {
    const mit = keys.filter(k => normInterpret(byKey.get(k).interpret));
    if (mit.length !== 1) continue;
    const ziel = byKey.get(mit[0]);
    for (const k of keys) {
      if (k === mit[0]) continue;
      _mergeSong(ziel, byKey.get(k), opts);
      byKey.delete(k);
    }
  }
  return [...byKey.values()].map((s, i) => ({ ...s, id: 'song_' + (i + 1) }));
}

/** Figuren-Refs eines Songs (Klarnamen, je mit optionaler Rolle `rolle`) gegen die
 *  kanonische Figurenliste auflösen → [{ fig_id, kontext_typ }]. Nicht auflösbare Namen
 *  fallen weg (wie _remapFigNames), unbekannte Rollen werden zu null. */
function remapSongFiguren(refs, figNameToId, figNameToIdLower) {
  const out = [];
  for (const r of (refs || [])) {
    const [fig_id] = _remapFigNames([r], figNameToId, figNameToIdLower);
    if (!fig_id) continue;
    const rolle = typeof r === 'object' && r && typeof r.rolle === 'string' ? r.rolle.trim() : '';
    _mergeSongFiguren(out, [{ fig_id, kontext_typ: SONG_FIG_ROLLEN.includes(rolle) ? rolle : null }]);
  }
  return out;
}

const _withFiguren = (songs, figNameToId, figNameToIdLower) => (songs || []).map(s => ({
  ...s,
  figuren: remapSongFiguren(s.figuren_namen, figNameToId, figNameToIdLower),
}));

/** Regelbasierter Songs-Merge als Fallback, wenn die KI-Konsolidierung scheitert (analog
 *  buildFallbackOrte): löst figuren_namen gegen die kanonische Figurenliste auf, führt
 *  erst innerhalb jedes Chunks zusammen (Häufigkeit = Maximum, ein Modell nennt denselben
 *  Song mitunter zweimal) und dann über die Chunks (Häufigkeit = Summe, ein grosses
 *  Kapitel ist auf mehrere Chunks gleichen Namens verteilt). */
function buildFallbackSongs(chapterSongs, figNameToId, figNameToIdLower) {
  const flat = [];
  for (const ch of (chapterSongs || [])) {
    flat.push(...dedupeSongsWithinRun(_withFiguren(ch.songs, figNameToId, figNameToIdLower)));
  }
  return dedupeSongsWithinRun(flat, { sumKapitel: true });
}

/** Holt Kapitel-Songs zurück, die die KI-Konsolidierung weder übernommen noch
 *  zusammengeführt hat (Gegenstück zu restoreOmittedOrte; `quellnamen` werden in place
 *  entfernt). Abgedeckt ist ein Kapitel-Song bei gleichem songKey (Titel+Interpret), bei
 *  gleichem Titel, wenn eine Seite keinen Interpreten trägt (dieselbe Regel wie
 *  dedupeSongsWithinRun), oder wenn sein Titel als Quellname eines Ausgabe-Songs steht.
 *  Gleicher Titel mit zwei verschiedenen Interpreten ist eine Cover-Version, also nicht
 *  abgedeckt. Die zurückgeholten Songs baut der regelbasierte Fallback-Merge. */
function restoreOmittedSongs(kiSongs, chapterSongs, figNameToId, figNameToIdLower) {
  const keys = new Set();
  const titlesOhneInterpret = new Set();
  const titlesMitInterpret = new Set();
  const quell = new Set();
  for (const s of (kiSongs || [])) {
    if (!s) continue;
    const k = songKey(s);
    if (k) keys.add(k);
    const t = songTitleKey(s);
    if (t) (normInterpret(s.interpret) ? titlesMitInterpret : titlesOhneInterpret).add(t);
    for (const q of (Array.isArray(s.quellnamen) ? s.quellnamen : [])) {
      const qt = songTitleKey({ titel: q });
      if (qt) quell.add(qt);
    }
    delete s.quellnamen;
  }
  const omitted = findOmitted(chapterSongs, 'songs', {
    keyOf: songKey,
    isCovered: (s) => {
      if (keys.has(songKey(s))) return true;
      const t = songTitleKey(s);
      if (!t) return false;
      if (quell.has(t) || titlesOhneInterpret.has(t)) return true;
      return !normInterpret(s.interpret) && titlesMitInterpret.has(t);
    },
  });
  if (!omitted.length) return [];
  const want = new Set(omitted.map(songKey));
  return buildFallbackSongs(filterSources(chapterSongs, 'songs', songKey, want), figNameToId, figNameToIdLower);
}

module.exports = { dedupeSongsWithinRun, remapSongFiguren, withFiguren: _withFiguren, buildFallbackSongs, restoreOmittedSongs };
