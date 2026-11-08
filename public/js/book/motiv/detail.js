// Motiv-Werkstatt — Detail-Editor eines Motivs, geteilt von Seitenpanel (neben der
// Konstellation) und Gliederung (aufgeklappte Zeile). EIN Markup-Fragment
// (partials/motiv-detail.html), EIN Satz Methoden; welcher Ort rendert, entscheidet
// `motivView` gegen den `detailHost` des umgebenden Scopes — es steht nie an zwei
// Orten zugleich im DOM (Comboboxen/Fokus wären sonst doppelt).
//
// Reiter: Details · Fundstellen · Verknüpfungen · Beziehungen. Der gewählte Reiter
// gilt kartenweit (nicht pro Motiv) und ist per localStorage gemerkt.

import { sendJson } from '../../utils.js';
import { lsGet, lsSet } from '../../safe-storage.js';

const TAB_KEY = 'sw:motiv:detail-tab';
export const MOTIV_DETAIL_TABS = ['details', 'occ', 'links', 'relations'];

// Trigger-Eingabe (ein Feld, Komma oder Enter trennt) auf Begriffe normalisieren.
export function splitTriggerInput(text) {
  return String(text || '').split(',').map(s => s.trim()).filter(Boolean);
}

// Begriffe an eine Liste hängen, Dubletten (Gross-/Kleinschreibung egal) übergehen.
export function mergeTriggerTerms(list, add) {
  const out = (list || []).slice();
  const seen = new Set(out.map(t => t.toLocaleLowerCase()));
  for (const t of add) {
    const k = t.toLocaleLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

// Fundstellen nach Kapitel gruppieren, Gruppen in Lesereihenfolge (chapterOrder =
// Kapitel-IDs depth-first). Szenen-/kapitellose Funde landen in einer Restgruppe
// am Ende. Reihenfolge innerhalb einer Gruppe bleibt die des Servers (Score).
export function groupOccurrences(occurrences, chapterOrder, sourceFilter = '') {
  const pos = new Map((chapterOrder || []).map((id, i) => [String(id), i]));
  const groups = new Map();
  for (const o of (occurrences || [])) {
    if (sourceFilter && o.source !== sourceFilter) continue;
    const key = o.chapter_id != null ? String(o.chapter_id) : '';
    if (!groups.has(key)) groups.set(key, { key, name: o.chapter_name || '', items: [] });
    groups.get(key).items.push(o);
  }
  const rank = (g) => (g.key === '' ? Infinity : (pos.has(g.key) ? pos.get(g.key) : 1e9));
  return [...groups.values()].sort((a, b) => rank(a) - rank(b));
}

export const detailMethods = {
  // Reiter-Umschaltung selbst macht Alpine.data('tabs') (x-model auf
  // motivDetailTab); hier nur Lesen/Merken des kartenweiten Stands.
  _readDetailTab() {
    const v = lsGet(TAB_KEY);
    return MOTIV_DETAIL_TABS.includes(v) ? v : 'details';
  },
  _persistDetailTab(tab) {
    if (MOTIV_DETAIL_TABS.includes(tab)) lsSet(TAB_KEY, tab);
  },
  motivDetailTabs() { return MOTIV_DETAIL_TABS; },
  // Zähler je Reiter (Details trägt keinen).
  motivDetailTabCount(tab) {
    if (tab === 'occ') return this.selectedMotif()?.occurrenceCount || 0;
    if (tab === 'links') return this.linkCount();
    if (tab === 'relations') return this.relationsForSelected().length;
    return null;
  },

  // ── Trigger-Begriffe als Chips ─────────────────────────────────────────
  // Puffer `editTriggerTerms` (Liste) + Eingabe-Draft `newTriggerTerm`. Ein noch
  // nicht mit Enter übernommener Draft zählt beim Speichern mit — sonst ginge
  // ein getippter, aber nicht bestätigter Begriff beim Save verloren.
  addTriggerTerm() {
    const add = splitTriggerInput(this.newTriggerTerm);
    if (!add.length) return;
    this.editTriggerTerms = mergeTriggerTerms(this.editTriggerTerms, add);
    this.newTriggerTerm = '';
  },
  removeTriggerTerm(idx) {
    this.editTriggerTerms = this.editTriggerTerms.filter((_, i) => i !== idx);
  },
  // Komma im Eingabefeld übernimmt sofort (wie Enter) — Tippgewohnheit aus der
  // früheren Komma-Liste.
  onTriggerInput() {
    if ((this.newTriggerTerm || '').includes(',')) this.addTriggerTerm();
  },

  // ── Fundstellen: nach Kapitel gruppiert, filterbar nach Quelle ─────────
  occSourceOptions() {
    const t = (k) => window.__app.t(k);
    return [
      { value: 'semantic', label: t('motiv.occ.source.semantic') },
      { value: 'trigger', label: t('motiv.occ.source.trigger') },
    ];
  },
  occGroups() {
    return this._memo('occGroups', [this.occurrences, this.occSourceFilter, this.$store.nav.tree], () =>
      groupOccurrences(this.occurrences, this.bandChapters().map(c => c.id), this.occSourceFilter));
  },
  occGroupLabel(g) {
    return g.key === '' ? window.__app.t('motiv.occ.noChapter') : (g.name || '?');
  },
  // Ort innerhalb der Kapitelgruppe: der Abschnitt (Kapitel steht schon im Kopf)
  // bzw. der Szenentitel.
  occRowLabel(o) {
    return o.page_name || o.scene_titel || '';
  },

  // ── Beziehungen: Typ einer bestehenden Kante ändern ────────────────────
  // Öffnet das Aktionsmenü der Karte mit den kuratierten Typen (ein Klick wählt).
  openRelationTypMenu(ev, rel) {
    this.openActionMenu(ev, `motivrel:${rel.id}`, rel);
  },
  relationMenuRel() {
    return String(this.actionMenuKey || '').startsWith('motivrel:') ? this.actionMenuTarget : null;
  },
  async setRelationTyp(rel, typ) {
    if (!rel || !typ || rel.typ === typ) return;
    try {
      await sendJson(`/motifs/relations/${rel.id}`, 'PATCH', { typ });
      await this.loadBoard();
    } catch (e) {
      this.errorMessage = window.__app.t(e?.status === 409 ? 'motiv.relations.exists' : 'motiv.error.save');
    }
  },
  // Ziel-Optionen fürs Anlegen: alle anderen Motive. Partner, mit denen schon eine
  // Kante besteht, tragen den Hinweis in der Gruppe (Typ ändern statt doppeln).
  relationTargetOptions() {
    const id = this.selectedMotifId;
    const linked = new Set(this.relationsForSelected().map(r => r.otherId));
    const t = (k) => window.__app.t(k);
    return this.motifs.filter(m => m.id !== id).map(m => ({
      value: String(m.id), label: m.name,
      group: linked.has(m.id) ? t('motiv.relations.groupLinked') : t('motiv.relations.groupOther'),
    }));
  },
};
