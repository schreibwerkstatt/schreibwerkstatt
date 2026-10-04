// Buchgestaltungs-Vorlagen für den Custom-PDF-Export: fertig durchgesetzte
// Profil-Konfigurationen, die der User als eigenes Profil anlegt und dann frei
// weiterbearbeitet.
//
// Eine Vorlage ist eine TEILKONFIGURATION, kein vollständiges Profil: sie nennt
// nur, was sie tatsächlich gestaltet. Den Rest füllt `validateConfig`
// ([lib/pdf-export-defaults.js](../../../lib/pdf-export-defaults.js)) beim
// Anlegen aus den Defaults auf — die Validierung IST der Merge. Dadurch bleibt
// hier nur die gestalterische Aussage stehen, und eine neue Default-Option
// erreicht die Vorlagen automatisch, statt still auf einem alten Wert
// einzufrieren.
//
// Bewusst NICHT gesetzt: die Textfelder in `extras` (Widmung, Impressum,
// Untertitel, ISBN, Klappentext …). Sie gehören dem Werk, nicht der Gestaltung —
// eine Vorlage, die sie mitbrächte, würde beim Anwenden fremden Text
// hineinschreiben oder vorhandenen leeren. Gesetzt werden nur die *Platzierungs*-
// Schalter daneben (Impressum auf Verso, Widmung auf Recto …).
//
// Schriftwahl ist an die Whitelist in [lib/font-fetch.js](../../../lib/font-fetch.js)
// gebunden (Familie UND Gewicht) — eine Vorlage mit nicht gelisteter Schrift
// liesse sich anlegen, aber nicht mehr speichern (`FONT_NOT_ALLOWED` beim PUT).
//
// Zwei gelistete Familien sind fuer Fliesstext trotzdem unbrauchbar und stehen
// darum in `HYPHEN_BROKEN_FAMILIES`: bei ihnen faellt der TRENNSTRICH am
// Zeilenumbruch aus, das Wort wird also stillschweigend in zwei Teile
// zerschnitten. Literale Bindestriche im Text sind nicht betroffen, weshalb der
// Fehler erst im gesetzten Absatz auffaellt. Eine Vorlage darf dort nicht landen.
//
// Reine Daten + pure Funktionen, keine Alpine-/`this`-Bindung — wie
// pdf-export-presets.js, und damit ohne Browser testbar.

