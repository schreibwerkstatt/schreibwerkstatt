// Berufsweg- und Hobby-Vorschlag (Job `stationen-vorschlag`, docs/figur-lebenslauf.md
// «Berufsweg und Hobbys»): das Modell liest Textstellen, in denen eine Figur
// zusammen mit Arbeits- bzw. Freizeitbegriffen vorkommt, und notiert Ausbildungen,
// Berufsstationen und Hobbys — jede mit woertlichem Beleg.
//
// DAS MODELL RECHNET NICHT. Jahre und Monate nur, wenn sie im Zitat stehen; der
// Job prueft das und streicht, was dort nicht steht. Der Autor uebernimmt einzeln.

import { _obj, _str } from './schema-utils.js';
import { _jsonOnly } from './state.js';

export function buildStationenSystemPrompt() {
  return `Du bist Lektorin und fuehrst die Figurenkartei eines Romans. Deine Aufgabe ist eng: du liest vorgelegte Textstellen und notierst, welche AUSBILDUNGEN und BERUFSSTATIONEN und welche HOBBYS der Text fuer eine Figur belegt.

Du notierst nur, was in einer vorgelegten Stelle steht. Du rechnest keine Jahre aus, du schaetzt nichts aus Weltwissen, und du uebertraegst keine Angabe von einer Figur auf eine andere. Zu jedem Eintrag gehoert das woertliche Zitat der Stelle, die ihn belegt — ohne Zitat gilt der Eintrag als nicht gemacht. Eine Figur ohne Beleg ist ein gueltiges Ergebnis.${_jsonOnly()}`;
}

/**
 * @param {object} p
 * @param {Array}  p.figuren  [{ name, geburtsjahr?, bekannt: { berufe: [text], hobbys: [text] }, stellen: [satz] }]
 * @param {string} [p.buchKontext]
 */
export function buildStationenPrompt({ figuren = [], buchKontext = '' } = {}) {
  const ctxSeg = (buchKontext || '').trim() ? `\nBUCH-KONTEXT:\n${buchKontext}\n` : '';
  const figurBloecke = figuren.map((f, i) => {
    const stellen = (f.stellen || []).map((s, k) => `  (${i + 1}.${k + 1}) ${s}`).join('\n');
    const bek = [];
    if (f.bekannt?.berufe?.length) bek.push(`  schon erfasst (Beruf): ${f.bekannt.berufe.join('; ')}`);
    if (f.bekannt?.hobbys?.length) bek.push(`  schon erfasst (Hobby): ${f.bekannt.hobbys.join('; ')}`);
    return `${i + 1}. ${f.name}${f.geburtsjahr ? ` (geboren ${f.geburtsjahr})` : ''}\n${bek.length ? bek.join('\n') + '\n' : ''}${stellen || '  (keine Stellen gefunden)'}`;
  }).join('\n\n');

  return `Die Autorin will den Berufsweg und die Hobbys ihrer Figuren kennen. Unten stehen zu jeder Figur die Textstellen, in denen sie zusammen mit Arbeits- oder Freizeitbegriffen vorkommt.
${ctxSeg}
FIGUREN UND IHRE STELLEN:
${figurBloecke}

Regeln fuer beide Listen:
- "figur" ist der Name genau so, wie er oben in der Liste steht.
- Nur, was die Stelle fuer DIESE Figur sagt. Ein Beruf, den jemand einer anderen Figur zuschreibt, gehoert jener.
- Was unter "schon erfasst" steht, nicht noch einmal ausgeben — ausser die Stelle nennt einen anderen Zeitraum oder Arbeitgeber.
- "von_jahr" / "bis_jahr" nur, wenn die Stelle die Jahreszahl ausdruecklich nennt ("seit 1998", "von 1990 bis 1995", "1987 trat sie die Stelle an"). Sonst null — nicht aus Alter, Schulzeit oder Handlung ausrechnen.
- "von_monat" / "bis_monat" (1-12) nur, wenn die Stelle den Monat nennt. Sonst null.
- "stelle" ist die Nummer der Stelle, aus der das Zitat stammt (z.B. "1.2").
- "zitat" ist ein WOERTLICHES Stueck dieser Stelle (hoechstens 200 Zeichen), in dem die Taetigkeit bzw. das Hobby steht. Nicht umformulieren, nicht zusammensetzen.
- "begruendung": ein Satz, warum das Zitat diesen Eintrag belegt.

BERUFE ("berufe"):
- Ausbildung (Lehre, Studium, Weiterbildung) mit "art": "ausbildung"; Erwerbstaetigkeit (Anstellung, Selbstaendigkeit, eigenes Geschaeft) mit "art": "beruf".
- "taetigkeit": die Taetigkeit in einem Wort oder kurzen Ausdruck, so wie im Zitat ("Schreinerin", "Lehre als Koch", "Studium der Medizin", "Verkaeufer"). Ein Wort davon muss im Zitat stehen.
- "arbeitgeber" und "ort" nur, wenn die Stelle sie nennt, sonst leer.
- Nicht: Schule bis zur Matur (das ist der Schulweg), einmalige Handgriffe, Hausarbeit ohne Berufsbezug.

HOBBYS ("hobbys"):
- Wiederkehrende Freizeitbeschaeftigungen (Sport, Musik, Verein, Sammeln, Handwerk, Spiele).
- "hobby": in einem Wort oder kurzen Ausdruck, so wie im Zitat ("Fussball", "Klavier", "Pfadi", "Briefmarken sammeln"). Ein Wort davon muss im Zitat stehen.
- "ort" nur, wenn die Stelle ihn nennt (Verein, Ort), sonst leer.
- Nicht: eine einmalige Handlung ("spielte an jenem Abend Karten"), es sei denn, die Stelle sagt, dass sie es regelmaessig tut.

Findest du nichts, gib leere Arrays zurueck.

Antworte mit diesem JSON-Schema:
{
  "berufe": [
    { "figur": "Name wie oben", "art": "beruf", "taetigkeit": "kurz", "arbeitgeber": "", "ort": "", "von_jahr": null, "von_monat": null, "bis_jahr": null, "bis_monat": null, "stelle": "1.1", "zitat": "woertliches Stueck der Stelle", "begruendung": "ein Satz" }
  ],
  "hobbys": [
    { "figur": "Name wie oben", "hobby": "kurz", "ort": "", "von_jahr": null, "von_monat": null, "bis_jahr": null, "bis_monat": null, "stelle": "1.2", "zitat": "woertliches Stueck der Stelle", "begruendung": "ein Satz" }
  ]
}`;
}

const _intOrNull = { type: ['integer', 'null'] };
const _zeit = { von_jahr: _intOrNull, von_monat: _intOrNull, bis_jahr: _intOrNull, bis_monat: _intOrNull };

export function buildStationenSchema() {
  return _obj({
    berufe: {
      type: 'array',
      items: _obj({
        figur: _str,
        art: { type: 'string', enum: ['ausbildung', 'beruf'] },
        taetigkeit: _str,
        arbeitgeber: _str,
        ort: _str,
        ..._zeit,
        stelle: _str,
        zitat: _str,
        begruendung: _str,
      }),
    },
    hobbys: {
      type: 'array',
      items: _obj({
        figur: _str,
        hobby: _str,
        ort: _str,
        ..._zeit,
        stelle: _str,
        zitat: _str,
        begruendung: _str,
      }),
    },
  });
}
