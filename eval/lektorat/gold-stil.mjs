// Stil-Gold-Set: misst, was der Stil-Pass bzw. die Stil-Spezialisten finden
// (`npm run eval:lektorat -- --set=stil`). Ergänzt gold.mjs, das nur objektive
// Fehler prüft.
//
// Anders als dort sind die Fälle bewusst LANG und mit vielen kleinen Schwächen
// durchsetzt (Füllwörter, schwache Verben, Passiv): die Frage ist, ob seltene
// Typen (Perspektivbruch, Tempuswechsel, Welt-Fakt, Soziolekt, Beleg) gegen die
// Mengen-Obergrenze und die Aufmerksamkeit eines breiten Passes bestehen.
//
// `mustCatch` nur für Stellen, die jeder professionelle Lektor anstreichen würde
// und die genau EINEM Typ klar zuzuordnen sind. `alt` = weitere Fundstellen
// desselben Mangels (z.B. die zweite Variante einer Begriffsinkonsistenz) — ein
// Treffer auf einer davon zählt. `cleanSpans` = gute Sätze, an denen ein Befund
// ein False-Positive ist (im Fachtext gezielt Nominalstil/Passiv, die dort
// erwünscht sind). Alle Strings verbatim aus `text`; der Runner prüft das.
//
// `kontext` geht 1:1 in die Prompt-Optionen (Erzählform, Figuren, Orte,
// Welt-Fakten, Soziolekte) — wie checkOnePage sie aus dem Buch lädt.