// ── Vorlage 1: kleines, modernes Taschenbuch ────────────────────────────────
// 12.5 × 20 cm. Zeitgenössischer Handelsband: enge, papiersparende Ränder,
// Spectral im Satz gegen Work Sans in den Titeln, ruhige Kapitelköpfe ohne
// Zierrat, keine laufenden Kolumnentitel — die Seitenzahl allein trägt die
// Orientierung. Satzbreite 93 mm ≈ 62 Zeichen.
const TASCHENBUCH_MODERN = {
  layout: {
    pageSize: 'custom', customWidthMm: 125, customHeightMm: 200,
    // left = Bund (innen), right = aussen — mirrorMargins tauscht sie auf Verso.
    marginsMm: { top: 16, right: 14, bottom: 19, left: 18 },
    mirrorMargins: true,
    // Kein Kolumnentitel: der Default setzt {title} in die Kopfzeile, die
    // Vorlage muss ihn also aktiv leeren statt ihn bloss nicht zu erwähnen.
    headerLeft: '', headerCenter: '', headerRight: '',
    footerLeft: '', footerCenter: '{page}', footerRight: '',
    headerRule: false, footerRule: false,
    showHeaderOnChapterStart: false, showFooterOnChapterStart: false,
    hyphenate: true, widowOrphanControl: true,
    pageCountMode: 'body', pageNumberStart: 1, pageNumberFirstVisible: 1,
    frontMatterNumbering: 'none',
  },
  font: {
    // Erstzeilen-Einzug STATT Absatzabstand — zwei Absatzmarken nebeneinander
    // wären eine doppelte Ansage (paragraphGap zählt in Zeilen, nicht in mm).
    body:        { family: 'Spectral', weight: 400, sizePt: 10,   lineHeight: 1.42, paragraphGap: 0, firstLineIndentMm: 4.5, color: '#1a1a1a', numerals: 'auto' },
    heading:     { family: 'Work Sans', weight: 600, sizes: { h1: 19, h2: 15, h3: 12.5, h4: 11.5, h5: 11, h6: 10.5 }, color: '#111111' },
    title:       { family: 'Work Sans', weight: 700, sizePt: 26, color: '#111111' },
    subtitle:    { family: 'Work Sans', weight: 400, sizePt: 14, color: '#444444' },
    byline:      { family: 'Work Sans', weight: 500, sizePt: 11, color: '#444444' },
    // Kursive Rollen bleiben auf der Serifen-Familie — die Kursive ist dort die
    // Auszeichnung des Fliesstexts und gehört zu seiner Schrift.
    dedication:  { family: 'Spectral', weight: 400, sizePt: 11,  color: '#1a1a1a', italic: true },
    frontMatter: { family: 'Spectral', weight: 400, sizePt: 11,  color: '#1a1a1a', italic: true },
    authorBio:   { family: 'Spectral', weight: 400, sizePt: 9.5, lineHeight: 1.4,  paragraphGap: 0.3, color: '#1a1a1a', italic: false },
    bibliography:{ family: 'Spectral', weight: 400, sizePt: 9,   lineHeight: 1.3,  paragraphGap: 0.3, color: '#1a1a1a', italic: false },
    footnote:    { family: 'Spectral', weight: 400, sizePt: 7.5, lineHeight: 1.2,  color: '#333333', italic: false },
    imprint:     { family: 'Spectral', weight: 400, sizePt: 8.5, color: '#333333', italic: false },
    year:        { family: 'Work Sans', weight: 400, sizePt: 11, color: '#444444', italic: false },
    toc:         { family: 'Spectral', weight: 400, sizePt: 10, lineHeight: 1.5, paragraphGap: 0.2, color: '#1a1a1a' },
    tocTitle:    { family: 'Work Sans', weight: 600, sizePt: 16, color: '#111111' },
    header:      { family: 'Work Sans', weight: 400, sizePt: 8,   color: '#8a8a8a' },
    footer:      { family: 'Work Sans', weight: 400, sizePt: 8.5, color: '#8a8a8a' },
  },
  chapter: {
    // 'always' statt 'right-page': ein Taschenbuch zählt Bogen, nicht Gesten —
    // jedes Kapitel auf Recto kostet im Schnitt eine halbe Leerseite pro Kapitel.
    breakBefore: 'always',
    breakBeforeSubchapter: true,
    firstChapterOnRecto: true,
    blankPageAfter: false,
    numbering: 'arabic', numberingMode: 'flat',
    titleStyle: 'minimal',
    dropCap: false,
    spaceBeforeMm: 34,
    // Jede Seite ist ein Abschnitt: eigener Titel, eigene neue Seite.
    pageStructure: 'nested',
    pageBreakBetweenPages: true,
    titleRule: false, pageTitleRule: false,
  },
  cover: { enabled: true, fit: 'cover' },
  toc: {
    enabled: true, depth: 1, includePages: false,
    showPageNumbers: true, titleAlign: 'left',
    indentMm: 5, leader: 'dots', pageNumReserveMm: 12, startOnRecto: true,
  },
  extras: { imprintPosition: 'front', imprintOnVerso: true, dedicationOnRecto: true, barcode: true },
  footnotes: { separator: true, separatorWidthMm: 25, gapMm: 2, hangMm: 3.5, maxHeightPct: 35 },
  print: { bleedMm: 0, cropMarks: false, blackTextKOnly: false, dpiWarnThreshold: 300, padToEvenPages: true },
  // Rückenstärke-Richtwert für den Umschlagbogen (weisses POD-Papier).
  // pageCount bleibt 0 — die trägt der Innenteil-Export selbst nach.
  coverSpec: { paperBulkMmPer1000: 57.2 },
  pdfa: { standard: 'pdfa', conformance: 'B' },
};

