// Weitere Kontext-Blöcke des Abschnitts-Chats: Zeitstrahl des Buchs, offene
// Kontinuitäts-Befunde des Kapitels (beide Block 1, kapitel-stabil) und offene Ideen
// im übrigen Buch (Block 2, abschnitts-spezifisch: gruppiert nach Lage zum aktuellen
// Abschnitt). Daten: routes/jobs/chat/page-chat-kontext.js.
//
// Jeder Block hat einen Zeichendeckel aus dem Kontextfenster des Providers
// (`maxChars`) — ein lokales Modell mit kleinem Fenster bekommt weniger, nie einen
// gesprengten Prompt. Was der Deckel abschneidet, wird ausgewiesen.

/** Zeilen bis zum Deckel; `priority(row)` (kleiner = wichtiger) entscheidet beim
 *  Kappen, die Ausgabe bleibt in der Eingabe-Reihenfolge. */
function _fit(rows, format, maxChars, priority) {
  const lines = rows.map(format);
  const total = lines.reduce((n, l) => n + l.length + 1, 0);
  if (total <= maxChars) return { lines, dropped: 0 };
  const order = rows.map((r, i) => i).sort((a, b) => priority(rows[a], a) - priority(rows[b], b));
  const keep = new Set();
  let used = 0;
  for (const i of order) {
    if (used + lines[i].length + 1 > maxChars) continue;
    keep.add(i);
    used += lines[i].length + 1;
  }
  return { lines: lines.filter((_, i) => keep.has(i)), dropped: rows.length - keep.size };
}

/**
 * Zeitstrahl des Buchs. Beim Kappen haben Ereignisse dieses Kapitels Vorrang, dann
 * die Reihenfolge des Zeitstrahls.
 * @param {Array<{datum,ereignis,bedeutung,kapitel,figuren,imKapitel}>} events
 * @returns {string[]}  Zeilen samt Leerzeile; [] = kein Block
 */
export function buildPageChatZeitstrahlLines(events, { maxChars = 6000 } = {}) {
  const list = Array.isArray(events) ? events.filter(e => e && e.ereignis) : [];
  if (!list.length) return [];
  const fmt = (e) => {
    const extra = [
      e.kapitel?.length ? `Kapitel: ${e.kapitel.join(', ')}` : '',
      e.figuren?.length ? `Figuren: ${e.figuren.join(', ')}` : '',
    ].filter(Boolean).join('; ');
    return `- ${e.datum || '?'}: ${e.ereignis}${e.bedeutung ? ` — ${e.bedeutung}` : ''}${extra ? ` (${extra})` : ''}`;
  };
  const { lines, dropped } = _fit(list, fmt, maxChars, (e, i) => (e.imKapitel ? 0 : 1) * 1e6 + i);
  return [
    '=== ZEITSTRAHL DES BUCHS (aus der Komplettanalyse) ===',
    '(Datierte Ereignisse in Handlungsreihenfolge, Stand des letzten Analyselaufs — neuere Kapitel können fehlen. Halte Daten, Wochentage und Abfolge im Abschnitt dagegen; lege kein Datum fest, das hier anders steht, ohne es zu sagen.'
      + (dropped ? ` NUR ${lines.length} von ${list.length} Ereignissen aufgeführt — Ereignisse dieses Kapitels zuerst.)` : ')'),
    ...lines,
    '',
  ];
}

/**
 * Offene Kontinuitäts-Befunde, die dieses Kapitel betreffen.
 * @param {Array<{schwere,beschreibung,stelle_a,stelle_b,empfehlung,kapitel}>} issues
 */
export function buildPageChatKontinuitaetLines(issues, { maxChars = 4000 } = {}) {
  const list = Array.isArray(issues) ? issues.filter(i => i && i.beschreibung) : [];
  if (!list.length) return [];
  const rang = { kritisch: 0, mittel: 1, niedrig: 2 };
  const fmt = (i) => {
    const stellen = [i.stelle_a, i.stelle_b].filter(Boolean).map(s => `«${s}»`).join(' / ');
    return `- [${i.schwere || '?'}] ${i.beschreibung}${stellen ? ` Stellen: ${stellen}.` : ''}${i.empfehlung ? ` Empfehlung: ${i.empfehlung}` : ''}${i.kapitel?.length ? ` (Kapitel: ${i.kapitel.join(', ')})` : ''}`;
  };
  const { lines, dropped } = _fit(list, fmt, maxChars, (i, idx) => (rang[i.schwere] ?? 3) * 1e6 + idx);
  return [
    '=== OFFENE KONTINUITÄTS-BEFUNDE ZU DIESEM KAPITEL ===',
    '(Aus dem letzten Kontinuitätscheck, vom Autor weder behoben noch verworfen. Der Text kann seither geändert sein — prüfe gegen den Abschnitt, bevor du dich darauf beziehst.'
      + (dropped ? ` NUR ${lines.length} von ${list.length} Befunden aufgeführt, schwerste zuerst.)` : ')'),
    ...lines,
    '',
  ];
}

