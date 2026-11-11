// Geocode-Resolver: normalisiert beschreibende/fiktive Schauplatz-Labels eines
// Buchs auf einen realen Karten-Anker (Toponym + ISO-3166-1-alpha-2-Land), bevor
// der externe Geocoder anlaeuft. Rein rueckwaertsgewandt — liest bestehende
// Ortslabels, generiert keinen Buchtext. KI-Fallback, wenn die regelbasierte
// Heuristik in lib/geocode.js (parseToponym + Zwei-Pass) keinen Treffer findet.

import { _obj, _str } from './schema-utils.js';
import { _jsonOnly } from './state.js';

export function buildSystemGeocodeResolve() {
  return `Du bist ein Geografie-Resolver fuer eine Buch-Schauplatzkarte. Du bekommst beschreibende oder erfundene Schauplatz-Labels aus einem Roman (z.B. «Bar in Olten», «Badi Olten», «Schuetzenmattstrasse Olten», «Hogwarts»). Deine Aufgabe: zu jedem Label die praeziseste REALE Geocoder-Anfrage bestimmen, mit der sich der Ort auf einer Weltkarte pinnen laesst.

Regeln:
- Gib die praeziseste reale Anfrage zurueck, die das Label hergibt — so genau wie moeglich, aber nie ungenauer als der reale Anker.
- Form der Anfrage: «Objekt, Gemeinde» oder nur «Gemeinde». Nach dem ersten Komma steht GENAU die Gemeinde/Stadt, in der das Objekt liegt — findet der Geocoder das Objekt dort nicht, pinnt die Karte diese Gemeinde. Kein drittes Glied.
- BEHALTE echte geografische Bestandteile (Strasse, Quartier, Flurname, Huegel, Wald, Gemeinde, Stadt). «Schuetzenmattstrasse Olten» → «Schuetzenmattstrasse, Olten» (die Strasse ist geografisch praezise).
- Haenge KEINE Kantons-, Bundesland- oder Regionsnamen an («Bure, Solothurn», «Schafmatt, Aargau» sind falsch): sie stimmen oft nicht und lenken den Geocoder ab. Das Land gehoert ins Feld «land». Die Gemeinde steht mit ihrem amtlichen Namen, bei Namensgleichheit mit Kantonskuerzel («Rickenbach SO», «Bremgarten AG», nicht «Rickenbach bei Olten»).
- ENTFERNE nicht-geografische Beschreibungen (Bar, Badi, Cafe, Hotel, Restaurant, Schule, Spielplatz …), wenn sie keinen eigenen Geocoder-Treffer ergeben — der reale Anker bleibt der genannte Ort.
  - «Bar in Olten» → «Olten» (die Bar ist nur ein Detail in der realen Stadt Olten).
  - «Badi Olten» → «Olten» («Badi» = Badeanstalt, kein Toponym; Anker ist die Stadt Olten).
- Beruecksichtige regionale/umgangssprachliche Begriffe (CH-Deutsch: Badi = Badeanstalt, Beiz = Wirtschaft, …) und loese sie auf die genannte reale Ortschaft auf.
- Bestimme das Land als ISO-3166-1-alpha-2-Code (z.B. CH, DE, AT). Wenn unklar, leer lassen.
- Linien ohne Punkt (Autobahn, Bahnstrecke, Fluss, Kanal): die genannte Gemeinde als Anker («A1 bei Oensingen» → «Oensingen»), sonst die Gemeinde im Buch-Setting, an der der Abschnitt liegt.
- Kein Ort auf der Karte → «ort» leer: rein erfundene Orte ohne realen Anker (z.B. «Hogwarts», «Mittelerde»), virtuelle Orte (Chat, Forum, Telefonat, Sendung) und fahrende Verkehrsmittel (Zug, Auto, Flugzeug).
- Ganze Laender, Bundesstaaten und Grossregionen: «ort» = ihr Name, «land» = ihr Code («Kalifornien» → «Kalifornien», US). Erfinde keine Stadt dazu.
- Nutze Buch-Kontext (Setting des Romans) und die Wohnadressen verknuepfter Figuren als Disambiguierungs-Hinweise — etwa um zwischen gleichnamigen Orten zu waehlen oder ein knappes Label zu verorten. Der geografische Anker des Labels selbst hat aber Vorrang; widerspricht das Label dem Hinweis klar, gewinnt das Label.
- Gleichnamige Orte: nennt der Buch-Kontext eine Region, ist ein Name zuerst der Ort IN dieser Region — Huegel, Waelder, Weiler, Flurnamen, Strassen, Lokale. Spielt ein Roman in der Region Olten, ist «Engelberg mit Sendeturm» der Engelberg bei Dulliken, nicht der Kurort in Obwalden: → «Engelberg, Dulliken». Den bekannten fernen Ort nur, wenn das Label ihn eindeutig meint (Grossstaedte, Laender, beruehmte Bauwerke) oder es in der Region keinen solchen Ort gibt. Kennst du die lokale Gemeinde nicht, gib nur den Namen («Engelberg») — der Geocoder sucht dann nahe dem Buch-Setting.${_jsonOnly()}`;
}

export function buildGeocodeResolvePrompt(items, ctx = {}) {
  const ctxLines = [];
  if (ctx.region) ctxLines.push(`Laender-Hinweis des Buchs (bei Mehrdeutigkeit bevorzugen): ${ctx.region}`);
  if (ctx.bookContext) ctxLines.push(`Buch-Kontext (Setting/Schauplatz des Romans): ${ctx.bookContext}`);
  const ctxBlock = ctxLines.length ? '\n' + ctxLines.join('\n') : '';
  const list = items.map(it => {
    const hints = Array.isArray(it.hints) && it.hints.length
      ? ` (Wohnadressen verknuepfter Figuren: ${it.hints.map(h => `«${h}»`).join(', ')})`
      : '';
    // Vom Autor gepflegte Hierarchie (Raum › Gebäude › Stadt): der umgebende Ort
    // ist oft genau der reale Anker, den das Label allein nicht nennt.
    const within = Array.isArray(it.within) && it.within.length
      ? ` (liegt in: ${it.within.map(w => `«${w}»`).join(' › ')})`
      : '';
    return `- id=${it.id}: ${it.name}${within}${hints}`;
  }).join('\n');
  return `Bestimme zu jedem folgenden Schauplatz-Label den realen Karten-Anker.${ctxBlock}

Labels:
${list}

Antworte mit diesem JSON-Schema:
{
  "orte": [
    { "id": "exakt die id von oben", "ort": "realer Toponym oder leerer String", "land": "ISO-3166-1-alpha-2 oder leerer String" }
  ]
}`;
}

export const SCHEMA_GEOCODE_RESOLVE = _obj({
  orte: {
    type: 'array',
    items: _obj({ id: _str, ort: _str, land: _str }),
  },
});
