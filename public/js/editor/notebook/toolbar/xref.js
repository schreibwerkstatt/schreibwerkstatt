// Querverweis einfügen (Notebook-Editor). Inline am Caret, nicht als Block —
// darum bewusst KEIN Slash-Menü-Eintrag: das Slash-Menü triggert auf einem
// leeren Block und *ersetzt* ihn (siehe slash.js), ein Querverweis gehört aber
// mitten in den fertigen Satz. Vorbild ist deshalb der Beleg-Picker in cite.js:
// Range sichern → kleines Panel → an der gesicherten Range einfügen.
//
// Der eingefügte Verweis trägt seine Nummer als Text (Cache) und
// `data-xref`/`data-xref-id` als Wahrheit — Markup-SSoT ist
// public/js/xrefs/xref-html.js.
//
// DIE NUMMER IM EDITOR IST EINE VORSCHAU. Sie folgt der nested-arabischen
// Vorgabe (1, 1.1, „Abb. 2.1"). Was im fertigen Dokument steht, entscheidet der
// Ausgabeweg: ein PDF-Profil mit römischer Nummerierung schreibt „Kapitel III",
// eines ohne Nummerierung den Kapiteltitel. Das ist kein Fehler, sondern der
// Kern des Features — lib/xref-render.js setzt den Text bei jedem Export neu.
//
// Nur Notebook: Focus-Editor und Bucheditor stellen Verweise dar und zerstören
// sie nicht, bringen aber keinen Einfügepfad mit.

import { getEditEl, caretRangeIn } from './_shared.js';
import { capHits, cycleIdx, insertHtmlAtRange, onPickerKeydown, panelAnchorFor } from './caret-panel.js';
import { buildXrefHtml, markXrefsAtomic } from '../../../xrefs/xref-html.js';
import { formatXref } from '../../../xrefs/xref-format.js';
// Ziel-Liste und Vorschau-Nummern teilt sich der Picker mit den
// Legenden-Nummern der Leseansichten (xrefs/caption-preview.js) — ein Cache,
// ein Stand.
import { loadXrefTargets, previewNumbers, invalidateXrefTargetCache } from '../../../xrefs/target-cache.js';
import { trackUsageEvent } from '../../../features-usage.js';

export { invalidateXrefTargetCache };

// Deckel der Trefferliste — wie beim Beleg-Picker: mehr als 40 Zeilen scannt
// niemand, und der Picker soll bei langen Büchern nicht zur Endlosliste werden.
const XREF_MAX_HITS = 40;

