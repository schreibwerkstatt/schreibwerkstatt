#!/usr/bin/env node
'use strict';
// UserPromptSubmit-Hook: erkennt im User-Prompt mehrdeutige Sammelbegriffe, die
// laut CLAUDE.md eine Pflicht-Klaerung ausloesen, BEVOR geantwortet/gearbeitet
// wird — die einzige Regelklasse, die sich NICHT per Test/CI gaten laesst, weil
// sie reine Disambiguierung ist. Injiziert einen knappen Kontext-Hinweis
// (additionalContext), blockt nichts.
//
// Drei betroffene Harte Regeln (je drei unabhaengige Auspraegungen):
//   • Editor-Spezifikation     → Notebook- / Focus- / Bucheditor
//   • Chat-Spezifikation       → Seiten- / Buch- / Recherche- / Plot- / Ideen-Chat
//   • Kommentar-Oberflaeche    → Share-Reader / Notebook-Leseansicht / Bucheditor
//
// Logik pro Kategorie: feuert nur, wenn der GENERISCHE Sammelbegriff vorkommt
// UND KEIN spezifizierender Begriff genannt ist. Sobald der User (oder ein
// Dateipfad wie public/js/editor/focus/) die Auspraegung nennt, ist der Hinweis
// automatisch still — kein Rauschen in bereits geklaerten Threads.

const CATEGORIES = [
  {
    key: 'editor',
    // "der Editor", "im Editor", "Edit-Modus". \b vor "editor" trifft NICHT in
    // "Bucheditor" (kein Wortanfang) → dort feuert der generische Zweig gar nicht.
    generic: [/\beditor\b/i, /\bedit[-\s]?modus\b/i],
    specifiers: [/notebook/i, /\bfocus\b/i, /bucheditor/i, /buch[-\s]?editor/i, /book[-\s]?editor/i, /manuskript[-\s]?stream/i],
    hint: 'Editor mehrdeutig → die App hat DREI unabhaengige Editoren: Notebook-Editor '
      + '(Einzelseiten-Edit, public/js/editor/notebook/), Focus-Editor (Vollbild-Schreibmodus, '
      + 'public/js/editor/focus/) und Bucheditor (Manuskript-Stream, book-editor-card.js). '
      + 'Zuerst klaeren, welcher gemeint ist — nicht raten (Harte Regel "Editor-Spezifikation Pflicht").',
  },
  {
    key: 'chat',
    generic: [/\bchat\b/i, /\bchats\b/i],
    specifiers: [/abschnitts?[-\s]?chat/i, /section[-\s]?chat/i, /seiten[-\s]?chat/i, /page[-\s]?chat/i, /buch[-\s]?chat/i, /book[-\s]?chat/i, /recherche[-\s]?chat/i, /research[-\s]?chat/i, /plot[-\s]?chat/i, /ideen[-\s]?chat/i, /ideas?[-\s]?chat/i],
    hint: 'Chat mehrdeutig → die App hat FUENF unabhaengige Chats: Abschnitts-Chat (Code: Seiten-Chat, kind="page", '
      + 'Textersetzungs-Vorschlaege), Buch-Chat (kind="book", agentisch read-only, BOOK_CHAT_TOOLS), '
      + 'Recherche-Chat (kind="research", Claude-only mit Web-Suche) und Plot-Chat (kind="plot", '
      + 'Panel der Plot-Werkstatt, Board-Vorschlaege einzeln uebernehmen) und Ideen-Chat (kind="ideen", '
      + 'Panel im Ideen-Board, Erledigt-Check mit Textbeleg, Ideen-Vorschlaege einzeln uebernehmen). '
      + 'Zuerst klaeren, welcher gemeint ist (Harte Regel "Chat-Spezifikation Pflicht").',
  },
  {
    key: 'kommentar',
    generic: [/\bkommentar/i],  // trifft Kommentar, Kommentare, Kommentaren
    specifiers: [/share[-\s]?reader/i, /\breader\b/i, /leseansicht/i, /bucheditor/i, /margin[-\s]?rail/i, /comments-rail/i],
    hint: 'Kommentar-Oberflaeche mehrdeutig → Leser-Kommentare erscheinen auf DREI unabhaengigen '
      + 'Oberflaechen: Share-Reader-View (oeffentl. SSR-Leseansicht), Notebook-Leseansicht '
      + '(Margin-Rail, Owner) und Bucheditor (Margin-Rail ueber den Manuskript-Stream, Owner). '
      + 'Zuerst klaeren, welche gemeint ist (Harte Regel "Kommentar-Oberflaeche Pflicht").',
  },
];

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let prompt = '';
  try {
    prompt = String(JSON.parse(raw || '{}').prompt || '');
  } catch {
    process.exit(0);
  }
  if (!prompt.trim()) process.exit(0);

  const hints = [];
  for (const cat of CATEGORIES) {
    const mentionsGeneric = cat.generic.some((re) => re.test(prompt));
    if (!mentionsGeneric) continue;
    const isSpecified = cat.specifiers.some((re) => re.test(prompt));
    if (isSpecified) continue;
    hints.push('• ' + cat.hint);
  }

  if (hints.length) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: '[disambiguation] Vor der Arbeit ggf. Auspraegung klaeren:\n' + hints.join('\n'),
      },
    }));
  }
  process.exit(0);
});