// ── Vorlage 2: klassischer grosser deutschsprachiger Roman ──────────────────
// 15.5 × 23 cm. Ruhiger Werksatz nach klassischem Vorbild: eine einzige
// Renaissance-Antiqua über alle Rollen, grosszügiger Rand mit schwerem Fuss,
// Mediävalziffern im Fliesstext, Kapitel auf der rechten Seite mit tiefem
// Anfang und Initiale, Kolumnentitel in Versalien (Verso Werk, Recto Kapitel),
// römische Zählung der Titelei. Satzbreite 105 mm ≈ 66 Zeichen.
const ROMAN_KLASSISCH = {
  layout: {
    pageSize: 'custom', customWidthMm: 155, customHeightMm: 230,
    // Der Fuss ist deutlich schwerer als der Kopf: der Satzspiegel sitzt optisch
    // in der Mitte, nicht geometrisch — auf der geometrischen Mitte wirkt er
    // nach unten gerutscht.
    marginsMm: { top: 24, right: 30, bottom: 38, left: 20 },
    mirrorMargins: true,
    headerLeft: '', headerCenter: '{chapter}', headerRight: '',
    headerVersoLeft: '', headerVersoCenter: '{title}', headerVersoRight: '',
    footerLeft: '', footerCenter: '{page}', footerRight: '',
    hfStyle: {
      header: {
        recto: { center: { upper: true } },
        verso: { center: { upper: true } },
      },
    },
    headerRule: false, footerRule: false,
    showHeaderOnChapterStart: false, showFooterOnChapterStart: false,
    showHeaderOnChapterEnd: true, showFooterOnChapterEnd: true,
    hyphenate: true, widowOrphanControl: true,
    // Titelei römisch (i, ii, iii), Werk arabisch ab 1 — der klassische
    // Doppelzählstrang. Nur tragfähig zusammen mit pageCountMode='body'.
    pageCountMode: 'body', pageNumberStart: 1, pageNumberFirstVisible: 1,
    frontMatterNumbering: 'roman', frontMatterNumberFirstVisible: 1,
  },
  font: {
    body:        { family: 'EB Garamond', weight: 400, sizePt: 11.5, lineHeight: 1.5, paragraphGap: 0, firstLineIndentMm: 5.5, color: '#1c1a17', numerals: 'oldstyle' },
    // Überschriften im REGULÄREN Schnitt, nur grösser und zentriert — der
    // klassische Werksatz kennt keinen fetten Kapitelkopf. Die Rolle trägt
    // zugleich die Initiale (lib/pdf-render/dropcap.js setzt sie in 'heading'):
    // ein Fettschnitt stünde als Klotz im Text.
    heading:     { family: 'EB Garamond', weight: 400, sizes: { h1: 20, h2: 16, h3: 13.5, h4: 12.5, h5: 12, h6: 11.5 }, color: '#1c1a17' },
    title:       { family: 'EB Garamond', weight: 500, sizePt: 28, color: '#1c1a17' },
    subtitle:    { family: 'EB Garamond', weight: 400, sizePt: 15, color: '#3a3630' },
    byline:      { family: 'EB Garamond', weight: 400, sizePt: 12, color: '#3a3630' },
    dedication:  { family: 'EB Garamond', weight: 400, sizePt: 12,   color: '#1c1a17', italic: true },
    frontMatter: { family: 'EB Garamond', weight: 400, sizePt: 12,   color: '#1c1a17', italic: true },
    authorBio:   { family: 'EB Garamond', weight: 400, sizePt: 10.5, lineHeight: 1.45, paragraphGap: 0.3, color: '#1c1a17', italic: false },
    bibliography:{ family: 'EB Garamond', weight: 400, sizePt: 10,   lineHeight: 1.35, paragraphGap: 0.3, color: '#1c1a17', italic: false },
    footnote:    { family: 'EB Garamond', weight: 400, sizePt: 8.5,  lineHeight: 1.25, color: '#1c1a17', italic: false },
    imprint:     { family: 'EB Garamond', weight: 400, sizePt: 9,    color: '#3a3630', italic: false },
    year:        { family: 'EB Garamond', weight: 400, sizePt: 12,   color: '#3a3630', italic: false },
    toc:         { family: 'EB Garamond', weight: 400, sizePt: 11, lineHeight: 1.7, paragraphGap: 0.2, color: '#1c1a17' },
    tocTitle:    { family: 'EB Garamond', weight: 400, sizePt: 18, color: '#1c1a17' },
    header:      { family: 'EB Garamond', weight: 400, sizePt: 9,  color: '#4a463f' },
    footer:      { family: 'EB Garamond', weight: 400, sizePt: 10, color: '#3a3630' },
  },
  chapter: {
    // Jedes Kapitel auf der rechten Seite — die Geste, für die dieses Format da ist.
    breakBefore: 'right-page',
    breakBeforeSubchapter: true,
    firstChapterOnRecto: true,
    blankPageAfter: false,
    // Römisch und flach: I, II, III über die Kapitel; Unterebenen fallen im
    // Renderer ohnehin auf arabisch zurück.
    numbering: 'roman', numberingMode: 'flat',
    titleStyle: 'centered-large',
    dropCap: true,
    spaceBeforeMm: 55,
    pageStructure: 'nested',
    pageBreakBetweenPages: true,
    titleRule: false, pageTitleRule: false,
  },
  cover: { enabled: true, fit: 'cover' },
  toc: {
    enabled: true, depth: 1, includePages: false,
    showPageNumbers: true, titleAlign: 'center',
    // Ohne Punktlinie: im klassischen Werksatz steht die Zahl frei rechts.
    indentMm: 7, leader: 'none', pageNumReserveMm: 14, startOnRecto: true,
  },
  extras: { imprintPosition: 'front', imprintOnVerso: true, dedicationOnRecto: true, barcode: true },
  footnotes: { separator: true, separatorWidthMm: 35, gapMm: 2.5, hangMm: 5, maxHeightPct: 45 },
  print: { bleedMm: 0, cropMarks: false, blackTextKOnly: false, dpiWarnThreshold: 300, padToEvenPages: true },
  coverSpec: { paperBulkMmPer1000: 60 },
  pdfa: { standard: 'pdfa', conformance: 'B' },
};

