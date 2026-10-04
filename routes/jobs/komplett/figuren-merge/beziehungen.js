'use strict';
// Beziehungs-Helper der Komplettanalyse-Phase 2: Zielnamen anreichern und neu
// binden, Beschreibungen prüfen, flache A2-Beziehungen falten. Facade:
// ../figuren-merge.js.

const { normName: _normalizeName, nameTokens: _nameTokens } = require('../../../../lib/name-normalize');

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
  for (const f of (figuren || [])) {
    if (!Array.isArray(f?.beziehungen)) continue;
    f.beziehungen = f.beziehungen.filter(bz => {
      if (!bz || !bz.name) return true;
      const target = idByName.get(_normalizeName(bz.name));
      if (!target || target === f.id) { dropped++; return false; }
      if (target !== bz.figur_id) { bz.figur_id = target; rebound++; }
      return true;
    });
  }
  if ((rebound || dropped) && log) {
    log.info(`Beziehungs-Ziele über Namen neu gebunden – ${rebound} korrigiert, ${dropped} unauflösbar entfernt.`);
  }
  return { rebound, dropped };
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
      ...(bz.beschreibung ? { beschreibung: bz.beschreibung } : {}),
      ...(Array.isArray(bz.belege) && bz.belege.length ? { belege: bz.belege } : {}),
    });
  }
  return figuren.map(f => byId.get(f.id));
}

module.exports = {
  annotateBeziehungenNames, rebindBeziehungenByName,
  validateBeziehungenDescriptions, mergeBeziehungenIntoFiguren,
};