export const xrefMethods = {
  // Panel öffnen: Caret-Range sichern, positionieren, Ziele laden.
  async openXrefInput() {
    const app = window.__app;
    if (!app?.editMode || app.focusActive) return;
    const editEl = getEditEl();
    if (!editEl) return;
    // Ohne Caret im Edit-Feld kein Verweis: anders als beim Beleg (der auch aus
    // der Seiten-Toolbar kommt und dann ans Ende ankert) hat dieser Picker nur
    // Einstiege AUS dem Text heraus.
    const range = caretRangeIn(editEl);
    if (!range) return;

    this._xrefRange = range.cloneRange();

    const { x, y } = panelAnchorFor(this._xrefRange, editEl);
    this.xrefX = x;
    this.xrefY = y;

    this.xrefQuery = '';
    this.xrefIdx = 0;
    this.xrefFmt = 'label';
    this.xrefError = false;
    this.bubbleShow = false;
    this.xrefShow = true;

    const bookId = window.Alpine?.store('nav')?.selectedBookId;
    if (!bookId) { this.xrefTargets = []; this.xrefHits = []; return; }
    this.xrefLoading = true;
    try {
      const data = await loadXrefTargets(bookId);
      const { chapterLabels, figNums, tblNums, depthById } = previewNumbers(data);
      // Eine flache Liste in Buch-Leserichtung: erst die Kapitel (mit ihrer
      // Hierarchie-Einrückung), dann die Abbildungen, dann die Tabellen. Alle
      // tragen ihre Vorschau-Nummer schon hier, damit der Picker zeigt, was
      // gleich im Text steht.
      this.xrefTargets = [
        ...data.chapters.map(c => ({
          kind: 'chapter',
          target: c.target,
          title: c.title,
          number: chapterLabels.get(String(c.target)) || null,
          depth: depthById.get(String(c.target)) || 1,
        })),
        ...data.figures.map(f => ({
          kind: 'figure',
          target: f.target,
          title: f.title,
          number: figNums.get(f.target) || null,
          depth: 1,
          pageName: f.pageName,
        })),
        ...data.tables.map(t => ({
          kind: 'table',
          target: t.target,
          title: t.title,
          number: tblNums.get(t.target) || null,
          depth: 1,
          pageName: t.pageName,
        })),
      ];
    } catch (_) {
      this.xrefTargets = [];
      this.xrefError = true;
    } finally {
      this.xrefLoading = false;
      this._recomputeXrefHits();
    }
    this.$nextTick(() => {
      const inp = this.$refs?.xrefFilter;
      if (inp) inp.focus();
    });
  },

  // Trefferliste neu berechnen. Ergebnis liegt in `xrefHits` (deklarierter
  // State), nicht als Methode im Template — dieselbe Begründung wie bei
  // `_recomputeCiteHits`: das Panel liest die Liste mehrfach pro Render.
  // Aufrufer: nach dem Laden und der $watch auf `xrefQuery`.
  _recomputeXrefHits() {
    const q = (this.xrefQuery || '').trim().toLowerCase();
    const list = this.xrefTargets || [];
    const hits = q
      ? list.filter(t => `${t.title} ${t.number || ''} ${t.pageName || ''}`.toLowerCase().includes(q))
      : list;
    this.xrefHits = capHits(hits, XREF_MAX_HITS);
    if (this.xrefIdx >= this.xrefHits.length) this.xrefIdx = 0;
  },

  // Vorschautext einer Zeile — genau das, was `_commitXref` einfügen würde.
  xrefPreview(hit) {
    if (!hit) return '';
    const lang = window.__app?.citationLangForCurrentBook || 'de';
    return formatXref({
      kind: hit.kind,
      fmt: this.xrefFmt || 'label',
      entry: { number: hit.number, title: hit.title },
      lang,
    }) || hit.title || '';
  },

  xrefMove(delta) {
    if (!this.xrefHits.length) return;
    this.xrefIdx = cycleIdx(this.xrefIdx, delta, this.xrefHits.length);
  },

  _onXrefKeydown(e) {
    onPickerKeydown(e, {
      onClose: () => this._closeXref(),
      onMove: (d) => this.xrefMove(d),
      onEnter: () => {
        const hit = this.xrefHits[this.xrefIdx];
        if (hit) this._commitXref(hit);
      },
    });
  },

  // Verweis an der gesicherten Range einfügen.
  _commitXref(hit) {
    const editEl = getEditEl();
    const range = this._xrefRange;
    if (!editEl || !range || !hit?.target) { this._closeXref(); return; }

    const text = this.xrefPreview(hit);
    const html = buildXrefHtml({
      kind: hit.kind,
      target: hit.target,
      fmt: this.xrefFmt || 'label',
      text,
    });
    if (!html) { this._closeXref(); return; }

    editEl.focus();

    // `replaceContents`: eine markierte Stelle WIRD hier ersetzt — der Verweis
    // tritt an ihre Stelle im Satz (anders als der Beleg, der sie nachweist).
    // Trennzeichen ist ein gewöhnliches Leerzeichen, weil der Verweis Fliesstext
    // ist; Caret dahinter besorgt der Helfer.
    insertHtmlAtRange(range, html, { after: ' ', replaceContents: true });

    // Der frisch eingefügte Verweis ist noch nicht atomar (markXrefsAtomic läuft
    // sonst nur beim Mount). Direkt nachziehen, sonst tippt der User in den
    // Verweis hinein statt dahinter. Idempotent.
    markXrefsAtomic(editEl);

    window.__app?._markEditDirty?.();
    trackUsageEvent('xref.applied', { kind: hit.kind });
    this._closeXref();
  },

  _closeXref() {
    this.xrefShow = false;
    this.xrefQuery = '';
    this.xrefIdx = 0;
    this.xrefHits = [];
    this.xrefError = false;
    this._xrefRange = null;
    getEditEl()?.focus();
  },
};