// ── Vorlage 3: Sachbuch ─────────────────────────────────────────────────────
// 17 × 24 cm. Gliederung ist hier Lesehilfe: verschachtelte Nummerierung
// (1, 1.1, 1.1.1), jede Seite mit eigenem Titel und Verzeichnis-Eintrag,
// Kolumnentitel Werk (Verso) / Kapitel (Recto), Punktlinie im Verzeichnis.
// Noto Serif im Satz (robuste Ziffern, Fussnoten gut lesbar) gegen Lato in den
// Titeln. Satzbreite 128 mm ≈ 75 Zeichen bei 10.5 pt.
const SACHBUCH = {
  layout: {
    pageSize: 'custom', customWidthMm: 170, customHeightMm: 240,
    marginsMm: { top: 22, right: 20, bottom: 28, left: 22 },
    mirrorMargins: true,
    headerLeft: '', headerCenter: '', headerRight: '{chapter}',
    headerVersoLeft: '{title}', headerVersoCenter: '', headerVersoRight: '',
    footerLeft: '', footerCenter: '{page}', footerRight: '',
    headerRule: true, footerRule: false,
    showHeaderOnChapterStart: false, showFooterOnChapterStart: true,
    hyphenate: true, widowOrphanControl: true,
    pageCountMode: 'body', pageNumberStart: 1, pageNumberFirstVisible: 1,
    frontMatterNumbering: 'roman', frontMatterNumberFirstVisible: 1,
  },
  font: {
    body:        { family: 'Noto Serif', weight: 400, sizePt: 10.5, lineHeight: 1.45, paragraphGap: 0.4, firstLineIndentMm: 0, color: '#1a1a1a', numerals: 'lining' },
    heading:     { family: 'Lato', weight: 700, sizes: { h1: 22, h2: 17, h3: 14, h4: 12.5, h5: 11.5, h6: 11 }, color: '#14213d' },
    title:       { family: 'Lato', weight: 900, sizePt: 32, color: '#14213d' },
    subtitle:    { family: 'Lato', weight: 400, sizePt: 16, color: '#3a3a3a' },
    byline:      { family: 'Lato', weight: 700, sizePt: 12, color: '#3a3a3a' },
    dedication:  { family: 'Noto Serif', weight: 400, sizePt: 11, color: '#1a1a1a', italic: true },
    frontMatter: { family: 'Noto Serif', weight: 400, sizePt: 11, color: '#1a1a1a', italic: false },
    authorBio:   { family: 'Noto Serif', weight: 400, sizePt: 10, lineHeight: 1.4, paragraphGap: 0.3, color: '#1a1a1a', italic: false },
    bibliography:{ family: 'Noto Serif', weight: 400, sizePt: 9, lineHeight: 1.35, paragraphGap: 0.3, color: '#1a1a1a', italic: false },
    footnote:    { family: 'Noto Serif', weight: 400, sizePt: 8, lineHeight: 1.25, color: '#1a1a1a', italic: false },
    imprint:     { family: 'Noto Serif', weight: 400, sizePt: 8.5, color: '#3a3a3a', italic: false },
    year:        { family: 'Lato', weight: 400, sizePt: 12, color: '#3a3a3a', italic: false },
    toc:         { family: 'Noto Serif', weight: 400, sizePt: 10, lineHeight: 1.5, paragraphGap: 0.2, color: '#1a1a1a' },
    tocTitle:    { family: 'Lato', weight: 700, sizePt: 18, color: '#14213d' },
    header:      { family: 'Lato', weight: 400, sizePt: 8.5, color: '#555555' },
    footer:      { family: 'Lato', weight: 400, sizePt: 9, color: '#555555' },
  },
  chapter: {
    breakBefore: 'right-page', breakBeforeSubchapter: true, firstChapterOnRecto: true, blankPageAfter: false,
    numbering: 'arabic', numberingMode: 'nested',
    titleStyle: 'left-rule', dropCap: false, spaceBeforeMm: 40,
    pageStructure: 'nested', pageBreakBetweenPages: true,
    titleRule: true, pageTitleRule: false,
  },
  cover: { enabled: true, fit: 'cover' },
  toc: {
    enabled: true, depth: 3, includePages: true,
    showPageNumbers: true, titleAlign: 'left',
    indentMm: 6, leader: 'dots', pageNumReserveMm: 14, startOnRecto: true,
  },
  extras: { imprintPosition: 'front', imprintOnVerso: true, dedicationOnRecto: true, barcode: true },
  footnotes: { separator: true, separatorWidthMm: 40, gapMm: 2, hangMm: 5, maxHeightPct: 50 },
  print: { bleedMm: 0, cropMarks: false, blackTextKOnly: false, dpiWarnThreshold: 300, padToEvenPages: true },
  coverSpec: { paperBulkMmPer1000: 60 },
  pdfa: { standard: 'pdfa', conformance: 'B' },
};

