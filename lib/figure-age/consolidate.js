'use strict';
// Verdichtung: aus geprueften Einzelfunden wird EINE Zeile pro Figur.
//
// WARUM DETERMINISTISCH UND NICHT IM MODELL: „wie alt ist die Figur im Buch" ist
// keine Formulierungs-, sondern eine Rechenfrage — Spanne bilden, Bezugsjahr
// abziehen, Widerspruch erkennen. Das Modell liefert die Behauptungen samt Zitat;
// was daraus folgt, rechnet dieses Modul, damit es reproduzierbar ist und ein
// Widerspruch nicht davon abhaengt, ob das Modell ihn bemerkt hat.
//
// Reine Funktionen, keine DB, kein Netz.

// Ab dieser Abweichung (in Jahren) gilt eine Angabe als widerspruechlich. Eins
// ist Toleranz und keine Willkuer: zwischen Geburtstag und Bezugszeitpunkt liegt
// je nach Monat ein Jahr Unterschied, ohne dass jemand sich geirrt hat.
const TOLERANZ_JAHRE = 1;

const KONF = {
  explizit: 0.9,   // woertliche Altersangabe im Text, Zitat nachgeschlagen
  geburtsjahr: 0.75, // aus Geburtsjahr + Bezugsjahr gerechnet
  zeitstrahl: 0.5, // nur aus dem konsolidierten Zeitstrahl abgeleitet
  vage: 0.3,       // Fund, den das Modell selbst als unsicher meldet
};
const KONF_WIDERSPRUCH_MALUS = 0.2;
// Befunde, die die Sicherheit NICHT senken: ein juengeres Alter spaeter im Buch ist
// oft eine Rueckblende — ein Hinweis zum Pruefen, kein Zweifel an der Angabe.
const OHNE_MALUS = new Set(['reihenfolge']);

