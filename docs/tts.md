# TTS / Proof-Listening (Text-to-Speech, self-hosted)

Vorlesen von Text auf **zwei Oberflächen**: der **Notebook-Seitenansicht** (Read-Modus, nicht im Edit-Modus — Korrekturhören am fertigen Text) und dem **Share-Reader** (öffentliche Leseansicht geteilter Seiten/Kapitel/Bücher — Beta-Leser hören sich den Text vorlesen). Den eigenen Text gehört aufzudecken Stolperstellen, die das Auge überliest. Self-hosted, vom Betreiber konfigurier- und abschaltbar. **Dritte Sync-Proxy-Ausnahme** zur Job-Queue-Regel (neben [stt.md](stt.md) und [languagetool.md](languagetool.md)): kurzer Request/Response-Synthesecall, **kein** KI-Analysejob, kein Token-Budget, kein `callAI`. TTS liest verbatim vor — keine generative KI.

Drei SSoT-Kerne, von beiden Oberflächen geteilt — Änderungen dort betreffen **beide**:

- **Synthese** [lib/tts-synth.js](../lib/tts-synth.js) (`isEnabled`, `synthesizeSpeech({ text, lang })`, `resolveVoice`, `pauseConfig`, `clearAudioCache`) — genutzt vom auth-pflichtigen `POST /tts/speak` (Notebook) und vom public, token-skopierten `POST /share/:token/tts` (Share-Reader).
- **Segmentierung** [public/js/tts-segment.js](../public/js/tts-segment.js) — Vorlese-Blöcke, Sprech-Einheiten, Sätze/Chunks, Range-Bau, Klick-Position, Sprech-Normalisierung.
- **Abspielkern** [public/js/tts-player.js](../public/js/tts-player.js) (`createTtsPlayer`) — Abspiel-Schleife, Vorausladen, Wiederholen, Pause/Springen, Highlight, Audio-Cache im Browser, Media Session.

Die Oberflächen — Notebook-Dock ([tts-proof.js](../public/js/editor/notebook/tts-proof.js)) und Share-Reader-Dock ([share-reader/tts.js](../public/js/share-reader/tts.js)) — liefern nur, was sich unterscheidet: Lese-Container, Synthese-Request, Scrollen, Darstellung des Zustands, Leseposition, Tastatur/Klick.

## Datenfluss

```
Dock → collectTtsSegments(Lese-Container, Buchsprache) → player.start(segs, ab Markierung | gemerkter Stelle | 0)
  → pro Segment: markieren (::highlight(tts-sentence)) → Audio aus Browser-Cache oder request(normalizeForSpeech(text))
       Notebook:     POST /tts/speak?bookId=…   (guardBook viewer)
       Share-Reader: POST /share/:token/tts      (Ratenlimit + Inhaltsbindung)
    → synthesizeSpeech: Server-Audio-Cache oder ${tts.host}/v1/audio/speech (OpenAI-kompatibel)
    → blob:-URL → new Audio(...).play() (playbackRate = Lesetempo) → Atempause → nächstes Segment
```

Reines Lesen: **keine DOM-Mutation**, kein Save-Pfad, kein `data-bid`, kein Stale-Write. Der Highlight läuft über die CSS Custom Highlight API — er färbt nur.

## Segmentierung ([tts-segment.js](../public/js/tts-segment.js))