// ── Vorlage 4: Lyrik ────────────────────────────────────────────────────────
// 13.5 × 21.5 cm. Jedes Gedicht ist eine Seite mit eigenem Titel, eigenem
// Umbruch und eigenem Verzeichnis-Eintrag. Silbentrennung AUS — ein Vers wird
// nicht getrennt. Absatzabstand statt Einzug trennt die Strophen. Cormorant
// Garamond, viel Weissraum, keine Kolumnentitel.
const LYRIK = {
  layout: {
    pageSize: 'custom', customWidthMm: 135, customHeightMm: 215,
    marginsMm: { top: 26, right: 22, bottom: 34, left: 24 },
    mirrorMargins: true,
    headerLeft: '', headerCenter: '', headerRight: '',
    footerLeft: '', footerCenter: '{page}', footerRight: '',
    headerRule: false, footerRule: false,
    showHeaderOnChapterStart: false, showFooterOnChapterStart: false,
    hyphenate: false, widowOrphanControl: true,
    pageCountMode: 'body', pageNumberStart: 1, pageNumberFirstVisible: 1,
    frontMatterNumbering: 'none',
  },
  font: {
    body:        { family: 'Cormorant Garamond', weight: 400, sizePt: 12, lineHeight: 1.5, paragraphGap: 0.8, firstLineIndentMm: 0, color: '#1c1a17', numerals: 'oldstyle' },
    heading:     { family: 'Cormorant Garamond', weight: 500, sizes: { h1: 22, h2: 18, h3: 15.5, h4: 14, h5: 13, h6: 12.5 }, color: '#1c1a17' },
    title:       { family: 'Cormorant Garamond', weight: 500, sizePt: 30, color: '#1c1a17' },
    subtitle:    { family: 'Cormorant Garamond', weight: 400, sizePt: 16, color: '#3a3630' },
    byline:      { family: 'Cormorant Garamond', weight: 400, sizePt: 13, color: '#3a3630' },
    dedication:  { family: 'Cormorant Garamond', weight: 400, sizePt: 13, color: '#1c1a17', italic: true },
    frontMatter: { family: 'Cormorant Garamond', weight: 400, sizePt: 13, color: '#1c1a17', italic: true },
    authorBio:   { family: 'Cormorant Garamond', weight: 400, sizePt: 11.5, lineHeight: 1.45, paragraphGap: 0.3, color: '#1c1a17', italic: false },
    bibliography:{ family: 'Cormorant Garamond', weight: 400, sizePt: 10.5, lineHeight: 1.35, paragraphGap: 0.3, color: '#1c1a17', italic: false },
    footnote:    { family: 'Cormorant Garamond', weight: 400, sizePt: 9, lineHeight: 1.25, color: '#1c1a17', italic: false },
    imprint:     { family: 'Cormorant Garamond', weight: 400, sizePt: 9.5, color: '#3a3630', italic: false },
    year:        { family: 'Cormorant Garamond', weight: 400, sizePt: 12, color: '#3a3630', italic: false },
    toc:         { family: 'Cormorant Garamond', weight: 400, sizePt: 11.5, lineHeight: 1.6, paragraphGap: 0.2, color: '#1c1a17' },
    tocTitle:    { family: 'Cormorant Garamond', weight: 500, sizePt: 18, color: '#1c1a17' },
    header:      { family: 'Cormorant Garamond', weight: 400, sizePt: 9.5, color: '#4a463f' },
    footer:      { family: 'Cormorant Garamond', weight: 400, sizePt: 10.5, color: '#3a3630' },
  },
  chapter: {
    // Kapitel = Zyklus: auf Recto, ohne Nummer, mit tiefem Anfang.
    breakBefore: 'right-page', breakBeforeSubchapter: true, firstChapterOnRecto: true, blankPageAfter: false,
    numbering: 'none', numberingMode: 'flat',
    titleStyle: 'centered-large', dropCap: false, spaceBeforeMm: 60,
    pageStructure: 'nested', pageBreakBetweenPages: true,
    titleRule: false, pageTitleRule: false,
  },
  cover: { enabled: true, fit: 'cover' },
  toc: {
    enabled: true, depth: 1, includePages: true,
    showPageNumbers: true, titleAlign: 'center',
    indentMm: 6, leader: 'none', pageNumReserveMm: 12, startOnRecto: true,
  },
  extras: { imprintPosition: 'front', imprintOnVerso: true, dedicationOnRecto: true, barcode: true },
  footnotes: { separator: true, separatorWidthMm: 25, gapMm: 2, hangMm: 4, maxHeightPct: 30 },
  print: { bleedMm: 0, cropMarks: false, blackTextKOnly: false, dpiWarnThreshold: 300, padToEvenPages: true },
  coverSpec: { paperBulkMmPer1000: 63.5 },
  pdfa: { standard: 'pdfa', conformance: 'B' },
};

