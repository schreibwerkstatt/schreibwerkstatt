// Welt-Fakten im Abschnitts-Lektorat: Kontextblöcke (die Fakten selbst) und
// Regelblöcke der Typen «weltfakt» und «soziolekt». Die Auswahl der Fakten je
// Abschnitt trifft der Server (lib/lektorat-weltfakten.js); hier steht nur, wie sie
// im Prompt erscheinen und wie das Modell sie benutzt.
//
// Rahmung wie überall, wo Welt-Fakten in einen Prompt fliessen: sie sind
// KI-extrahiert, kein kuratierter Kanon — im Zweifel gilt der Text, und ein Befund
// ist ein Hinweis auf einen möglichen Widerspruch, keine Korrekturpflicht.

function _zeile(f) {
  return `- ${f.subjekt ? `${f.subjekt}: ` : ''}${f.fakt}`;
}

/** Kontextblock «etablierte Welt-Fakten» ('' ohne Fakten). */
export function _buildWeltfaktenContextBlock(weltfakten) {
  if (!weltfakten?.length) return '';
  return `\nEtablierte Welt-Fakten aus anderen Stellen des Buchs (automatisch aus dem Text erhoben, kein geprüfter Kanon – Prüfgrundlage für «weltfakt»):\n${weltfakten.map(_zeile).join('\n')}\n`;
}

/** Kontextblock «Sprechweise der Figuren» ('' ohne Einträge). */
export function _buildSoziolektContextBlock(soziolekte) {
  if (!soziolekte?.length) return '';
  return `\nErfasste Sprechweise von Figuren in diesem Abschnitt (aus anderen Stellen des Buchs – Prüfgrundlage für «soziolekt»):\n${soziolekte.map(_zeile).join('\n')}\n`;
}

export function _buildWeltfaktBlock() {
  return `
Welt-Fakt-Regeln (typ: «weltfakt»):
- Wird AUSSCHLIESSLICH gegen den oben gelieferten Block «Etablierte Welt-Fakten» geprüft. KEINE externe Welt-Annahme, kein Allgemeinwissen. Schweigt der Block zur Stelle → kein Eintrag.
- Melden, wenn eine Aussage im Text einem dort gelisteten Fakt klar widerspricht: Zahl, Ort, Lage, Zeitpunkt, Zugehörigkeit, Regel der Welt, Zustand eines Gegenstands («sieben Stockwerke» gegen «neun Stockwerke», «liegt am Stadtrand» gegen «mitten in der Altstadt»).
- Figuren-Eigenschaften, die der Figuren-Block trägt, gehören zu «figurenmerkmal»; Orts-Eigenschaften aus dem Schauplätze-Block zu «schauplatzmerkmal». «weltfakt» ist für alles Übrige.
- NICHT melden: Figurenrede, die irrt, lügt oder bewusst übertreibt; Erinnerung oder Gerücht als solche gekennzeichnet; nachvollziehbare Entwicklung im Plot (etwas wurde umgebaut, verlegt, geändert); blosse Ergänzung ohne Widerspruch.
- «original»: die widersprechende Phrase zeichengenau aus dem Text.
- «korrektur»: dieselbe Phrase, angeglichen an den Fakt.
- «erklaerung»: MUSS den Fakt nennen («laut Welt-Fakten: Der Turm hat sieben Stockwerke») und offenlassen, welche Seite gilt – der Fakt kann veraltet sein.
- Severity-Schwelle: nur eindeutige Widersprüche. Unklare Bezüge (ist «der Turm» derselbe?) → weglassen.`;
}

export function _buildSoziolektBlock() {
  return `
Soziolekt-Regeln (typ: «soziolekt»):
- Wird AUSSCHLIESSLICH gegen den oben gelieferten Block «Erfasste Sprechweise» geprüft, und nur in direkter Rede der dort genannten Figuren.
- Melden, wenn eine Figur deutlich aus ihrem erfassten Register fällt, ohne dass die Szene es erklärt: eine Figur mit Szenejargon spricht plötzlich gestelzt-formell, eine biblisch-moralische Stimme flucht im Gassenjargon, Dialekt- oder Fachsprach-Marker fehlen auffällig.
- NICHT melden: situativer Registerwechsel mit Anlass (Wut, Ironie, Parodie, Gespräch mit Vorgesetzten, Imitation einer anderen Figur), Entwicklung der Figur über das Buch, eine einzelne neutrale Äusserung, Erzähltext ausserhalb der Rede.
- «original»: der Redesatz oder die Phrase zeichengenau aus dem Text.
- «korrektur»: dieselbe Rede im erfassten Register – Inhalt unverändert.
- «erklaerung»: MUSS das erfasste Register nennen («laut Sprechweise: Adrian spricht moralisch-biblisch»).
- Severity-Schwelle: nur deutliche Brüche, die ein Lektor als «klingt nicht nach ihr» anstreichen würde. Bei Zweifel weglassen.`;
}

/** Zeilen des Abschnitts-Chats: Welt-Fakten + Sprechweise zu diesem Abschnitt (gleiche
 *  Auswahl wie das Lektorat). [] ohne Einträge — dann entfällt der Block ganz, statt
 *  eine weltlose Stelle zu behaupten. */
export function buildPageChatWeltLines(weltfakten, soziolekte) {
  const welt = Array.isArray(weltfakten) ? weltfakten : [];
  const sozio = Array.isArray(soziolekte) ? soziolekte : [];
  if (!welt.length && !sozio.length) return [];
  const out = ['=== WELT-FAKTEN ZU DIESEM ABSCHNITT (automatisch aus dem Buch erhoben, kein geprüfter Kanon – im Zweifel gilt der Text) ==='];
  out.push(...welt.map(_zeile));
  if (sozio.length) out.push('Erfasste Sprechweise der Figuren:', ...sozio.map(_zeile));
  out.push('', 'Hinweis: Halte Vorschläge mit diesen Fakten und Sprechweisen in Einklang und weise auf Widersprüche im Abschnitt hin. Es sind Aussagen über die Welt des Buchs, nicht über die reale Welt.', '');
  return out;
}
