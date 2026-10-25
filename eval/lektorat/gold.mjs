// Gold-Set für die Lektorat-Output-Qualitäts-Eval (manuell via `npm run eval:lektorat`).
//
// Zweck: eine kleine, kuratierte Stichprobe, gegen die sich Prompt-Änderungen
// EMPIRISCH messen lassen, statt nach Gefühl zu tunen. Zwei Metriken pro Fall:
//
//   1. RECALL auf `mustCatch` – klar gepflanzte, objektive Fehler (Rechtschreibung,
//      Grammatik/Komma, Dialogformat), die das Modell finden MUSS. Ein Regress im
//      Prompt, der solche Fehler übersieht, senkt den Recall sofort messbar.
//   2. FALSE-POSITIVES auf `cleanSpans` – vollständig KORREKTE (Schweizer) Sätze,
//      die das Modell NICHT anstreichen darf. ss statt ß, Helvetismen und saubere
//      Prosa sind hier bewusst als Fallen gesetzt (Anti-Pedanterie-Kontrolle).
//
// Locale: de-CH, sofern ein Fall nicht `locale` setzt; `buchtyp` wählt das
// Fehlertyp-Profil (Default: Roman). `mustCatch.needle` und `cleanSpans[]` sind
// VERBATIM-Teilstrings des jeweiligen `text` – der Scorer matcht per Substring-
// Überlappung mit finding.original (das lt. Prompt zeichengenau aus dem Text stammt).
//
// Pflege: gern erweitern (mehr Fälle = aussagekräftiger). mustCatch bewusst nur
// für ZWEIFELSFREIE Fehler – subjektive Stil-Findings gehören nicht ins Gold-Set,
// weil ihr Fehlen kein Regress ist.