// ── Vorlage 5: Manuskript A5 (Normseiten-artig) ─────────────────────────────
// 14.8 × 21 cm als Arbeitsausdruck fürs Lektorat, nicht für den Druck: Mono-
// Schrift (gleich breite Zeichen machen den Umfang abschätzbar wie bei der
// Normseite), anderthalbzeilig, breiter Korrekturrand links, keine Trennung,
// kein Spiegelsatz, keine Auffüllung auf gerade Seitenzahl. Kopfzeile trägt
// Werk und Kapitel, damit lose Blätter zuordenbar bleiben.
const MANUSKRIPT_A5 = {
  layout: {
    pageSize: 'custom', customWidthMm: 148, customHeightMm: 210,
    marginsMm: { top: 20, right: 15, bottom: 20, left: 28 },
    mirrorMargins: false,
    headerLeft: '{title}', headerCenter: '', headerRight: '{chapter}',
    footerLeft: '', footerCenter: '', footerRight: '{page}',
    headerRule: true, footerRule: false,
    showHeaderOnChapterStart: true, showFooterOnChapterStart: true,
    hyphenate: false, widowOrphanControl: false,
    pageCountMode: 'physical', pageNumberStart: 1, pageNumberFirstVisible: 1,
    frontMatterNumbering: 'none',
  },
  font: {
    body:        { family: 'JetBrains Mono', weight: 400, sizePt: 9.5, lineHeight: 1.5, paragraphGap: 0, firstLineIndentMm: 5, color: '#111111', numerals: 'auto' },
    heading:     { family: 'JetBrains Mono', weight: 700, sizes: { h1: 14, h2: 12.5, h3: 11.5, h4: 11, h5: 10.5, h6: 10 }, color: '#111111' },
    title:       { family: 'JetBrains Mono', weight: 700, sizePt: 20, color: '#111111' },
    subtitle:    { family: 'JetBrains Mono', weight: 400, sizePt: 12, color: '#333333' },
    byline:      { family: 'JetBrains Mono', weight: 400, sizePt: 11, color: '#333333' },
    dedication:  { family: 'JetBrains Mono', weight: 400, sizePt: 10, color: '#111111', italic: true },
    frontMatter: { family: 'JetBrains Mono', weight: 400, sizePt: 10, color: '#111111', italic: true },
    authorBio:   { family: 'JetBrains Mono', weight: 400, sizePt: 9.5, lineHeight: 1.5, paragraphGap: 0.3, color: '#111111', italic: false },
    bibliography:{ family: 'JetBrains Mono', weight: 400, sizePt: 8.5, lineHeight: 1.4, paragraphGap: 0.3, color: '#111111', italic: false },
    footnote:    { family: 'JetBrains Mono', weight: 400, sizePt: 7.5, lineHeight: 1.3, color: '#111111', italic: false },
    imprint:     { family: 'JetBrains Mono', weight: 400, sizePt: 8, color: '#333333', italic: false },
    year:        { family: 'JetBrains Mono', weight: 400, sizePt: 10, color: '#333333', italic: false },
    toc:         { family: 'JetBrains Mono', weight: 400, sizePt: 9.5, lineHeight: 1.5, paragraphGap: 0.2, color: '#111111' },
    tocTitle:    { family: 'JetBrains Mono', weight: 700, sizePt: 13, color: '#111111' },
    header:      { family: 'JetBrains Mono', weight: 400, sizePt: 7.5, color: '#666666' },
    footer:      { family: 'JetBrains Mono', weight: 400, sizePt: 8, color: '#666666' },
  },
  chapter: {
    breakBefore: 'always', breakBeforeSubchapter: true, firstChapterOnRecto: false, blankPageAfter: false,
    numbering: 'arabic', numberingMode: 'nested',
    titleStyle: 'minimal', dropCap: false, spaceBeforeMm: 20,
    pageStructure: 'nested', pageBreakBetweenPages: true,
    titleRule: false, pageTitleRule: false,
  },
  cover: { enabled: false, fit: 'cover' },
  toc: {
    enabled: true, depth: 2, includePages: true,
    showPageNumbers: true, titleAlign: 'left',
    indentMm: 5, leader: 'dots', pageNumReserveMm: 12, startOnRecto: false,
  },
  extras: { imprintPosition: 'back', imprintOnVerso: false, dedicationOnRecto: false, barcode: false },
  footnotes: { separator: true, separatorWidthMm: 30, gapMm: 2, hangMm: 4, maxHeightPct: 45 },
  print: { bleedMm: 0, cropMarks: false, blackTextKOnly: false, dpiWarnThreshold: 150, padToEvenPages: false },
  pdfa: { standard: 'none', conformance: 'B' },
};

