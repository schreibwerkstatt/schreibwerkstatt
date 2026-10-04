// Figuren-Konsolidierung, kapitelübergreifende Beziehungen, Beziehungs-Extraktion (A2),
// Soziogramm-Revision.
import { _isLocal } from '../state.js';
import { FIGUREN_BASIS_SCHEMA, figurenBasisRules } from './schema-strings.js';

export function buildFiguresBasisConsolidationPrompt(bookName, chapterFiguren, buchKontext = '') {
  const synthInput = chapterFiguren.map(cf => {
    const nameById = Object.fromEntries((cf.figuren || []).map(f => [f.id, f.name]));
    const arcStr = (a) => {
      if (!a || typeof a !== 'object') return '';
      const parts = [a.anfang, ...(Array.isArray(a.wendepunkte) ? a.wendepunkte : []), a.ende].filter(Boolean);
      return parts.length ? `${a.typ ? a.typ + ': ' : ''}${parts.join(' → ')}` : (a.typ || '');
    };
    return `## Kapitel: ${cf.kapitel}\n` + (cf.figuren || []).map(f => {
      const meta = [f.typ, f.beruf, f.geburtstag ? `*${f.geburtstag}` : '', f.geschlecht].filter(Boolean).join(', ');
      return `- ${f.name}${f.kurzname && f.kurzname !== f.name ? ` («${f.kurzname}»)` : ''} (${meta}): ${f.beschreibung || ''}` +
        (f.rolle ? '\n  Rolle: ' + f.rolle : '') +
        (f.motivation ? '\n  Motivation: ' + f.motivation : '') +
        (f.konflikt ? '\n  Konflikt: ' + f.konflikt : '') +
        (f.aeusseres ? '\n  Äusseres: ' + f.aeusseres : '') +
        (f.stimme ? '\n  Stimme: ' + f.stimme : '') +
        (f.hintergrund ? '\n  Hintergrund: ' + f.hintergrund : '') +
        (arcStr(f.arc) ? '\n  Arc: ' + arcStr(f.arc) : (f.entwicklung ? '\n  Entwicklung: ' + f.entwicklung : '')) +
        (f.wohnadresse ? '\n  Wohnadresse: ' + f.wohnadresse : '') +
        (f.eigenschaften?.length ? '\n  Eigenschaften: ' + f.eigenschaften.join(', ') : '') +
        (f.schluesselzitate?.length ? '\n  Zitate: ' + f.schluesselzitate.map(z => `«${z}»`).join(' ') : '') +
        (f.kapitel?.length ? '\n  Kapitel: ' + f.kapitel.map(k => k.name + (k.haeufigkeit > 1 ? ' ×' + k.haeufigkeit : '')).join(', ') : '') +
        (f.beziehungen?.length ? '\n  Beziehungen: ' + f.beziehungen.map(b => {
          const relName = nameById[b.figur_id] || b.name || b.figur_id;
          return `${relName} [${b.typ}]${b.beschreibung ? ': ' + b.beschreibung : ''}`;
        }).join(', ') : '');
    }).join('\n');
  }).join('\n\n');
  return `Konsolidiere die folgenden Figurenanalysen aller Kapitel des Buchs «${bookName}» zu einer einheitlichen Gesamtliste. Dedupliziere Figuren, führe Informationen zusammen und vergib stabile IDs.

Wähle pro Feld die textnächste, reichhaltigste Variante; ergänzende Angaben aus verschiedenen Kapiteln zusammenführen statt verkürzen. Die Tiefe-Felder (motivation, konflikt, aeusseres, stimme, hintergrund, arc) NICHT einkürzen.

Kapitelanalysen:

${synthInput}

Antworte mit diesem JSON-Schema:
${FIGUREN_BASIS_SCHEMA}

${figurenBasisRules(buchKontext)}`;
}

