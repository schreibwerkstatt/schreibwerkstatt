'use strict';
// Beziehungs-Helper der Komplettanalyse-Phase 2: Zielnamen anreichern und neu
// binden, Beschreibungen prüfen, flache A2-Beziehungen falten. Facade:
// ../figuren-merge.js.

const { normName: _normalizeName, nameTokens: _nameTokens, nameQualifier, stripNameQualifier: stripQualifier } = require('../../../../lib/name-normalize');

/** Reichert `beziehungen[].figur_id` mit dem Zielnamen an (mutiert in place, liefert
 *  die Anzahl gesetzter Namen). MUSS auf den ROHEN Phase-1-Chunks laufen, vor jedem
 *  Merge.
 *
 *  **Why:** `figur_id` ist CHUNK-LOKAL. Der Extraktions-Prompt verlangt pro Chunk
 *  «Eindeutige IDs (fig_1, fig_2, …); Beziehungen nur zwischen IDs dieser Liste»
 *  (prompts/komplett/extraktion/system.js) — jeder Chunk beginnt also wieder bei
 *  fig_1, und `extractField` hält pro Chunk einen eigenen Eintrag, also einen eigenen
 *  ID-Namensraum. Wer die Figuren danach global neu durchnummeriert, ohne die
 *  Beziehungen mitzunehmen, bindet sie an eine FREMDE Figur: `dedupRelations` in
 *  db/figures/save.js filtert nur auf Existenz der id, und `fig_2` existiert ja.
 *  Der Name ist der einzige chunk-übergreifend stabile Schlüssel — dieselbe
 *  Begründung, aus der Songs/Orte ihre Figuren schon über Namen referenzieren
 *  (utils.js#_remapFigNames). Der Konsolidierungs-Prompt liest `bz.name` bereits als
 *  Fallback (prompts/komplett/figuren.js), das Feld ist also vorgesehen und macht
 *  zugleich den Prompt für chunk-fremde Ziele lesbar. */
function annotateBeziehungenNames(chapterFiguren) {
  let annotated = 0;
  for (const chunk of (chapterFiguren || [])) {
    const nameById = new Map();
    for (const f of (chunk?.figuren || [])) {
      if (f?.id != null) nameById.set(String(f.id), f.name || '');
    }
    for (const f of (chunk?.figuren || [])) {
      for (const bz of (f?.beziehungen || [])) {
        if (!bz || bz.name) continue;
        const name = nameById.get(String(bz.figur_id ?? ''));
        if (name) { bz.name = name; annotated++; }
      }
    }
  }
  return annotated;
}

/** Bindet Beziehungs-Ziele nach dem Vergeben der FINALEN ids über `bz.name` neu.
 *  Gegenstück zu `annotateBeziehungenNames`, aufzurufen an jeder Stelle, die Figuren-ids
 *  neu vergibt (heute: der Fallback in phases/figuren.js). Idempotent und ein No-op für
 *  Einträge ohne `name`. Die KI-Konsolidierung geht bewusst NICHT hier durch — sie bringt
 *  ihre eigene, in sich konsistente ID-Welt mit, und an ihr gibt es nichts zu binden.
 *  Nicht auflösbare Ziele werden ENTFERNT: eine Kante zur falschen Figur
 *  ist schlimmer als eine fehlende, und genau dieser Fall ist unten in der DB nicht
 *  mehr erkennbar. Selbst-Referenzen fallen ebenfalls weg (kann durch das Neubinden
 *  entstehen, wenn zwei Chunk-Figuren dieselbe Person waren). */
