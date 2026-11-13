// figurenRelCheckMethods — Beziehungsprüfung in der Figurenkarte, gespreadet in
// cards/figuren-card.js. Dieselbe Prüfung, die den Fine-Tuning-Export anhält
// (routes/jobs/finetune-export/lib/relation-check.js), hier nur als Hinweis:
// Liste über der Figurenliste und Markierung der betroffenen Beziehungen im
// Figuren-Detail. GET /figures/:book_id/relation-check rechnet ohne KI, darum
// lädt die Karte nach jedem Katalog-Reload neu. Die Prüfung korrigiert nichts;
// an einer gemeldeten Kante entscheidet der Autor per Knopf: entfernen oder — wo
// die Beschreibung eine andere Figur nennt — umhängen (DELETE/PATCH
// /figures/:book_id/relations/:rel_id, db/figures/relation-edits.js).
//
// Kein `get x()` in diesem gespreadeten Modul (Spread-Getter-Falle).

import { fetchJson, sendJson } from '../utils.js';
import { tFetchError } from '../i18n.js';
import { loadToken, isSelectedBook } from '../cards/book-guard.js';

export const figurenRelCheckState = () => ({
  // { conflicts, mainCount, edges } — `edges` = die Kanten hinter den Quellen
  // `relation:<id>` ({ id, from, to, typ }, fig_id).
  figurenRelCheck: { conflicts: [], mainCount: 0, edges: [] },
  _figurenRelCheckSeq: 0,
  // Löschen/Umhängen einer gemeldeten Kante läuft (Knöpfe gesperrt).
  figurBzBusy: false,
});

// Pure: Kante (von, zu, Typ) → Regeln der Konflikte, die sie als Quelle nennen.
export function computeRelConflictIndex(check) {
  const ruleByRel = new Map();
  for (const c of check?.conflicts || []) {
    for (const s of c.sources || []) {
      if (!s.startsWith('relation:')) continue;
      const id = Number(s.slice('relation:'.length));
      if (!ruleByRel.has(id)) ruleByRel.set(id, new Set());
      ruleByRel.get(id).add(c.rule);
    }
  }
  const out = new Map();
  for (const e of check?.edges || []) {
    const rules = ruleByRel.get(e.id);
    if (!rules) continue;
    const key = `${e.from}|${e.to}|${e.typ}`;
    out.set(key, [...new Set([...(out.get(key) || []), ...rules])]);
  }
  return out;
}

export const figurenRelCheckMethods = {
  async loadFigurenRelCheck() {
    const bookId = Alpine.store('nav').selectedBookId;
    const isCurrent = loadToken(this, '_figurenRelCheckSeq', bookId);
    if (!bookId) { this.figurenRelCheck = figurenRelCheckState().figurenRelCheck; return; }
    try {
      const r = await fetchJson(`/figures/${encodeURIComponent(bookId)}/relation-check`);
      // Buchwechsel oder neuer Katalog-Reload dazwischen: die spätere Antwort gilt.
      if (!isCurrent()) return;
      this.figurenRelCheck = { conflicts: r.conflicts || [], mainCount: r.mainCount || 0, edges: r.edges || [] };
    } catch (e) {
      console.error('[figuren] Beziehungsprüfung:', e);
    }
  },

  _resetFigurenRelCheck() {
    this._figurenRelCheckSeq++;
    this.figurenRelCheck = figurenRelCheckState().figurenRelCheck;
  },

  // Regeln, unter denen die Beziehung `bz` der Figur `f` gemeldet ist ([] = keine).
  figurBzConflictRules(f, bz) {
    const idx = this._memo('relConflictIndex', [this.figurenRelCheck], () => computeRelConflictIndex(this.figurenRelCheck));
    return idx.get(`${f.id}|${bz.figur_id}|${bz.typ}`) || [];
  },

  // Vorgeschlagenes neues Ziel einer verrutschten Kante ({ to, toName } | null).
  figurBzRetarget(bz) {
    const idx = this._memo('relRetargetIndex', [this.figurenRelCheck], () => computeRelRetargetIndex(this.figurenRelCheck));
    return (bz?.rel_id != null && idx.get(bz.rel_id)) || null;
  },

  // Gemeldete Kante entfernen. Eine KI-Kante bekommt serverseitig eine Löschmarke —
  // die nächste Komplettanalyse legt sie nicht wieder an.
  async deleteFigurBz(f, bz) {
    if (bz?.rel_id == null || this.figurBzBusy) return;
    const app = window.__app;
    const ok = await app.appConfirm({
      message: app.t('figuren.relcheck.deleteConfirm', {
        von: f.name, typ: app.t('figuren.bz.' + bz.typ), zu: _figName(bz.figur_id),
      }),
      danger: true,
    });
    if (!ok) return;
    await this._figurBzRequest('DELETE', bz.rel_id);
  },

  // Gemeldete Kante auf das Ziel umhängen, das ihre Beschreibung nennt.
  async retargetFigurBz(bz, sug) {
    if (bz?.rel_id == null || !sug?.to || this.figurBzBusy) return;
    await this._figurBzRequest('PATCH', bz.rel_id, { to: sug.to });
  },

  async _figurBzRequest(method, relId, body) {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) return;
    this.figurBzBusy = true;
    try {
      await sendJson(`/figures/${encodeURIComponent(bookId)}/relations/${encodeURIComponent(relId)}`, method, body);
      if (!isSelectedBook(bookId)) return;
      await window.__app.loadFiguren(bookId);
      this.loadFigurenRelCheck();
    } catch (e) {
      console.error('[figuren] Beziehung ändern:', e);
      window.__app.appAlert?.({ message: e?.body || e?.status === 0 ? tFetchError(e) : window.__app.t('figuren.relcheck.editError') });
    } finally {
      this.figurBzBusy = false;
    }
  },
};

function _figName(figId) {
  return (Alpine.store('catalog').figuren || []).find(x => x.id === figId)?.name || figId;
}

// Pure: rel_id → vorgeschlagenes neues Ziel aus den foreignTarget-Konflikten.
export function computeRelRetargetIndex(check) {
  const out = new Map();
  for (const c of check?.conflicts || []) {
    if (c.retarget?.relId != null && c.retarget.to) out.set(c.retarget.relId, { to: c.retarget.to, toName: c.retarget.toName || c.retarget.to });
  }
  return out;
}