export const GOLD_CASES = [
  {
    id: 'rechtschreibung-genitiv',
    text: 'Er ging zum Fluss, den er schon als Kind kannte. Warscheinlich würde er wegen dem Regen nicht lange bleiben. Trozdem stieg er ins kalte Wasser.',
    mustCatch: [
      { typ: 'rechtschreibung', needle: 'Warscheinlich' },  // → wahrscheinlich
      { typ: 'grammatik',       needle: 'wegen dem Regen' }, // → wegen des Regens (Genitiv)
      { typ: 'rechtschreibung', needle: 'Trozdem' },         // → Trotzdem
    ],
    cleanSpans: [
      'Er ging zum Fluss, den er schon als Kind kannte.',
    ],
  },
  {
    id: 'komma-dialogformat',
    text: 'Sie wusste dass er kommen würde. «Komm herein» sagte sie leise und lächelte.',
    mustCatch: [
      { typ: 'grammatik',    needle: 'wusste dass' },     // Komma vor «dass» fehlt
      { typ: 'dialogformat', needle: '«Komm herein» sagte' }, // Inquit-Komma fehlt
    ],
    cleanSpans: [],
  },
  {
    id: 'clean-swiss-keine-findings',
    text: 'Er ass sein Znüni auf der Strasse. Draussen war es kalt, und der Nebel hing tief über den Dächern. Sie grüsste ihn freundlich.',
    // Vollständig korrektes Schweizer Schriftdeutsch – hier darf NICHTS beanstandet
    // werden (ss statt ß, «Znüni»/«Strasse» sind keine Fehler, saubere Kommasetzung).
    mustCatch: [],
    cleanSpans: [
      'Er ass sein Znüni auf der Strasse.',
      'Draussen war es kalt, und der Nebel hing tief über den Dächern.',
      'Sie grüsste ihn freundlich.',
    ],
  },

  // ── Direkte Rede, deutsche Norm ────────────────────────────────────────────
  {
    id: 'dialog-de-anschluss',
    text: '„Kommst du morgen?“ fragte sie.\n\n„Ja“ sagte er.\n\n„Gut.“, meinte sie und ging zur Tür.',
    mustCatch: [
      { typ: 'dialogformat', needle: 'morgen?“ fragte' }, // Komma auch nach ?
      { typ: 'dialogformat', needle: '„Ja“ sagte' },      // Komma fehlt
      { typ: 'dialogformat', needle: 'Gut.“, meinte' },   // Punkt entfällt vor Inquit
    ],
    cleanSpans: [],
  },
  {
    id: 'dialog-de-doppelpunkt',
    text: 'Sie sagte, „Wir müssen los.“ Dann stand sie auf und nahm ihre Jacke.',
    mustCatch: [
      { typ: 'dialogformat', needle: 'sagte, „Wir' },     // vorangestellter Begleitsatz → Doppelpunkt
    ],
    cleanSpans: ['Dann stand sie auf und nahm ihre Jacke.'],
  },
  {
    id: 'dialog-de-korrekt',
    // Korrekt nach amtlicher Regel, inkl. Komma nach ?-Rede und eingeschobenem Inquit.
    text: '„Kommst du morgen?“, fragte sie.\n\n„Ja“, sagte er, „aber erst am Abend.“ Sie nickte. Er sagte: „Bis dann.“',
    mustCatch: [],
    cleanSpans: [
      '„Kommst du morgen?“, fragte sie.',
      '„Ja“, sagte er, „aber erst am Abend.“',
      'Er sagte: „Bis dann.“',
    ],
  },

  // ── Konjunktiv ─────────────────────────────────────────────────────────────
  {
    id: 'konjunktiv-roman',
    text: 'Anna erzählte, sie ist gestern in Bern gewesen. Er meinte, dass sie müde ist, und schwieg.',
    mustCatch: [
      { typ: 'konjunktiv', needle: 'sie ist gestern in Bern gewesen' }, // uneingeleitet → sei
    ],
    // Indikativ nach «dass» ist in Erzählprosa zulässig.
    cleanSpans: ['Er meinte, dass sie müde ist, und schwieg.'],
  },
  {
    id: 'konjunktiv-roman-erlebte-rede',
    text: 'Sie stand am Fenster. Er kam nicht. Würde er überhaupt noch kommen? Sie wusste es nicht. „Ich bin müde“, sagte sie.',
    mustCatch: [],
    cleanSpans: [
      'Würde er überhaupt noch kommen?',
      'Sie wusste es nicht.',
      '„Ich bin müde“, sagte sie.',
    ],
  },
  {
    id: 'konjunktiv-sachbuch',
    buchtyp: 'sachbuch',
    text: 'Der Ökonom Müller behauptet, der Effekt ist gering. Die Studie zeigt, dass die Preise gestiegen sind.',
    mustCatch: [
      { typ: 'konjunktiv', needle: 'der Effekt ist gering' },
    ],
    // Verb des Belegens: der Autor übernimmt die Aussage.
    cleanSpans: ['Die Studie zeigt, dass die Preise gestiegen sind.'],
  },
  {
    id: 'zitat-sachbuch-gemischt',
    buchtyp: 'sachbuch',
    text: 'Die Ministerin nannte den Plan "unrealistisch". Sie sagte: „Wir prüfen alles.“',
    mustCatch: [
      { typ: 'dialogformat', needle: '"unrealistisch"' }, // gerade Quotes neben typografischen
    ],
    cleanSpans: ['Sie sagte: „Wir prüfen alles.“'],
  },

  // ── Englisch ───────────────────────────────────────────────────────────────
  {
    id: 'dialog-en-us-fehler',
    locale: 'en-US',
    text: '“Come here.” she said.\n\n“Wait”, he replied.\n\n“Why?”, she asked.',
    mustCatch: [
      { typ: 'dialogformat', needle: 'here.” she said' },
      { typ: 'dialogformat', needle: 'Wait”, he replied' },
      { typ: 'dialogformat', needle: 'Why?”, she asked' },
    ],
    cleanSpans: [],
  },
  {
    id: 'dialog-en-us-korrekt',
    locale: 'en-US',
    // Sprecherwechsel = neuer Absatz.
    text: '“Come here,” she said.\n\n“Why?” he asked.\n\n“Because I said so.” She smiled.',
    mustCatch: [],
    cleanSpans: ['“Come here,” she said.', '“Why?” he asked.', '“Because I said so.” She smiled.'],
  },
  {
    id: 'dialog-en-gb-korrekt',
    locale: 'en-GB',
    // Britische Belletristik: einfache Anführungszeichen, Apostroph = schliessendes Zeichen.
    text: '‘Come here,’ she said.\n\n‘Why?’ he asked.\n\n‘Because it’s late.’ She smiled.',
    mustCatch: [],
    cleanSpans: ['‘Come here,’ she said.', '‘Why?’ he asked.', '‘Because it’s late.’ She smiled.'],
  },
  {
    id: 'dialog-en-gb-fehler',
    locale: 'en-GB',
    text: '‘Come here.’ she said.\n\n‘Wait’, he replied, and sat down.',
    mustCatch: [
      { typ: 'dialogformat', needle: 'here.’ she said' },
      { typ: 'dialogformat', needle: 'Wait’, he replied' },
    ],
    cleanSpans: [],
  },
  {
    id: 'zitat-en-gb-sachbuch-logisch',
    locale: 'en-GB',
    buchtyp: 'sachbuch',
    // Logische Zeichensetzung: Punkt/Komma ausserhalb, weil sie nicht zum Zitat gehören.
    text: 'The minister, Jane Hart, called the plan ‘unworkable’. Critics, she added, had described it as ‘a fantasy’.',
    mustCatch: [],
    cleanSpans: ['called the plan ‘unworkable’.', 'had described it as ‘a fantasy’.'],
  },
  {
    id: 'backshift-en-us',
    locale: 'en-US',
    text: 'She said she was tired and is going home. He said the earth is round.',
    mustCatch: [
      { typ: 'konjunktiv', needle: 'she was tired and is going home' },
    ],
    // Allgemeingültige Aussage: Rückverschiebung entfällt zu Recht.
    cleanSpans: ['He said the earth is round.'],
  },
];
