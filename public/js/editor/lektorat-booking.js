// Buchung am Lektorat-Lauf (`page_checks.applied_errors_json` /
// `selected_errors_json` / `saved`): der einzige Schreiber für
// `PATCH /history/check/:id/saved` im Frontend. Konsumenten: «Korrekturen
// speichern» (lektorat.js#saveCorrections), «Korrekturen rückgängig»
// (lektorat-undo.js), Übernehmen im Edit-Modus (lektorat-live.js) und der
// Gespeichert-Schalter im Verlauf (book/history.js).
//
// Der PATCH ersetzt die Listen, er ergänzt nicht. Darum liest jede Änderung den
// Serverstand frisch (`/details`) und rechnet ihre Änderung darauf — ein Stand
// aus der Session (Verlaufseintrag) kennt die Buchungen der anderen Wege nicht
// und würde sie überschreiben. Je Lauf laufen die Änderungen hintereinander:
// jede sieht, was die vorige geschrieben hat.

const _chain = new Map();

function _enqueue(checkId, task) {
  const run = (_chain.get(checkId) || Promise.resolve()).catch(() => {}).then(task);
  _chain.set(checkId, run);
  run.finally(() => { if (_chain.get(checkId) === run) _chain.delete(checkId); }).catch(() => {});
  return run;
}

async function _patch(checkId, body) {
  const r = await fetch('/history/check/' + checkId + '/saved', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

// Verlaufseintrag der offenen Seite nachführen, wie der Server ihn jetzt hat.
function _syncEntry(entry, { saved, applied, selected }) {
  if (!entry) return;
  if (entry.saved !== saved) entry.saved_at = saved ? new Date().toISOString() : null;
  entry.saved = saved;
  if (applied) entry.applied_errors_json = applied;
  if (selected) entry.selected_errors_json = selected;
}

/** Gebuchte Listen eines Laufs, frisch vom Server. */
export async function fetchBookedLists(checkId) {
  const r = await fetch('/history/check/' + checkId + '/details');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  return { applied: d.applied_errors_json || [], selected: d.selected_errors_json || [] };
}

/** Gebuchte Form eines Befunds: ohne die transienten Laufzeit-Flags. */
export function bookingEntry(f) {
  const { umgeschrieben, erledigt, mehrfach, ...rest } = f;
  return rest;
}

/** `items` an `existing` anhängen, je `original` einmal. */
export function mergeByOriginal(existing, items) {
  const seen = new Set((existing || []).map(e => e.original));
  return [...(existing || []), ...(items || []).filter(e => !seen.has(e.original))];
}

/** `list` ohne die Einträge, deren `original` in `originals` (Set) steht. */
export function withoutOriginals(list, originals) {
  return (list || []).filter(e => !originals.has(e.original));
}

/**
 * Gebuchte Listen eines Laufs ändern. `change(prev)` bekommt den frischen
 * Serverstand `{ applied, selected }` und liefert `{ applied, selected, saved? }`
 * (`saved` fehlt → true, wie am Server). `entry` (optional): Verlaufseintrag,
 * der danach den Serverstand spiegelt. Liefert `{ prev, next }`, wirft bei Fehlern.
 */
export function patchBookedLists(checkId, change, { entry = null } = {}) {
  return _enqueue(checkId, async () => {
    const prev = await fetchBookedLists(checkId);
    const next = change(prev);
    const saved = next.saved ?? true;
    await _patch(checkId, { saved, applied_errors_json: next.applied, selected_errors_json: next.selected });
    _syncEntry(entry, { saved, applied: next.applied, selected: next.selected });
    return { prev, next: { ...next, saved } };
  });
}

/** Nur den Gespeichert-Status eines Laufs setzen (Listen bleiben). Wirft bei Fehlern. */
export function patchCheckSaved(checkId, saved, { entry = null } = {}) {
  return _enqueue(checkId, async () => {
    await _patch(checkId, { saved });
    _syncEntry(entry, { saved });
  });
}
