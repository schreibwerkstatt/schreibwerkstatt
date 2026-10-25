'use strict';
// Zeit-Messung der Plot-Werkstatt — PURE, ohne DB und ohne KI.
//
// Sie stellt die erzählte Zeit eines Beats (`plot_beats.zeit`) gegen Dinge, die
// die App bereits weiss: das Geburtsjahr der beteiligten Figuren, die
// Altersspanne im Aktnamen (lib/plot-act-age.js), den Stand der Strang-Figur im
// Manuskript, die Lesereihenfolge des Boards und die Orte, an denen eine Figur
// zur selben Zeit in anderen Beats steht.
//
// Das Alter einer Figur am Beat ist KEIN Befund, sondern eine Angabe an der
// Karte (public/js/book/plot/zeit.js#beatAlter): ein Kind im Beat ist so oft
// gewollt wie nicht, und wer nach Lebensphasen plant, will die Zahl sehen, nicht
// eine Warnung.
//
// Warum das hier gehört und nicht in die KI-Konsistenzprüfung: „Beat spielt
// 1987, Figur X ist laut Geburtsjahr dann acht" ist eine Subtraktion, kein
// Urteil. Ein Modell danach zu fragen kostet Geld und liefert eine Aussage, die
// niemand nachrechnen kann; hier ist sie reproduzierbar und gratis. Dieselbe
// Arbeitsteilung wie in lib/motif-consistency.js und lib/figure-arc.js, darum
// tragen die Befunde `quelle: 'messung'`.
//
// Verglichen werden ZEITFENSTER (lib/time-key.js), keine Jahreszahlen: „1987"
// und „März 1987" überlappen und widersprechen sich nicht. Kalenderzeit und
// Story-Tage („Tag 3") werden nie gegeneinander gemessen.
//
// Pflicht-Invariante (wie überall in dieser Familie):
// UNDATIERT IST UNGEPRÜFT, NICHT FALSCH. Ein Beat ohne `zeit` erzeugt keinen
// Befund — die Zeit-Angabe ist optional und ihr Fehlen kein Mangel. Dasselbe
// gilt für eine Angabe, die der Parser nicht versteht.

const SEVERITY_ORDER = ['kritisch', 'stark', 'mittel', 'schwach', 'niedrig'];

function _finding(code, schwere, beat, params = {}) {
  return {
    code,
    quelle: 'messung',
    schwere,
    beat_id: beat.id,
    beat: beat.titel,
    params,
  };
}

// Orts-Hierarchie: Raum → Gebäude → Stadt. Zwei Orte vertragen sich, wenn sie
// gleich sind oder einer im anderen liegt — „Zürich" und „Altstadt Zürich" sind
// kein Widerspruch.
function _ancestors(locId, parents) {
  const out = new Set([locId]);
  let cur = parents.get(locId);
  while (cur != null && !out.has(cur)) { out.add(cur); cur = parents.get(cur); }
  return out;
}
function _locsCompatible(a, b, parents) {
  for (const x of a) {
    const ax = _ancestors(x.id, parents);
    for (const y of b) {
      if (ax.has(y.id) || _ancestors(y.id, parents).has(x.id)) return true;
    }
  }
  return false;
}