function _num(v) {
  const n = typeof v === 'number' ? v : parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

/** Jahreszahl aus einem freien Datums-String ("Frühling 1850") — dieselbe Lesart
 *  wie routes/figures.js#_yearFromString, damit das kuratierte `geburtstag`-Feld
 *  hier und dort dasselbe bedeutet. */
function yearFromString(s) {
  if (!s) return null;
  const m = String(s).match(/\b(\d{4})\b/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * @param {object} input
 *   funde       [{ art:'alter'|'geburtsjahr'|'todesjahr', wert, bezugsjahr,
 *                  zitat, page_id, chapter, ordinal, offset, unsicher, begruendung }]
 *               — bereits zitat-geprueft (das Zitat steht wirklich im Text).
 *   kuratiert   { geburtstag }  aus `figures` (Autor-gepflegt, hat Vorrang).
 *   zeitstrahl  { jahr_im_roman, geburtsjahr } | null
 *               — die KANONISCHE Ableitung aus lib/figure-years.js: das Jahr, in
 *               dem DIESE Figur steckt (ihr jüngstes datiertes Ereignis), und das
 *               Geburtsjahr des Zeitstrahls. Bewusst nicht die Jahresspanne des ganzen
 *               Buchs: eine Figur, die 1987 aus der Geschichte verschwindet, ist
 *               nicht so alt, wie sie am Buchende WÄRE.
 */
function consolidateFigure({ funde = [], kuratiert = null, zeitstrahl = null } = {}) {
  const sorted = [...funde].sort((a, b) => (a.ordinal - b.ordinal) || (a.offset - b.offset));
  const alterFunde = sorted.filter(f => f.art === 'alter' && _num(f.wert) != null);
  const gebFunde   = sorted.filter(f => f.art === 'geburtsjahr' && _num(f.wert) != null);
  const todFunde   = sorted.filter(f => f.art === 'todesjahr' && _num(f.wert) != null);

  // ── Geburtsjahr: kuratiert schlaegt Text schlaegt Zeitstrahl ──────────────
  const gebKuratiert = yearFromString(kuratiert?.geburtstag);
  // Ein als sicher gemeldeter Fund geht einem unsicheren vor; sonst der erste.
  const gebFund = gebFunde.find(f => !f.unsicher) || gebFunde[0] || null;
  const gebText = gebFund ? _num(gebFund.wert) : null;
  const gebZeitstrahl = _num(zeitstrahl?.geburtsjahr);
  let geburtsjahr = gebKuratiert ?? gebText ?? gebZeitstrahl ?? null;
  const geburtsjahrQuelle = gebKuratiert != null ? 'kuratiert'
    : gebText != null ? 'text'
      : gebZeitstrahl != null ? 'zeitstrahl' : null;

  const widerspruch = [];
  if (gebKuratiert != null && gebText != null && Math.abs(gebKuratiert - gebText) > TOLERANZ_JAHRE) {
    widerspruch.push({ typ: 'geburtsjahr', a: gebKuratiert, b: gebText, zitat: gebFund.zitat || null, page_id: gebFund.page_id ?? null });
  }
  // Der Text selbst nennt zwei verschiedene Geburtsjahre: genauso ein Befund wie die
  // Abweichung vom Steckbrief — gezaehlt wird nur eines, also muss das andere
  // sichtbar werden.
  const gebAbweichend = gebText == null ? null
    : gebFunde.find(f => Math.abs(_num(f.wert) - gebText) > TOLERANZ_JAHRE);
  if (gebAbweichend) {
    widerspruch.push({ typ: 'geburtsjahrText', a: gebText, b: _num(gebAbweichend.wert), zitat: gebAbweichend.zitat || null, page_id: gebAbweichend.page_id ?? null });
  }
  // Ohne Steckbrief-Eintrag kennt der Zeitstrahl ein eigenes Geburtsjahr (Geburts-
  // Ereignis). Der Text gewinnt — weicht er ab, ist das derselbe Befund wie gegen
  // den Steckbrief. (Mit Steckbrief-Eintrag IST das Zeitstrahl-Geburtsjahr der
  // Steckbrief, lib/figure-years.js; die Pruefung oben deckt das ab.)
  if (gebKuratiert == null && gebText != null && gebZeitstrahl != null
      && Math.abs(gebZeitstrahl - gebText) > TOLERANZ_JAHRE) {
    widerspruch.push({ typ: 'geburtsjahrZeitstrahl', a: gebZeitstrahl, b: gebText, zitat: gebFund.zitat || null, page_id: gebFund.page_id ?? null });
  }

  // ── Alter aus dem Text: Spanne ueber die Leserichtung ────────────────────
  let alterVon = null, alterBis = null, bezugVon = null, bezugBis = null;
  for (const f of alterFunde) {
    const w = _num(f.wert);
    if (alterVon == null || w < alterVon) alterVon = w;
    if (alterBis == null || w > alterBis) alterBis = w;
    const bj = _num(f.bezugsjahr);
    if (bj != null) {
      if (bezugVon == null || bj < bezugVon) bezugVon = bj;
      if (bezugBis == null || bj > bezugBis) bezugBis = bj;
    }
  }

  // Alter sinkt im Buchverlauf: entweder Rueckblende (legitim) oder Fehler —
  // beides ist etwas, das der Autor sehen will. Gemeldet wird der Befund, nicht
  // ein Urteil darueber.
  for (let i = 1; i < alterFunde.length; i++) {
    const prev = alterFunde[i - 1], cur = alterFunde[i];
    if (_num(cur.wert) < _num(prev.wert) - TOLERANZ_JAHRE) {
      widerspruch.push({
        typ: 'reihenfolge', a: _num(prev.wert), b: _num(cur.wert),
        zitat: cur.zitat || null, page_id: cur.page_id ?? null,
      });
      break; // ein Hinweis genuegt; die Belegliste zeigt den Rest
    }
  }

  // ── Aus Geburtsjahr gerechnet: EIN Wert, am Anker der Figur ──────────────
  // Ankerjahr der Figur aus lib/figure-years.js (`jahr_im_roman`, ihr juengstes
  // datiertes Ereignis) MINUS das Geburtsjahr DIESER Zeile. Nicht das fertige
  // `alter_im_roman` uebernehmen: das rechnet mit dem Geburtsjahr des Zeitstrahls,
  // und steht in der Zeile ein anderes aus dem Text, passten Geburtsjahr und
  // gerechnetes Alter nicht zusammen. Bei gleichem Geburtsjahr ist es dieselbe
  // Zahl wie im Figuren-Katalog.
  // Ein Todesjahr im Text deckelt das Ankerjahr: eine Figur, an die 1990 noch
  // erinnert wird, die aber 1950 starb, wird nicht aelter als bei ihrem Tod.
  const todesjahr = todFunde.length ? _num(todFunde[0].wert) : null;
  let bezugsjahr = _num(zeitstrahl?.jahr_im_roman);
  if (bezugsjahr != null && todesjahr != null && todesjahr >= (geburtsjahr ?? -Infinity) && bezugsjahr > todesjahr) {
    bezugsjahr = todesjahr;
  }
  const gerechnet = (geburtsjahr != null && bezugsjahr != null && bezugsjahr >= geburtsjahr)
    ? bezugsjahr - geburtsjahr : null;

  // Textangabe gegen Rechnung. `gerechnet` gilt am Ankerjahr, dem SPAETESTEN Punkt
  // der Figur — eine Angabe aus Kapitel 1 („zwoelf, 1912") ist damit nicht
  // vergleichbar, sonst waere jede Figur in einem Buch ueber dreissig Jahre ein
  // Widerspruch. Darum zwei Pruefungen:
  //   1. Nennt der Beleg sein Bezugsjahr, wird genau dort gerechnet.
  //   2. Ohne Bezugsjahr bleibt nur die Richtung: am Ankerjahr ist die Figur
  //      mindestens so alt wie an jeder frueheren Stelle.
  let rechnungBeleg = null;
  if (geburtsjahr != null) {
    for (const f of alterFunde) {
      const bj = _num(f.bezugsjahr);
      if (bj == null || bj < geburtsjahr) continue;
      if (Math.abs(_num(f.wert) - (bj - geburtsjahr)) > TOLERANZ_JAHRE) { rechnungBeleg = f; break; }
    }
  }
  if (rechnungBeleg) {
    widerspruch.push({
      typ: 'rechnung', a: _num(rechnungBeleg.wert), b: _num(rechnungBeleg.bezugsjahr) - geburtsjahr,
      zitat: rechnungBeleg.zitat || null, page_id: rechnungBeleg.page_id ?? null,
    });
  } else if (alterVon != null && gerechnet != null && gerechnet < alterBis - TOLERANZ_JAHRE) {
    widerspruch.push({ typ: 'rechnung', a: alterBis, b: gerechnet });
  }

  // ── Ergebnis waehlen ─────────────────────────────────────────────────────
  // Der Text hat Vorrang: eine woertliche Angabe ist die Aussage des Werks, die
  // Rechnung nur ihre Rekonstruktion.
  let quelle = null, von = null, bis = null, konfidenz = 0;
  if (alterVon != null) {
    quelle = 'text';
    von = alterVon; bis = alterBis;
    const alleUnsicher = alterFunde.every(f => f.unsicher);
    konfidenz = alleUnsicher ? KONF.vage : KONF.explizit;
  } else if (gerechnet != null) {
    // Kein Textfund: die Rechnung ist die Antwort. `quelle` sagt, worauf sie
    // steht — auf einem vom Autor gepflegten Geburtsjahr oder nur auf dem
    // abgeleiteten Zeitstrahl.
    quelle = geburtsjahrQuelle === 'zeitstrahl' ? 'zeitstrahl' : 'geburtsjahr';
    von = bis = gerechnet;
    konfidenz = quelle === 'zeitstrahl' ? KONF.zeitstrahl : KONF.geburtsjahr;
  }
  if (konfidenz > 0 && widerspruch.some(w => !OHNE_MALUS.has(w.typ))) {
    konfidenz = Math.max(0.1, Math.round((konfidenz - KONF_WIDERSPRUCH_MALUS) * 100) / 100);
  }

  return {
    alter_von: von,
    alter_bis: bis == null ? von : bis,
    // Bezugsjahr: beim Textalter nur, was die Stellen nennen — das Ankerjahr neben
    // einer Spanne aus dem ganzen Buch laese sich, als gelte sie in diesem einen
    // Jahr. Beim gerechneten Alter ist das (ggf. gedeckelte) Ankerjahr genau der
    // Bezugspunkt. Ohne Alter KEIN Bezugsjahr — eine Jahreszahl neben „unbekannt"
    // sieht aus wie eine Teilantwort, ist aber nur das Buchende.
    bezugsjahr_von: von == null ? null : (quelle === 'text' ? bezugVon : bezugsjahr),
    bezugsjahr_bis: von == null ? null : (quelle === 'text' ? bezugBis : bezugsjahr),
    geburtsjahr,
    geburtsjahr_quelle: geburtsjahrQuelle,
    gerechnet,
    quelle,
    konfidenz,
    widerspruch: widerspruch.length ? widerspruch : null,
    belege: sorted,
  };
}

/** Plausibilitaet eines Modellwerts — dieselben Grenzen wie die Muster in
 *  patterns.js#extractAgeSignals: ein Alter liegt in 0–130, ein Geburts- oder
 *  Todesjahr in 1000–2999. Faengt Verwechslungen ab, die die Zahl-Pruefung nicht
 *  sieht (die Zahl steht ja im Zitat): ein «Geburtsjahr 12» wuerde sonst ein
 *  gerechnetes Alter von rund 1900 Jahren erzeugen. */
function isPlausibleWert(art, wert) {
  if (!Number.isFinite(wert)) return false;
  if (art === 'alter') return wert >= 0 && wert <= 130;
  if (art === 'geburtsjahr' || art === 'todesjahr') return wert >= 1000 && wert <= 2999;
  return false;
}

module.exports = { consolidateFigure, yearFromString, isPlausibleWert, TOLERANZ_JAHRE, KONF };
