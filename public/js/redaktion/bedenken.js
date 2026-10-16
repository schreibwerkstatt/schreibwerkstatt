// Freigabe-Bedenken im Browser: Wortlaut des Hinweises beim Freigeben und die
// Zeilen der Übersicht in der Struktur-Karte.
//
// Die Bedenken selbst rechnet der Server (lib/freigabe-bedenken.js) — hier wird
// nur formuliert und sortiert. Pur, ohne Alpine: `t` kommt herein.

/** Ein Bedenken in Sätzen, für den Hinweis beim Freigeben eines Abschnitts. */
export function bedenkenSaetze(b, t) {
  if (!b) return [];
  const out = [];
  if (b.struktur) {
    out.push(t('freigabe.bedenken.struktur', { urteil: t('struktur.urteil.' + b.struktur.urteil) }));
  }
  for (const o of b.otone || []) {
    out.push(t('freigabe.bedenken.oton', {
      title: o.title || t('freigabe.bedenken.ohneTitel'),
      auth: t('sources.otonAuth.' + o.oton_auth),
    }));
  }
  return out;
}

/** Text des Hinweises nach dem Freigeben oder '' (nichts zu melden).
 *  `bedenken` ist beim Abschnitt ein Objekt, beim Kapitel eine Map page_id → Objekt. */
export function bedenkenHinweis(bedenken, { chapter = false } = {}, t) {
  if (!bedenken) return '';
  if (!chapter) {
    const saetze = bedenkenSaetze(bedenken, t);
    return saetze.length ? [t('freigabe.bedenken.pageIntro'), ...saetze].join(' ') : '';
  }
  const list = Object.values(bedenken);
  if (!list.length) return '';
  return t('freigabe.bedenken.chapter', {
    n: list.length,
    struktur: list.filter(b => b.struktur).length,
    otone: list.filter(b => (b.otone || []).length).length,
  });
}

/**
 * Zeilen der Übersicht: Abschnitte mit Bedenken, freigegebene zuerst (dort ist
 * der Widerspruch schon publiziert oder kurz davor), dann in Buchreihenfolge.
 *
 * @param {Record<string, object>} bedenken  page_id → { struktur, otone }
 * @param {Array<{id, name, chapter_id}>} pages  Seiten in Buchreihenfolge
 * @param {Record<string, {status}>} editStatus  page_id → Bearbeitungsstand
 * @param {string} doneStatus  letzte Stufe der Kette ('freigegeben')
 */
export function bedenkenRows(bedenken, pages, editStatus, doneStatus) {
  const order = new Map((pages || []).map((p, i) => [String(p.id), i]));
  const byId = new Map((pages || []).map(p => [String(p.id), p]));
  return Object.entries(bedenken || {})
    .filter(([id]) => byId.has(id))
    .map(([id, b]) => {
      const p = byId.get(id);
      return {
        id: p.id,
        name: p.name || '',
        chapterId: p.chapter_id || null,
        released: !!doneStatus && editStatus?.[id]?.status === doneStatus,
        struktur: b.struktur || null,
        otone: b.otone || [],
      };
    })
    .sort((a, b) => (Number(b.released) - Number(a.released))
      || (order.get(String(a.id)) - order.get(String(b.id))));
}
