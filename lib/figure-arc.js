'use strict';
// Bogen-Messung der Figuren-Werkstatt — PURE, ohne DB und ohne KI.
//
// Sie misst den geplanten Figurenbogen (Mindmap-Kerne) gegen den Ist-Index
// (`draft_figure_occurrences`) ueber die Kapitel-Achse. Das ist der Schritt,
// den Plot- und Motiv-Werkstatt laengst gegangen sind: ein Plan ist erst dann
// etwas wert, wenn ihm eine Messung gegen den geschriebenen Text gegenuebersteht.
//
// Was hier NICHT hingehoert: alles, was ein Urteil braucht („traegt die Wunde
// die Szene?"). Das bleibt Sache der Werkstatt-Consistency (callAI). Hier stehen
// nur Aussagen, die aus Zahlen folgen — darum tragen die Befunde `quelle:
// 'messung'` wie in lib/motif-consistency.js, und darum sind sie gratis.
//
// Pflicht-Invariante (gleiche wie Motiv-Messung + Plot-Anchor):
// UNGESCANNT IST UNGEPRUEFT, NICHT ABWESEND. Ohne befuellten Ist-Index gibt es
// keine Befunde, sondern `scanned: false` — sonst meldete ein nie gelaufener
// Anchor jeden Kern als „steht nicht im Buch".

const { PSYCHE_KERNE } = require('./draft-mindmap-extract');

const SEVERITY_ORDER = ['kritisch', 'stark', 'mittel', 'schwach', 'niedrig'];

// Ein Bogen braucht Laenge, um einer zu sein: unter so vielen Kapiteln ist
// „vorne vs. hinten" keine Aussage, sondern Rauschen.
const ARC_MIN_CHAPTERS = 6;
// Ab so vielen Fundstellen eines Kerns lohnt der Verteilungsvergleich. Darunter
// entscheidet ein einzelner Treffer ueber das Urteil.
const ARC_MIN_HITS = 4;
// Kopf-/Schlussdrittel des Buchbogens (das Schlussdrittel ist gleich breit,
// siehe _split).
const HEAD_SHARE = 1 / 3;

// Die Kerne, deren Aufloesung den Wandel AUSMACHT: eine Luege soll brechen, eine
// Wunde soll beruehrt und ueberwunden werden. Want/Need sind bewusst NICHT dabei
// — ein durchgehaltenes Wollen ist kein Fehler, sondern oft der Antrieb.
const WANDEL_KERNE = ['lie', 'wound'];

function _finding(code, schwere, draft, kern, params = {}) {
  return {
    code,
    quelle: 'messung',
    schwere,
    draft_id: draft.id,
    figur: draft.name,
    kern: kern || null,
    params,
  };
}

// Fundstellen eines Kerns auf Kopf-/Schlussdrittel verteilen. `stellen` sind
// { pos, n }: 0-basierter Kapitel-Index in Lesereihenfolge plus die Zahl der
// Fundstellen DARIN.
//
// Gezaehlt werden Fundstellen, nicht Kapitel — sonst waere die Schwelle davor
// (ARC_MIN_HITS, in Fundstellen) gegen eine andere Groesse geprueft als die
// Verteilung danach, und ein Kapitel mit zwanzig Belegen zaehlte wie eines mit
// einem.
//
// Beide Drittel gleich breit: das Schlussdrittel beginnt `head` Kapitel vor dem
// Ende. Mit floor(n * 2/3) waere es bei n = 7, 8, 10 … ein Kapitel breiter als
// das Kopfdrittel — und `hinten >= vorn` schluege bei gleichmaessig verteilter
// Luege/Wunde systematisch an.
function _split(stellen, chapterCount) {
  const head = Math.floor(chapterCount * HEAD_SHARE);
  const tail = chapterCount - head;
  let vorn = 0, hinten = 0;
  for (const { pos, n } of stellen) {
    if (pos < head) vorn += n;
    else if (pos >= tail) hinten += n;
  }
  return { vorn, hinten };
}