// ── Alias-Cluster (F3, Claude Multi-Pass, VOR der Konsolidierung) ─────────────
// Cross-Chunk-Figuren zerfallen bei rein namensbasiertem Merge (Epitheta, Spitznamen,
// Umbenennungen «der Alte» ↔ «Gregor»). Dieser Pass bekommt die Kandidatennamen +
// Kurzbeschreibungen + Kapitel und clustert Namensvarianten derselben Figur, damit die
// nachfolgende Konsolidierung sie zusammenführt statt als Dubletten zu behalten.
export function buildAliasClusterPrompt(bookName, candidates) {
  const list = candidates.map(c =>
    `- ${c.name}${c.kapitel ? ` | Kapitel: ${c.kapitel}` : ''}${c.beschreibung ? `\n  ${c.beschreibung}` : ''}`
  ).join('\n');
  return `Buch: «${bookName}»

Unten stehen aus verschiedenen Kapiteln extrahierte Figuren-KANDIDATEN. Manche Namen bezeichnen dieselbe Figur (Vollname vs. Vorname vs. Spitzname vs. Epitheton wie «der Alte», oder eine im Buch umbenannte Figur). Bilde Cluster von Namen, die SICHER dieselbe Figur meinen.

Kandidaten:
${list}

Antworte mit diesem JSON-Schema:
{
  "cluster": [
    { "kanonisch": "bevorzugter, vollständigster Name aus der Liste", "aliase": ["weitere Namen aus der Liste, die dieselbe Figur bezeichnen"] }
  ]
}

Regeln:
- NUR Namen aus der obigen Kandidatenliste verwenden (exakte Schreibweise), keine erfundenen.
- Nur clustern, wenn Beschreibung/Kapitel/Kontext die Identität eindeutig stützen – KONSERVATIV, im Zweifel getrennt lassen. Zwei Figuren mit ähnlichem Namen aber verschiedenen Rollen NICHT zusammenlegen.
- Jeder Alias erscheint in HÖCHSTENS einem Cluster. Der kanonische Name selbst nicht zusätzlich in aliase.
- Nur Cluster mit mindestens einem Alias ausgeben (Einzelnamen ohne Variante weglassen). Leeres Array, wenn keine Varianten existieren.`;
}

// ── Kapitelübergreifende Beziehungen ──────────────────────────────────────────
export function buildKapiteluebergreifendeBeziehungenPrompt(bookName, figurenList, bookText) {
  const idToName = Object.fromEntries(figurenList.map(f => [f.id, f.name]));
  const figInfo = figurenList.map(f => {
    const kap = (f.kapitel || []).map(k => k.name).join(', ') || '(kein Kapitel)';
    const bzStr = (f.beziehungen || [])
      .map(b => `${idToName[b.figur_id] || b.figur_id} [${b.typ}]`)
      .join(', ');
    return `- **${f.id}** ${f.name}${f.kurzname && f.kurzname !== f.name ? ` («${f.kurzname}»)` : ''} | ${f.typ} | Kapitel: ${kap}` +
      (f.beschreibung ? `\n  ${f.beschreibung}` : '') +
      (bzStr ? `\n  Bekannte Beziehungen: ${bzStr}` : '');
  }).join('\n');

  return `Buchname: «${bookName}»

Analysiere die folgende Figurenliste und den Buchtext. Identifiziere Beziehungen zwischen Figuren aus VERSCHIEDENEN Kapiteln, die noch NICHT in «Bekannte Beziehungen» aufgeführt sind.

Figurenliste:
${figInfo}

Buchtext:
${bookText}

Antworte mit diesem JSON-Schema:
{
  "beziehungen": [
    { "von": "fig_1", "zu": "fig_2", "typ": "elternteil|geschwister|kind|freund|feind|kollege|bekannt|liebesbeziehung|ehepartner|ex_partner|rivale|mentor|schuetzling|patronage|geschaeft|verbuendete|komplize|vorgesetzter|untergebener|andere", "machtverhaltnis": 0, "beschreibung": "1 Satz", "belege": [{ "kapitel": "Kapitelname (ohne ##-Präfix)", "seite": "Seitentitel (ohne ###-Präfix); leer wenn = Kapitel oder unklar" }] }
  ]
}

Regeln:
- Nur Beziehungen zwischen Figuren aus VERSCHIEDENEN Kapiteln
- Nur Beziehungen die im Buchtext eindeutig belegt sind – KONSERVATIV, lieber weglassen als spekulieren
- von/zu: nur IDs aus der obigen Figurenliste
- Jede Beziehung nur einmal eintragen (nicht von→zu UND zu→von für denselben Typ)
- Keine Beziehungen die bereits in «Bekannte Beziehungen» stehen
- machtverhaltnis: ganzzahlig im Bereich -2 bis 2 (KEIN führendes Plus-Zeichen). Machtasymmetrie: 2=Gegenüber («zu») dominiert klar, 1=Gegenüber hat leichten Vorteil, 0=symmetrisch, -1=diese Figur («von») hat leichten Vorteil, -2=diese Figur dominiert klar; weglassen oder 0 wenn unklar
- belege: HÖCHSTENS 1 Stelle (Kapitelname + Seitentitel) an der die Beziehung sichtbar wird. seite leer lassen wenn identisch mit dem Kapitelnamen oder unklar. Seitennamen aus ### Überschriften, Kapitel aus ## Überschriften des übergebenen Textes.
- Leeres Array wenn keine neuen kapitelübergreifenden Beziehungen eindeutig belegt sind`;
}