// ── Vorlage 6: Roman-Taschenbuch 12 × 19 cm ─────────────────────────────────
// Das gängigste deutschsprachige Taschenbuchformat (BoD/epubli/tredition).
// Crimson Pro mit Einzug, Kolumnentitel kursiv (Verso Werk, Recto Kapitel),
// Kapitel ausgeschrieben («Eins», «Zwei»), jede Seite als Abschnitt mit Titel.
// Satzbreite 90 mm ≈ 60 Zeichen bei 10 pt.
const ROMAN_TB_12X19 = {
  layout: {
    pageSize: 'custom', customWidthMm: 120, customHeightMm: 190,
    marginsMm: { top: 15, right: 13, bottom: 18, left: 17 },
    mirrorMargins: true,
    headerLeft: '', headerCenter: '{chapter}', headerRight: '',
    headerVersoLeft: '', headerVersoCenter: '{title}', headerVersoRight: '',
    footerLeft: '', footerCenter: '{page}', footerRight: '',
    hfStyle: {
      header: {
        recto: { center: { italic: true } },
        verso: { center: { italic: true } },
      },
    },
    headerRule: false, footerRule: false,
    showHeaderOnChapterStart: false, showFooterOnChapterStart: false,
    hyphenate: true, widowOrphanControl: true,
    pageCountMode: 'body', pageNumberStart: 1, pageNumberFirstVisible: 1,
    frontMatterNumbering: 'none',
  },
  font: {
    body:        { family: 'Crimson Pro', weight: 400, sizePt: 10, lineHeight: 1.38, paragraphGap: 0, firstLineIndentMm: 4, color: '#1a1a1a', numerals: 'oldstyle' },
    heading:     { family: 'Crimson Pro', weight: 600, sizes: { h1: 18, h2: 15, h3: 13, h4: 12, h5: 11, h6: 10.5 }, color: '#1a1a1a' },
    title:       { family: 'Crimson Pro', weight: 600, sizePt: 26, color: '#1a1a1a' },
    subtitle:    { family: 'Crimson Pro', weight: 400, sizePt: 14, color: '#3a3a3a' },
    byline:      { family: 'Crimson Pro', weight: 400, sizePt: 11.5, color: '#3a3a3a' },
    dedication:  { family: 'Crimson Pro', weight: 400, sizePt: 11, color: '#1a1a1a', italic: true },
    frontMatter: { family: 'Crimson Pro', weight: 400, sizePt: 11, color: '#1a1a1a', italic: true },
    authorBio:   { family: 'Crimson Pro', weight: 400, sizePt: 9.5, lineHeight: 1.4, paragraphGap: 0.3, color: '#1a1a1a', italic: false },
    bibliography:{ family: 'Crimson Pro', weight: 400, sizePt: 9, lineHeight: 1.3, paragraphGap: 0.3, color: '#1a1a1a', italic: false },
    footnote:    { family: 'Crimson Pro', weight: 400, sizePt: 7.5, lineHeight: 1.2, color: '#333333', italic: false },
    imprint:     { family: 'Crimson Pro', weight: 400, sizePt: 8.5, color: '#333333', italic: false },
    year:        { family: 'Crimson Pro', weight: 400, sizePt: 11, color: '#3a3a3a', italic: false },
    toc:         { family: 'Crimson Pro', weight: 400, sizePt: 10, lineHeight: 1.5, paragraphGap: 0.2, color: '#1a1a1a' },
    tocTitle:    { family: 'Crimson Pro', weight: 600, sizePt: 15, color: '#1a1a1a' },
    header:      { family: 'Crimson Pro', weight: 400, sizePt: 8.5, color: '#555555' },
    footer:      { family: 'Crimson Pro', weight: 400, sizePt: 9, color: '#555555' },
  },
  chapter: {
    breakBefore: 'always', breakBeforeSubchapter: true, firstChapterOnRecto: true, blankPageAfter: false,
    numbering: 'word', numberingMode: 'flat',
    titleStyle: 'centered-large', dropCap: false, spaceBeforeMm: 38,
    pageStructure: 'nested', pageBreakBetweenPages: true,
    titleRule: false, pageTitleRule: false,
  },
  cover: { enabled: true, fit: 'cover' },
  toc: {
    enabled: true, depth: 1, includePages: false,
    showPageNumbers: true, titleAlign: 'center',
    indentMm: 5, leader: 'none', pageNumReserveMm: 12, startOnRecto: true,
  },
  extras: { imprintPosition: 'front', imprintOnVerso: true, dedicationOnRecto: true, barcode: true },
  footnotes: { separator: true, separatorWidthMm: 25, gapMm: 2, hangMm: 3.5, maxHeightPct: 35 },
  print: { bleedMm: 0, cropMarks: false, blackTextKOnly: false, dpiWarnThreshold: 300, padToEvenPages: true },
  coverSpec: { paperBulkMmPer1000: 63.5 },
  pdfa: { standard: 'pdfa', conformance: 'B' },
};

