// Fehlerklassen eines gescheiterten Page-Saves (Notebook-Editor). Rein, ohne
// Imports — auch die Statuszeile des Roots (app/app-ui.js#saveIndicatorText)
// liest daraus, ob ein Fehler auf einen neuen Versuch wartet oder hängt.
//
// contentRepo (repo/content.js#_httpError) hängt `status`/`code`/`body` an den
// Fehler. Ohne Status kam keine Antwort → Netz.

export function classifySaveError(e) {
  const s = e?.status;
  if (typeof s !== 'number') return 'network';
  if (s === 423) return 'locked';
  if (s === 401) return 'auth';
  if (s === 403) return 'forbidden';
  if (s === 404) return 'notFound';
  if (s === 429 || s >= 500) return 'server';
  return 'rejected';
}

// Ein neuer Versuch lohnt nur, wenn sich der Grund von selbst erledigen kann:
// Netz zurück, Server wieder da, nach dem Neu-Anmelden (401 → Session-Banner).
// Gesperrt/kein Recht/gelöscht/abgewiesen ändert sich durch Wiederholen nicht —
// dort hielte der Online-/Fokus-Retry die Seite in einer Endlosschleife.
const RETRYABLE = new Set(['network', 'server', 'auth']);

export function isRetryableSaveError(kind) {
  return !kind || RETRYABLE.has(kind);
}