// ── Beziehungs-Extraktion (Claude-Single-Pass A2) ────────────────────────────
// Eigenständiger Pass: nimmt die in A1 extrahierten Figuren-Stammdaten (stabile IDs)
// plus den – im System-Prompt gecachten – Buchtext und liefert ALLE Beziehungen flach
// (von/zu). Wird via mergeBeziehungenIntoFiguren in figuren[].beziehungen zurückgefaltet.
export function buildFigurenBeziehungenExtraktionPrompt(bookName, figurenList, bookText, vonScopeNames = null) {
  const figInfo = figurenList.map(f => {
    const kap = (f.kapitel || []).map(k => k.name).join(', ') || '(kein Kapitel)';
    return `- **${f.id}** ${f.name}${f.kurzname && f.kurzname !== f.name ? ` («${f.kurzname}»)` : ''} | ${f.typ || 'andere'} | Kapitel: ${kap}` +
      (f.beschreibung ? `\n  ${f.beschreibung}` : '');
  }).join('\n');
  const textBlock = bookText == null
    ? 'Der Buchtext steht im System-Prompt oben.'
    : `Buchtext:\n${bookText}`;
  const machtRule = _isLocal
    ? ''
    : `\n- machtverhaltnis: ganzzahlig im Bereich -2 bis 2 (KEIN führendes Plus-Zeichen). 2=«zu» dominiert klar, 1=«zu» leichter Vorteil, 0=symmetrisch, -1=«von» leichter Vorteil, -2=«von» dominiert klar; 0 wenn unklar`;
  const machtField = _isLocal ? '' : ' "machtverhaltnis": 0,';
  // Batch-Scope (grosse Casts): die volle Figurenliste bleibt sichtbar (damit «zu» auflösbar
  // ist), aber es werden NUR Beziehungen ausgegeben, deren «von» eine der Scope-Figuren ist →
  // partitionierter, kleinerer Output pro Call. Paar-Dedup übernimmt der Server.
  const scope = Array.isArray(vonScopeNames) && vonScopeNames.length
    ? `\n\nGib in DIESEM Durchgang AUSSCHLIESSLICH Beziehungen aus, deren «von»-Figur eine der folgenden ist:\n${vonScopeNames.map(n => `- ${n}`).join('\n')}\n(Die übrigen Figuren dienen nur als mögliche «zu»-Gegenüber; für sie in diesem Durchgang KEINE «von»-Beziehungen ausgeben.)`
    : '';
  const scopeRule = scope
    ? '\n- NUR Beziehungen mit «von» aus der oben genannten Scope-Liste; alle anderen weglassen (sie werden in einem anderen Durchgang erfasst).'
    : '';
  return `Buchname: «${bookName}»

Analysiere die folgende Figurenliste und den Buchtext. Identifiziere ALLE Beziehungen zwischen den Figuren, die im Text eindeutig belegt sind.

Figurenliste:
${figInfo}${scope}

${textBlock}

Antworte mit diesem JSON-Schema:
{
  "beziehungen": [
    { "von": "fig_1", "zu": "fig_2", "typ": "elternteil|geschwister|kind|freund|feind|kollege|bekannt|liebesbeziehung|ehepartner|ex_partner|rivale|mentor|schuetzling|patronage|geschaeft|verbuendete|komplize|vorgesetzter|untergebener|andere",${machtField} "beschreibung": "1 Satz", "belege": [{ "kapitel": "Kapitelname (ohne ##-Präfix)", "seite": "Seitentitel (ohne ###-Präfix); leer wenn = Kapitel oder unklar" }] }
  ]
}

Regeln:
- von/zu: nur IDs aus der obigen Figurenliste
- typ beschreibt die ROLLE von «zu» (NICHT von «von»). Beispiel: Robert hat Mutter Sandra → { von: «<Roberts id>», zu: «<Sandras id>», typ: elternteil } (Sandra IST der Elternteil von Robert). patronage=Schutzherrschaft (zu = Patron), geschaeft=wirtschaftliche Beziehung, geschwister/ehepartner/ex_partner/verbuendete/komplize=ungerichtet, vorgesetzter=«zu» ist Vorgesetzte(r) von «von», untergebener=«zu» ist «von» unterstellt, liebesbeziehung nur für nicht-eheliche romantische Bindung, übrige selbsterklärend.
- Pro Figurenpaar höchstens EINE Beziehung – nicht von→zu UND zu→von für dasselbe Paar. Keine widersprüchlichen Angaben.${machtRule}
- belege: HÖCHSTENS 1 Stelle (Kapitelname + Seitentitel) an der die Beziehung klar wird. seite leer lassen wenn identisch mit dem Kapitelnamen oder unklar. Seitennamen aus ### Überschriften, Kapitel aus ## Überschriften.
- KONSERVATIV: Nur Beziehungen die im Text eindeutig belegt sind – lieber weglassen als spekulieren.${scopeRule}
- Leeres Array wenn keine Beziehungen eindeutig belegt sind.`;
}

