// Sender der Nutzungs-Events (docs/usage-events.md). Eigenes Modul ohne
// Abhängigkeiten, damit Sitzungs-Buchhaltung (usage-sessions.js) und
// Unterkarten es laden, ohne die Karten-Registry mitzuziehen. Nicht im
// OTA-Editor-Bundle verwenden (docs/usage-events.md#regeln).

// Nutzungs-Event an /usage/event (docs/usage-events.md). Nur Events mit
// origin 'client' aus lib/usage-events.js; der Server schneidet `meta` auf die
// kategorialen Felder des Katalogs zu — nie Text uebergeben. `keepalive`, damit
// `editor.close` beim Schliessen des Tabs noch rausgeht. Best-Effort, wirft nie.
export function trackUsageEvent(event, meta = null, bookId = undefined) {
  try {
    const book = bookId !== undefined ? bookId : (window.Alpine?.store('nav')?.selectedBookId || null);
    fetch('/usage/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, meta, book_id: book }),
      credentials: 'same-origin',
      keepalive: true,
    }).catch(() => {});
  } catch (e) { /* Tracking ist Best-Effort, niemals UI blockieren. */ }
}

