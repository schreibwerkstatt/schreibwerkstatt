// Lokaler Entwurf eines Abschnitts aus Sicht der Ablage (editor/draft-storage.js):
// localStorage ist nur der synchrone Vorlauf, bestätigt liegt der Entwurf in
// IndexedDB. Liefert `{ ls, idb }` (je der Datensatz oder null).

async function draftRecords(page, pageId) {
  return page.evaluate(async (id) => {
    const match = (k) => k === 'editor_draft_' + id || (/^editor_draft_u:/.test(k) && k.endsWith(':' + id));
    let ls = null;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (match(k)) ls = JSON.parse(localStorage.getItem(k));
    }
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('schreibwerkstatt-drafts', 1);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const idb = await new Promise((res) => {
      let hit = null;
      const c = db.transaction('drafts').objectStore('drafts').openCursor();
      c.onsuccess = () => {
        const cur = c.result;
        if (!cur) return res(hit);
        if (match(cur.key)) hit = cur.value;
        cur.continue();
      };
    });
    db.close();
    return { ls, idb };
  }, pageId);
}

// Der gültige Entwurf: der jüngere der beiden Ablagen.
async function readDraftRecord(page, pageId) {
  const { ls, idb } = await draftRecords(page, pageId);
  if (!ls) return idb;
  if (!idb) return ls;
  return (ls.savedAt || 0) >= (idb.savedAt || 0) ? ls : idb;
}

module.exports = { draftRecords, readDraftRecord };