// ── Soziogramm-Konsolidierung (Claude-only, holistische Revision) ────────────
export function buildSoziogrammConsolidationPrompt(bookName, figuren, buchKontext = '') {
  const nameById = Object.fromEntries(figuren.map(x => [x.id, x.name]));
  const figInfo = figuren.map(f => {
    const meta = [f.typ, f.beruf, f.geschlecht].filter(Boolean).join(', ');
    const bzStr = (f.beziehungen || [])
      .map(b => `${nameById[b.figur_id] || b.figur_id} [${b.typ}${Number.isFinite(b.machtverhaltnis) ? ', macht=' + b.machtverhaltnis : ''}]`)
      .join(', ');
    return `- **${f.id}** ${f.name}${f.kurzname && f.kurzname !== f.name ? ` («${f.kurzname}»)` : ''} | ${meta || '—'} | sozialschicht=${f.sozialschicht || '—'}` +
      (f.beschreibung ? `\n  ${f.beschreibung}` : '') +
      (bzStr ? `\n  Beziehungen: ${bzStr}` : '');
  }).join('\n');

  return `Buch: «${bookName}»${buchKontext ? `\nBuchkontext: ${buchKontext}` : ''}

Die folgenden Figuren sind bereits konsolidiert. Die preliminary-Werte für sozialschicht und die machtverhaltnis-Werte in den Beziehungen stammen aus einer kapitelweisen Vorab-Analyse und sind oft inkonsistent oder fehlen. Revidiere beides HOLISTISCH mit Blick auf das ganze Buch.

Figurenliste:
${figInfo}

Antworte mit diesem JSON-Schema:
{
  "figuren": [
    { "id": "fig_1", "sozialschicht": "wirtschaftselite|gehobenes_buergertum|mittelschicht|arbeiterschicht|migrantenmilieu|prekariat|unterwelt|andere" }
  ],
  "beziehungen": [
    { "from_fig_id": "fig_1", "to_fig_id": "fig_2", "machtverhaltnis": 0 }
  ]
}

Regeln sozialschicht:
- Für JEDE Figur der Liste einen Eintrag – auch wenn der preliminary-Wert übernommen wird
- id: exakt aus der obigen Liste (keine neuen IDs, keine Namensfelder)
- wirtschaftselite=Unternehmerfamilien/Direktoren, gehobenes_buergertum=Akademiker/freie Berufe/obere Kader, mittelschicht=Angestellte/Beamte/mittlere Kader, arbeiterschicht=Fabrik-/Bauarbeiter/Servicepersonal, migrantenmilieu=Zugewanderte/zweite Generation (primär nach Milieu-Zugehörigkeit, nicht nach beruflichem Status), prekariat=Sozialhilfe/Randständige/Langzeitarbeitslose, unterwelt=kriminelles Milieu, andere=nicht eindeutig zuordenbar
- Innerhalb eines Buchs Milieu-Zuordnungen konsistent halten: wenn zwei Figuren im gleichen Haushalt/Familienverbund leben, teilen sie meist die sozialschicht
- KONSERVATIV: im Zweifel «andere» statt spekulativ eine Schicht wählen

Regeln beziehungen (machtverhaltnis):
- Nur Beziehungen der obigen Liste – keine neuen Paare, keine Pfeile zwischen Figuren ohne bestehende Beziehung
- from_fig_id / to_fig_id: exakt die figur_id aus dem obigen Beziehungsfeld («von» = die Figur in deren Block die Beziehung steht, «zu» = figur_id darin)
- machtverhaltnis: ganzzahlig im Bereich -2 bis 2 (KEIN führendes Plus-Zeichen). 2=to_fig_id dominiert klar, 1=to_fig_id hat leichten Vorteil, 0=symmetrisch, -1=from_fig_id hat leichten Vorteil, -2=from_fig_id dominiert klar
- HOLISTISCH bewerten: wer hat strukturelle Macht (Kapital, Hierarchie, Wissen), wer psychologische (Manipulation, Autorität)? Im Zweifel 0
- Pro ungeordnetem Paar (A,B) nur EIN Eintrag – nicht sowohl A→B als auch B→A
- Beziehungen weglassen wenn machtverhaltnis unklar oder 0 ist und der preliminary-Wert ebenfalls 0/leer war`;
}