function rebindBeziehungenByName(figuren, log) {
  // Vollnamen zuerst, danach Kurznamen und im Merge aufgegangene Namen
  // (`__aliasNamen`) — die nur, solange sie keinen Vollnamen verdrängen.
  const idByName = new Map();
  for (const f of (figuren || [])) {
    const key = _normalizeName(f?.name);
    if (key && !idByName.has(key)) idByName.set(key, f.id);
  }
  for (const f of (figuren || [])) {
    for (const alt of [f?.kurzname, ...(f?.__aliasNamen || [])]) {
      const key = _normalizeName(alt);
      if (key && !idByName.has(key)) idByName.set(key, f.id);
    }
  }
  let rebound = 0, dropped = 0;
  // Verworfene Kanten «Von → Ziel» fürs Log (Selbst-Referenzen nicht: die sind gewollt weg).
  const lost = [];
  for (const f of (figuren || [])) {
    if (!Array.isArray(f?.beziehungen)) continue;
    f.beziehungen = f.beziehungen.filter(bz => {
      if (!bz) return false;
      // Ohne Zielnamen ist die figur_id chunk-lokal und nach der globalen Neunummerierung
      // bedeutungslos — sie träfe die Figur, die zufällig denselben Index hat. Verwerfen:
      // eine fehlende Kante ist besser als eine zur falschen Figur.
      if (!bz.name) { dropped++; lost.push(`${f.name} → (ohne Namen)`); return false; }
      const target = idByName.get(_normalizeName(bz.name));
      if (!target) { dropped++; lost.push(`${f.name} → ${bz.name}`); return false; }
      if (target === f.id) { dropped++; return false; }
      if (target !== bz.figur_id) { bz.figur_id = target; rebound++; }
      return true;
    });
  }
  if ((rebound || dropped) && log) {
    log.info(`Beziehungs-Ziele über Namen neu gebunden – ${rebound} korrigiert, ${dropped} unauflösbar entfernt.`);
    if (lost.length) {
      log.info(`Beziehungen ohne auflösbares Ziel: ${lost.slice(0, 12).join('; ')}${lost.length > 12 ? ` … (+${lost.length - 12})` : ''}`);
    }
  }
  return { rebound, dropped };
}

/** Bindet die Ziele einer KI-Konsolidierung (Einzel-Call) über `bz.name`, wo Name und
 *  `figur_id` auseinanderlaufen. Das Schema verlangt beide (schemas.js#_bzItem
 *  `withName`); die Ausgabe-ids der Figuren und die `figur_id` der Beziehungen zählt das
 *  Modell aber getrennt — legt es eine Figur zusammen, verrutschen die Kanten dahinter
 *  um eins («Der Vater baut ihm …» landet bei der nächsten Figur der Liste). Der Name
 *  ist der Wert, den das Modell bewusst geschrieben hat.
 *
 *  Konservativ: trägt die id eine Figur, zu der der Name passt (`nameFitsFigure`, auch
 *  Namensvettern mit Zusatz), bleibt sie. Sonst gilt die Figur, auf die der Name
 *  EINDEUTIG zeigt (Voll-, Kurz- oder Grundname ohne Zusatz); ein mehrdeutiger oder
 *  unbekannter Name lässt die id stehen. Mutiert in place. */
function preferBeziehungNames(figuren, log) {
  const byId = new Map((figuren || []).map(f => [f?.id, f]));
  const idsByKey = new Map();
  const add = (key, id) => {
    if (!key) return;
    if (!idsByKey.has(key)) idsByKey.set(key, new Set());
    idsByKey.get(key).add(id);
  };
  for (const f of (figuren || [])) {
    if (!f?.id) continue;
    for (const nm of new Set([f.name, f.kurzname, stripQualifier(f.name)])) add(_normalizeName(nm), f.id);
  }
  let rebound = 0;
  for (const f of (figuren || [])) {
    for (const bz of (f?.beziehungen || [])) {
      if (!bz?.name) continue;
      if (nameFitsFigure(bz.name, byId.get(bz.figur_id))) continue;
      const ids = idsByKey.get(_normalizeName(bz.name));
      if (!ids || ids.size !== 1) continue;
      const [target] = ids;
      if (target === f.id || target === bz.figur_id) continue;
      bz.figur_id = target;
      rebound++;
    }
  }
  if (rebound && log) log.info(`Konsolidierung: ${rebound} Beziehungs-Ziel(e) über den Namen statt die figur_id gebunden.`);
  return rebound;
}

