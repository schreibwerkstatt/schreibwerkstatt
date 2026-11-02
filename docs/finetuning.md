# Fine-Tuning auf den Exportdaten

Vom JSONL-Export der Fine-Tuning-Karte zu einem lokal laufenden Modell, das Stil, Welt und Figuren des Buchs internalisiert und als das Buch mit Leserinnen und Lesern spricht ([Leser-Modell](#leser-modell)). Für die eigene Arbeit am Buch ist der [Buch-Chat](chats.md) da, nicht ein trainiertes Modell.

**Pfad:** [Unsloth](https://github.com/unslothai/unsloth) + QLoRA mit Ministral-3-8B als Basis. Web-UI ([Unsloth Studio](https://studio.unsloth.ai)) oder CLI-Script ([train_book.py](unsloth-config/train_book.py)). Standardprofil: 16 GB VRAM.

## 1. Modell und Hardware

**Basemodell:** `unsloth/Ministral-3-8B-Instruct-2512-unsloth-bnb-4bit`. Mehrsprachig inkl. DE, 256 k Context, Apache 2.0, `[SYSTEM_PROMPT]`/`[INST]`-Template (Tekken), GGUF-Export für Ollama. Der Pixtral-Vision-Encoder bleibt beim Training eingefroren. Braucht `transformers` v5 ([requirements.txt](unsloth-config/requirements.txt)).

**Hardware:** 16 GB VRAM reichen für QLoRA mit seq_len 4096, Batch 1 × Accum 16 (bei OOM seq_len 2048); mit 20 GB Batch 2 × Accum 8. Andere GPU-Grössen und das Mistral-Small-3.2-24B-Profil: Tabelle in [§4](#4-hyperparameter-nach-ziel).

## 2. Daten exportieren

UI → Buch → Kachel **Fine-Tuning-Export**:

- `Profil` = Basismodell × GPU-Speicher (Default Ministral 3 8B, 16 GB) — setzt `Max. Token pro Sample` und `Max. Zeichen` und trägt die **Export-Vorgaben** ([Export-Vorgaben](#export-vorgaben)); daneben **studio-config.yaml herunterladen** ([§4](#4-hyperparameter-nach-ziel)).
- Typen aktiv: `Stil`, `Szene`, `Dialog`, `Buchwissen`. `Wörtlich` ist standardmässig aus (lange wörtliche Ziele belohnen Auswendiglernen; eingeschaltet höchstens 1 % der Antwort-Tokens), `Lektorats-Feedback` ebenfalls. Die Leser-Samples laufen immer mit.
- `Min. Zeichen = 200`, `Max. Zeichen` aus dem Profil.
- `Validation-Split = 0.05` (> 20 000 Samples), sonst `0.1`.
- `Max. Token pro Sample` aus dem Profil.
- `Vorgerendertes text-Feld` optional.
- `Max. Wiederholungen je Antwort = 2` ([Qualität des Sets](#qualität-des-sets)).
- `Typ-Balance` (Max. Anteil pro Aufgabentyp) steht auf `0`. Sie deckelt zusätzlich jeden Aufgabentyp der Tabelle «Qualität des Sets» gegen den **exportierten** Datensatz ([finalize.js](../routes/jobs/finetune-export/finalize.js)#`balanceCap`); mit weniger als `1/Anteil` Typen ist sie nicht erfüllbar und wird übersprungen.

**Geschnitten wird nur an Satz- oder Absatzgrenzen** ([lib/text.js](../routes/jobs/finetune-export/lib/text.js) `clipAtSentence`/`tailFromSentence`/`chunkAtSentence`). Eine Antwort, die mitten im Wort endet, brächte dem Modell bei, mitten im Wort aufzuhören. Abschnitte und Absätze über `Max. Zeichen` laufen deshalb in Satzgrenzen-Teilen durch („Schreibe Teil 2 von 3 dieses Abschnitts"), statt nach 4000 Zeichen abzubrechen — so fehlt auch der Rest langer Abschnitte nicht.

### Export-Vorgaben

Quelle: `EXPORT_DEFAULTS` in [finetune-profiles.js](../public/js/book/finetune-profiles.js), pro Profil über `export` überschreibbar. Die Karte schickt sie mit; der Server füllt Fehlendes aus derselben Datei ([lib/esm-bridge.js](../lib/esm-bridge.js)#`finetuneProfiles`) und begrenzt die Werte ([index.js](../routes/jobs/finetune-export/index.js)#`normalizeExportOptions`). Die verwendeten Werte stehen in `stats.exportOptions`.

| Vorgabe | Standard | Wirkung |
|---|---|---|
| `minMentions` | 3 | Figuren ab so vielen Erwähnungen im Text bekommen [Kernwissen](#kernwissen) |
| `factParaphrases` / `maxVariantsPerFact` | 8 / 10 | Varianten pro Faktenkarte |
| `corePerTier` | main 12, side 6, minor 3 | Varianten des Kurzporträts nach Bedeutung der Figur ([Kernwissen](#kernwissen)) |
| `coreFactRepeat` | 3 | Kernfakten der Hauptfiguren in 8 × so vielen Frage-Antwort-Paaren ([Kernfakten](#kernfakten-der-hauptfiguren)) |
| `familyTokenShares` | writing 0.25, facts 0.60, persona 0.15, refusal 0.05 | [Mischung nach Antwort-Tokens](#mischung-nach-antwort-tokens); der refusal-Wert gilt nicht, siehe `refusalShareBasis` |
| `maxPerFactAnswer` | 6 | [Antwort-Budget](#qualität-des-sets) der Faktenfamilie: dieselbe Faktenantwort mit anderer Frage so oft |
| `refusalShareBasis` / `refusalShare` / `refusalMix` | count / 0.055 / unknownEntity 0.45, offTopic 0.2, falsePremise 0.2, mixedRefusal 0.08, metaQuestion 0.07 | [Ablehnen](#ablehnen-lernen): Ziel nach **Anzahl** der Beispiele (5–6 %), nicht nach Tokens |
| `valRefusalMin` | unknownEntity/offTopic/falsePremise je 8, metaQuestion/mixedRefusal je 4 | Mindestzahl je Ablehnungs-Untertyp in `val-refusal.jsonl` |
| `verbatimMaxTokenShare` | 0.01 | Deckel für `Wörtlich` |
| `maxAnswerChars` | sceneWrite/povPassage/passage 2000, continue 1500 | Antwortlänge pro Typ, an Satzgrenzen gekürzt |
| `maxTargetsPerParagraph` | 2 | höchstens so viele Samples mit demselben Absatz als Ziel |
| `whoSaysMinWords` | 6 | «Wer sagt das?» nur für Zitate ab so vielen Wörtern |
| `editorFeedback` | aus | Lektorats-Feedback als eigener Typ |
| `aiParaphrase` | aus | Kernfakten-Varianten zusätzlich per KI |
| `aiWhyQuestions` | an | [Warum-Leserfragen](#warum-familie) per KI, ein Call je Warum-Karte |

**Lange Samples passen sich `Max. Token pro Sample` an.** Voll-Kapitel-, Wörtlich- und Mehrseiten-Samples werden in Slices von höchstens 60 % des Sequenz-Budgets geschnitten (4096 Tokens → rund 8000 Zeichen DE); der Rest bleibt dem Prompt. Ein fester, grösserer Slice würde genau die Samples aus dem Export filtern, die den Buchtext am vollständigsten tragen. `Lange Samples kappen` kürzt diese Slices nie — ein gekapptes „Teil 2 von 5" brächte dem Modell bei, mitten im Text aufzuhören —, sie fallen dann weg.

**Figurennamen werden als ganzes Wort gesucht, Unicode-fähig** ([lib/names.js](../routes/jobs/finetune-export/lib/names.js) `nameRegex`). JavaScripts `\b` kennt nur ASCII-Buchstaben; ein Name, der mit Umlaut oder Akzent beginnt oder endet (Ömer, René, Zoë), fände sonst nie einen Treffer, und seine Passagen, Ortsbezüge und Sprecher-Zuordnungen fielen still weg.

**Antworten im Buchton (KI-Augment, optional).** „Was ist Ort Y?", die Innenleben-Fragen und die Ich-Vorstellung einer Figur beantwortet das Buchwissen mit dem Text der Analyse. Ohne Umschreibung lernt das Modell für solche Fragen den Ton der Analyse, nicht den des Autors. Die Option **Figuren- und Ortsantworten im Buchton** fasst diese Antworten neu ([samples/ai-augment.js](../routes/jobs/finetune-export/samples/ai-augment.js)#`rewriteAnswersInBookVoice`). Als Stilvorlage dienen bis zu drei Originalabsätze, in denen die Figur bzw. der Ort vorkommt. Die Fakten bleiben gleich. Ersetzt wird die Antwort in den bestehenden Samples; es kommen keine neuen hinzu. Ein KI-Call pro Figur und Ort, gecacht wie die übrigen Augment-Calls. Leere oder ausufernde Antworten (mehr als dreimal so lang) behalten die Analyse-Antwort.

**Modell der KI-Teile:** Buchton, Ich-Form, Deutungen und KI-Varianten laufen über `ai.claude.model.finetune` (Admin → Einstellungen → Provider, Standard `claude-haiku-5-5`; [lib/ai-overrides.js](../routes/jobs/finetune-export/lib/ai-overrides.js)). Exporte sollen günstig bleiben, und jede KI-Antwort läuft durch Belegpflicht bzw. Fakten-Abgleich. Das Modell steht im Cache-Schlüssel der Augment-Calls: ein Wechsel rechnet die KI-Ergebnisse einmal neu, ein zweiter Export mit demselben Modell zahlt nur Neues.

**Dialog-Zitate** erkennt [lib/text.js](../routes/jobs/finetune-export/lib/text.js)#`extractDialogs` in allen fünf Schreibweisen: „…“, “…”, »…«, «…» und ASCII-`"…"`. Sie füttern den Dialog-Typ, „Wer sagt das?" und das Sprach-Portrait pro Figur im Buchwissen; ohne erkannte Zitate fallen alle drei still weg. Die Dialogzeile als Schreibaufgabe bekommt die Sätze davor als Vorlauf und braucht mindestens 25 Zeichen. „Wer sagt das?" nimmt nur Zitate ab 30 Zeichen und `whoSaysMinWords` Wörtern (Standard 6), die genau einmal im Buch stehen und einem Namen zugeordnet sind, den genau eine Figur trägt ([samples/dialog.js](../routes/jobs/finetune-export/samples/dialog.js)): «Ich weiss nicht.» ist ohne Kontext keiner Figur zuzuordnen, und ein geteilter Kurzname («Meier») keiner bestimmten. Die Antwort nennt die Situation: «Das sagt Fabio in der Szene «…» (Kapitel «…»).» — die Szene des Abschnitts, in der die Figur auftritt, wenn es genau eine ist. Ohne Szene bleibt «Das sagt Fabio im Kapitel «…».», höchstens acht je Figur. Jede Antwort steht je Figur höchstens zweimal, und das Antwort-Budget gilt auch hier: ein Name allein als Antwort wiederholte sich dutzendfach. Die Token-Mischung kürzt «Wer sagt das?» erst spät: die Antworten sind kurz und üben das Wiedererkennen der Stimmen.

**Satzgrenzen:** ein- und zweistellige Zahlen mit Punkt sind Ordnungszahlen («die 1. Klasse», «am 11. September»), kein Satzende; Jahreszahlen bleiben Satzenden ([lib/text.js](../routes/jobs/finetune-export/lib/text.js)#`isAbbreviationBefore`).

**Namen:** ein Figuren- oder Ortsname mit Unterstrichen (`cat_lady_40`) steht im Training in der Schreibweise des Buchs: wörtlich, wenn das Buch ihn so schreibt (Chat-Nicknames wie «das_unklare_abdomen»), sonst als Wortfolge ohne Zählnummer («Cat Lady»). Kennt das Buch den Namen nicht, fällt die Entität weg und steht im Job-Log ([data-loader.js](../routes/jobs/finetune-export/data-loader.js)#`cleanNames`). Reine Kennungen (`fig_129`) erscheinen nie als Name.

**Welt-Fakten (Buchwissen Block 29) sind KI-extrahiert, nicht kuratiert.** `world_facts` ist ein abgeleiteter Index der Komplettanalyse mit Full-Replace — es gibt keinen Edit-Pfad. Der Sampler ([samples/author-chat/world-facts.js](../routes/jobs/finetune-export/samples/author-chat/world-facts.js)) giesst EINEN Fakt in rund ein halbes Dutzend Samples (mehrere Frage-Paraphrasen + Sammelantwort pro Subjekt + pro Kategorie + globale Welt-Übersicht). Deshalb filtert er die Fakten heraus, die der **Weltfakten-Faktencheck** als real falsch belegt hat (SSoT [db/world-facts.js](../db/world-facts.js)#`refutedFactKeys`: Urteils-Cache `world_fact_verdicts`, abzüglich der vom Autor als „kein Fehler“ verworfenen; siehe [docs/komplett.md](komplett.md)): bei Trainingsdaten ist die Vervielfachung eines Fehlers teurer als das fehlende Sample. Lief der Faktencheck nie, wird nichts gefiltert. Der Abgleich läuft über den normalisierten Aussage-Schlüssel (`subjekt: fakt`, [lib/world-fact-key.js](../lib/world-fact-key.js)) — eine `fact_id` hinge an einem Index, den der nächste Lauf komplett ersetzt.

**Ereignisse (Buchwissen Block 6–11b)** werden einmal angereichert geladen ([samples/author-chat/event-data.js](../routes/jobs/finetune-export/samples/author-chat/event-data.js)) und von Szenen-, Ereignis- und Figuren-Block geteilt. Die Vollantwort eines Ereignisses trägt alles, was der Zeitstrahl kennt: Zeitpunkt oder Spanne, Tag der Handlung, Art und Untertyp, Handlungsstrang, beteiligte Figuren, Schauplätze, Szenen, Kapitel und Bedeutung. Abschnittsnamen fehlen bewusst: sie sind Gliederung der Werkstatt, nicht des Buchs, das Leser kennen. Die Listen werden nicht gekürzt.
- **Szeneninhalt kommt aus den Ereignissen.** `figure_scenes.kommentar` ist die Begründung der Wertung samt Verbesserungshinweis der Komplettanalyse, keine Inhaltsangabe; es fliesst in keine Antwort, keinen Prompt und keine Fundstellen-Suche. «Was passiert in Szene X?» antwortet mit den verknüpften Ereignissen, ohne Ereignis gibt es keine Inhaltsfrage. Dasselbe gilt für `chapter_reviews.zusammenfassung` (Gesamteindruck der Kapitelbewertung): nie als «Inhalt:» im Prompt.
- **Szene ↔ Ereignis** nur über denselben Abschnitt. Ein gemeinsames Kapitel verbände in Büchern mit wenigen grossen Kapiteln fast alles mit allem.
- **Schauplätze** eines Ereignisses sind nur Orte, deren Name im Ereignistext, in der Bedeutung oder in der Buchstelle steht. Die Szenen-Orte des Abschnitts zählen nicht: sie sind die Ortsliste des ganzen Abschnitts und hingen sonst an jedem Ereignis darin. Ein eigenes Ortsfeld hat das Ereignis nicht. In Fragen steht ein Ort als «am Schauplatz «X»» — ob «in Basel» oder «im Kantonsspital», weiss der Export nicht.
- **Buchstelle** ([event-links.js](../routes/jobs/finetune-export/samples/author-chat/event-links.js)): «Wie ist X im Buch erzählt?» antwortet mit dem Fenster im verknüpften Abschnitt, in dem beteiligte Figuren und Stichwörter am dichtesten stehen, wörtlich. «Erzähle X aus der Sicht von Y» gibt es nur mit dieser Passage als Ziel und nur für Figuren, die darin vorkommen; ebenso «Erzähle die Szene X aus der Sicht von Y» mit der Szenenpassage ([scenes.js](../routes/jobs/finetune-export/samples/author-chat/scenes.js)#`sceneExcerpt`). Ohne Passage fällt die Aufgabe weg — eine Faktenkarte als Antwort brächte dem Modell bei, eine Erzählbitte mit Stichpunkten zu beantworten.
- **Keine Kreuzprodukte:** keine Fragen Figur × Ort × Ereignis oder Facettenfragen, deren Antwort wieder die ganze Karte ist; jede Frage hat ihre eigene Antwort. Die Art des Ereignisses steht als Sprache («ein persönliches Ereignis (Geburt)»), nie als Enum-Wert.
- **Datum:** Vorrang hat die Original-Notation (`datum`), dann ein kurzes `datum_label`, dann die strukturierten Felder. Ein Label mit Auslassungszeichen oder über 60 Zeichen ist ein Textzitat der Analyse, kein Datum. «unbekannt (…)» gilt als kein Datum. Ein aus dem Kontext erschlossenes Jahr (`datum_unsicher`) steht ohne Zusatz im Text und ist als `unsure` markiert: Porträt, Kernfakten und Kapitelinhalt nennen nur sichere Daten.
- **Geburt und Tod gehören der Figur, die der Titel nennt** ([core-facts/words.js](../routes/jobs/finetune-export/samples/core-facts/words.js)#`isOwnLifeEvent`): an den Eltern hängt auch «Geburt von Stefan», an der Tochter «Tod von Sandras Vater». Geburtsjahr, «Wann wurde X geboren?» und die Prüfung des Generationenabstands lesen nur die eigene Geburt.
- **«Was für ein Ereignis ist …?» gibt es nicht** — die Frage stellt kein Leser. Für ein persönliches Ereignis einer Figur fragt das Kernwissen «Warum ist «…» für Samuel wichtig?» mit der Bedeutung als Antwort.
- Kurze Fakten (Kapitel, Strang, Tag) stehen als ganzer Satz, weil `pushQA` Antworten unter 20 Zeichen verwirft.

### Qualität des Sets

[finalize.js](../routes/jobs/finetune-export/finalize.js) räumt nach den Samplern auf, in dieser Reihenfolge:

1. **Schreibung, Notizen, Lint, Trivial-Antworten** ([lib/answer-lint.js](../routes/jobs/finetune-export/lib/answer-lint.js)):
   - Kennt der Buchtext kein «ß» (Schweizer Schreibung), wird es in allen Antworten ausser Buchtext-Zielen zu «ss».
   - Eine Lektoratsnotiz im Manuskript («… – Anspielung auf X, aber im Kontext …; besser: «…»») ist keine Prosa: jedes Sample, das sie in Frage oder Antwort trägt, fällt weg (`noteDropped`). Das Manuskript bleibt unverändert.
   - Lint für alle Antworten ausser Schreibaufgaben (`lintDropped`, Grund in `lintReasons`): Anfang mit Grossbuchstabe, Ziffer oder Anführungszeichen, nie mit einem Etikett (`^\w+:` — «vorgesetzter: …», «Mitglieder: …»), keine Doppelpunkt-Liste (`colonList`: «Renate ist: …», «Zur Familie von X gehören: …» — diese Form übernähme das Modell für «Was ist Renate für ein Mensch?»), kein Teilsatz aus vier Wörtern mehr als zweimal (`repetition`, Nährboden für Endlosschleifen), kein «ß» in Schweizer Schreibung. Die Sampler bauen solche Antworten nicht; der Lint ist das Netz dahinter.
   - Eine Antwort, deren Inhaltswörter alle schon in der Frage stehen («Wer ist an «Renate tritt … bei» beteiligt?» → «Renate …»), fällt weg (`trivialDropped`).
2. **Prompt-Dedup:** dieselbe Frage (alle Nutzer-Turns) steht nur einmal im Set (`promptDeduped`); zwei Antworten auf dieselbe Frage lehren Beliebigkeit. Geschütztes Kernwissen gewinnt.
3. **Keine Faktenkarte als Schreibziel.** Eine Schreibaufgabe, deren Antwort mindestens zwei Karten-Etiketten trägt («Zeitpunkt:», «Art:», «Beteiligte Figuren:» …), fliegt raus ([lib/tasks.js](../routes/jobs/finetune-export/lib/tasks.js)#`looksLikeCard`). Das ist das Schutznetz hinter den Samplern, die solche Paare gar nicht erst bauen.
4. **Keine Lektorats-Sprache als Inhalt** ([lib/critique.js](../routes/jobs/finetune-export/lib/critique.js), Zähler `critiqueDropped`): jede Antwort, die kein Buchtext ist, wird gegen die Kritik-Muster geprüft («würde … stärker», «reines Telling», «die Szene etabliert …», «Füllstoff», «thesenhaft», «Spannung erhöhen» …). Schreibaufgaben zielen auf echten Text, der «wirkt wie» legitim enthalten darf, und bleiben ungeprüft; `editorFeedback` ist ausdrücklich Kritik. Die Muster sind eng gefasst — sie urteilen über einen *Text*, nicht über eine Figur («Er wirkt wie ein Fremder» bleibt) — und über `critiquePatterns` ersetzbar.
5. **Antwortlänge pro Typ** (`maxAnswerChars`): länger wird an einer Satz- oder Absatzgrenze gekürzt (`lengthClipped`), «Teil N von M»-Stücke werden nicht gekappt, sondern verworfen. Die Sampler schneiden ihre Teile deshalb gleich in Deckelgrösse.
6. **Antwort-Budget** (`Max. Wiederholungen je Antwort`, Standard 2; Faktenfamilie `maxPerFactAnswer`, Standard 6): jede Assistant-Antwort steht höchstens so oft im Set, auch als Turn eines Gesprächs. Gilt für identische Antworttexte; Paraphrasen sind keine Dubletten. Bevorzugt bleiben Schreibaufgaben, dann Fragen zu einer Entität, dann verschiedene Aufgabentypen. Ausgenommen sind die [Kernfakten der Hauptfiguren](#kernfakten-der-hauptfiguren): dort trägt jede Antwort denselben Fakt mit anderer Frage, und das Modul deckelt ihre Wiederholung selbst (2 × `coreFactRepeat`).
7. **Absatz-Budget** (`maxTargetsPerParagraph`, [lib/paragraph-budget.js](../routes/jobs/finetune-export/lib/paragraph-budget.js)): ein Sample zielt auf einen Absatz, wenn eine seiner Antworten eine 12-Wort-Folge mit ihm teilt. Höchstens 2 Samples pro Absatz bleiben — Faktenantworten mit Buchzitat zuerst, dann die Schreibaufgaben reihum (das k-te Sample jedes Typs vor dem k+1-ten), Wörtlich zuletzt. Abschnitte ohne Leerzeilen zählen in Stücken von rund 800 Zeichen, sonst trüge ein ganzer Abschnitt nur zwei Samples. `paragraphTargetMax` misst das Ergebnis im Train.
8. **Mischung nach Antwort-Tokens** — siehe [unten](#mischung-nach-antwort-tokens).
9. **Train/Val nach Einheiten** ([lib/split.js](../routes/jobs/finetune-export/lib/split.js)): Buchtext trennt nach **Abschnitt**, Fakten nach **Einheit** (`unit`: Ereignis, Figur, Ort, Szene, Faktenkarte) mit allen Fragen und Varianten dazu. **Kernwissen (`core`) bleibt immer im Train** — Val hält nur die übrigen Fakten zurück. Welche Abschnitte ein Sample berührt, erkennt der Split am Text (8-Wort-Folgen aus Prompt und Antwort, kurze Zitate per Teilstring), nicht am Sampler — so gilt die Regel auch für Kontext im Prompt. Ein Sample über Abschnitte aus beiden Splits fällt weg. Sammellisten über mehrere Entitäten bleiben im Train. Val-Einheiten sind ein fester Anteil (`Validation-Split`), per Hash gereiht. Ablehnungen werden je Untertyp gezogen, mit Mindestzahl (`valRefusalMin`) und höchstens der Hälfte eines Untertyps — `val-refusal.jsonl` misst so jede Art von Ablehnung. Val-Samples, die trotzdem Text mit Train teilen (Refrain im Buch, gleiche Kurzantwort), werden entfernt, nie Train-Samples. Danach prüft der Export: Val-Prompt wörtlich im Train, Val-Antwort wörtlich im Train, gemeinsame 12-Wort-Folge. Bleibt etwas, bricht er mit `finetune.error.splitLeak` ab — ein geschönter Eval-Loss ist schlimmer als kein Export.

**Val je Familie:** neben `val.jsonl` gibt es `val-facts.jsonl` (Faktenwissen — die empfohlene Eval-Datei in Studio), `val-writing.jsonl`, `val-persona.jsonl` (Leser-Gespräch, Deutungen «Warum …?», Ich-Form), `val-refusal.jsonl` und `val-editor.jsonl` (nur mit `editorFeedback`). Jeder Aufgabentyp hat genau eine Familie ([lib/tasks.js](../routes/jobs/finetune-export/lib/tasks.js)#`familyOf`), zusammen ergeben die Dateien genau `val.jsonl` — sonst bricht der Export mit `finetune.error.valFamilies` ab. Die Überlappung steht je Datei in `quality.overlapByVal`.

### Beziehungsprüfung

Bevor ein Sampler läuft, prüft [lib/relation-check.js](../routes/jobs/finetune-export/lib/relation-check.js) die Figurenbeziehungen als Netz. Ein falscher Verwandtschaftsfakt, in vielen Varianten gelernt, ist das Teuerste, was das Set enthalten kann. Regeln (`rule`):

| Regel | Widerspruch |
|---|---|
| `maxParents` | mehr als ein Vater oder eine Mutter (ohne Geschlecht: mehr als zwei Eltern); die Ehe-Beziehungen der Mutter zu den konkurrierenden Vätern gehören dazu |
| `parentIsKin` | ein Elternteil ist zugleich Geschwister oder Partner |
| `spouseAsymmetric` / `pairConflict` | ein Paar ist Ehepartner und etwas anderes bzw. trägt zwei spezifische Typen |
| `familyAndFriend` | Familie und zugleich Freund/Bekannter |
| `siblingsNoParent` | Geschwister ohne gemeinsames Elternteil, obwohl bei beiden Eltern erfasst sind |
| `generationGap` | Elternteil laut eigener Geburt keine 14 Jahre älter |
| `duplicateDescription` | dieselbe Beschreibung auf zwei Beziehungen gleichen Typs mit einer gemeinsamen Figur (kopiert) |
| `textContradiction` | Beziehungsbeschreibung, Ereignis oder Biografie nennt ein Verwandtschaftswort, das zum Graphen nicht passt («Schwager», wo die Daten «Schwiegervater» ergeben; «vom grossen Bruder», wo sie «Sohn» sagen) |
| `genderMismatch` | die Beschreibung nennt die Rolle des Ziels mit einem anderen Geschlecht als die Zielfigur («Der Vater …» auf der Elternteil-Kante zu einer Frau); ein Wort direkt bei einer dritten Figur («Manfreds Vater») zählt nicht |
| `foreignName` | die Beschreibung nennt statt des Ziels eine andere Figur (ganzer Name oder Kurzname), zu der die Ausgangsfigur dieselbe Beziehung hat («… Peter sich fügt» auf der Ehe-Kante zu Adrian, neben einer Ehe-Kante zu Peter) |

Die Verwandtschaft über Ehe (Schwiegereltern, Schwager, Grosseltern, Onkel, Neffe) leitet die Prüfung aus dem Graphen ab. Verwandtschaftswörter in Ereignissen zählen nur mit Verweis auf eine andere Person («vom grossen Bruder», nicht «wird Mutter»), in Biografien nur direkt bei einem Namen («Stefans Bruder»). Ein Wort mit Geschlecht belastet nur genannte Figuren, deren Geschlecht passt: «zwischen den Brüdern» trifft nicht die Ehefrau, die im selben Ereignis steht.

**Feiner sperren.** `maxParents` und `duplicateDescription` nennen Alternativen — einer von zwei Vätern ist falsch, eine von zwei Kanten trägt die kopierte Beschreibung. Belegt eine Regel, die ein bestimmtes Paar belastet (alle übrigen), genau einen Teil davon, fällt nur dieser Teil aus; die anderen Paare stehen im Konflikt unter `kept` und bleiben im Set. Ohne solchen Beleg bleiben alle gesperrt. Gemeldet wird der Konflikt in beiden Fällen. **Why:** «Der Amoklauf» (2026-11) hatte Adrian (Bruder) als zweiten Vater Stefans; das ganze Paar-Bündel zu sperren nahm dem Set auch Peter als Vater und seine Ehe mit Gisela — Kernfakten der Hauptfamilie, die nichts falsch hatten. Jeder Konflikt nennt Figuren, Regel, Quellen (`relation:<id>`, `event:<id>`, `bio:<fig_id>.<feld>`) und einen Ausschnitt (`stats.relationConflicts`). **Korrigiert wird nichts**, der Autor entscheidet. Bis zur Klärung fallen die betroffenen Paare aus allen Fakten-Aufgaben: Kernwissen, Beziehungslisten, Falschannahmen, Porträts und Eval (`conflictDropped`). Lieber eine Lücke als ein gelernter Widerspruch.

Die Karte zeigt die Liste vor dem Export (`GET /jobs/finetune-export/relation-check`), mit Verweis auf jede Figur. Betrifft ein Konflikt eine Hauptfigur, startet der Export nur nach ausdrücklicher Bestätigung (`allow_relation_conflicts`); sonst hält der Job an und liefert die Liste (`blocked: 'relationConflicts'`). Bei Neben- und Randfiguren bleibt es bei der Warnung.

### Kernwissen

[samples/core-facts/](../routes/jobs/finetune-export/samples/core-facts/) baut Grundfakten als eigene Aufgaben — ein 8B-LoRA lernt einen Fakt erst nach mehreren *verschieden formulierten* Begegnungen; beiläufig in Prosa genügt nicht.

- **Faktenkarten** ([variants.js](../routes/jobs/finetune-export/samples/core-facts/variants.js)): ein Fakt = eine Karte mit stabiler ID (`fig:<id>:core`, `fig:<id>:beruf`, `rel:<a>|<b>`, `evt:<i>:when`, `chap:<Kapitel>`) und Feldern. So lassen sich die Karten später einzeln als Dokumente exportieren (Retrieval). Jede Karte erscheint in `factParaphrases` Varianten: Frage-Vorlagen × Antwort-Vorlagen, deterministisch per Seed, verschiedene Fragen **und** verschiedene Antworten. Alle Varianten tragen `factId` und dieselbe Einheit.
- **Bedeutung einer Figur** (`tier`: main / side / minor) kommt aus `figures.typ` — Figurenanalyse bzw. Figurenwerkstatt, nicht die Erwähnungszahl: `hauptfigur` → main, `nebenfigur`/`mentor`/`antagonist` → side, sonst minor. Eine oft genannte Figur mit Typ `randfigur` bleibt minor.
- **`figureCore`** («Wer ist X?», «Erzähl mir kurz von X.», «Was ist X für ein Mensch?», «X – wer ist das?» … — 13 Vorlagen, direkte wie umgangssprachliche) für Figuren ab `minMentions` Erwähnungen, `corePerTier` Varianten (Hauptfiguren 8, Nebenfiguren 4, Randfiguren 1). Dieselben Vorlagen fragen beim [Ablehnen](#ablehnen-lernen) nach erfundenen Namen. 2–4 ganze Sätze aus festen Bausteinen in dieser Reihenfolge: Rolle im Buch mit Hauptkapitel → die ein, zwei engsten Beziehungen (Partner, Eltern, Kinder, Geschwister, Freunde) → Beruf oder Ort → der wichtigste persönliche Wendepunkt. Wendepunkt heisst: Ereignis mit Art `persoenlich`, nie Weltgeschehen (`extern`, Untertyp `extern_*`) und nie die Geburt; das Datenmodell kennt kein Gewicht, gewählt wird nach Untertyp (Wendepunkt vor Verlust, Trennung, Hochzeit … vor Sonstigem), dann mit Bedeutung, dann das erste im Zeitstrahl. Keine «X erlebt: …»-Konstruktion. Die Varianten kombinieren die Formulierungen der Bausteine und sind alle verschieden, die Hälfte setzt die Beschreibung an die Stelle von Beruf/Ort. **`figureAttr`**: Beruf, Geburtsjahr, Familie, Schicht einzeln, die Familie als Sätze («Rudolfs Ehefrau ist Johanna.»), nie als Liste. Die Eigenschaften einer Figur (Buchwissen, `figTraits`) stehen als Satz mit höchstens drei tragenden Eigenschaften — zuerst die, die Beschreibung, Motivation, Konflikt oder Entwicklung aufgreifen —, ohne Dubletten und mit dem Satz der Analyse als Beleg, wo einer sie trägt.
- **Namen** ([naming.js](../routes/jobs/finetune-export/samples/core-facts/naming.js)): im Text steht der Name ohne Klammerzusatz («Herr Koch (Primarlehrer)» → «Herr Koch») und dekliniert («über Herrn Koch», «zu Herrn Koch»). **Rollenfiguren** ohne Eigennamen («Fahrer des Mercedes», «Alfreds Vater», «Barfrau im Bolero», Nutzernamen wie «madame_phantasma») bekommen kein `relationCore`, kein `figureAttr`, keine falsche Annahme und keine Beziehungs-/Schichtfrage im Buchwissen; im Kurzporträt stehen sie mit Artikel und Fall («Erzähl mir kurz vom Fahrer des Mercedes.»). In Prosa und Szenen kommen sie vor. Eine Figur, deren Nennform oder Kurzname eine andere Figur teilt (dreimal «Herr Koch»), bekommt gar kein Kernwissen: «Wer ist Herr Koch?» hätte drei widersprüchliche Antworten. `figures.beruf` ist Freitext der Analyse; als Beruf gilt sein Kopf («Polymechaniker, zuerst im Stahlwerk …» → «Polymechaniker», `berufHead`), ohne Klammer, «von» oder Verwandtschaft («Familienmitglied (Onkel)» zählt nicht). Der Rest des Feldes ist Werdegang und steht als eigene Antwortvariante. Ein vorangestelltes Adjektiv steht im Satz klein («als reformierter Pfarrer»). Platzhalter-Figuren («… (unnamed)») bekommen kein Kernwissen.
- **`relationCore`** ([relations.js](../routes/jobs/finetune-export/samples/core-facts/relations.js)) **in beiden Richtungen**, Rolle ausgeschrieben und nach Geschlecht gebeugt, als natürlicher Satz: «Wie steht Stefan zu Gisela?» → «Gisela ist Stefans Mutter.», «Wer ist Stefan für Peter?» → «Stefan ist Peters Sohn.» — nie «Für Peter ist Stefan ein Sohn.». Eine Beschreibung der Beziehung steht als zweiter Satz dahinter, in beiden Richtungen. Eine blosse Bekanntschaft (`bekannt`) ohne Beschreibung ist kein Fakt und entfällt. `figure_relations.typ` ist die Rolle von «zu» gegenüber «von»; `normalizeRelationTyp` + `canonicalRelation` ([beziehung-typen.js](../public/js/book/beziehung-typen.js)) legen Altbestand und beide Perspektiven derselben Aussage zusammen. **Widersprüchliche Paare fallen weg** — die [Beziehungsprüfung](#beziehungsprüfung) vorab, und als Netz dahinter zwei verschiedene spezifische Typen oder eine Beschreibung mit einer anderen Verwandtschaft als der Typ (`relationResidual`). Eine schwache Rolle (`bekannt`) steht nur mit ihrem Kontextsatz, nie als «Dennis ist Melindas Bekannter; Melinda ist seine Bekannte.». Vermutungen der Analyse («wahrscheinlich sein Sohn») zählen nicht als Beschreibung. «die Mutter von X» nur für Rollen, die man einmal hat (Eltern, Ehe), sonst «eine Kollegin von X».
- **`eventCore`** ([events.js](../routes/jobs/finetune-export/samples/core-facts/events.js)): wann, wer, wo (nur zugeordnete Orte), warum wichtig. «Wer ist dabei?» nur, wenn mehr Figuren beteiligt sind, als der Titel nennt — die Antwort nennt die übrigen («Neben Renate sind Stefan und Gisela dabei.»). Ereignisse heissen in Fragen nie «Was weisst du über …?» (das gilt Figuren, Orten, Organisationen), sondern «Was passiert bei «…»?», «Erzähl mir von «…».». Beginnt ein Titel mit «Wort:» («Millenniumsnacht: …»), steht er am Antwortanfang in «…». «Was folgt daraus» gibt es nicht — das Datenmodell kennt keine Kausalbeziehung zwischen Ereignissen. **`chapterCore`**: pro Kapitel drei Zusammenfassungen aus den Ereignissen des Kapitels, je mit eigenen Fragen (mindestens acht) und vier Antwortfassungen — kurz (1–2 Sätze: tragende Figuren und das Schlüsselereignis), mittel (die 5–8 wichtigsten Ereignisse chronologisch als Fliesstext mit Jahreszahlen, «Das Kapitel beginnt 1984 mit «…». 1985 folgt «…». … Am Ende steht …») und je tragender Figur («Worum geht es für Stefan im Kapitel «Der Vater»?»). Keine «Zuerst: … Dann: …»-Ketten, keine Verbindung mehr als zweimal: sie luden zur Endlosschleife ein. Ein Ereignis zählt nur für das Kapitel, in dem seine verknüpften Abschnitte liegen (ohne Abschnitt nur bei genau einer Kapitel-Zuordnung); weicht die Zuordnung ab, steht das in `chapterMismatches`. Dazu die Kapitelliste in Buchreihenfolge («Welche Kapitel hat das Buch?», erstes, letztes Kapitel). Ohne Ereignis keine Zusammenfassung.
- **Kernfakten bleiben im Train** (`core: true` für Figuren ab `minMentions`, ihre Beziehungen und die Kapitelkarten). Die Token-Mischung kürzt nie das Kernwissen der Hauptfiguren, nie die Kapitelkarten und nie die erste Variante einer Kernkarte (je Fragerichtung), siehe [Mischung](#mischung-nach-antwort-tokens). `coreFactCoverage` misst den Anteil dieser Figuren, deren `figureCore` und alle Kernbeziehungen in beiden Richtungen im Train stehen.
- **KI-Fragevarianten** (`aiParaphrase`, Standard aus — für Warum-Karten gibt es eigene Leserfragen, siehe [Warum-Familie](#warum-familie), [ai-paraphrase.js](../routes/jobs/finetune-export/samples/core-facts/ai-paraphrase.js)): die erste **Frage** jeder Karte und Richtung wird per KI umformuliert, die Antworten bleiben die der Vorlage — eine umformulierte Antwort könnte einen neuen, falschen Fakt enthalten. Eine Frage zählt nur, wenn sie alle Namen der Vorlage trägt und keinen anderen; danach laufen die neuen Fragen durch Prompt-Dedup und Overlap-Prüfung wie alle. Gezählt in `aiAugmentCount`, gecacht wie die übrigen Augment-Calls.

### Warum-Familie

[core-facts/why.js](../routes/jobs/finetune-export/samples/core-facts/why.js) beantwortet «Warum vergewaltigt Stefan Renate am Chilbi-Abend?», «Was steckt hinter «…»?», «Was sind Stefans Beweggründe bei «…»?» — ohne Nachschlagen muss das Modell Beweggründe genauso gelernt haben wie Fakten. Die Antwort setzt sich nur aus Daten der Analyse zusammen, nichts wird erfunden:

- die **Bedeutung** des Ereignisses, ein führendes «Er»/«Sie» durch den Namen ersetzt;
- die ein, zwei Sätze aus **Motivation und Konflikt** der handelnden Figur, die am meisten mit dem Ereignis zu tun haben (Stichwörter aus Titel und Bedeutung, Namen der übrigen Beteiligten); passt nur einer, füllt der erste Satz der Motivation auf;
- die **Vorgeschichte**: die letzten zwei persönlichen Ereignisse derselben Figur davor im Zeitstrahl — ohne Weltgeschehen und ohne Geburt/Tod.

Handelnd ist die Figur, deren Name den Ereignistitel eröffnet; aus «Stefan vergewaltigt Renate …» wird die Verbfrage «Warum vergewaltigt Stefan Renate …?» (nicht bei Zustand — «ist Mitglied», «wird geboren» — oder Konjunktion — «Fabio und Sarah …»). **Jede weitere beteiligte Figur** bekommt eine Karte aus ihrer Sicht («Wie erlebt Renate «…»?», «Was bedeutet «…» für Renate?», `evt:<i>:motive:<fig>`), aber nur, wenn ein Satz ihrer Motivation oder ihres Konflikts nachweislich zum Ereignis passt; eine Bedeutung, die mit «Er»/«Sie» beginnt, meint die handelnde Figur und fehlt dort. Die Ereignisfragen («Wie kam es zu «…»?») trägt die Karte der handelnden Figur, sonst die der Figur, die der Titel nennt, sonst die der einzigen Beteiligten. Höchstens drei Figuren je Ereignis. Keine Warum-Karte ohne Bedeutung, für Weltgeschehen, Geburt, Tod und Rollenfiguren — «Warum ist «E» wichtig?» beantwortet die Bedeutungskarte (`eventCore`). Typ `eventWhy`, vier Antwortfassungen je Karte; Kernwissen, wenn die Figur eine Hauptfigur ist. «Der Amoklauf» (2026-11, 190 Ereignisse): 149 Karten, rund 1200 Beispiele.

**Warum-Leserfragen per KI** (`aiWhyQuestions`, Standard an, [ai-paraphrase.js](../routes/jobs/finetune-export/samples/core-facts/ai-paraphrase.js)#`buildAiWhyQuestions`): Die Vorlagen nennen das Ereignis mit seinem Titel in «…» und im Präsens; Leser fragen «Warum hat Stefan Renate vergewaltigt?». Je Warum-Karte formuliert die KI bis zu sechs Fragen so, wie Leser fragen — Perfekt und Präsens, umgangssprachlich, das Ereignis mit eigenen Worten. Das deckt auch Ereignisse ab, deren Titel kein Satz mit Handelndem ist («Standesamtliche Hochzeit von …»). Die Antworten bleiben die geprüften der Karte. Eine Frage zählt nur, wenn sie jeden Namen aus Ereignis und Figur trägt, keinen anderen und keinen zitierten Titel; danach laufen die Fragen durch Prompt-Dedup und Overlap-Prüfung wie alle. Ein Call je Karte über `ai.claude.model.finetune`, gecacht (`why-questions`); das Job-Log nennt übernommene und verworfene Fragen.

### Zeitstrahl rückwärts

[core-facts/timeline.js](../routes/jobs/finetune-export/samples/core-facts/timeline.js) stellt dieselben Ereignisse aus der anderen Richtung (Typ `eventTimeline`): ein LoRA, das «Ereignis → Jahr» gelernt hat, beantwortet «Jahr → Ereignis» meist nicht.

- **Jahr → Ereignisse**: «Was passiert 1994 in der Geschichte?»
- **Figur + Jahr → Ereignisse**: «Was erlebt Renate 1992?»
- **Gemeinsame Ereignisse** zweier Figuren (ab zwei, die 60 Paare mit den meisten): «Was erleben Stefan und Renate gemeinsam?», beide Namensreihenfolgen
- **Reihenfolge** zweier Ereignisse derselben Figur mit verschiedenen Jahren (vier je Figur): «Was passiert zuerst: «A» oder «B»?»

Nur sichere Jahre (`datum_unsicher` aus), nur benannte Figuren; was eine Figur «erlebt» und was zwei Figuren gemeinsam erleben, sind ihre persönlichen Ereignisse — Weltgeschehen steht nur unter «Was passiert im Jahr …?». Listen chronologisch und höchstens sechs Einträge. «Unmittelbar davor/danach» und die Ereigniskette stehen schon im Buchwissen (author-chat/events.js).

### Kernfakten der Hauptfiguren

[core-facts/core-set.js](../routes/jobs/finetune-export/samples/core-facts/core-set.js) definiert für jede Hauptfigur ein explizites Set von Kernfakten: Eltern, Geschwister, Partner, Kinder (ohne Konflikt-Paare), Beruf und Werdegang, das eigene Geburtsjahr, die bis zu fünf wichtigsten persönlichen Wendepunkte **mit sicherem Jahr** (zwei am selben Datum: der wichtigere), das Kapitel, in dem die Figur im Zentrum steht (häufigste Auftritte), und ihr Antrieb in einem Satz (`figures.motivation`). Jeder Kernfakt erscheint in vielen verschiedenen Frage-Antwort-Paaren:

- direkt («Wer ist Stefans Ehefrau?»), umgekehrt («Wessen Ehefrau ist Renate?»), eingebettet («Erzähl mir von Stefans Familie.»),
- als Ja/Nein-Frage («Ist Renate Stefans Ehefrau?» → «Ja, Renate ist Stefans Ehefrau.»),
- als Leserfrage in Alltagssprache («Ist Stefan verheiratet?», «Hat Stefan Kinder?»),
- im Mehrturn-Gespräch (Porträt, dann «Und wer ist seine Ehefrau?»),
- im Porträt und in der Falschannahme (zählen über `factIds` mit).

Die Antworten variieren in der Formulierung, nennen den Fakt aber immer gleich: gleiche Namen, gleiche Verwandtschaftswörter. Ziel je Fakt: 8 × `coreFactRepeat` Paare, begrenzt durch die Zahl verschiedener Fragen. Die Samples (`coreFact`) sind Kernwissen der Hauptfiguren: nie gekürzt, immer im Train, vom Antwort-Budget ausgenommen. **`coreFactVariants`** misst je Hauptfigur Zahl der Fakten und Varianten (min/median, dazu die drei schwächsten); Abnahme: min ≥ 6, Median ≥ 8.

Die alten Einzelfragen «Wer ist X?» mit der Analyse-Beschreibung als Antwort und «Wie steht A zu B?» nur in Speicherrichtung gibt es nicht mehr; Sammellisten (Familien, Rollen, Cast) bleiben im Buchwissen.

### Ablehnen lernen

[samples/reader/refusals.js](../routes/jobs/finetune-export/samples/reader/refusals.js), Familie `refusal`:

- **`unknownEntity`**: erfundene Figuren, Orte und Ereignisse → «… kommt in meiner Geschichte nicht vor», in mehreren Formulierungen. **Kontrastpaare:** erfundene Figuren werden in genau den 13 Porträt-Vorlagen des Kernwissens gefragt — im Vorrat bis 0.6 je echte Porträt-Frage, ähnliche und häufige Namen zuerst — und in den Beziehungsvorlagen; das Modell soll am Namen entscheiden, nicht an der Frageform. `refusalPortraitRatio` misst Ablehnungen in Porträt-Form je echte Porträt-Frage (Ziel 0.3–0.5). Ein erfundener Name, von dem auch nur ein Wort im Buch steht, wird nicht verwendet, sonst lernte das Modell, eine echte Figur zu leugnen. Namen, die einer echten Figur ähneln — echter Vorname + erfundener Nachname, erfundener Vorname + echter Nachname —, antworten mit dem Hinweis auf die echte Figur («Meinst du vielleicht Stefan?»); dazu häufige Schweizer Namen, die im Buch nicht vorkommen. Die Namen des Eval-Sets stehen nie im Train.
- **`mixedRefusal`**: echte und erfundene Figur in einer Frage («Wer sind Stefan und Aurelia Pfändler?») → die echte kurz einordnen (höchstens elf Wörter, sonst wiederholte sie das Porträt wörtlich), die erfundene ablehnen.
- **`offTopic`**: buchfremde Bitten — Schreib- und Alltagsaufträge (E-Mail, Bewerbung, Kündigung, Rede), Rezepte, Code, Hausaufgaben, Übersetzung, aktuelle Nachrichten, Rat zu Gesundheit oder Recht, Allgemeinwissen; über 60 Fragen in verschiedenen Formen → kurz ablehnen und über eine der meistgenannten Figuren zum Buch zurückführen. Nie aus der Buchwelt antworten.
- **`metaQuestion`**: Fragen zum Buch als Werk (Autor, Erscheinungsjahr, Verlag, Entstehung, Fortsetzung, Kapitelzahl, Titel) → aus den Projektdaten (`book_publication`: Autorname, Jahr, Verlag), sonst ehrlich ablehnen («Wer mich geschrieben hat, steht nicht in meinen Seiten.»). Nie raten. Je Thema eine Einheit mit eigenen Antworten.
- **`falsePremise`**: Frage mit falscher Annahme (vertauschte Beziehungsrolle, falscher Beruf, falsches Geburtsjahr) → die Antwort korrigiert sie, immer in voller Form («Das stimmt so nicht: Gisela ist nicht Stefans Mentorin, sondern Stefans Mutter.»; als Ja/Nein-Frage «Nein, … sondern …»). Für Kernbeziehungen von Hauptfiguren bis zu drei Falschannahmen (beide Richtungen, mehrere plausible falsche Rollen), sonst eine je Richtung; alle Samples einer Beziehung teilen die Einheit. Ein Beruf nur als einzelner Begriff, nie als Aufzählung. Nur zwischen benannten Figuren und nur plausibel: eine falsche Geschwister- oder Partnerrolle nur bei gleicher Generation, eine falsche Eltern- oder Mentorrolle nur, wenn die Figur älter ist, Kind oder Schützling nur, wenn sie jünger ist. Die Generation folgt aus dem echten Typ (Eltern, Kind, Geschwister, Partner) oder aus den Geburtsjahren; fehlt beides, entfällt die Frage. Keine Prämisse «Renate ist die Mutter ihres Vorgesetzten».

Erfundene Namen kommen aus je 50 Vor- und Nachnamen (Englisch 40), gepaart über zwei gemischte Listen mit festem Seed: Runde r paart den i-ten Vornamen mit dem (i + r)-ten Nachnamen, so taucht kein Nachname gehäuft auf. Dazu erfundene Orte (Silben-Kombinationen wie «Eschenried») und rund zwanzig erfundene Ereignisse («der Absturz der Seilbahn»). Vorlagen und Listen: [reader/refusal-text.js](../routes/jobs/finetune-export/samples/reader/refusal-text.js).

Der Sampler erzeugt einen Vorrat; ins Set kommt davon `refusalShare` der **Beispiele** (Standard 5.5 %, `refusalShareBasis: count`), verteilt nach `refusalMix`. Nach Tokens ist der Anteil wegen der kurzen Antworten rund 2 % — das ist so gewollt. Jede Ablehnung hat ihre Einheit (eine Falschannahme-Beziehung, ein Meta-Thema, eine Off-Topic-Frage oder ein Name); Train und Val bekommen verschiedene Namen und Fragen, Val geschichtet nach Untertyp (`valRefusalMin`).

### Mischung nach Antwort-Tokens

Eine Schreibaufgabe trägt rund zehnmal so viele Antwort-Tokens wie eine Faktenfrage; nach Anzahl gezählt stellte die Prosa 60 % der Beispiele, aber über 90 % des Loss. [lib/token-mix.js](../routes/jobs/finetune-export/lib/token-mix.js) steuert deshalb nach Antwort-Tokens (`familyTokenShares`). Weil nur weggelassen, nie ergänzt werden kann:

1. writing und facts im Verhältnis ihrer Zielanteile — die grössere Seite wird gekürzt (Wörtlich zuerst, Sammellisten ohne Einheit zuerst). Fakten **nach Wichtigkeit**: zuerst Ereignis-Facetten und Ereignisfragen ohne Hauptfigur (`eventCore`, `factEvent`; die Bedeutung eines Ereignisses ist die seiner wichtigsten Figur), dann Fakten zu Randfiguren, dann Orte, Welt-Fakten und Szenen, dann die übrigen Fakten, dann Zusatzvarianten des Kernwissens der Rand- und danach der Nebenfiguren, zuletzt die Fakten der Hauptfiguren; innerhalb eines Rangs anteilig je Typ, Kernkarten von der höchsten Variante abwärts. Lieber fallen Randfiguren-Fakten ganz weg, als dass eine Hauptfigur auf eine Variante schrumpft. Die Bedeutung trägt das Sample selbst (`tier`, Kernwissen) oder sie folgt aus den Figuren-IDs in seiner ID;
2. persona höchstens ihr Anteil an writing + facts; zu wenig Persona bleibt zu wenig;
3. verbatim höchstens `verbatimMaxTokenShare` aller Antwort-Tokens;
4. refusal **nach Anzahl** (`refusalShare`): Ablehnungen sind kurz, 5 % der Tokens wären ein Viertel aller Beispiele.

Nie gekürzt werden das Kernwissen der Hauptfiguren samt ihren Kernfakten, die Kapitelkarten und die erste Variante jeder Kernkarte. Tokens schätzt der Export mit `estimateTokens` (Zeichen je Token des Profil-Tokenizers, `charsPerToken`: Tekken 3.3 DE / 4.0 EN, Qwen 3.0 / 3.8, [lib/tokens.js](../routes/jobs/finetune-export/lib/tokens.js)), die Methode steht in `quality.tokenMethod`. Gegen den echten Tekken-Tokenizer misst [token_factor.py](unsloth-config/token_factor.py) eine Stichprobe von 200 Beispielen und schreibt `tokenEstimateError` (Faktor echt/geschätzt, Median, p10/p90, Zeichen je Token) in die Statistik-Datei. Für «Der Amoklauf» (2026-11) lag der Faktor bei 0.84: die Schätzung zählt rund 16 % zu viel, ist also der beabsichtigte Puffer; die Anteile der Familien verschieben sich dadurch kaum.

Den Text der Holdout-Abschnitte sieht ein Training auf `train.jsonl` nie. Deshalb gibt es zusätzlich **`all.jsonl`** (train + val gemeinsam gemischt) für einen zweiten Lauf, siehe [§3](#3-training).

**Statistik** (`stats`, Karte «Qualität des Sets», Job-Log und Download `finetune-stats-….json`): je Aufgabentyp Anzahl, Anteil, Antwort-Tokens und Token-Anteil, eigene Antworten und mittlere Antwortlänge; Familienanteile nach Anzahl und nach Tokens (`writingTokenShare`, `factTokenShare`, `personaTokenShare`, `refusalTokenShare`, `verbatimTokenShare`); `refusalCount` je Untertyp; `factCount` und `factParaphraseCount`; `paraphrasesPerFact` (Varianten je Kernkarte als min/median/p90, getrennt nach main/side/minor — Ziel: Median ≥ 3 für Hauptfiguren); `coreFactCoverage`; `paragraphTargetMax`; `critiqueDropped`, `noteDropped`, `lintDropped` + `lintReasons`, `trivialDropped`, `promptDeduped`, `relationConflicts` (Liste, [Beziehungsprüfung](#beziehungsprüfung)) + `relationConflictsMain` + `conflictDropped`, `coreFactVariants`, `refusalPortraitRatio`, `chapterMismatches`, `overRecommendedSeq` (Beispiele über der empfohlenen Länge), `evalDropped`, `aiAugmentCount`; `valFacts`/`valWriting`/`valPersona`/`valRefusal`/`valEditor`; die zehn häufigsten Antworten; die Überlappung Val ↔ Train gesamt und je Val-Datei; was jeder Schritt oben verworfen hat; die verwendeten `exportOptions`.

**Loss-Masking:** Trainiere über das `messages`-Feld + `train_on_responses_only` (so im CLI-Script verdrahtet; das Script rendert `messages` selbst über das Chat-Template und entfernt dabei das führende `<s>`, weil der Tokenizer es beim Tokenisieren ein zweites Mal setzt) — dann fliesst der Loss nur auf die Assistant-Tokens, User-Instruktionen/System-Prompts werden maskiert. Das `text`-Feld (`emit_text=true`) ist nur ein Fallback für Loader, die `dataset_text_field` erwarten; es kann den Prompt nicht maskieren, das Modell lernt dann auch die Instruktions-Phrasen mit.

**Downloads der Karte:** `train`, `val`, `all`, `val-facts`, `val-writing`, `val-persona`, `val-refusal` (und `val-editor`, falls vorhanden), **Testprompts** (`eval`, [lib/eval-prompts.js](../routes/jobs/finetune-export/lib/eval-prompts.js)), die **Statistik** (`stats.json`), die **Studio-Konfiguration** und das **Ollama-Modelfile**. Dateinamen: `finetune-<art>-<Buch>-<Profil>-<Zeitstempel>.<ext>` (`stats.fileStem`); das Modelfile heisst `Modelfile`, weil Ollama den Namen erwartet. Die Testprompts ([§5](#5-qualitäts-check)) sind sechs Fragen je Kategorie, gefüllt mit echten Figuren- und Kapitelnamen; dazu die **Bewertungsanleitung** `eval-judge.md` ([lib/eval/judge-md.js](../routes/jobs/finetune-export/lib/eval/judge-md.js)), aus `eval.jsonl` erzeugt. Fortsetzungs-Prompts kommen bevorzugt aus Holdout-Abschnitten. Das Modelfile trägt den System-Prompt des Exports wörtlich (`stats.systemPrompt`, Generator [finetune-modelfile.js](../public/js/book/finetune-modelfile.js)). Sets, die vor diesen Downloads erzeugt wurden, zeigen die Knöpfe erst nach dem nächsten Generieren.

Stats nach Generierung: p95/max Token, empfohlene `seq_len`, verworfene Samples, entfernte Dubletten, per Typ-Cap entfernte Samples, dazu die [Qualität des Sets](#qualität-des-sets). Exakte Dubletten-Entfernung und ein deterministisches Shuffle pro Split laufen immer.

**Die letzten fünf Sets bleiben gespeichert**, pro Buch und User, in der Datenbank (`finetune_exports` + `finetune_export_files`, jede Datei gzip-komprimiert als BLOB; [db/finetune-exports.js](../db/finetune-exports.js)). Damit sind sie im täglichen DB-Backup und fallen mit Buch oder Konto weg (CASCADE). Ein sechster Export räumt das älteste weg, einzelne Sets lassen sich löschen. Die Karte zeigt sie als Verlauf, neuestes zuerst: jede Zeile klappt Statistik, Qualität und Downloads des Sets auf — jede Datei einzeln oder alle zusammen als ZIP (`export.zip`: jede JSONL mit Inhalt, `stats.json`, `studio-config.yaml`, `Modelfile.txt` und `eval-judge.md`). Studio-Config und Modelfile erzeugt [finetune-studio-files.js](../public/js/book/finetune-studio-files.js) für Karte und ZIP gleich: `max_seq_length` ist die empfohlene Länge des Sets (`recommendedSeqLen`), mit `tokensMax` und der Zahl längerer Beispiele als Kommentar; die Schritte rechnen mit der Train-Grösse. Zu jedem Set gehört ein Fingerabdruck des Buchstands: Reihenfolge, Kapitel und `updated_at` jedes Abschnitts, ausgeschlossene Kapitel nicht mitgezählt. Weicht der aktuelle Stand davon ab, ist das Set als veraltet markiert. Neu generiert wird nur auf Klick, weil ein Export mit KI-Augmentierung Stunden dauern kann. Änderungen an Figuren, Szenen oder anderen Metadaten allein lösen die Markierung nicht aus.

Format pro Zeile:

```json
{"messages":[
  {"role":"system","content":"Du bist das Buch «…». Leserinnen und Leser sprechen mit dir …"},
  {"role":"user","content":"Wer ist Hans Meier?"},
  {"role":"assistant","content":"Hans Meier ist der Protagonist …"}
]}
```

Validieren:

```bash
wc -l train.jsonl val.jsonl
python3 -c "import json; [json.loads(l) for l in open('train.jsonl')]; print('OK')"
```

### Leser-Modell

Der Export trainiert das Buch im Gespräch, etwa für eine Webseite, auf der Leser Fragen stellen, Hintergründe erfahren und das Innenleben der Figuren ergründen. Code: [samples/reader/](../routes/jobs/finetune-export/samples/reader/).

- **Eigener System-Prompt** ([reader/system.js](../routes/jobs/finetune-export/samples/reader/system.js)): «Du bist das Buch «…». Leserinnen und Leser sprechen mit dir …». Er reist als `stats.systemPrompt` ins Modelfile und muss beim Betrieb wörtlich gesetzt sein. Die Ich-Form einer Figur hat keinen zweiten System-Prompt: Der Leser bittet im Gespräch darum («Ich möchte mit Anna sprechen»). So trägt ein einziges Modelfile beides.
- **Kein Werkstattwissen:** Lektorats-Korrekturen und -Bewertungen (auch die Szenen-Wertung der Komplettanalyse und die Kapitelbewertung), Antworten aus dem Buch-Chat, Fundort eines Satzes («In welchem Abschnitt steht …»), Abschnittsnamen und der Kapitelaufbau kommen nicht in die Daten. Vor Lesern erklärte das Modell sonst die Schwächen des Buchs oder die Gliederung der Werkstatt. Lektorats-Feedback gibt es nur als eigenen, ausdrücklich benannten Typ (`editorFeedback`, Standard aus).
- **Buchtext als Ziel, aber nicht auswendig.** Stil, Szene und Dialog tragen echten Buchtext als Ziel, gedeckelt auf `maxAnswerChars` pro Typ und höchstens zwei Ziele pro Absatz. `Wörtlich` ist standardmässig aus: lange wörtliche Ziele dominieren den Loss und belohnen Auswendiglernen statt Schreiben.
- **Innenleben** kommt aus zwei Quellen:
  - **Komplettanalyse** (Buchwissen Block 32, [author-chat/depth.js](../routes/jobs/finetune-export/samples/author-chat/depth.js)): Pro Figur werden Rolle, Motivation, Konflikt, Entwicklung (`arc` als Prosa, sonst `entwicklung`), Hintergrund, Äusseres und Sprechweise zu Fragen wie «Was treibt Stefan an?» oder «Wie verändert sich Stefan?». Mit Motivation und Konflikt zusammen kommt «Was geht in Stefan vor?» dazu. Jedes Schlüsselzitat wird wörtlich zu einer eigenen Antwort. Die Analyse-Prosa fasst **Antworten im Buchton** in die Erzählstimme um.
  - **[Figuren-Werkstatt](figur-werkstatt.md)** ([reader/psyche.js](../routes/jobs/finetune-export/samples/reader/psyche.js)): Pro Kern (Want, Need, Wound, Lie, Konflikt, Bogen) entstehen Fragen mit den Notizen des Autors als Antwort, dazu eine Übersicht ab zwei Kernen. Die Textstellen, die das Verankern gefunden hat (`draft_figure_occurrences`), werden zu eigenen Beleg-Samples («Wo zeigt sich im Buch …?»), wörtlich und mit ihrem Abschnitt gesplittet.
- **Tragende Figuren** sind alle Werkstatt-Figuren (verknüpft über die Quell-Figur oder den Namen) und die Katalog-Figuren mit Typ Hauptfigur oder Antagonist oder mit Präsenz `zentral`. Nur sie bekommen die Ich-Form, Gespräche über mehrere Runden und «Was passiert nach dem Ende?».
- **Ich-Form** ([reader/persona.js](../routes/jobs/finetune-export/samples/reader/persona.js)): Ohne KI wird jede Dialogzeile einer tragenden Figur zur Antwort auf «Sag mir etwas, wie nur du es sagen würdest». Mit der KI-Option **Figuren in der Ich-Form** kommen Leserfragen mit der Antwort der Figur dazu. Material dafür sind die Beschreibung, die Tiefe-Felder und Schlüsselzitate der Analyse, alle Werkstatt-Notizen und die Dialogzeilen der Figur. Eine Figur braucht ein Innenleben (Motivation oder Konflikt der Analyse oder Werkstatt-Notizen) oder mindestens drei Dialogzeilen. Dialogzeilen, die mit einem Satzzeichen beginnen oder einen Redebegleitsatz tragen («, sagte sie»), sind verkehrt gepaarte Anführungszeichen und fallen weg.
- **Deutungen** (KI-Option): Pro Szene mit Figuren entstehen Warum-Fragen mit einer Antwort, die die Beweggründe deutet. Als Hintergrund bekommt die KI Motivation und Konflikt der Figuren aus Analyse und Werkstatt. Ohne Szenen-Analyse läuft das pro Abschnitt, in dem eine tragende Figur vorkommt. Die Antworten zitieren Buchtext und werden darum mit ihrem Abschnitt gesplittet.
- **Belegpflicht** für beide KI-Phasen ([reader/ai.js](../routes/jobs/finetune-export/samples/reader/ai.js)): Jedes Paar braucht ein wörtliches Stück aus dem gelieferten Material, mindestens 12 Zeichen lang. [lib/quote-verify.js](../lib/quote-verify.js) prüft es dort nach; ohne Treffer fällt das Paar still weg. Eine erfundene Motivation im Ton des Buchs klänge für Leser wie Kanon. Darum gibt es keine Review-Liste, sondern diese Prüfung.
- **Grenzen** ([reader/boundaries.js](../routes/jobs/finetune-export/samples/reader/boundaries.js)): «Was passiert nach dem Ende?», «Bist du eine KI?» (ehrlich: ein auf das Buch trainiertes Sprachmodell) und Versuche, es aus der Rolle zu bringen. Unbekannte Namen, Off-Topic und falsche Annahmen: [Ablehnen lernen](#ablehnen-lernen). Spoiler sind erlaubt: Das Modell erzählt alles.
- **Gespräche über mehrere Runden** ([reader/conversations.js](../routes/jobs/finetune-export/samples/reader/conversations.js)): Sie werden aus den fertigen Ich-Form-Paaren zusammengesetzt, zusätzlich zu ihnen. Pro tragender Figur sind es bis zu zwei Gespräche à drei Runden; sie beginnen mit der Bitte um die Figur, das erste endet mit der Rückkehr zum Buch über eine Frage ohne Titel in Anführungszeichen. Aneinandergereihte Faktenfragen («Wann erlebt Samuel «…»?» → «In welchem Kapitel erlebt Samuel «…»?») gibt es nicht: die Folgefrage bezöge sich nicht auf die vorige Antwort, das wäre ein Quiz, kein Gespräch. Berührt ein Gespräch Abschnitte aus Train und Val, fällt es beim Split weg.
- **Testprompts** (`eval.jsonl`) bekommen die Kategorien `psyche`, `persona`, `why`, `unknown` und `offTopic` ([reader/eval.js](../routes/jobs/finetune-export/samples/reader/eval.js)).

Die Samples tragen den Typ `reader`: eine eigene Zeile in den Stats und eine eigene Grösse für die Typ-Balance.

## 3. Training

Konfiguration: [docs/unsloth-config/](unsloth-config/) – Script, gepinnte Requirements, Studio-YAML, Ollama-Modelfile. Setup-/Run-Anleitung dort.

**Faktentiefe über Varianten, nicht über Epochen.** Eine Epoche genügt, dafür Rang 64 im Default-Profil (Platz für Figuren, Beziehungen, Ereignisse und Jahre ohne Nachschlagen); eine zweite Epoche verdoppelte vor allem die Schreibaufgaben und lehrte wörtliches Kopieren: die Kernfakten kommen über `coreFactRepeat` und die vielen Frageformen ins Set. Im Lauf mit «Der Amoklauf» (v3.1, 1 Epoche) sank der Eval-Loss an `val-facts` bis zum Schluss (1.11 → 0.63) — mehr Faktenbeispiele sind also verträglich.

**Feste Länge statt Early Stopping.** Der Eval-Loss eines Buch-LoRA steigt früh — im Test ab einem Drittel der ersten Epoche —, während der Train-Loss gegen null fällt und das Faktenwissen noch wächst. Early Stopping behielte genau den Stand, der die Fakten am schlechtesten kennt. Die Studio-Konfiguration trainiert deshalb eine feste Länge (`num_epochs: 1`, oder `max_steps` ≈ 1.5 Epochen mit `trainBy: 'steps'` im Profil), sichert alle ~10 % einen Stand (`save_steps`) und evaluiert an `val-facts.jsonl` (`eval_steps` ist ein Anteil der Gesamtschritte). Welcher Stand der beste ist, entscheidet der Vergleich mit `eval.jsonl` ([§5](#5-qualitäts-check)), nicht der Eval-Loss.

**Zwei Läufe.** Lauf 1 trainiert auf `train.jsonl` und misst an `val-facts.jsonl`. Lauf 2 trainiert mit der Länge des besten Stands auf `all.jsonl`, ohne Evaluation. Erst dann kennt das fertige Modell auch die Holdout-Kapitel. Wer nur einen Lauf will, nimmt `all.jsonl` direkt mit einer Epoche.

Kurzform CLI:

```bash
conda create -n unsloth python=3.11 -y && conda activate unsloth
pip install -r docs/unsloth-config/requirements.txt
cp ~/Downloads/{train,val,all}.jsonl docs/unsloth-config/
cd docs/unsloth-config
CUDA_VISIBLE_DEVICES=0 python train_book.py                    # Lauf 1, druckt FINAL_EPOCHS=…
FINAL_EPOCHS=1.6 CUDA_VISIBLE_DEVICES=0 python train_book.py   # Lauf 2 auf all.jsonl
```

Output am Ende: `runs/ministral3-8b-buch-final/gguf/*.gguf`.

In Ollama einbinden: das **Modelfile aus der Karte** neben die `.gguf` legen und `FROM` auf deren Dateinamen setzen.

```bash
cd runs/ministral3-8b-buch-final/gguf
cp ~/Downloads/Modelfile .
ollama create buch-leser -f Modelfile
ollama run buch-leser "Worum geht es in dir?"
```

**Nicht als Provider der App eintragen.** Ein globales `OLLAMA_MODEL=buch-leser` schickte jeden KI-Job der App über das Buch-Modell, auch Lektorat und Komplettanalyse, die JSON verlangen. Das Modell ist auf Prosa und einen festen System-Prompt trainiert; dort leiden die Ergebnisse. KI-Profile ([docs/ai-providers.md](ai-providers.md)) gelten pro User, nicht pro Job, also lässt sich das auch nicht auf einen einzelnen Job beschränken. Das Buch-Modell läuft direkt in Ollama (CLI, Open WebUI oder ein anderer Chat-Client).

## 4. Hyperparameter nach Ziel

| Ziel | `r` | `lr` | Epochen | Inferenz-Temp |
|---|---|---|---|---|
| Stilimitation (leicht) | 16 | 2e-4 | 1–2 | 0.7–0.8 |
| Welt internalisieren | 32 | 1e-4 | 1 | 0.7 |
| **Faktenwiedergabe, Leser-Modell (Default)** | **64** | **1e-4** | **1** | **0.4–0.6** |
| Figuren-Persona | 32 | 2e-4 | 2 | 0.85–1.0 |

**Trainingsprofile** (Basismodell × GPU-Speicher, QLoRA). Die Karte bietet sie als Auswahl **Profil** an: die Wahl setzt `Max. Token pro Sample` und `Max. Zeichen`, und **studio-config.yaml herunterladen** liefert die passende Studio-Konfiguration (Abschnitte `training`/`lora`/`logging`; `max_seq_length` folgt dem aktuellen `Max. Token pro Sample`). Quelle der Werte: [finetune-profiles.js](../public/js/book/finetune-profiles.js); die kommentierte [studio-config.yaml](unsloth-config/studio-config.yaml) ist das Default-Profil, beides gegated durch [finetune-profiles.test.mjs](../tests/unit/finetune-profiles.test.mjs).

| Modell | GPU | `batch` | `accum` | `seq_len` | `r` |
|---|---|---|---|---|---|
| Ministral 3 8B | 16 GB | 1 | 16 | 4096 | 64 |
| Ministral 3 8B | 20 GB | 2 | 8 | 4096 | 32 |
| Ministral 3 8B | 24 GB | 2 | 8 | 8192 | 64 |
| Mistral Small 3.2 24B | 20 GB | 1 | 16 | 4096 | 32 |
| Qwen3 14B | 16 GB | 1 | 16 | 2048 | 16 |

Default: Ministral 3 8B auf 16 GB. Effektive Batch ist überall 16; `lora_alpha` = `r`. Das 16-GB-Profil von Ministral sichert fest alle 100 Schritte (`saveSteps`), `eval_steps: 0.1`, kein Early Stopping, Eval-Datei `val-facts`. **Qwen3 14B** ist das Vergleichsprofil: gleicher System-Prompt, ChatML-Template (Modelfile und `text`-Feld), eigene Token-Schätzung (`charsPerToken`), `seq_len` 2048 — P95 der Beispiele liegt bei rund 740 Tokens.

## 5. Qualitäts-Check

**Testprompts** (`eval.jsonl`, [lib/eval-prompts.js](../routes/jobs/finetune-export/lib/eval-prompts.js)): sechs Fragen je Kategorie — `figure`, `relation`, `chapter`, `falsePremise`, `meta`, `mixed`, `continuation`, `newChapter` ([lib/eval/categories.js](../routes/jobs/finetune-export/lib/eval/categories.js)) und `psyche`, `persona`, `why`, `unknown`, `offTopic` ([reader/eval.js](../routes/jobs/finetune-export/samples/reader/eval.js)). Zeile:

```json
{ "category": "relation", "holdout": "phrasing", "expected": "Renate ist Stefans Ehefrau.",
  "mustContain": [], "mustContainAny": [["Ehefrau", "Frau", "verheiratet", "Gattin", "Ehemann", "Mann", "Gatte"]],
  "mustNotContain": [], "judge": "Richtig: Renate ist Stefans Ehefrau. …", "factIds": ["rel:fig_1|fig_2"], "messages": [ … ] }
```

- `mustContainAny`: Synonymgruppen, aus jeder Gruppe mindestens ein Begriff; `mustNotContain`: Ausschluss (Porträt-Marker bei Unbekanntem, Rezept-/E-Mail-Marker bei Off-Topic, «Name ist:» beim Porträt); `judge`: Anweisung für einen menschlichen oder LLM-Richter; `factIds`: geprüfte Fakten. Kriterien je Kategorie ([lib/eval/criteria.js](../routes/jobs/finetune-export/lib/eval/criteria.js)): Porträt mit zwei Kernfakten (Partner, Elternteil, Kapitel); Beziehung mit Rollenwort und Synonymen; Kapitel mit Hauptfiguren, Schlüsselereignis und Ereignissen anderer Kapitel als Ausschluss; Innenleben und Deutung nur über `judge` mit dem Kernmotiv — bei `why` das Motiv **der Szene** (Bedeutung eines Ereignisses der Szene); Ich-Form über Ich-Formen plus ein Merkmal der Figur, Erzählerform als Ausschluss; Fortsetzung über `judge` zu Perspektive, Zeitform und Schweizer Schreibung; Ablehnungen über Ablehnungs-Marker.
- **Hälfte in neuen Frageformen:** je Kategorie drei Fragen in Formen, die im Train vorkommen (die Frage selbst nie wörtlich, `holdout: false`), drei in Formen, die es nicht kennt (`holdout: "phrasing"`) — gemessen wird Verallgemeinerung. `holdout: "unit"` = der Fakt lag in Val, `"text"` = der Buchtext lag in Val.
- **Prüfungen im Export:** keine Frage wörtlich im Train; keine Referenz, die einen gemeldeten Beziehungskonflikt wiederholt; jede Zeile mit mindestens einem Kriterium ausser «ich» oder «nicht». Was durchfällt, zählt `evalDropped`.
- **Bewertungsanleitung** `eval-judge.md` (im ZIP und einzeln): pro Frage Referenz, Kriterien und Anweisung, Skala 0–2 (falsch / teilweise / richtig).

Automatisch: `eval.jsonl` an Basismodell und trainiertes Modell (oder zwei gesicherte Stände) schicken; das Script druckt Referenz, Bewertungsanweisung und Antworten und zählt am Ende pro Kategorie, wie viele Antworten alle Wort-Kriterien erfüllen:

```bash
python docs/unsloth-config/compare_models.py eval.jsonl ministral-3:8b buch-leser
```

Von Hand: System-Prompt **identisch zum Training** setzen (das Modelfile der Karte tut das schon):

```
Du bist das Buch «‹Buchtitel›». Leserinnen und Leser sprechen mit dir über deine
Geschichte, deine Welt und deine Figuren. Antworte im Ton des Buchs und aus seiner
Welt heraus. Möchte jemand mit einer deiner Figuren sprechen, antwortest du als
diese Figur in der Ich-Form.
```

Tests:

1. Weltfakten: „Wer ist {Hauptfigur}?"
2. Relation: „Wie steht {A} zu {B}?"
3. Szenen-Recall: „Was passiert in Kapitel «X»?"
4. Stil-Fortsetzung aus Kapitel-Anfang.
5. Neues Kapitel mit zwei Figuren generieren.
6. Ich-Form: „Ich möchte mit {Hauptfigur} sprechen." und eine Frage an sie.
7. Grenze: „Wer ist {erfundener Name}?" → „kommt nicht vor".
8. Falsche Annahme: „Warum ist {Mutter} {Kinds} Schwester?" → korrigiert die Rolle.

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| OOM | `seq_len=2048`, `batch=1`, `accum=16` |
| Eval-Loss steigt früh | erwartet bei einem Buch-LoRA; Stände per `eval.jsonl` vergleichen statt Early Stopping ([§3](#3-training)) |
| Repetitive Inferenz | `repeat_penalty 1.1` (Modelfile der Karte), sonst 1.15 |
| Figuren halluziniert | `factParaphrases` ↑, `minMentions` ↓; Faktenkarten später per Retrieval in den Prompt |
| Erfindet Antworten zu Unbekanntem | `refusalShare` ↑ (z. B. 0.04) |
| Antwortet auf Inhaltsfragen mit Lektorat | `critiqueDropped` in der Statistik prüfen, Muster in `critiquePatterns` ergänzen |
| Klingt wie Standard-Mistral | `r` ↑ (Default 64; Profile mit 32 auf 48–64), +1 Epoche |
| Kopiert Buch wörtlich | Epochen ↓, `lora_dropout=0.05` |
| Antwortet auf Englisch | Modelfile aus der Karte verwenden (System-Prompt wörtlich) |
| Kennt Holdout-Kapitel nicht | Lauf 2 auf `all.jsonl` ([§3](#3-training)) |
| Antwortet auf Figurenfragen im Analyse-Ton | Export mit **Figuren- und Ortsantworten im Buchton** |
| Satz mitten abgeschnitten | Export mit `max_seq_tokens=4096` neu |

## 7. Links

- [Unsloth-Docs](https://docs.unsloth.ai)
- [Unsloth: Ministral 3](https://unsloth.ai/docs/models/ministral-3)
- [Ministral-3-8B-Modellkarte](https://huggingface.co/mistralai/Ministral-3-8B-Instruct-2512)
- [Unsloth-Variante](https://huggingface.co/unsloth/Ministral-3-8B-Instruct-2512-unsloth-bnb-4bit)
- [TRL SFTTrainer](https://huggingface.co/docs/trl/sft_trainer)
