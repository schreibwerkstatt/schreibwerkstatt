// Prompt-Block «Bearbeitungsstand» (docs/bearbeitungsstand.md) für den
// Abschnitts-Chat. Eigenes Modul, weil prompts/chat.js am LOC-Deckel steht.
//
// Die Stufe ist eine Selbsteinschätzung des Autors. Sie steuert die Art des
// Feedbacks, nicht seine Strenge bei echten Fehlern: in einer Rohfassung lohnt
// Arbeit an Inhalt und Aufbau, in einem redigierten oder finalen Abschnitt nur
// noch Feinschliff — ein Umbauvorschlag dort ignoriert, wo der Autor steht.

/**
 * @param {{ status: string, stale?: boolean, chain: string[] }} stand
 * @returns {string[]} Zeilen für den Seiten-Block; leer ohne gültige Stufe.
 */
export function buildEditStatusBlock(stand) {
  const chain = stand?.chain || [];
  const rank = chain.indexOf(stand?.status);
  if (rank < 0) return [];
  const spaet = rank >= chain.length - 2;
  return [
    '=== BEARBEITUNGSSTAND (vom Autor gesetzt) ===',
    `Stufe «${stand.status}» (${rank + 1} von ${chain.length}: ${chain.join(' → ')})`
      + (stand.stale ? '; der Text wurde nach dem Setzen noch geändert.' : '.'),
    spaet
      ? 'Der Autor betrachtet den Abschnitt als weitgehend fertig: konzentriere Hinweise und Vorschläge auf Feinschliff (Wortwahl, Rhythmus, Wiederholungen, echte Fehler). Keine Umbau- oder Strukturvorschläge, ausser der Autor fragt danach oder etwas ist inhaltlich falsch.'
      : 'Der Abschnitt ist in einer frühen Fassung: Inhalt, Aufbau, Szenenlogik und Figurenführung gehen vor sprachlichem Feinschliff.',
    '',
  ];
}