/** Prüfung der Beziehungs-Beschreibungen gegen offensichtliche Fehlzuordnung.
 *  Modelle verrutschen gelegentlich eine Beschreibung zwischen den Beziehungen
 *  derselben Figur («Cara ist die Schwester» auf der Kante Anna→Bert).
 *
 *  Bewusst KONSERVATIV — die Prüfung sieht nur Wörter, nicht den Sinn:
 *    * Nennt die Beschreibung das Ziel (Voll-, Kurzname oder ein Namens-Token) oder
 *      gar keine andere Figur, bleibt sie. «Seine strenge Mutter …» ist korrekt, auch
 *      ohne Namen; der Extraktions-Prompt verlangt keinen.
 *    * Nennt sie statt des Ziels genau EINE andere Figur, und hat der Besitzer zu dieser
 *      Figur bereits eine Kante OHNE Beschreibung, wandert sie dorthin.
 *    * Sonst bleibt sie stehen und zählt als `suspicious` (Log). Es wird NIE eine Kante
 *      angelegt (der Typ der alten Kante gälte sonst für eine Beziehung, die das Modell
 *      nie behauptet hat) und NIE eine Beschreibung geleert («Sebastian vermittelte ihm
 *      die Stelle beim Kommissar» beschreibt die Kante zu Herrn Koch richtig).
 *  Namen werden als ganze Wörter gesucht; Namen unter drei Zeichen zählen nicht.
 *  Gibt { moved, suspicious } zurück. */
function _wordRe(name) {
  const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'iu');
}
function validateBeziehungenDescriptions(figuren) {
  const specificNames = (f) => [f.name, f.kurzname].filter(n => n && String(n).trim().length >= 3).map(n => _wordRe(String(n).trim()));
  const byId = new Map(figuren.map(f => [f.id, f]));
  const specific = new Map(figuren.map(f => [f.id, specificNames(f)]));
  const targetRes = new Map(figuren.map(f => [f.id, [
    ...specific.get(f.id),
    ..._nameTokens(f.name).filter(t => t.length >= 3).map(_wordRe),
  ]]));
  let moved = 0, suspicious = 0;
  for (const f of figuren) {
    for (const bz of (f.beziehungen || [])) {
      if (!bz?.beschreibung || !byId.has(bz.figur_id)) continue;
      const text = String(bz.beschreibung);
      if ((targetRes.get(bz.figur_id) || []).some(re => re.test(text))) continue;
      const others = figuren.filter(c => c.id !== f.id && c.id !== bz.figur_id
        && (specific.get(c.id) || []).some(re => re.test(text)));
      if (!others.length) continue;
      if (others.length === 1) {
        const existing = (f.beziehungen || []).find(x => x !== bz && x.figur_id === others[0].id);
        if (existing && !existing.beschreibung) {
          existing.beschreibung = bz.beschreibung;
          bz.beschreibung = null;
          moved++;
          continue;
        }
      }
      suspicious++;
    }
  }
  return { moved, suspicious };
}

/** Beschreibung als Vergleichsschlüssel für kopierte Kanten; unter 20 Zeichen zu
 *  unspezifisch («Freund»), dann ''. */
function relationDescKey(s) {
  const k = String(s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[\s.!?…]+$/, '').trim();
  return k.length >= 20 ? k : '';
}

/** Passt ein Name aus dem Eingabetext zu einer konsolidierten Figur, die die
 *  Konsolidierung mit Zusatz versehen hat? («Sebastian» ↔ «Sebastian (Mitlehrling)»,
 *  Kurzname «Sebastian»). */
function nameFitsFigure(name, f) {
  const k = _normalizeName(name);
  return !!k && (k === _normalizeName(f?.name) || k === _normalizeName(f?.kurzname) || k === _normalizeName(stripQualifier(f?.name)));
}

/** Kopierte Kanten: zwei Beziehungen derselben Figur mit gleichem Typ und wörtlich
 *  gleicher Beschreibung auf zwei verschiedene Ziele — eine ist die Kopie. Entsteht,
 *  wenn die Konsolidierung Namensvettern trennt («Herr Koch» → «Herr Koch
 *  (Primarlehrer)» / «(Frohheim)»), eine Kante aber noch den Rohnamen trägt.
 *  Bleiben darf das Ziel, dessen Namenszusatz die Beschreibung nennt («Der
 *  Primarlehrer fördert …»), sonst bei gleichem Grundnamen das einzige Ziel mit
 *  Zusatz. Lässt sich das nicht entscheiden, bleiben beide (die Beziehungsprüfung des
 *  Finetune-Exports meldet sie als `duplicateDescription`). Mutiert in place, liefert
 *  die Zahl entfernter Kanten. Erwartet finale ids. */
