// Schulweg-Vorschlag (Job `schulweg-vorschlag`, docs/figur-lebenslauf.md
// «Schullaufbahn»): das Modell liest Textstellen, in denen eine Figur zusammen
// mit Schulbegriffen vorkommt, und ordnet ihr einen der ERLAUBTEN Wege des
// Buch-Schulsystems zu — mit woertlichem Beleg.
//
// DAS MODELL RECHNET NICHT. Welche Klasse eine Figur in welchem Jahr besucht,
// rechnet public/js/book/school-path.js. Das Modell sagt nur, welchen Weg der Text
// belegt (Bez, Kanti, Lehre …), und ein Einschulungsjahr bzw. eine Repetition
// nur, wenn der Text sie ausdruecklich nennt. Der Job prueft jedes Zitat gegen die
// vorgelegten Stellen und verwirft Unbelegtes; der Autor uebernimmt einzeln.

import { _obj, _str } from './schema-utils.js';
import { _jsonOnly } from './state.js';

export function buildSchulwegSystemPrompt() {
  return `Du bist Lektorin und fuehrst die Figurenkartei eines Romans. Deine Aufgabe ist eng: du liest vorgelegte Textstellen und notierst, welchen SCHULWEG der Text fuer eine Figur belegt — welche Schulen sie besucht hat.

Du waehlst ausschliesslich aus den vorgegebenen Weg-Schluesseln. Du rechnest keine Jahre aus, du schaetzt nichts aus Weltwissen, und du uebertraegst keine Angabe von einer Figur auf eine andere. Zu jedem Vorschlag gehoert das woertliche Zitat der Stelle, die ihn belegt — ohne Zitat gilt der Vorschlag als nicht gemacht. Eine Figur ohne Beleg ist ein gueltiges Ergebnis.${_jsonOnly()}`;
}

/**
 * @param {object} p
 * @param {Array}  p.wege     [{ key, label, stufen: [label] }] — erlaubte Wege des Buchs
 * @param {Array}  p.stufen   [{ key, label }] — Stufen-Schluessel fuer `repetition.stufe`
 * @param {Array}  p.figuren  [{ name, geburtsjahr, stellen: [satz] }]
 * @param {string} [p.buchKontext]
 */
export function buildSchulwegPrompt({ wege = [], stufen = [], figuren = [], buchKontext = '' } = {}) {
  const ctxSeg = (buchKontext || '').trim() ? `\nBUCH-KONTEXT:\n${buchKontext}\n` : '';
  const wegListe = wege.map(w => `- "${w.key}": ${w.label} (${w.stufen.join(' → ')})`).join('\n');
  const stufenListe = stufen.map(s => `"${s.key}" = ${s.label}`).join(', ');
  const figurBloecke = figuren.map((f, i) => {
    const stellen = (f.stellen || []).map((s, k) => `  (${i + 1}.${k + 1}) ${s}`).join('\n');
    return `${i + 1}. ${f.name}${f.geburtsjahr ? ` (geboren ${f.geburtsjahr})` : ''}\n${stellen || '  (keine Stellen gefunden)'}`;
  }).join('\n\n');

  return `Die Autorin will wissen, welche Schulen ihre Figuren besucht haben. Unten stehen die erlaubten Schulwege des Buchs und zu jeder Figur die Textstellen, in denen sie zusammen mit Schulbegriffen vorkommt.
${ctxSeg}
ERLAUBTE WEGE (Schluessel: Bezeichnung, Stufenfolge):
${wegListe}

STUFEN (fuer "repetition_stufe"): ${stufenListe}

FIGUREN UND IHRE STELLEN:
${figurBloecke}

Regeln:
- "figur" ist der Name genau so, wie er oben in der Liste steht.
- "weg" ist einer der Schluessel oben. Waehle den Weg, den die Stellen belegen (z.B. "Bez" / "Bezirksschule" → ein Weg mit Bezirksschule; "Kanti" / "Gymnasium" / "Matura" → ein Weg mit Gymnasium; "Lehre" / "Stift" → ein Weg mit Lehre; "Oberstufe" ohne Schultyp → ein Weg mit Oberstufe). Belegen die Stellen keinen Weg, gib fuer diese Figur nichts aus.
- "einschulung_jahr" nur, wenn die Stelle das Jahr der Einschulung ausdruecklich als Jahreszahl nennt. Sonst null — nicht ausrechnen.
- "repetition_stufe" und "repetition_klasse" nur, wenn die Stelle ausdruecklich sagt, dass die Figur eine Klasse wiederholt hat (repetiert, sitzengeblieben, Ehrenrunde): Stufen-Schluessel und Nummer der wiederholten Klasse. Sonst null.
- "stelle" ist die Nummer der Stelle, aus der das Zitat stammt (z.B. "1.2").
- "zitat" ist ein WOERTLICHES Stueck dieser Stelle (hoechstens 200 Zeichen), in dem der Schulbegriff steht. Nicht umformulieren, nicht zusammensetzen.
- "begruendung": ein Satz, warum das Zitat diesen Weg belegt.
- Hoechstens ein Vorschlag pro Figur.
- Findest du nichts, gib ein leeres Array zurueck.

Antworte mit diesem JSON-Schema:
{
  "vorschlaege": [
    { "figur": "Name wie oben", "weg": "Schluessel", "einschulung_jahr": null, "repetition_stufe": null, "repetition_klasse": null, "stelle": "1.1", "zitat": "woertliches Stueck der Stelle", "begruendung": "ein Satz" }
  ]
}`;
}

/** Schema pro Call: `weg` als Enum der Weg-Keys DIESES Buchs — bei lokalen
 *  Providern erzwingt Constrained Decoding sonst Wege, die es nicht gibt. */
export function buildSchulwegSchema(wegKeys = [], stufenKeys = []) {
  return _obj({
    vorschlaege: {
      type: 'array',
      items: _obj({
        figur: _str,
        weg: wegKeys.length ? { type: 'string', enum: [...wegKeys] } : _str,
        einschulung_jahr: { type: ['integer', 'null'] },
        repetition_stufe: stufenKeys.length ? { type: ['string', 'null'], enum: [...stufenKeys, null] } : { type: ['string', 'null'] },
        repetition_klasse: { type: ['integer', 'null'] },
        stelle: _str,
        zitat: _str,
        begruendung: _str,
      }),
    },
  });
}