- **Vorlese-Blöcke** (`ttsBlocks`): der Container selbst plus jedes Element aus `TTS_BLOCK_SEL` (Kern aus `TEXT_BLOCK_TAGS` + `pre`/`figcaption` + reine Container wie `ul`/`div`/`figure`). Jeder Block liest nur seinen **eigenen** Text: verschachtelte Blöcke sind eigene Blöcke. So liest `<li>Punkt A<ul><li>Sub</li></ul></li>` erst „Punkt A", dann „Sub" — nichts doppelt, nichts verloren; `blockquote > p` einmal. Blöcke in Tabellen/Diagrammen (`TTS_SKIP_BLOCK_SEL`) fallen ganz weg.
- **Sprech-Einheiten** (`ttsUnits`) — **ein Offsetraum** für Sprechtext (`ttsBlockText`), Highlight (`ttsBuildRange`) und Klick-Position (`ttsOffsetAt`/`ttsSegmentAt`): Textknoten plus **Grenzen** als ein Zeichen `\n` — `<br>` und verschachtelte/übersprungene Blöcke. Ohne die Grenze würde „Zeile eins`<br>`Zeile zwei" als „einsZeile" gesprochen und eine Liste als „ErstensZweitens". Grenzen werden nie mitmarkiert (ein Satz, der an einer Unterliste endet, färbt sie nicht ein).
- **Ausgelassen im Sprechtext:** Beleg-Chips (`TTS_SKIP_SEL`, Kopie von `CITE_SEL`) und eingeblendete Korrekturvorschläge der Notebook-Leseansicht (`TTS_SKIP_DECOR_SEL`: `ins.lektorat-ins`, `ins.chat-mark-ins` — vorgelesen wird der Text, wie er dasteht, nicht Fehler **und** Korrektur). Querverweise werden mitgelesen.
- **Sätze** via `Intl.Segmenter` in der **Buchsprache** (dieselbe, nach der der Server die Stimme wählt; Notebook aus `$store.nav.books`, Share-Reader aus `config_json.tts.lang`). Die UI-/Browsersprache wäre falsch: ein deutsches Buch bei englischer Oberfläche zerfiele an „z. B." in Pseudo-Sätze.
- **Chunk-Grössen (`chunkTtsRanges` pro Block):**
  - **Kurz-Satz-Bündelung:** sehr kurze Sätze werden innerhalb **eines** Blocks zu einem Chunk ≥ `TTS_MIN_CHUNK_CHARS` (60) zusammengefasst. **Why:** XTTS-v2 hängt bei sehr kurzen Eingaben am Satzende einen erfundenen Restlaut an (Kurz-Input-Halluzination). Isolierte Kurz-Blöcke (einzeilige Überschriften) lassen sich mangels Block-Nachbar nicht bündeln.
  - **Lang-Satz-Splitting:** Sätze über `TTS_MAX_CHUNK_CHARS` (220) werden an Klausel-Grenzen (`;` `:` `,`, freistehende Gedankenstriche) zerlegt, sonst am letzten Leerzeichen. **Why:** ein Schachtelsatz ergäbe sonst einen Request nahe am 20-s-Server-Timeout und einen halbminütigen Audio-Block.
  - Segmente ohne Buchstaben/Ziffern (Szenentrenner „* * *") fallen weg.
- **Sprech-Normalisierung** (`normalizeForSpeech`, nur der gesendete Text): Guillemets → gerade Anführung (XTTS spricht sie sonst als Laute), Zeilenumbruch ohne Satzzeichen → Komma (Atempause in Gedicht-/Listenzeilen), freistehender Gedankenstrich → Komma, Auslassungspunkte → Komma bzw. am Ende Punkt, Auszeichnungsreste (`* _ # ~`) weg.

## Abspielkern ([tts-player.js](../public/js/tts-player.js))

- **Schleife:** markieren → vorausladen → auf das eigene Audio warten → abspielen → Atempause (`fragmentMs` Satz-zu-Satz, `paragraphMs` bei Blockwechsel, aus `pauseConfig`) → nächstes. **Jedes Warten ist unterbrechbar** (`kick`): Vor/Zurück/Sprung und Stop wirken auch, während ein Satz noch synthetisiert wird oder eine Atempause läuft. Pause unterbricht das Laden nicht — gespielt wird erst nach dem Fortsetzen.
- **Steuerung:** `start(segs, idx)`, `toggle`/`pause`/`resume` (am Media-Element), `skip`, `prev` (startet einen Satz, der schon > 2 s läuft, neu; sonst vorheriger), `jumpTo`, `stop`, `setRate` (`playbackRate`, `TTS_RATES` 0.8/1/1.25/1.5 — ohne neue Synthese), `updateSegments` (s. u.).
- **Vorausladen adaptiv:** 1 Segment im Voraus; ist die gemessene Synthese-Dauer im Verhältnis zur Abspiel-Dauer hoch (> 0,6 bzw. > 1), 2 bzw. 3 — sonst entstehen bei langsamen Engines Lücken.
- **Wiederholen:** Netzwerkfehler und `429/500/502/503/504` einmal (bei `Retry-After` dessen Wert, gedeckelt auf 5 s). **`408` nicht** — der Server hat dort schon 20 s gewartet. `401/403/404` beenden die Session (`onFatal`). Scheitert ein Satz endgültig, wird er übersprungen; Fehlermeldung **einmal pro Session** (`onFailed`).
- **Audio-Cache im Browser:** LRU nach Bytes (24 MB), Schlüssel = Scope der Oberfläche (Buch bzw. Share-Token → Stimme) + Text. Wer eine Seite nach einer kleinen Korrektur noch einmal hört, lässt unveränderte Sätze nicht neu synthetisieren. Object-URLs leben nur für die Wiedergabe eines Segments.
- **Neu gerenderter Container** (`updateSegments`): die Session hängt die Position an das gleichlautende Segment der neuen Knoten (nächstgelegenes bei Duplikaten, sonst gleicher Index). Ohne das läse der Ton weiter, während die Markierung an abgehängten Knoten verschwunden ist.
- **Media Session:** Titel, Play/Pause/Stop/Vor/Zurück für Sperrbildschirm und Kopfhörer-Tasten, solange eine Session läuft.
- **Session-Runtime roh im Closure** — nicht auf einem reaktiven Alpine-Proxy: dort hielten die Identitäts-Guards (`rt === r`) nie.

## Backend

- **[lib/tts-synth.js](../lib/tts-synth.js)** — prüft `tts.enabled` + `tts.host`, validiert Text (8 KB Cap), löst Model/Voice/Format/Speed/Key aus `app_settings` auf und forwarded an `${host}/v1/audio/speech`. Wirft `TtsError { code, status }` (disabled→404, no-text→400, too-large→413, upstream→502, timeout→408). **Audio-Cache** im Prozess (LRU, 64 MB) mit Schlüssel über Host, Modell, Stimme, Format, Tempo und Text — eine geänderte Einstellung trifft nie altes Audio, Fehler werden nie gecacht. **Formate:** nur browser-abspielbare (mp3/opus/aac/flac/wav); ein gespeichertes `pcm` (rohes PCM, spielt kein Browser) fällt auf mp3 zurück. Audio nie persistiert; Host/Key verlassen den Server nie.
- **[routes/tts.js](../routes/tts.js)** — `POST /tts/speak` (auth). JSON-Body `{ text }`. Mit `?bookId=` erst `guardBook(…, 'viewer')` (die Buch-ID wählt die Stimme über die Buch-Locale), dann Synthese. Antwort-Bytes 1:1 (`Cache-Control: no-store`). Abgelaufene Session → `401 JSON` → globaler Session-Banner.
- **[routes/share/tts.js](../routes/share/tts.js)** — `POST /share/:token/tts` (**public, kein Session-Guard**). Der Token beschränkt nur, **wer** vorlesen darf, nicht **was** — darum zwei Schichten vor der Synthese: **Ratenlimit** pro Token + IP-Hash ([lib/share-ratelimit.js](../lib/share-ratelimit.js)#`checkTts`, 400 / 10 min, `429` + `Retry-After`) und **Inhaltsbindung** ([lib/share-tts-guard.js](../lib/share-tts-guard.js)): ≥ 85 % der Wörter des Texts müssen im geteilten Inhalt stehen (Wort-Ebene, weil der Client Belege auslässt und Satzzeichen normalisiert; Wortmenge pro Token 10 min gecacht, bei Fehlschlag einmal frisch geladen), sonst `422 tts_text_not_shared`. Stimme aus der Buch-Locale des geteilten Buchs (`owner_email`). `404` bei unbekanntem/abgelaufenem Token oder `tts.enabled=false`. **Why:** ohne diese Schichten wäre jeder Share-Link ein freier Zugang zum GPU-Speech-Server.
- **[routes/admin-settings.js](../routes/admin-settings.js)** — `POST /admin/settings/test-tts` (Health-Probe `GET /v1/models`).
- **[routes/telemetry.js](../routes/telemetry.js)** — `POST /telemetry/tts-log`. Fire-and-forget für Notebook-Frontend-Events (Start/Stop/Retry/Fehler), über den `[tts|user|book]`-Child-Logger mit `[client]`-Marker. Session-authed.
- **[routes/proxies.js](../routes/proxies.js)** `/config` — liefert `tts: { enabled, pause: { fragmentMs, paragraphMs } }`. **Kein** Host/Key/Model/Voice/Speed/Format. Der Share-Reader bekommt `tts: { enabled, pause, lang }` über sein `config_json` ([routes/share/reader.js](../routes/share/reader.js)).
- **Stimme locale-aware:** `getBookLocale(bookId, userEmail)`, Region abgeschnitten (`de-CH` → `de`). `tts.voice.<lang>` gewinnt, sonst `tts.voice`. Ohne Buchscope Default.
- **[lib/app-settings.js](../lib/app-settings.js)** — Keys: `tts.enabled`, `tts.host`, `tts.model`, `tts.voice`, `tts.voice.de` / `tts.voice.en`, `tts.format` (Enum mp3/opus/aac/flac/wav), `tts.speed` (0.25–4), `tts.pause.fragment_ms` / `tts.pause.paragraph_ms` (0–5000, 0 = keine Pause), `tts.api_key` (`ENCRYPTED_KEYS`).
- **[lib/csp.js](../lib/csp.js)** — `media-src 'self' blob:` (sonst blockt die CSP das `blob:`-Audio).

## Frontend (Notebook)

- **[tts-proof.js](../public/js/editor/notebook/tts-proof.js)** — `ttsProofMethods`, in den **Root** gespreaded (Dock im Root-Scope). Eine modul-scoped Spieler-Instanz (`_ttsPlayer`), Zustand gespiegelt in `$store.tts` ([tts-store.js](../public/js/cards/tts-store.js): `enabled`, `pause`, `playing`, `paused`, `loading`, `index`/`total`, `rate`, `continueReading`).
- **Lese-Container:** `#editor-card .page-content-view:not(.page-content-view--editing)` — bewusst nicht das contenteditable. Eigener Scroll-Container → `_ttsScrollViewIntoView` nudgt `scrollTop`.
- **Dock-Sichtbarkeit:** `_ttsHasReadableText` parst `renderedPageHtml` in ein inertes `<template>` und fragt `hasTtsText` — dieselbe Regel wie die Segmentierung (eine Seite aus nur einer Tabelle zeigt keinen Knopf). Gemerkt pro HTML-Stand.
- **Start-Position:** nicht-leere Markierung in der Leseansicht → ab deren Satz; sonst gemerkte Stelle dieser Seite (`localStorage tts.pos.<pageId>`, 14 Tage, Abgleich über den Satztext); sonst Anfang. Abgebrochen → Stelle merken, zu Ende gehört → vergessen.
- **Während des Vorlesens:** Klick in den Text springt zum Satz (nicht auf Links, Lektorat-/Chat-Markierungen, Erwähnungen, Belege; nicht beim Markieren). Tastatur: Leertaste Pause/Weiter (ausser ein Bedienelement hat den Fokus), ←/→ Satz zurück/vor (auch mit Fokus im Dock).
- **Weiterlesen** (`continueReading`, `localStorage tts.continue`): am natürlichen Seitenende die nächste Seite **desselben Kapitels** öffnen und von vorn lesen; Kapitelgrenze = Ende. Bricht ab, sobald der User woanders hin navigiert oder in den Edit-Modus geht.
- **Lifecycle** (`_initTtsProof`): Stop bei `book:changed`/`view:reset`, Wechsel in den Edit-Modus und Seitenwechsel; `renderedPageHtml`-Watch → `updateSegments` (Fremd-Änderung nachgeladen, Lektorat-Markierungen ein/aus).
- **Fehler:** `tts.error.failed`-Toast einmal pro Session, `tts.error.empty` bei leerem Text; 404/401/403 beenden still (401 zeigt der globale Session-Banner).
- **Dock** ([editor-body-view.html](../public/partials/editor-body-view.html)): unten links, Status-Pille (liest i/n · lädt · pausiert), Tempo, Weiterlesen, Zurück, Vor, Stop, Haupttaste. CSS [page/tts-dock.css](../public/css/page/tts-dock.css) + geteilt [components/floating-dock.css](../public/css/components/floating-dock.css) (`.dock-btn--text`, `.dock-btn.is-on`).
- **Admin-UI** ([admin-settings-tts.html](../public/partials/admin-settings-tts.html)): enabled, Host, Model, Stimmen, Format, Speed, Pausen, API-Key, Test-Button. **Ein Admin-Toggle, beide Oberflächen.**

## Frontend (Share-Reader)

- **[share-reader/tts.js](../public/js/share-reader/tts.js)** — Vanilla-Dock, **selbst-bootstrappend** (eigenes `<script type="module">` in share.html, liest `#share-config`), baut den Dock nur bei `tts.enabled` und vorhandenem Vorlese-Text in `#share-article`. Gleicher Abspielkern; Synthese via `POST /share/:token/tts`, Scroll gegen das Fenster.
- Start ab Markierung bzw. gemerkter Stelle (`localStorage sw.tts.pos.<token>`), Klick-Sprung, Tastatur und Lesetempo (`sw.tts.rate`) wie im Notebook; kein Weiterlesen (der Share zeigt den ganzen Inhalt am Stück).
- **Kein Stop beim Wechsel in den Hintergrund** — wer das Display ausschaltet, um zuzuhören, hört weiter; gesteuert wird dann über die Media Session.
- **Fehler** → Status-Pille `tts_error` für 4 s; die Tasten folgen dabei weiter dem Zustand. Kein Toast/Telemetrie (anonym).
- **Pre-Auth-Serving** ([server.js](../server.js)): `PUBLIC_ASSET_PREFIXES` enthält `/js/` und deckt `share-reader/tts.js`, `tts-segment.js` und `tts-player.js`. Beide Kerne dürfen nichts aus dem App-Bundle importieren (gegated in [block-sel-consolidation.test.mjs](../tests/unit/block-sel-consolidation.test.mjs)).

## Pflicht-Invarianten

- **Zwei Oberflächen: Notebook-Seitenansicht (Read-Modus) + Share-Reader.** Nicht im Edit-Modus, nicht im Focus-Editor/Bucheditor. Segmentierung, Abspielkern und Synthese sind SSoT beider Oberflächen.
- **Ein Offsetraum:** Sprechtext, Highlight und Klick-Position laufen über `ttsUnits` — wer nur den Sprechtext filtert (Chips, Korrektur-Einschübe) oder Grenzen nur dort einfügt, verschiebt das Highlight. Der Range zwischen Start- und Endknoten umfasst einen ausgelassenen Chip weiterhin (markiert, nicht gesprochen — gewollt). `TTS_SKIP_SEL` (Kopie von `CITE_SEL`), `TTS_SKIP_BLOCK_SEL` (Diagramm/Tabelle) und `TTS_BLOCK_SEL` (Kern `TEXT_BLOCK_TAGS`) sind bewusste Kopien, gegated durch [cite-guard-drift](../tests/unit/cite-guard-drift.test.mjs), [mermaid-drift](../tests/unit/mermaid-drift.test.mjs), [table-drift](../tests/unit/table-drift.test.mjs), [block-sel-consolidation](../tests/unit/block-sel-consolidation.test.mjs).
- **Keine DOM-Mutation, kein Save-Pfad.**
- **Host/API-Key bleiben server-seitig**; ans Frontend gehen nur `enabled`, Pausen und (Share) die Buchsprache.
- **Die public Route liest nur geteilten Inhalt vor** (Ratenlimit + Inhaltsbindung) — nie eine reine Token-Prüfung.
- Kein Audio persistiert (nur flüchtige Caches in Prozess und Browser). Ein einzelner Satz-Fehler stoppt die Session nicht.
- **Kein Abspielen nach Stop** — Stop nullt die Session, abortet Requests, pausiert Audio, revokiert Object-URLs.
- Abschaltbar über `tts.enabled=false` (Default) → Dock auf beiden Oberflächen nicht im DOM, Routen `404`.

## Tests

- Unit: [tts-segment-dom.test.mjs](../tests/unit/tts-segment-dom.test.mjs) (`<br>`, Listen, Verschachtelung, Skip-Blöcke, Korrektur-Einschübe, Klick-Position, Normalisierung), [tts-player.test.mjs](../tests/unit/tts-player.test.mjs) (Ablauf, Vor während des Ladens, Zurück, 408 ohne / 503 mit Retry, fatale Status, Cache, Pause beim Laden, `updateSegments`, Tempo, Stop), [tts-proof.test.mjs](../tests/unit/tts-proof.test.mjs) + [tts-segment.test.mjs](../tests/unit/tts-segment.test.mjs) (Satz-/Chunk-Logik), [tts-config-delivery.test.js](../tests/unit/tts-config-delivery.test.js) (Secret-Leck-Schutz).
- Integration: [tts-proxy.test.js](../tests/integration/tts-proxy.test.js) (`/tts/speak`: disabled/no-text/forward/502/408, `/v1`-Strip, Voice aus Buch-Locale, fremdes Buch → 403, Audio-Cache, `pcm`-Fallback), [share-tts.test.js](../tests/integration/share-tts.test.js) (`/share/:token/tts`: disabled/Token/no-text/OK+Voice/502, fremder Text → 422, normalisierter Text ok, Ratenlimit → 429).
- E2E: [tts-proof.spec.js](../tests/e2e/tts-proof.spec.js) (Notebook-Harness [tts-harness.html](../tests/fixtures/tts-harness.html): Dock, Highlight, Durchlesen, Pause/Resume, Vor/Zurück, Vor während des Ladens, Klick-Sprung, Start ab Markierung, gemerkte Stelle, Pfeiltasten mit Fokus im Dock, `<br>`, Stop-Aufräumen, 404/401, ein Fehler-Toast), [share-tts.spec.js](../tests/e2e/share-tts.spec.js) (Share-Harness [share-tts-harness.html](../tests/fixtures/share-tts-harness.html): Dock, `<br>`, Vor/Zurück pausiert, Tempo, Fehler-Status ohne eingefrorene Tasten, kein Stop im Hintergrund).

## Betreiber (self-hosted Backend)

OpenAI-kompatibler Speech-Endpunkt mit `/v1/audio/speech`: openedai-speech (XTTS-v2 + Piper) / Kokoro-FastAPI. Host + Model + Voice im Admin-Tab „Vorlesen" eintragen, testen, aktivieren.

**Fertiges docker-compose-Setup (GPU, DE + EN): [docs/tts-host/](tts-host/)** — openedai-speech mit XTTS-v2/Piper, Beispiel-`voice_to_speaker.yaml`, Schritt-für-Schritt-Anleitung. Läuft auf Port 8000 parallel zum [STT-Host](stt-host/) (8001).