const LAGE_KOPF = {
  frueher: 'Frühere Teile des Buchs',
  umgebend: 'Übergeordnetes Kapitel',
  spaeter: 'Spätere Teile des Buchs (geplant)',
  buch: 'Ohne Ort (ganzes Buch)',
};

/**
 * Offene Ideen im übrigen Buch, nach Lage zum aktuellen Abschnitt gruppiert. Beim
 * Kappen haben Ideen nahe am Abschnitt Vorrang. Nur lesend: Änderungsvorschläge
 * (`ideen_aenderungen`) gelten weiter nur den Ideen mit [#id].
 * @param {Array<{content,status,ort,lage,abstand,index}>} ideen
 */
export function buildPageChatBuchIdeenLines(ideen, { maxChars = 6000 } = {}) {
  const list = Array.isArray(ideen) ? ideen.filter(i => i && i.content) : [];
  if (!list.length) return [];
  const sorted = list.slice().sort((a, b) => (a.index - b.index) || 0);
  const fmt = (i) => `- ${i.ort ? `[${i.ort}] ` : ''}${i.content}${i.status && i.status !== 'offen' ? ` — Stufe: ${i.status}` : ''}`;
  const { lines, dropped } = _fit(sorted, fmt, maxChars, (i, idx) => (Number.isFinite(i.abstand) ? i.abstand : 1e5) * 1e4 + idx);
  const keep = new Set(lines);
  const out = [
    '=== OFFENE IDEEN IM ÜBRIGEN BUCH (Notizen des Autors, nur lesend) ===',
    '(Pendenzen und Pläne des Autors für andere Stellen des Buchs. Sie zeigen, was schon angelegt ist und was er noch vorhat — nutze sie, um Bezüge herzustellen, statt Absichten zu raten. Nicht Ziel von ideen_aenderungen.'
      + (dropped ? ` NUR ${lines.length} von ${list.length} Ideen aufgeführt, die nächstgelegenen zuerst.)` : ')'),
  ];
  for (const lage of ['frueher', 'umgebend', 'spaeter', 'buch']) {
    const group = sorted.filter(i => i.lage === lage).map(fmt).filter(l => keep.has(l));
    if (!group.length) continue;
    out.push(`${LAGE_KOPF[lage]}:`, ...group);
  }
  out.push('');
  return out;
}

/**
 * Frühere Szenen (Komplettanalyse) mit Figuren, die der Abschnitt nennt — als
 * Inhaltsangabe des bisherigen Geschehens. Beim Kappen die nächstgelegenen zuerst,
 * Ausgabe in Lesereihenfolge.
 * @param {Array<{titel,ort,figuren,abstand,index}>} szenen
 */
export function buildPageChatSzenenLines(szenen, { maxChars = 6000 } = {}) {
  const list = Array.isArray(szenen) ? szenen.filter(s => s && s.titel) : [];
  if (!list.length) return [];
  const fmt = (s) => `- ${s.ort ? `[${s.ort}] ` : ''}${s.titel}${s.figuren?.length ? ` (${s.figuren.join(', ')})` : ''}`;
  const { lines, dropped } = _fit(list, fmt, maxChars, (s, i) => (Number.isFinite(s.abstand) ? s.abstand : 1e5) * 1e4 + i);
  return [
    '=== FRÜHERE SZENEN MIT FIGUREN DIESES ABSCHNITTS (aus der Komplettanalyse) ===',
    '(Was diese Figuren vor diesem Abschnitt erlebt haben, je Szene ein Satz, in Lesereihenfolge. Stand des letzten Analyselaufs — neuere Kapitel können fehlen; fehlt hier etwas, ist es deshalb nicht ungeschehen. Nutze es für Rückbezüge und Anschlussfehler.'
      + (dropped ? ` NUR ${lines.length} von ${list.length} Szenen aufgeführt, die nächstgelegenen zuerst.)` : ')'),
    ...lines,
    '',
  ];
}
