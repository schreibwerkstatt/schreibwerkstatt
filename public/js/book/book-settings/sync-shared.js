// Gemeinsame Bausteine der beiden Sync-Abschnitte in den Bucheinstellungen
// (WordPress: ./blog.js, HubSpot: ./hubspot.js). Was die zwei gleich machen —
// laufende Jobs nach einem Reload wiederfinden, Sync-Jobs starten, POST mit
// Fehlercode, Verbindung trennen — steht nur hier.
import { EVT, fetchJson } from './_shared.js';

/** Fehlertext zu einem Server-Code im Namensraum des Providers
 *  (`blog.error.*` bzw. `hubspot.error.*`). `<P>_HTTP_<n>` (jeder nicht eigens
 *  benannte Status, lib/sync/request.js) → der allgemeine HTTP-Text mit dem
 *  Status; sonst unbekannt → der Code selbst. */
export function syncErrorText(providerKey, code) {
  const t = window.__app.t;
  const key = `${providerKey}.error.${code}`;
  const text = t(key);
  if (text && text !== key) return text;
  const m = /^([A-Z]+)_HTTP_(\d{3})$/.exec(String(code || ''));
  if (m) {
    const httpKey = `${providerKey}.error.${m[1]}_HTTP`;
    const httpText = t(httpKey, { status: m[2] });
    if (httpText && httpText !== httpKey) return httpText;
  }
  return code;
}

/** POST mit JSON-Body. Wirft `Error(error_code || failCode)` bei !ok. */
export async function postSyncJson(url, body, failCode) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_code || failCode);
  return data;
}

/** Laufende Jobs dieses Buchs (des eigenen Users) wiederfinden — nach Reload
 *  zeigen die Knöpfe sonst keinen Spinner, bis der User erneut klickt.
 *  `/jobs/active` antwortet `{ jobId, status }` (jobId null = keiner).
 *  Rückgabe: Job-ID je Typ, in derselben Reihenfolge. */
export function rehydrateSyncJobs(bookId, types) {
  const probe = async (type) => {
    try {
      const { jobId, status } = await fetchJson(`/jobs/active?type=${encodeURIComponent(type)}&book_id=${encodeURIComponent(bookId)}`);
      return (jobId && (status === 'running' || status === 'queued')) ? jobId : null;
    } catch { return null; }
  };
  return Promise.all(types.map(probe));
}

/** Sync-Job (Import/Pull/Abgleich) starten und im Job-Footer anmelden. */
export async function startSyncJob(type, bookId, failCode) {
  const data = await postSyncJson(`/jobs/${type}`, { book_id: bookId }, failCode);
  window.dispatchEvent(new CustomEvent(EVT.JOB_ENQUEUED, { detail: { type, jobId: data.jobId } }));
  return data.jobId;
}

/** Verbindung trennen (Links fallen per CASCADE mit). */
export async function deleteSyncConnection(endpointBase, bookId, failCode) {
  const res = await fetch(`${endpointBase}/${bookId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(failCode);
}
