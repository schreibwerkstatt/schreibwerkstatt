// figurenRelCheckMethods — Beziehungsprüfung in der Figurenkarte, gespreadet in
// cards/figuren-card.js. Dieselbe Prüfung, die den Fine-Tuning-Export anhält
// (routes/jobs/finetune-export/lib/relation-check.js), hier nur als Hinweis:
// Liste über der Figurenliste und Markierung der betroffenen Beziehungen im
// Figuren-Detail. GET /figures/:book_id/relation-check rechnet ohne KI, darum
// lädt die Karte nach jedem Katalog-Reload neu. Korrigiert wird nichts.
//
// Kein `get x()` in diesem gespreadeten Modul (Spread-Getter-Falle).

import { fetchJson } from '../utils.js';

export const figurenRelCheckState = () => ({
  // { conflicts, mainCount, edges } — `edges` = die Kanten hinter den Quellen
  // `relation:<id>` ({ id, from, to, typ }, fig_id).
  figurenRelCheck: { conflicts: [], mainCount: 0, edges: [] },
  _figurenRelCheckSeq: 0,
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
    const seq = ++this._figurenRelCheckSeq;
    if (!bookId) { this.figurenRelCheck = figurenRelCheckState().figurenRelCheck; return; }
    try {
      const r = await fetchJson(`/figures/${encodeURIComponent(bookId)}/relation-check`);
      // Buchwechsel oder neuer Katalog-Reload dazwischen: die spätere Antwort gilt.
      if (seq !== this._figurenRelCheckSeq || String(Alpine.store('nav').selectedBookId) !== String(bookId)) return;
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

  // Konflikte, an denen die Figur beteiligt ist (Detail-Hinweis).
  figurRelConflicts(f) {
    return this.figurenRelCheck.conflicts.filter(c => c.figIds.includes(f.id));
  },
};