function dropCopiedRelations(figuren) {
  const byId = new Map((figuren || []).map(f => [f.id, f]));
  let dropped = 0;
  const winnerOf = (list) => {
    const targets = list.map(bz => byId.get(bz.figur_id));
    const desc = String(list[0].beschreibung);
    const named = list.filter((bz, i) => {
      const q = nameQualifier(targets[i].name);
      return q && _nameTokens(q).some(t => t.length >= 4 && _wordRe(t).test(desc));
    });
    if (named.length === 1) return named[0];
    const bases = new Set(targets.map(t => _normalizeName(stripQualifier(t.name))));
    const qualified = list.filter((bz, i) => nameQualifier(targets[i].name));
    return bases.size === 1 && qualified.length === 1 ? qualified[0] : null;
  };
  for (const f of (figuren || [])) {
    const groups = new Map();
    for (const bz of (f.beziehungen || [])) {
      const k = relationDescKey(bz?.beschreibung);
      if (!k || !byId.has(bz.figur_id)) continue;
      const g = `${bz.typ || ''}|${k}`;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(bz);
    }
    const drop = new Set();
    for (const list of groups.values()) {
      if (new Set(list.map(bz => bz.figur_id)).size < 2) continue;
      const winner = winnerOf(list);
      if (!winner) continue;
      for (const bz of list) if (bz.figur_id !== winner.figur_id) drop.add(bz);
    }
    if (drop.size) {
      f.beziehungen = f.beziehungen.filter(bz => !drop.has(bz));
      dropped += drop.size;
    }
  }
  return dropped;
}

/** Faltet flache Beziehungen aus dem Claude-A2-Pass ({von,zu,typ,machtverhaltnis,
 *  beschreibung,belege}) zurück in figuren[].beziehungen ({figur_id,...} aus Sicht der
 *  «von»-Figur), sodass der Downstream (Soziogramm-Preliminary, saveFigurenToDb) dieselbe
 *  Datenform wie beim kombinierten Extraktions-Call sieht. Filtert ungültige/Selbst-IDs,
 *  dedupliziert pro ungeordnetem Paar, respektiert bereits vorhandene Beziehungen.
 *  Mutiert die Eingabe nicht – gibt eine neue Figurenliste in Originalreihenfolge zurück. */
function mergeBeziehungenIntoFiguren(figuren, flatBz) {
  const byId = new Map(figuren.map(f => [f.id, { ...f, beziehungen: [...(f.beziehungen || [])] }]));
  const seenPair = new Set();
  for (const f of byId.values()) {
    for (const b of f.beziehungen) {
      const [a, c] = f.id < b.figur_id ? [f.id, b.figur_id] : [b.figur_id, f.id];
      seenPair.add(`${a}|${c}`);
    }
  }
  for (const bz of (flatBz || [])) {
    const von = bz?.von, zu = bz?.zu;
    if (!von || !zu || von === zu) continue;
    if (!byId.has(von) || !byId.has(zu)) continue;
    const [a, c] = von < zu ? [von, zu] : [zu, von];
    const key = `${a}|${c}`;
    if (seenPair.has(key)) continue;
    seenPair.add(key);
    byId.get(von).beziehungen.push({
      figur_id: zu,
      typ: bz.typ || 'andere',
      ...(Number.isFinite(bz.machtverhaltnis) ? { machtverhaltnis: bz.machtverhaltnis } : {}),
      ...(Number.isFinite(bz.naehe) ? { naehe: bz.naehe } : {}),
      ...(bz.beschreibung ? { beschreibung: bz.beschreibung } : {}),
      ...(Array.isArray(bz.belege) && bz.belege.length ? { belege: bz.belege } : {}),
    });
  }
  return figuren.map(f => byId.get(f.id));
}

module.exports = {
  annotateBeziehungenNames, rebindBeziehungenByName, preferBeziehungNames,
  validateBeziehungenDescriptions, mergeBeziehungenIntoFiguren,
  relationDescKey, nameFitsFigure, dropCopiedRelations,
};
