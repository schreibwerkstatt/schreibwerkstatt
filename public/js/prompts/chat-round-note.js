// Zwischenstand der agentischen Chats (Buch-, Recherche-, Plot-, Ideen-Chat): ein
// kurzer Satz vor den Werkzeug-Aufrufen einer Runde. Der Loop zeigt ihn als Notiz im
// Werkzeug-Verlauf und in der Statuszeile (routes/jobs/agentic-chat/run-log.js).
// Gewöhnliche Ausgabe in der Sprache der Frage — die Denk-Zusammenfassungen des
// Providers sind dafür nicht geeignet (eigene Sprache, nicht steuerbar).
//
// Nur Cloud: kleinere lokale Modelle schreiben neben Text gern den Werkzeug-Aufruf
// selbst als Text (WERKZEUG-DISZIPLIN in den Prompts) — dort keine Erzählung.

import { _isLocal } from './state.js';

/** Regelzeilen für den System-Prompt; leer bei lokalen Providern. */
export function roundNoteRule() {
  if (_isLocal) return [];
  return [
    'ZWISCHENSTAND: In JEDER Runde, in der du Werkzeuge aufrufst (ausser `final_answer`) — auch in der zweiten und jeder weiteren —, schreib in derselben Antwort vor den Aufrufen genau einen kurzen Satz in der Sprache der Userfrage, was du nachsiehst und wozu — z. B. «Ich lese, wie Kapitel 9 endet, um den Übergang zu prüfen.» Der Autor sieht ihn als Fortschrittsanzeige. Höchstens 20 Wörter, kein Ergebnis vorwegnehmen, keine Antwort darin: die Antwort steht nur in `final_answer`.',
  ];
}