// Hauptfunktion.
//
// beats: [{ id, titel, zeit, key, status, verworfen, fig_ids[], locations[], lane, ordnung,
//          strandFig, actAge }]
//        `key` ist das vom Aufrufer berechnete Zeitfenster (lib/time-key.js
//        #timeKeyOf aus `zeit`, null = undatiert), `lane` der Lane-Key und
//        `ordnung` der 0-basierte Rang INNERHALB der Lane — beides aus
//        lib/plot-reading-order.js#beatsInReadingOrder (Lane = Strang bzw. „ohne
//        Strang", Akte der Lane → sort_order). Fehlt `lane`, gelten alle Beats
//        als eine Lane. `fig_ids` enthält bereits die vom Strang geerbte
//        Hauptfigur, `locations` = [{ id: loc_id, name }], `strandFig` die fig_id
//        der Strang-Hauptfigur (oder null), `actAge` = { name, von, bis } des Akts
//        (oder null). Alles kommt vom Aufrufer, damit dieses Modul pur bleibt.
// figures: Map<fig_id(TEXT), { name, geburtsjahr|null, stand: { jahr, ereignis }|null }>
//          geburtsjahr aus Steckbrief bzw. Alters-Analyse (routes/plot-helpers.js#_figureTimeMap); stand = spätestes eigenes datiertes
//          Ereignis der Figur im Text.
// bookSpan: { minYear, maxYear } | null — die datierte Spanne des Buchs.
// locParents: Map<loc_id, parent_loc_id> — die Orts-Hierarchie.
function computeTimeFindings({ beats = [], figures = new Map(), bookSpan = null, locParents = new Map() } = {}) {
  // Nur nicht-verworfene, datierte Beats. Ein verworfener Beat soll nicht ins
  // Buch, seine Chronologie ist folglich keine Aussage über das Werk.
  const datiert = beats
    .filter(b => !b.verworfen && b.key)
    .sort((a, b) => (a.ordnung ?? 0) - (b.ordnung ?? 0));
  if (!datiert.length) return [];

  const findings = [];

  for (const b of datiert) {
    if (b.key.mode !== 'abs') continue;
    const { yearFrom, yearTo } = b.key;
    for (const figId of (b.fig_ids || [])) {
      const f = figures.get(figId);
      if (!f || !Number.isFinite(f.geburtsjahr)) continue;
      // 1. Der Beat spielt, bevor eine beteiligte Figur geboren ist — gemessen am
      //    ENDE des Fensters: erst wenn es ganz vor der Geburt liegt, ist es ein
      //    Rechenfehler im Plan und kein Geschmacksurteil.
      if (yearTo < f.geburtsjahr) {
        findings.push(_finding('beatVorGeburt', 'kritisch', b, {
          figur: f.name, zeit: b.zeit, geburtsjahr: f.geburtsjahr,
        }));
      }
    }

    // 1b. Alter der Strang-Figur passt nicht zur Altersspanne des Akts („Erste
    //     Krise (28-32)", die Figur wäre laut Zeitangabe 40). Gemessen wird das
    //     Altersfenster des Beats gegen die Spanne — erst wenn sie sich gar nicht
    //     überschneiden, ist es ein Widerspruch im Plan. Vor der Geburt meldet
    //     schon 1., darum dort nicht doppelt.
    //     Bekannt ist nur das Geburtsjahr: im Jahr Y ist die Figur Y−Geburtsjahr
    //     ODER ein Jahr jünger (Geburtstag noch nicht gewesen). Geprüft wird
    //     darum gegen das um dieses Jahr nach unten erweiterte Fenster — eine
    //     Figur „17" im Jahr Geburtsjahr+17 passt noch zu „(14-16)". Gemeldet
    //     wird die einfache Differenz, wie sie die Karte zeigt.
    const sf = b.strandFig ? figures.get(b.strandFig) : null;
    if (b.actAge && sf && Number.isFinite(sf.geburtsjahr) && yearTo >= sf.geburtsjahr) {
      const aVon = Math.max(0, yearFrom - sf.geburtsjahr), aBis = yearTo - sf.geburtsjahr;
      if (aBis < b.actAge.von || aVon - 1 > b.actAge.bis) {
        findings.push(_finding('alterAusserhalbAkt', 'mittel', b, {
          figur: sf.name, zeit: b.zeit, alter: aVon === aBis ? String(aVon) : `${aVon}–${aBis}`,
          akt: b.actAge.name, von: b.actAge.von, bis: b.actAge.bis,
        }));
      }
    }

    // 1c. Ein GEPLANTER Beat spielt, bevor der Text bei seiner Strang-Figur schon
    //     ist (ihr spätestes eigenes datiertes Ereignis). Schwach: wer vorwärts
    //     plant, meint das selten, aber eine Rückblende ist legitim — und der
    //     Stand hängt an abgeleiteten Zeitstrahl-Daten.
    if (b.status === 'geplant' && sf && sf.stand && Number.isFinite(sf.stand.jahr) && yearTo < sf.stand.jahr) {
      findings.push(_finding('vorStandImManuskript', 'schwach', b, {
        figur: sf.name, zeit: b.zeit, stand: sf.stand.jahr, ereignis: sf.stand.ereignis,
      }));
    }

    // 2. Ein Beat IM BUCH liegt ausserhalb der datierten Spanne des Buchs.
    //    Schwach, weil die Spanne selbst abgeleitet ist (aus dem Zeitstrahl). Ein
    //    geplanter Beat erweitert sie berechtigt — wer vorwärts plant, plant
    //    hinter das bisher Geschriebene; ihn zu melden wäre Rauschen.
    if (b.status === 'im_buch' && bookSpan && Number.isFinite(bookSpan.minYear) && Number.isFinite(bookSpan.maxYear)) {
      if (yearTo < bookSpan.minYear || yearFrom > bookSpan.maxYear) {
        findings.push(_finding('zeitAusserhalbBuch', 'schwach', b, {
          zeit: b.zeit, von: bookSpan.minYear, bis: bookSpan.maxYear,
        }));
      }
    }
  }

  // 3. Chronologie-Bruch: eine Lane wird von links nach rechts gelesen, die
  //    Zeit läuft aber rückwärts. Gemeldet wird gegen das bisher SPÄTESTE
  //    Fenster, nicht gegen den direkten Vorgänger — sonst erzeugt eine einzelne
  //    Rückblende eine Kette von Folgefehlern, obwohl nur ein Beat aus der Reihe
  //    fällt. Ein Bruch liegt erst vor, wenn das Fenster ganz VOR dem Beginn des
  //    spätesten Vorgängers endet; überlappende Fenster („1987" nach „März
  //    1987") sind keiner.
  //
  //    NUR innerhalb einer Lane und eines Modus: parallele Stränge erzählen
  //    gleichzeitig, und ein Strang, der 1950 spielt, ist kein Rückschritt
  //    gegenüber einem, der 1987 spielt. Über Lanes hinweg gibt es keine
  //    Lesereihenfolge; Kalenderzeit und Story-Tage haben keine gemeinsame Achse.
  //
  //    Eine Rückblende ist ein legitimes Mittel; darum `mittel` und nicht
  //    `kritisch`, und darum nennt der Befund beide Beats, statt eine Korrektur
  //    zu behaupten.
  const maxByLane = new Map(); // lane|mode → beat mit dem spätesten Fensterbeginn
  for (const b of datiert) {
    const slot = `${b.lane ?? ''}|${b.key.mode}`;
    const max = maxByLane.get(slot);
    if (max && b.key.to < max.key.from) {
      findings.push(_finding('chronologieBruch', 'mittel', b, {
        zeit: b.zeit, vorZeit: max.zeit, vorBeat: max.titel,
      }));
    }
    if (!max || b.key.from > max.key.from) maxByLane.set(slot, b);
  }

  // 4. Eine Figur an zwei Orten zugleich: zwei Beats, tagesgenau datiert, mit
  //    überlappender Zeit, derselben Figur und Orten, die sich nicht vertragen.
  //    Nur tagesgenau, weil „März 1987" in Zürich und „März 1987" in Berlin
  //    beides wahr sein kann. Unsichere Angaben fallen raus — ihr Fenster ist
  //    absichtlich breit. Über Lanes hinweg, denn genau dort entsteht der
  //    Fehler: zwei Stränge, die dieselbe Figur am selben Tag brauchen.
  const tagesgenau = datiert.filter(b => b.key.precision === 'day' && !b.key.unsicher
    && (b.fig_ids || []).length && (b.locations || []).length);
  const pairs = new Set();
  for (let i = 0; i < tagesgenau.length; i++) {
    for (let j = i + 1; j < tagesgenau.length; j++) {
      const a = tagesgenau[i], b = tagesgenau[j];
      if (a.key.mode !== b.key.mode || a.key.from !== b.key.from) continue;
      const figId = a.fig_ids.find(id => b.fig_ids.includes(id));
      if (!figId || _locsCompatible(a.locations, b.locations, locParents)) continue;
      // Ein Befund je Paar, am Beat mit der höheren ID — deterministisch, auch
      // wenn die Lanes umsortiert werden.
      const [early, late] = a.id < b.id ? [a, b] : [b, a];
      const k = `${early.id}:${late.id}`;
      if (pairs.has(k)) continue;
      pairs.add(k);
      const f = figures.get(figId);
      findings.push(_finding('figurAnZweiOrten', 'stark', late, {
        figur: f ? f.name : figId, zeit: late.zeit, anderBeat: early.titel,
        ort: late.locations[0].name, anderOrt: early.locations[0].name,
      }));
    }
  }

  findings.sort((a, b) => {
    const s = SEVERITY_ORDER.indexOf(a.schwere) - SEVERITY_ORDER.indexOf(b.schwere);
    return s !== 0 ? s : (a.beat_id - b.beat_id);
  });
  return findings;
}

module.exports = { computeTimeFindings, SEVERITY_ORDER };