// Hauptfunktion.
//
// drafts: [{ id, name, geplant: { kern: true|false }, occ: { kern: [{chapterId, n}] },
//            counts: { kern: n } }]
// chapterOrder: Kapitel-IDs in Lesereihenfolge (depth-first, wie im Verlaufsband).
// scanned: ist der Ist-Index des Buchs ueberhaupt befuellt?
//
// Liefert die Befunde sortiert (Schwere, dann Figurenname, dann Kern-Reihenfolge).
function computeArcFindings({ drafts = [], chapterOrder = [], scanned = true } = {}) {
  if (!scanned) return [];

  const chapterPos = new Map(chapterOrder.map((id, i) => [id, i]));
  const chapterCount = chapterOrder.length;
  const findings = [];

  for (const d of drafts) {
    const geplant = d.geplant || {};
    const counts = d.counts || {};
    const occ = d.occ || {};
    // Hat die Figur ueberhaupt Spuren im Text? Wenn nicht, ist sie schlicht noch
    // nicht geschrieben — dann ist jeder Einzelbefund ueber ihre Kerne eine
    // Selbstverstaendlichkeit und keine Meldung wert.
    const gesamt = PSYCHE_KERNE.reduce((s, k) => s + (counts[k] || 0), 0);

    for (const kern of PSYCHE_KERNE) {
      if (!geplant[kern]) continue;
      const n = counts[kern] || 0;

      // 1. Geplanter Kern ohne jede Spur — aber nur, wenn die Figur sonst im
      //    Buch steht. Sonst ist es „noch nicht geschrieben", kein Befund.
      //    `bogen` ist hier ausgenommen: fuer ihn gibt es unten den eigenen,
      //    staerkeren Befund (4). Zwei Meldungen ueber denselben Sachverhalt
      //    waeren doppelte Buchfuehrung.
      if (n === 0) {
        if (gesamt > 0 && kern !== 'bogen') {
          findings.push(_finding('kernOhneText', 'mittel', d, kern, { kerne: PSYCHE_KERNE.length }));
        }
        continue;
      }

      const stellen = (occ[kern] || [])
        .map(r => ({ pos: chapterPos.get(r.chapterId), n: r.n || 0 }))
        .filter(x => x.pos != null);
      if (!stellen.length) continue;

      // 2. Kern nur punktuell belegt: er kommt genau in EINEM Kapitel vor,
      //    obwohl das Buch einen Bogen hat. Ein Subtext, der einmal auftaucht,
      //    ist eine Erwaehnung, kein Motiv der Figur.
      if (stellen.length === 1 && chapterCount >= ARC_MIN_CHAPTERS) {
        findings.push(_finding('kernNurPunktuell', 'schwach', d, kern, {
          kapitel: stellen[0].pos + 1, kapitelGesamt: chapterCount, fundstellen: n,
        }));
        continue;
      }

      // 3. Der Wandel bleibt aus: Luege/Wunde sind im Schlussdrittel mindestens
      //    so dicht wie im Kopfdrittel. Das ist der haeufigste stille Fehler in
      //    einem Manuskript — der Plan sagt „sie ueberwindet es", der Text sagt
      //    nichts davon.
      if (WANDEL_KERNE.includes(kern) && n >= ARC_MIN_HITS && chapterCount >= ARC_MIN_CHAPTERS) {
        const { vorn, hinten } = _split(stellen, chapterCount);
        if (vorn > 0 && hinten >= vorn) {
          findings.push(_finding('wandelOhneEinloesung', 'stark', d, kern, {
            vorn, hinten, kapitelGesamt: chapterCount,
          }));
        }
      }
    }

    // 4. Die Figur steht im Buch, ihr WANDEL aber nirgends: `bogen` ist geplant
    //    und hat keine Fundstelle, waehrend andere Kerne welche haben. Eigener
    //    Befund neben (1), weil er ueber die Figur als Ganzes spricht.
    if (geplant.bogen && !(counts.bogen || 0) && gesamt > 0) {
      findings.push(_finding('bogenOhneBeleg', 'stark', d, 'bogen', { fundstellenGesamt: gesamt }));
    }
  }

  const kernPos = new Map(PSYCHE_KERNE.map((k, i) => [k, i]));
  findings.sort((a, b) => {
    const s = SEVERITY_ORDER.indexOf(a.schwere) - SEVERITY_ORDER.indexOf(b.schwere);
    if (s !== 0) return s;
    const f = String(a.figur).localeCompare(String(b.figur));
    if (f !== 0) return f;
    return (kernPos.get(a.kern) ?? 99) - (kernPos.get(b.kern) ?? 99);
  });
  return findings;
}

module.exports = {
  computeArcFindings, SEVERITY_ORDER,
  ARC_MIN_CHAPTERS, ARC_MIN_HITS, HEAD_SHARE, WANDEL_KERNE,
};