// `id` ist der stabile Schlüssel (Auswahl im UI), `nameKey` der vorgeschlagene
// Profilname, `descKey` der erklärende Satz darunter. Reihenfolge = Anzeige.
export const PDF_TEMPLATES = [
  {
    id: 'taschenbuch-modern',
    nameKey: 'pdfExport.template.taschenbuchModern.name',
    descKey: 'pdfExport.template.taschenbuchModern.desc',
    config: TASCHENBUCH_MODERN,
  },
  {
    id: 'roman-klassisch',
    nameKey: 'pdfExport.template.romanKlassisch.name',
    descKey: 'pdfExport.template.romanKlassisch.desc',
    config: ROMAN_KLASSISCH,
  },
  { id: 'sachbuch', nameKey: 'pdfExport.template.sachbuch.name', descKey: 'pdfExport.template.sachbuch.desc', config: SACHBUCH },
  { id: 'lyrik', nameKey: 'pdfExport.template.lyrik.name', descKey: 'pdfExport.template.lyrik.desc', config: LYRIK },
  { id: 'manuskript-a5', nameKey: 'pdfExport.template.manuskriptA5.name', descKey: 'pdfExport.template.manuskriptA5.desc', config: MANUSKRIPT_A5 },
  { id: 'roman-tb-12x19', nameKey: 'pdfExport.template.romanTb12x19.name', descKey: 'pdfExport.template.romanTb12x19.desc', config: ROMAN_TB_12X19 },
];

// Familien, bei denen der Trennstrich am Zeilenumbruch nicht gezeichnet wird
// (gemessen ueber lib/pdf-render gegen die ganze Whitelist; alle uebrigen
// Familien setzen ihn korrekt). Gegated in tests/unit/pdf-export-templates.test.mjs.
export const HYPHEN_BROKEN_FAMILIES = ['Source Serif 4', 'Source Sans 3'];

export function templateById(id) {
  return PDF_TEMPLATES.find(t => t.id === id) || null;
}

export function templateOptions(t) {
  return PDF_TEMPLATES.map(tpl => ({ value: tpl.id, label: t(tpl.nameKey) }));
}

export function templateDescription(id, t) {
  const tpl = templateById(id);
  return tpl ? t(tpl.descKey) : '';
}

export function templateName(id, t) {
  const tpl = templateById(id);
  return tpl ? t(tpl.nameKey) : '';
}

/** Teilkonfiguration der Vorlage als eigene Kopie (Aufrufer darf sie mutieren). */
export function templateConfig(id) {
  const tpl = templateById(id);
  return tpl ? structuredClone(tpl.config) : null;
}
