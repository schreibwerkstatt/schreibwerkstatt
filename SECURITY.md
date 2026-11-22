# Sicherheit

## Eine Lücke melden

**Bitte nicht über ein öffentliches Issue.** Nutze stattdessen die private
Meldefunktion von GitHub:

→ [Security → Report a vulnerability](https://github.com/schreibwerkstatt/schreibwerkstatt/security/advisories/new)

Damit landet die Meldung in einem privaten Advisory, das nur du und die
Maintainer sehen, bis ein Fix bereitsteht. Unsicher, ob die Lücke im Server
oder in einer App steckt? Melde sie einfach hier — sie wird dorthin
weitergereicht, wo sie hingehört.

Hilfreich in der Meldung:

- betroffene Version (Datei `VERSION` der Instanz)
- was passiert, und was stattdessen passieren müsste
- ein möglichst kurzer Reproduktionsweg, ohne echte Buchinhalte oder Zugangsdaten

Eine Rückmeldung kommt innerhalb von **14 Tagen**. Das Projekt entsteht in der
Freizeit — es gibt keine Bereitschaft rund um die Uhr und kein Bug-Bounty. Auf
Wunsch wirst du im Fix-Commit und im Advisory genannt.

## Unterstützte Versionen

Gefixt wird nur die jeweils neueste Version auf `main`. Wer selbst hostet,
aktualisiert wie in [docs/deployment.md](docs/deployment.md#update) beschrieben;
die gehostete Instanz [schreibwerkstatt.app](https://schreibwerkstatt.app) läuft
immer auf dem neuesten Stand.

## Was in den Geltungsbereich fällt

Der Code in diesem Repository. Besonders interessant:

- **Zugriffsrechte** — ein Weg an Bücher, Kapitel oder Abschnitte, für die das
  Konto keine Rolle hat (owner / editor / lektor / viewer), oder an die
  Admin-Konsole ohne Admin-Rolle.
- **Share-Links und die öffentliche Leseansicht** — Zugriff über einen Link
  hinaus, Kommentare an fremden Links, ausführbares Markup im geteilten Text.
- **Geräte- und API-Tokens** (`swd_…`, `sw_…`) — ein Token, das mehr darf als
  sein Scope, oder ein Weg, an fremde Tokens zu kommen.
- **Server-Requests auf vom User bestimmte URLs** (Blog-Sync, PDF-Bilder,
  Recherche-Links, eigener KI-Endpunkt) — jede Umgehung des SSRF-Schutzes in
  [lib/ssrf-guard.js](lib/ssrf-guard.js).
- **Skript-Ausführung** über Abschnitts-HTML, Chat-Antworten oder KI-Ausgaben,
  trotz Sanitizer und Content Security Policy.

## Was nicht in den Geltungsbereich fällt

- **Die Clients** ([focuseditor](https://github.com/schreibwerkstatt/focuseditor),
  [mobile](https://github.com/schreibwerkstatt/mobile),
  [browser-extension](https://github.com/schreibwerkstatt/browser-extension),
  [homeassistant](https://github.com/schreibwerkstatt/homeassistant)) — jeweils
  eigenes Repository mit eigener `SECURITY.md` und demselben Meldeweg.
- **Fehlkonfiguration einer eigenen Instanz**, etwa `LOCAL_DEV_MODE=true` in
  Produktion (schaltet die Anmeldung bewusst ab) oder ein Server ohne TLS.
- **Inhalte, die die KI erzeugt** — falsche oder unpassende Antworten sind ein
  Qualitäts-, kein Sicherheitsproblem, solange sie nicht ausgeführt werden.
- **Abhängigkeiten** — bitte den jeweiligen Projekten melden. Ist eine Lücke dort
  *hier* konkret ausnutzbar, ist sie sehr wohl eine Meldung wert.