export const STIL_CASES = [
  {
    id: 'stil-roman-handwerk',
    kontext: { erzaehlperspektive: 'personaler Er-Erzähler (Lukas)', erzaehlzeit: 'Präteritum' },
    text: `Lukas stand am Fenster und wartete auf den Bus, der wie jeden Morgen zu spät kam. Draussen zog der Nebel in dünnen Fahnen über den Platz, und die Laternen brannten noch, obwohl es längst hell sein sollte. Er hatte schlecht geschlafen.

Mara kam aus der Küche, zwei Tassen in der Hand. Sie stellte eine davon auf das Fensterbrett, ohne ihn anzusehen. Insgeheim fand sie, dass er in letzter Zeit unerträglich geworden war, und sie fragte sich, wie lange sie das noch aushalten würde.

«Du bist spät dran», sagte sie.

Lukas nickte zustimmend mit dem Kopf. Er war sehr traurig. Er nahm die Tasse, trank einen Schluck und verbrannte sich die Zunge. Der Kaffee war bitter, und er mochte ihn trotzdem.

Dann griff er nach seiner Jacke. Er öffnet die Tür und tritt in den kalten Flur hinaus. Im Treppenhaus roch es nach Bohnerwachs und nach dem Kohl der Nachbarin. Unten, vor den Briefkästen, blieb er stehen und zog einen Umschlag aus seinem Fach. Sein Herz schlug ihm bis zum Hals.

Der Brief kam von der Versicherung. Er riss ihn mit dem Daumen auf und überflog die erste Zeile, dann die zweite, dann las er alles noch einmal von vorn.`,
    mustCatch: [
      { typ: 'perspektivbruch', needle: 'Insgeheim fand sie, dass er in letzter Zeit unerträglich geworden war' },
      { typ: 'pleonasmus',      needle: 'nickte zustimmend mit dem Kopf' },
      { typ: 'show_vs_tell',    needle: 'Er war sehr traurig.' },
      { typ: 'tempuswechsel',   needle: 'Er öffnet die Tür und tritt in den kalten Flur hinaus.' },
      { typ: 'klischee',        needle: 'Sein Herz schlug ihm bis zum Hals.' },
    ],
    cleanSpans: [
      'Draussen zog der Nebel in dünnen Fahnen über den Platz',
      'Im Treppenhaus roch es nach Bohnerwachs und nach dem Kohl der Nachbarin.',
      'Der Kaffee war bitter, und er mochte ihn trotzdem.',
    ],
  },

  {
    // Viele kleine Schwächen (eigentlich/irgendwie, «machte», Passiv) über den
    // ganzen Text; die seltenen Typen stehen spät. Prüft die Verdrängung.
    id: 'stil-roman-verdraengung',
    kontext: { erzaehlperspektive: 'Ich-Erzählerin (Elena)', erzaehlzeit: 'Präteritum' },
    text: `Es war eigentlich ein ganz normaler Dienstag, als ich irgendwie beschloss, endlich mal das Archiv aufzuräumen. Das Archiv war im Keller des neu renovierten Gemeindehauses. Ich machte das Licht an und machte die erste Kiste auf. In der Kiste waren Ordner. Die Ordner waren alt. Es wurde von mir festgestellt, dass viele davon feucht geworden waren.

Ich nahm mir eigentlich vor, systematisch vorzugehen, aber irgendwie gelang mir das nicht so richtig. Ich machte einen Stapel für die Akten, die bleiben sollten, und einen Stapel für die Akten, die weg sollten. Der Stapel für die Akten, die weg sollten, wurde schnell grösser. Ich machte eine Pause und machte mir einen Tee auf dem kleinen Kocher, der in der Ecke stand.

Gegen Mittag kam Herr Wyss herunter. Er war der Sigrist und hatte den Schlüssel zum Keller schon seit dreissig Jahren. Er sagte, ich solle vorsichtig sein, die Regale seien nicht mehr ganz stabil. Ich sagte, ich sei vorsichtig. Er sagte, das sagten alle. Dann ging er wieder.

Am Nachmittag fand ich dann eigentlich zufällig eine Schachtel, die ganz hinten unter einem Regal stand. Die Schachtel war mit Schnur zugebunden. Ich machte die Schnur auf. In der Schachtel waren Briefe, die irgendwie alle an dieselbe Frau gerichtet waren: Anna Brunner, Kirchgasse 4. Die Briefe wurden von mir einzeln herausgenommen und auf den Tisch gelegt. Es waren sicher fünfzig Stück.

Ich fing an zu lesen. Der erste Brief war aus dem Jahr 1951 und war eigentlich ziemlich kurz. Ein Mann schrieb, er werde bald zurückkommen, sie solle auf ihn warten. Der zweite Brief war länger. Der dritte noch länger. In jedem Brief stand irgendwie dasselbe: dass er zurückkommen werde, dass sie warten solle.

Herr Wyss stand wieder in der Tür, ohne dass ich ihn hatte kommen hören. Er wusste sofort, wem die Briefe gehört hatten, und dachte an den Sommer, in dem Anna Brunner verschwunden war, an den Regen und an das leere Haus an der Kirchgasse. Er sagte nichts.

Ich lege den Brief zurück in die Schachtel und schaue ihn an. Er räusperte sich und sagte, das sei lange her. Ich fragte, ob er sie gekannt habe. Er sagte, jeder habe sie gekannt. Dann drehte er sich um und ging die Treppe hinauf, langsamer als am Mittag.

Ich blieb noch eine Weile sitzen. Die Glühbirne über dem Tisch flackerte. Draussen schlug die Kirchturmuhr sechs, und ich merkte, dass ich vergessen hatte, etwas zu essen.`,
    mustCatch: [
      { typ: 'pleonasmus',      needle: 'neu renovierten' },
      { typ: 'passiv',          needle: 'Es wurde von mir festgestellt', alt: ['Die Briefe wurden von mir einzeln herausgenommen'] },
      { typ: 'perspektivbruch', needle: 'und dachte an den Sommer, in dem Anna Brunner verschwunden war' },
      { typ: 'tempuswechsel',   needle: 'Ich lege den Brief zurück in die Schachtel und schaue ihn an.' },
    ],
    cleanSpans: [
      'Die Glühbirne über dem Tisch flackerte.',
      'Er sagte, jeder habe sie gekannt.',
      'Draussen schlug die Kirchturmuhr sechs',
    ],
  },

  {
    // Abgleich gegen Stammdaten, dazwischen normale Prosa.
    id: 'stil-roman-konsistenz',
    kontext: {
      erzaehlperspektive: 'personale Er-/Sie-Erzählung (Lea)', erzaehlzeit: 'Präteritum',
      figuren: [
        { name: 'Lea', beschreibung: 'Lehrerin, Mitte dreissig' },
        { name: 'Bruno', beschreibung: 'Fischer, Mitte sechzig' },
      ],
      orte: [
        { name: 'Café Lindenhof', typ: 'Café', beschreibung: 'Kleines Café am Seeufer mit drei Tischen und blauen Fensterläden' },
      ],
      weltfakten: [
        { subjekt: 'Uhrturm von Seldwil', fakt: 'Der Uhrturm hat sieben Stockwerke.' },
        { subjekt: 'Fähre nach Rutenau', fakt: 'Die Fähre nach Rutenau fährt nur sonntags.' },
      ],
      soziolekte: [
        { subjekt: 'Bruno', fakt: 'Spricht knapp und derb, Gassenjargon, flucht oft; nie förmlich, siezt niemanden.' },
      ],
    },
    text: `Lea erreichte das Café Lindenhof kurz nach acht. Die roten Fensterläden waren noch geschlossen, aber drinnen brannte Licht, und durch die Scheibe sah sie Bruno an einem der Tische sitzen, die Mütze tief in der Stirn.

Sie setzte sich zu ihm. Er schob ihr wortlos die Zeitung hin. Auf der ersten Seite war ein Foto des Uhrturms, eingerüstet bis unter das Dach.

«Sie wollen ihn abreissen», sagte Lea.

«Verehrte Lea, gestatten Sie mir die Bemerkung, dass mich diese Entwicklung ausserordentlich betrübt», sagte Bruno.

Sie sah ihn an, aber er blickte nur auf den See hinaus. Am Steg lag die Fähre nach Rutenau, und der Fährmann rollte gerade die Taue auf; es war Mittwoch, und um neun würde sie ablegen, wie an jedem Werktag.

Als Kind war Lea oft auf den Turm gestiegen, alle neun Stockwerke, bis zu der kleinen Kammer mit dem Uhrwerk. Von dort oben hatte man den ganzen See gesehen, bis hinüber zu den Bergen.

«Gopferdeckel, die spinnen doch», murmelte Bruno schliesslich und faltete die Zeitung zusammen.`,
    mustCatch: [
      { typ: 'schauplatzmerkmal', needle: 'Die roten Fensterläden' },
      { typ: 'soziolekt',         needle: 'gestatten Sie mir die Bemerkung' },
      { typ: 'weltfakt',          needle: 'wie an jedem Werktag', alt: ['es war Mittwoch, und um neun würde sie ablegen'] },
      { typ: 'weltfakt',          needle: 'alle neun Stockwerke' },
    ],
    cleanSpans: [
      '«Gopferdeckel, die spinnen doch», murmelte Bruno schliesslich',
      'Von dort oben hatte man den ganzen See gesehen',
    ],
  },

  {
    id: 'stil-sachbuch',
    buchtyp: 'sachbuch',
    text: `In der heutigen schnelllebigen Welt ist es wichtig zu beachten, dass Gewohnheiten unser Leben prägen. Wer morgens als Erstes zum Telefon greift, trainiert sein Gehirn auf Ablenkung. Das ist keine Charakterschwäche, sondern ein erlerntes Muster.

Die Forschung zur Gewohnheitsbildung unterscheidet drei Elemente: einen Auslöser, eine Handlung und eine Belohnung. Fehlt eines davon, bricht die Schleife ab. Genau hier setzen die meisten Ratgeber an, und genau hier scheitern sie, weil sie nur die Handlung betrachten.

Es könnte unter Umständen möglicherweise sinnvoll sein, den Auslöser zu verändern, bevor man an der Handlung arbeitet. Wer das Telefon abends in die Küche legt, muss morgens aufstehen, um es zu holen. Diese kleine Hürde reicht oft.

Nutzer, die diese Methode ausprobieren, berichten von schnellen Erfolgen. Anwender mit langjährigen Gewohnheiten brauchen länger. Bei Usern, die zusätzlich unter Stress stehen, kann der Effekt ganz ausbleiben.

Letztendlich lässt sich festhalten, dass Veränderung keine Frage des Willens ist, sondern eine der Umgebung. Kopf und Alltag müssen dabei gemeinsam zusammenarbeiten.`,
    mustCatch: [
      { typ: 'ki_geruch',            needle: 'In der heutigen schnelllebigen Welt ist es wichtig zu beachten' },
      { typ: 'hedging',              needle: 'Es könnte unter Umständen möglicherweise sinnvoll sein' },
      { typ: 'begriffsinkonsistenz', needle: 'Anwender mit langjährigen Gewohnheiten', alt: ['Bei Usern'] },
      { typ: 'pleonasmus',           needle: 'gemeinsam zusammenarbeiten' },
    ],
    cleanSpans: [
      'Wer das Telefon abends in die Küche legt, muss morgens aufstehen, um es zu holen.',
      'Die Forschung zur Gewohnheitsbildung unterscheidet drei Elemente: einen Auslöser, eine Handlung und eine Belohnung.',
    ],
  },

  {
    // Nominalstil und Passiv sind hier erwünscht — die cleanSpans sind die Falle.
    id: 'stil-wissenschaft',
    buchtyp: 'wissenschaft',
    text: `Die vorliegende Arbeit untersucht den Einfluss der Raumtemperatur auf die Konzentrationsleistung von Lernenden in der Sekundarstufe. Zur Beantwortung der Forschungsfrage wurde eine Querschnittserhebung an vier Schulen durchgeführt (n = 312).

Es ist allgemein bekannt, dass Temperaturen über 26 Grad die kognitive Leistungsfähigkeit deutlich senken. Frühere Untersuchungen kamen zu vergleichbaren Ergebnissen (Wargocki & Wyon, 2007).

Wir haben die Messungen jeweils zu Beginn der zweiten Lektion vorgenommen. Die Autorin hat sich bewusst gegen eine Messung am Nachmittag entschieden, da die Ermüdung den Effekt überlagern würde. Ich gehe davon aus, dass dieser Entscheid die Vergleichbarkeit erhöht.

Die Ergebnisse deuten möglicherweise unter Umständen eventuell darauf hin, dass ein Zusammenhang bestehen könnte. Die Konzentrationsleistung wurde mit dem d2-R-Test erhoben; die Aufmerksamkeitsleistung lag in den wärmeren Räumen im Mittel um 8 Prozent tiefer.`,
    mustCatch: [
      { typ: 'unbelegt',             needle: 'Es ist allgemein bekannt, dass Temperaturen über 26 Grad die kognitive Leistungsfähigkeit deutlich senken.' },
      { typ: 'autorenform',          needle: 'Die Autorin hat sich bewusst', alt: ['Ich gehe davon aus', 'Wir haben die Messungen'] },
      { typ: 'hedging',              needle: 'möglicherweise unter Umständen eventuell' },
      { typ: 'begriffsinkonsistenz', needle: 'Aufmerksamkeitsleistung' },
    ],
    cleanSpans: [
      'Zur Beantwortung der Forschungsfrage wurde eine Querschnittserhebung an vier Schulen durchgeführt (n = 312).',
      'Frühere Untersuchungen kamen zu vergleichbaren Ergebnissen (Wargocki & Wyon, 2007).',
    ],
  },

  {
    id: 'stil-journalismus-nachricht',
    buchtyp: 'journalismus',
    textsorte: 'nachricht',
    text: `Der Gemeinderat von Uster hat am Dienstagabend den Kredit für das neue Hallenbad abgelehnt. Mit 19 zu 16 Stimmen folgte das Parlament dem Antrag der Finanzkommission.

Die skandalöse Entscheidung trifft vor allem die Schwimmvereine, die seit Jahren auf mehr Wasserfläche warten. Der Bau hätte 38 Millionen Franken gekostet.

Das bestehende Bad sei in einem schlechten Zustand und müsse spätestens 2029 schliessen, sagte Stadträtin Petra Keller (SP). Die Sanierung des alten Gebäudes würde nach ihren Angaben rund 12 Millionen Franken kosten.

Hinter den Kulissen hatte die Bauverwaltung das Projekt schon im Frühling aufgegeben. Die Umsetzung der Planungsarbeiten erfolgt nun im Rahmen einer Neubeurteilung durch die zuständigen Stellen.

Die Stadt will dem Parlament bis Ende Jahr eine neue Vorlage unterbreiten.`,
    mustCatch: [
      { typ: 'wertung',      needle: 'Die skandalöse Entscheidung' },
      { typ: 'zuschreibung', needle: 'Hinter den Kulissen hatte die Bauverwaltung das Projekt schon im Frühling aufgegeben.' },
      { typ: 'amtsdeutsch',  needle: 'Die Umsetzung der Planungsarbeiten erfolgt nun im Rahmen einer Neubeurteilung' },
    ],
    cleanSpans: [
      'Mit 19 zu 16 Stimmen folgte das Parlament dem Antrag der Finanzkommission.',
      'Das bestehende Bad sei in einem schlechten Zustand und müsse spätestens 2029 schliessen, sagte Stadträtin Petra Keller (SP).',
    ],
  },
];
