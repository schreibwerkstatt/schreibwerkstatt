'use strict';
// Public-Endpunkte des Readers (Threads laden, Kommentar posten/bearbeiten/
// löschen/erledigen, Identität nachziehen). Self-Identität ausschliesslich über
// das reader_token `rt` — kein Login.

import { EVT } from '../events.js';

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

// Fehler eines Schreib-Calls → Text für den Leser. Eine Stelle für alle
// Formulare (Composer, Antwort, Bearbeiten, allgemeine Form), damit z.B. ein
// widerrufener Link überall gleich erklärt wird statt als „Fehler".
export function errorText(err, t) {
  const code = err && err.message;
  if (err && err.status === 429) return t('comment_rate_limited');
  if (code === 'INVALID_EMAIL') return t('email_invalid');
  if (code === 'HAS_REPLIES') return t('delete_has_replies');
  if (code === 'BODY_REQUIRED') return t('form_empty');
  if (code === 'SUGGESTION_OPEN') return t('suggestion_open');
  if (code === 'SUGGESTION_DECIDED') return t('suggestion_decided');
  if (code === 'SUGGESTION_UNCHANGED') return t('suggestion_unchanged');
  if (code === 'REVIEWERS_FULL') return t('review_full');
  if (err && (err.status === 410 || code === 'GONE')) return t('link_gone');
  return t('form_error');
}

export function createApi({ token, rt, savedEmail }) {
  const base = `/share/${encodeURIComponent(token)}`;
  return {
    // null = kein verwertbares Ergebnis (Netz/Server); { gone: true } = der Link
    // ist widerrufen, abgelaufen (410) oder geloescht (404) — der Aufrufer stellt
    // das Pollen ein.
    async fetchThreads() {
      const res = await fetch(`${base}/threads?rt=${encodeURIComponent(rt)}`, {
        headers: { 'Accept': 'application/json' },
      });
      if (res.status === 410 || res.status === 404) return { gone: true };
      if (!res.ok) return null;
      const j = await res.json();
      return Array.isArray(j.comments) ? j.comments : [];
    },
    // reader_email aus dem Identitäts-Chip mitschicken → Reply-Benachrichtigung.
    async postComment(payload) {
      const j = await send(`${base}/comment`, 'POST', { reader_email: savedEmail(), ...payload, reader_token: rt });
      // Für eigenständige Widgets (share-reader/promo.js: Hinweis nach dem ersten Kommentar).
      document.dispatchEvent(new CustomEvent(EVT.SHARE_COMMENT_POSTED));
      return j.comment;
    },
    // `suggestion` (optional): neuer Ersatztext eines eigenen offenen Vorschlags.
    editOwnComment: (id, body, suggestion) => send(`${base}/comment/${id}`, 'PATCH',
      suggestion == null ? { reader_token: rt, body } : { reader_token: rt, body, suggestion }),
    // 409 HAS_REPLIES = der Autor hat geantwortet → die UI zeigt für solche
    // Threads keinen Lösch-Button (Schutz vor Cascade), der Status fängt Races ab.
    deleteOwnComment: (id) => send(`${base}/comment/${id}`, 'DELETE', { reader_token: rt }),
    resolveOwnComment: (id, resolved) => send(`${base}/comment/${id}/resolve`, 'PATCH', { reader_token: rt, resolved }),
    async syncIdentity(name, email) {
      try { await send(`${base}/reader-name`, 'POST', { reader_token: rt, reader_name: name, reader_email: email }); } catch {}
    },
  };
}
