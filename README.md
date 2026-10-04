# schreibwerkstatt.app

Schreiben, Lektorat und Buchanalyse mit KI. Eigenständiger Node.js-Service, Multi-User mit Rollen-ACL pro Buch. Inhalte (Bücher/Kapitel/Seiten) liegen lokal in SQLite — keine externe Storage-Abhängigkeit.

## Gehostete Version

Wer nicht selbst hosten will, kann die betriebene Instanz unter **[schreibwerkstatt.app](https://schreibwerkstatt.app)** nutzen — gleicher Stand wie dieses Repository, ohne eigene Installation, Reverse-Proxy-Konfiguration oder API-Keys. Zugang über Selbst-Registrierung mit Admin-Freigabe; die nativen Clients für macOS und Android verbinden sich ebenfalls dorthin.

Das übrige README beschreibt das **Selbst-Hosting** und die Architektur — für die gehostete Version ist davon nichts nötig.

## Features

### Schreiben & Editor
- **Bearbeitungsmodus** (Notebook-Editor) – Seiten direkt bearbeiten. Auto-Save (Idle 60 s / Max 120 s), lokaler Draft (localStorage), Offline-Modus mit Retry, Block-Level-Merge bei parallelen Edits mit Konflikt-Auflösung.
- **Fokusmodus** (Cmd/Ctrl+Shift+E) – Vollbild, Typewriter-Scroll, Absatz-Hervorhebung. Auto-Save, Schreibzeit-Tracking, Live-Zeichen-/Wortzähler, Mobile-/IME-Support. Auch als native Clients (offline-first, lokaler SQLite-Store + Sync) verfügbar: **macOS** im [Mac App Store](https://apps.apple.com/app/id6797073919?mt=12) (Quellcode: [schreibwerkstatt-focuseditor](https://github.com/schreibwerkstatt/focuseditor)), **Android** [schreibwerkstatt-mobile](https://github.com/schreibwerkstatt/mobile).
- **Bucheditor** – Ganzes Buch als scrollbarer Stream mit Kapitel-Trennern und Outline. Inline-Edit pro Seite, Save-All sequenziell. Buchweite Suche & Ersetzen (Case/Whole-Word, Treffer-Navigation, Replace-All).
- **Live-Rechtschreibung** – Optionale LanguageTool-Integration (self-hosted, regelbasiert) auf allen drei Editoren und Prosa-Formularfeldern, mit eigenem Wörterbuch. [docs/languagetool.md](docs/languagetool.md).
- **Diktat** – Speech-to-Text im Notebook-Editor über einen self-hosted Whisper-Endpunkt. [docs/stt.md](docs/stt.md).
- **Vorlesen** – Text-to-Speech / Proof-Listening in der Notebook-Leseansicht. [docs/tts.md](docs/tts.md).
- **Volltextsuche** – FTS5-Index über alle Seiten, Filterung nach Kapitel/Buch.
- **Buchorganizer** – Kapitel & Seiten per Drag&Drop ordnen, anlegen, umbenennen, löschen. Kapitel-Hierarchie bis 3 Ebenen. [docs/chapter-hierarchy.md](docs/chapter-hierarchy.md).
- **Ordner-Import** – Tagebuch-Archive (ZIP mit Jahr/Monat/Tag-Struktur) mit regelbasierter Datumserkennung + KI-Fallback. [docs/folder-import.md](docs/folder-import.md).
- **Seiten-Verlauf** – Revisionen pro Seite mit Vergleich + Restore.
- **Fassungen** – Ganze-Buch-Snapshots als Manuskript-Meilensteine. [docs/fassungen.md](docs/fassungen.md).

### KI-Lektorat & Chat
- **Abschnitts-Lektorat** – Rechtschreib-, Grammatik- und Stilprüfung mit selektiver Korrekturübernahme.
- **Synonym-Finder** – Wort markieren → Rechtsklick → Vorschläge aus [OpenThesaurus](https://www.openthesaurus.de/) + KI mit Satzkontext.
- **Abschnitts-Chat** – KI-Dialog zu einer Seite. Änderungsvorschläge übernehmbar. [docs/chats.md](docs/chats.md).
- **Buch-Chat** – Agentischer KI-Dialog über das ganze Buch mit Werkzeugen auf vorberechnetem Index; optional Bild-Generierung (`generate_image`). [docs/buchchat-tools.md](docs/buchchat-tools.md), [docs/image.md](docs/image.md).
- **Buchbewertung / Kapitelbewertung** – Stärken, Schwächen, Empfehlungen.

### Analyse & Übersichten
- **Buch-Übersicht** – Dashboard pro Buch: Zeichen-Trend, Schreib-Heatmap, Lektorat-Abdeckung, Top-Fehlertypen, Kapitel-Qualität, Figuren-/Orts-Präsenz.
- **Komplettanalyse** – Pipeline, die Figuren, Schauplätze, Szenen, Ereignisse, Weltfakten, Soziogramm und Kontinuität extrahiert. [docs/komplett.md](docs/komplett.md).
- **Figurenübersicht & Figuren-Werkstatt** – Charakterextraktion mit Beziehungsgraph und jsMind-Mindmap. [docs/graph.md](docs/graph.md), [docs/figur-werkstatt.md](docs/figur-werkstatt.md).
- **Plot-Werkstatt** – Beat-Board zum Planen der Handlung (Kanban & Swimlanes). [docs/plot.md](docs/plot.md).
- **Orte-Karte** – Geocodierte Schauplätze auf interaktiver Leaflet-Karte. [docs/geocode.md](docs/geocode.md).
- **Weltfakten & Kontinuitätsprüfer** – Lore, Regeln und Widerspruchserkennung.
- **Wortschatz-Analyse** – Quantitative Stilistik (MATTR, MTLD, Hapax, Keyness). [docs/wortschatz.md](docs/wortschatz.md).
- **Recherche** – Buchweites Wissensboard mit Entitäten-Verknüpfung und Recherche-Chat. [docs/recherche-chat.md](docs/recherche-chat.md).

### Multi-User & Kollaboration
- **Rollen-ACL pro Buch** – owner / editor / lektor / viewer.
- **Presence & Page-Locks** – Mit-Anwesende und Soft-Locks im Editor.
- **Registrierung mit Approval** – Selbst-Registrierung mit Admin-Freigabe.
- **Share-Links** – Seiten/Kapitel über opaken Token öffentlich teilen. [docs/share-link.md](docs/share-link.md).
- **Admin-Konsole** – Web-UI für User, Bücher, Settings, Kategorien, Usage.

### Export & Tooling
- **Command-Palette** (Cmd/Ctrl+K bzw. `/`) – Fuzzy-Suche und Schnellstart.
- **Fine-Tuning-Export** – JSONL-Trainingsdaten. [docs/finetuning.md](docs/finetuning.md).
- **Buch-Export** – PDF, HTML, Markdown, Plaintext, EPUB.
- **Custom-PDF-Export & EPUB-Export** – Eigener pdfkit-Renderer (PDF/A-2B / PDF/X-3), Google Fonts, Cover-Generierung sowie EPUB-Builder. [docs/publikation-export.md](docs/publikation-export.md).
- **Custom-Word-Export** – Lektorats-/Verlags-Manuskript als DOCX. [docs/word-export.md](docs/word-export.md).
- **Buch-Migration** – Verlustfreier Buch-Round-Trip als `.swbook`-Bundle. [docs/book-migration.md](docs/book-migration.md).

### Integrationen & Monitoring
- **Blog-Sync (WordPress) & HubSpot-Sync** – Synchronisation für Bücher vom Typ `blog`. [docs/blog-sync.md](docs/blog-sync.md), [docs/hubspot-sync.md](docs/hubspot-sync.md).
- **Browser-Erweiterung (Chrome)** – Webseiten als Recherche-Fundstück/Quelle erfassen (`/capture`). [docs/clients.md](docs/clients.md).
- **Metrics-API** – Prometheus-Format (`GET /metrics`), Dashboards für Home Assistant und Grafana. [docs/metrics-api.md](docs/metrics-api.md), [docs/homeassistant/](docs/homeassistant/).

---

## Selbst-Hosting & Deployment

Ausführliche Anleitungen für den Betrieb, Reverse-Proxies, Backups und Testinstanzen:

- **[Deployment & Selbst-Hosting Guide](docs/deployment.md)** – Systemvoraussetzungen, Quick Start, NGINX / NPMplus, veraPDF / EPUBCheck, GitHub-Token, Backups.
- **[Demo-Hosting & Testinstanzen](docs/demo-hosting.md)** – Einrichtung einer separaten Demo-LXC für Store-Reviews, automatisierter Reset-Timer, fixe Device-Tokens und CD-Integration.

## Admin-Konsole

Unter `/admin` für User mit `global_role = 'admin'`:
- **Users, Books, Registration Requests, Settings, Categories, Usage** (Token-Verbrauch).

## Lokale Entwicklung

`LOCAL_DEV_MODE=true` in `.env` überspringt OAuth und legt eine Dev-Session an (`dev@local`).

> Niemals in Produktion – Auth-Guard wird komplett deaktiviert.

## Vertiefende Dokumentation

Alle tiefergehenden Fachkonzepte, Datenmodelle und Architekturentscheidungen liegen in [docs/](docs/):
- Job-Queue & Lifecycle: [docs/jobs.md](docs/jobs.md)
- KI-Provider & Profile: [docs/ai-providers.md](docs/ai-providers.md)
- Schema-ERD: [docs/erd.md](docs/erd.md)
- Testkonventionen: [docs/testing.md](docs/testing.md)
- (und viele weitere spezifische Themen unter `docs/`)

## Lizenz

**GNU Affero General Public License v3.0 oder später** (AGPL-3.0-or-later) – siehe [LICENSE](LICENSE).
