// Facade für die geteilten Frontend-Utilities. Sehr breit importiert (Dutzende
// Konsumenten) — alle bisherigen Named-Exports MÜSSEN hier unverändert
// re-exportiert werden. Interne Aufteilung nach Domäne unter `utils/`:
//   format.js    — Zahlen/Dauer/Token/Umfang/Locale + Compute-Helper (Min/Max, Heatmap)
//   date.js      — Zeitzone (appTimezone/tzOpts) + ISO-Datum + relative Zeit-Formatter
//   iso-day.js   — Kalendertag-Arithmetik auf ISO-Strings (UTC-Mittag-Anker)
//   escape.js    — HTML-Escape-Atome (escHtml/escMd)
//   net.js       — Fetch-Wrapper + Status-Reset
//   html.js      — HTML-Bereinigung (Paste-Sanitizing, Style-/Leerblock-Cleanup)
//   html-find.js — tolerantes Suchen/Ersetzen in HTML
//   html-replace-rich.js — Chat-Ersatz mit *kursiv*/**fett** und Absatzteilung
//   markdown.js  — Chat-Markdown → HTML + Mention/Channel-Dekoration
//   textarea.js  — Textarea-Höhe nach Inhalt (field-sizing-Fallback), Inline-Edit-Mount
//   keys.js      — Tastatur-Prädikate (Cmd/Ctrl+S)
//
// `export *` re-exportiert Live-Bindings (z.B. das mutable `CHARS_PER_TOKEN`/
// `appTimezone`), sodass configureTokenEstimate/configureAppTimezone weiterhin
// für alle Importer sichtbar mutieren.
export * from './utils/format.js';
export * from './utils/date.js';
export * from './utils/iso-day.js';
export * from './utils/escape.js';
export * from './utils/net.js';
export * from './utils/html.js';
export * from './utils/html-find.js';
export * from './utils/html-replace-rich.js';
export * from './utils/markdown.js';
export * from './utils/textarea.js';
export * from './utils/keys.js';
