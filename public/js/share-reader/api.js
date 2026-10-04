'use strict';
// Public-Endpunkte des Readers (Threads laden, Kommentar posten/bearbeiten/
// löschen/erledigen, Identität nachziehen). Self-Identität ausschliesslich über
// das reader_token `rt` — kein Login.

async function send(url, method, payload) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(j.error_code || 'ERR');
    err.status = res.status;
    throw err;
  }
  return j;
}

export function createApi({ token, rt, savedEmail }) {
  const base = `/share/${encodeURIComponent(token)}`;
  return {
    async fetchThreads() {
      const res = await fetch(`${base}/threads?rt=${encodeURIComponent(rt)}`, {
        headers: { 'Accept': 'application/json' },
      });
      if (!res.ok) return null;
      const j = await res.json();
      return Array.isArray(j.comments) ? j.comments : [];
    },
    // reader_email aus dem Identitäts-Chip mitschicken → Reply-Benachrichtigung.
    async postComment(payload) {
      const j = await send(`${base}/comment`, 'POST', { reader_email: savedEmail(), ...payload, reader_token: rt });
      return j.comment;
    },
    editOwnComment: (id, body) => send(`${base}/comment/${id}`, 'PATCH', { reader_token: rt, body }),
    // 409 HAS_REPLIES = der Autor hat geantwortet → die UI zeigt für solche
    // Threads keinen Lösch-Button (Schutz vor Cascade), der Status fängt Races ab.
    deleteOwnComment: (id) => send(`${base}/comment/${id}`, 'DELETE', { reader_token: rt }),
    resolveOwnComment: (id, resolved) => send(`${base}/comment/${id}/resolve`, 'PATCH', { reader_token: rt, resolved }),
    async syncIdentity(name, email) {
      try { await send(`${base}/reader-name`, 'POST', { reader_token: rt, reader_name: name, reader_email: email }); } catch {}
    },
  };
}
