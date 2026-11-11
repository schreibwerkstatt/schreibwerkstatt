// Fundstueck-Ebene der Recherche-Karte: Anlegen, Bearbeiten, Pin/Archiv/Loeschen
// und der Uebersichts-Cap des Beschreibungstexts.

import { fetchJson, escHtml } from '../../utils.js';
import { isSelectedBook } from '../../cards/book-guard.js';
import { emptyDraft as _emptyDraft } from './shared.js';
import { normalizeTags } from '../../tag-input.js';

export const rechercheItemMethods = {
  // ── Anlegen (Inline-Formular, partials/recherche-create.html) ────────────
  // Anlegen und Bearbeiten fahren auf DEMSELBEN `draft` und teilen dieselben
  // Formularfelder (partials/recherche-form-fields.html). Offen ist darum
  // höchstens EIN Formular: startCreate speichert ein laufendes Bearbeiten
  // zuerst, und Bearbeiten bei offenem Anlegen fragt, ob der Entwurf verworfen
  // werden darf (openDetail). LESEN geht neben dem Anlegen — wer beim Erfassen
  // in einem anderen Fundstück nachschaut, verliert seinen Entwurf nicht.
  async startCreate() {
    if (this.detailEditing && this.detailItemId != null) {
      const prev = (this.items || []).find(i => i.id === this.detailItemId);
      if (prev && !(await this.commitEdit(prev))) return;
    }
    this.draft = _emptyDraft();
    this.clearCreateFile();
    this.errorMessage = '';
    this.formError = '';
    this.creating = true;
    this.$nextTick(() => {
      document.querySelector('#recherche-card .recherche-create .recherche-title-input')?.focus();
    });
  },
  // Fasst die Textfelder von `draft` NICHT an: `draft` teilt sich das Anlegen mit
  // dem Bearbeiten, und openDetail(item, { edit: true }) schliesst zuerst das
  // Anlegen und füllt dann `draft`. Gefüllt wird `draft` nur von
  // startCreate/startEdit.
  closeCreate() {
    if (!this.creating) return;
    this.creating = false;
    this.clearCreateFile();
    this.formError = '';
  },
  // Hat das Anlegen-Formular Inhalt, der beim Schliessen verloren ginge? Der
  // Typ allein zählt nicht (er hat immer einen Wert).
  createDirty() {
    if (!this.creating) return false;
    const d = this.draft || {};
    return !!((d.title || '').trim() || (d.body || '').trim() || (d.source || '').trim()
      || (d.urls || []).some(u => (u.url || '').trim() || (u.label || '').trim())
      || (d.tags || []).length || d.fileName);
  },

  // Datei-Auswahl beim Anlegen: File NICHT in reaktivem State halten (ein Alpine-
  // Proxy bricht File.arrayBuffer mit „Illegal invocation"), nur den Anzeige-Namen.
  // Das echte File wird beim Speichern via x-ref aus dem Input gelesen.
  onCreateFilePick(ev) {
    const file = ev?.target?.files?.[0];
    if (!file) { this.draft.fileName = ''; return; }
    this.draft.fileName = file.name;
    // Typ nur nachziehen, wo der Server ihn beim Upload ohnehin umstellt
    // (routes/research-media.js: aus note/link wird image/document) — ein
    // bewusst gewähltes Zitat oder Faktum bleibt, was es ist.
    if (!['note', 'link', 'image', 'document'].includes(this.draft.kind)) return;
    if ((file.type || '').startsWith('image/')) this.draft.kind = 'image';
    else if (file.type === 'application/pdf') this.draft.kind = 'document';
  },
  clearCreateFile() {
    this.draft.fileName = '';
    if (this.$refs?.createFile) this.$refs.createFile.value = '';
  },

  async createItem() {
    const app = window.__app;
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || this.busy) return;
    const d = this.draft;
    const file = this.$refs?.createFile?.files?.[0] || null;
    const hasText = !!((d.title || '').trim() || (d.body || '').trim() || (d.urls || []).some(u => (u.url || '').trim()));
    if (!hasText && !file) {
      this.formError = app.t('recherche.error.empty');
      return;
    }
    this.busy = true;
    try {
      const payload = this._draftBody(d);
      // Reiner Datei-Eintrag ohne Text: Server verlangt ein nicht-leeres Feld →
      // Dateiname als Titel, damit das Item benannt ist (kind setzt der Upload).
      if (!hasText && file && !payload.title) payload.title = file.name.slice(0, 300);
      const post = (extra = {}) => fetchJson('/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId, ...payload, ...extra }),
      });
      let row;
      try {
        row = await post();
      } catch (e) {
        if (!isSelectedBook(bookId)) return;
        // Link liegt schon an einem Fundstück dieses Buchs (409 DUPLICATE_URL):
        // nachfragen statt still eine Dublette anzulegen — zwei Zitate aus
        // derselben Seite sind aber legitim, darum übersteuerbar.
        if (e?.status !== 409 || e.body?.error_code !== 'DUPLICATE_URL') throw e;
        const ok = await app.appConfirm({
          message: app.t('recherche.error.duplicateUrlConfirm', { title: e.body?.params?.title || '' }),
        });
        if (!ok || !isSelectedBook(bookId)) {
          // Nein: das bestehende Fundstück zum Lesen aufklappen, das Formular
          // samt Entwurf bleibt offen (Lesen geht neben dem Anlegen).
          if (!ok) this._focusRechercheItemById(e.body.existing_id);
          return;
        }
        row = await post({ allow_duplicate: true });
      }
      // Buch inzwischen gewechselt: das Fundstueck liegt im alten Buch und gehoert
      // nicht in die Liste des neuen (der Reset hat das Anlegen schon geschlossen).
      if (!isSelectedBook(bookId)) return;
      this.items = [row, ...this.items];
      // Datei nachladen (image/* → Bild, application/pdf → Dokument); uploadXxx
      // ersetzt das eben eingefügte Item per id und setzt kind serverseitig.
      let uploaded = true;
      if (file) {
        if ((file.type || '').startsWith('image/')) uploaded = await this.uploadImage(row, file);
        else if (file.type === 'application/pdf') uploaded = await this.uploadDoc(row, file);
      }
      if (!isSelectedBook(bookId)) return;
      this._loadTags();
      this._loadResearchTotals();
      if (!uploaded) {
        // Das Fundstueck steht, nur der Anhang fehlt: nicht im Anlegen-Formular
        // bleiben (ein zweites Speichern legte eine Dublette an), sondern das neue
        // Fundstueck oeffnen, wo der Anhang erneut gewaehlt werden kann. Die
        // Meldung nach openDetail wieder setzen — dessen closeCreate leert sie.
        // Die Meldung des Uploads über das Öffnen retten: der Zeilenwechsel darf
        // den Grund, warum der Anhang fehlt, nicht wegräumen.
        const msg = this.errorMessage;
        this.closeCreate();
        await this.openDetail(row);
        this.errorMessage = msg;
        return;
      }
      this.closeCreate();
      // Neu laden statt vorne einfügen: Position und Sichtbarkeit bestimmen
      // Sortierung und Filter des Servers (angeheftet zuerst). Danach die neue
      // Zeile zeigen — oder sagen, dass der Filter sie ausblendet.
      await this.loadRecherche();
      if (!isSelectedBook(bookId)) return;
      if ((this.items || []).some(i => i.id === row.id)) this._flashResearchRow(row.id);
      else this.noticeMessage = app.t('recherche.createdHidden');
    } catch (e) {
      if (isSelectedBook(bookId)) this.formError = this._rechercheErrorText(e, 'recherche.error.save');
    } finally {
      this.busy = false;
    }
  },

  // Zeile ins Bild holen und kurz hervorheben (Permalink-Sprung, neu angelegt).
  _flashResearchRow(id) {
    this.$nextTick(() => {
      const el = this.$root?.querySelector(`[data-research-id="${id}"]`);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      el.classList.remove('research-item--flash');
      void el.offsetWidth; // Reflow → Animation startet auch beim zweiten Mal neu
      el.classList.add('research-item--flash');
      setTimeout(() => el.classList.remove('research-item--flash'), 1600);
    });
  },

  // ── Aufgeklappte Zeile (Lesen) ──────────────────────────────────────────
  // Muster Figuren/Orte: ein Klick klappt das Fundstück in der Liste auf, kein
  // Dialog. Er ÖFFNET es zum Lesen, er bearbeitet es nicht: der Volltext eines
  // erfassten Artikels (bis 20 000 Zeichen) ist in einem Formularfeld nicht
  // lesbar. Bearbeiten ist darin ein eigener Schalter — Verknüpfungen, Tags und
  // Anhänge bleiben dabei sichtbar und bedienbar. Offen ist höchstens eine Zeile.
  // Das Status-Board hat keine Zeile zum Aufklappen: von dort wechselt das
  // Öffnen in die Liste (wie ein Sprung in die Orte-Karte).
  async openDetail(item, { edit = false } = {}) {
    if (!item) return;
    // Läuft in einer anderen Zeile ein Bearbeiten, wird es erst gespeichert
    // (Inline-Edit-Regel: nichts still verwerfen). Scheitert das Speichern,
    // bleibt das Formular offen und die Meldung stehen.
    // Bearbeiten teilt sich `draft` mit dem Anlegen: ein Entwurf mit Inhalt
    // geht nur nach Rückfrage verloren. Lesen lässt das Anlegen offen.
    if (edit && this.creating) {
      if (this.createDirty()) {
        const app = window.__app;
        const ok = await app.appConfirm({
          message: app.t('recherche.confirmDiscardCreate'),
          confirmLabel: app.t('recherche.discardCreate'), danger: true,
        });
        if (!ok) return;
      }
      this.closeCreate();
    }
    if (this.detailEditing && this.detailItemId != null && this.detailItemId !== item.id) {
      const prev = (this.items || []).find(i => i.id === this.detailItemId);
      if (prev && !(await this.commitEdit(prev))) return;
    }
    this.detailItemId = item.id;
    this.detailEditing = false;
    this.closeActionMenu();
    if (edit) this.startEdit(item);
    if (this.viewMode === 'status') this.viewMode = 'list';
    // Permalink-Spiegel: offenes Fundstück → #…/recherche/<itemId>. detailItemId
    // bleibt SSoT in der Karte (analog editingBeatId ↔ plotBeatId in der Plot-
    // Werkstatt).
    if (window.Alpine) window.Alpine.store('nav').rechercheItemId = item.id;
    // Transkript-Block füllen. Nur für Transkript-Fundstücke — für eine Notiz
    // wäre es ein 404 bei jedem Öffnen.
    if (item.kind === 'transcript') this.ivLoadTranscript?.(item.id);
    else { this.ivTranscript = null; this.ivSegments = []; this.ivSpeakerKeys = []; }
    // Schliesst das Aufklappen eine längere Zeile darüber, rutscht diese Zeile
    // nach oben aus dem Bild — dann ihren Kopf zurückholen.
    this.$nextTick(() => {
      const el = this.$root?.querySelector?.(`[data-research-id="${item.id}"]`);
      const top = el?.getBoundingClientRect?.().top;
      if (top != null && (top < 0 || top > window.innerHeight * 0.85)) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  },
  // Kopf-/Titel-Klick: auf- bzw. zuklappen. Eine Zeile im Bearbeiten-Modus
  // klappt nicht per Klick zu — raus geht es über Speichern/Abbrechen.
  toggleDetail(item) {
    if (this.detailItemId !== item.id) return this.openDetail(item);
    if (!this.detailEditing) this.closeDetail();
  },
  closeDetail() {
    this.detailItemId = null;
    this.detailEditing = false;
    this.cancelLinkPicker();
    // Ein in der Zeile geöffnetes Aktionsmenü schliesst mit ihr.
    this.closeActionMenu();
    if (window.Alpine) window.Alpine.store('nav').rechercheItemId = null;
  },

  // ── Bearbeiten (nur in der aufgeklappten Zeile) ──────────────────────────
  startEdit(item) {
    this.detailEditing = true;
    // Der Klick, der das Bearbeiten öffnet (Stift im Zeilenkopf, Eintrag im
    // Aktionsmenü), liegt ausserhalb von `.research-detail` und erreicht dessen
    // @click.outside erst danach — ohne diese Sperre speicherte er sofort wieder.
    this._editOpening = true;
    setTimeout(() => { this._editOpening = false; }, 0);
    this.formError = '';
    this.draft = {
      kind: item.kind || 'note',
      title: item.title || '',
      body: item.body || '',
      urls: (item.urls || []).map(u => ({ url: u.url || '', label: u.label || '' })),
      source: item.source || '',
      tags: [...(item.tags || [])],
      fileName: '',
    };
  },
  // Zurück in den Lesemodus — die Zeile bleibt offen (und damit der Permalink).
  cancelEdit() {
    this.detailEditing = false;
    this.formError = '';
    this.draft = _emptyDraft();
  },
  // Commit eines offenen Bearbeitens (Klick daneben, Wechsel auf eine andere
  // Zeile). Nur wenn noch DIESES Fundstück im Formular steht; ein laufender
  // Request zählt als «schon unterwegs». Liefert true, wenn das Formular zu ist.
  // Klick daneben (@click.outside der aufgeklappten Zeile). Kein Commit für den
  // öffnenden Klick und für Klicks in schwebende Teile der Zeile, die ausserhalb
  // hängen: Verknüpfen-Picker, Aktionsmenü (beide teleportiert), Rückfrage-
  // Dialog, Tooltip.
  onDetailClickOutside(item, ev) {
    if (!this.detailEditing || this.detailItemId !== item?.id || this._editOpening) return;
    if (ev?.target?.closest?.('.picker-popover, .context-menu, dialog, .tip-layer')) return;
    this.commitEdit(item);
  },
  async commitEdit(item) {
    if (!this.detailEditing || this.detailItemId !== item?.id) return true;
    if (this.busy) return false;
    return this.saveEdit(item);
  },
  // Wechsel ins Status-Board: dort gibt es keine aufgeklappte Zeile, also auch
  // keinen Permalink darauf. Ein offenes Bearbeiten wird erst gespeichert;
  // scheitert das, bleibt die Liste stehen (nichts still verwerfen).
  // Der Klick auf den Reiter löst zugleich den Click-outside-Commit der Zeile
  // aus; läuft dessen Request schon, wird er abgewartet statt als Fehlschlag
  // gewertet.
  async _closeDetailForBoard() {
    if (this.detailItemId == null) return;
    for (let i = 0; this.busy && i < 200; i++) await new Promise(r => setTimeout(r, 50));
    const item = (this.items || []).find(i => i.id === this.detailItemId);
    if (item && !(await this.commitEdit(item))) { this.viewMode = 'list'; return; }
    if (this.viewMode === 'status') this.closeDetail();
  },

  // URL-Zeilen des geteilten Formular-Fragments (Anlegen + Bearbeiten, `draft`).
  addUrlRow(draft) { if (!Array.isArray(draft.urls)) draft.urls = []; draft.urls.push({ url: '', label: '' }); },
  removeUrlRow(draft, i) { (draft.urls || []).splice(i, 1); },

  // Beschreibungstext als HTML für Board-Anriss und Detailansicht. Notizen und
  // Fakten kommen oft als Markdown (Recherche-Chat-Vorschläge) und
  // laufen durch den Chat-Renderer (escaped, html:false, lädt markdown-it nach).
  // Ein Zitat ist Wortlaut: escaped, nur Zeilenumbrüche — ein `*` im Original
  // darf dort nicht zur Hervorhebung werden.
  // Ab hier wird der Lesetext der aufgeklappten Zeile gekappt (CSS-Zeilen-Cap
  // + «Ganzen Text anzeigen»). Etwa so viel, wie der Cap ohnehin zeigt — kürzere
  // Texte bekommen keinen Umschalter, der nichts aufdeckt.
  isLongBody(item) {
    return (item?.body?.length || 0) > 900;
  },

  itemBodyHtml(item) {
    const body = item?.body || '';
    if (!body) return '';
    if (item.kind === 'quote') return escHtml(body).replace(/\n/g, '<br>');
    return this._renderChatMarkdown(body);
  },

  // Klick auf Kopf oder Anriss klappt die Zeile auf/zu — ausser auf interaktiven
  // Elementen (Aktions-Buttons, Links, Datei-Inputs, Tag-/Link-Chips) sowie
  // dem Verknüpfen-Picker (inkl. Combobox-Dropdown, dessen Optionen <li> sind
  // und sonst durchblubbern würden), die ihre eigene Aktion behalten.
  onItemBodyClick(item, ev) {
    if (this.busy) return;
    if (ev.target.closest('a, button, input, label, .research-tag, .entity-ref, .combobox-wrap')) return;
    // Im Auswahl-Modus markiert ein Klick, statt aufzuklappen.
    if (this.bulkMode) { this.toggleSelect(item.id); return; }
    // Textselektion nicht abwürgen: hat der User Text markiert (Drag löst am
    // Ende ebenfalls ein click aus), nicht auf-/zuklappen.
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) return;
    this.toggleDetail(item);
  },

  async saveEdit(item) {
    if (this.busy) return false;
    this.busy = true;
    try {
      this._replaceItem(await this._patchItem(item.id, this._draftBody(this.draft)));
      // Nach dem Speichern zurück in den Lesemodus, die Zeile bleibt offen: der
      // User will sehen, was er geschrieben hat.
      this.detailEditing = false;
      this.draft = _emptyDraft();
      this.formError = '';
      this._loadTags();
      return true;
    } catch (e) {
      // Meldung IM Formular: die Kartenzeile oben läge bei einer Zeile weiter
      // unten ausserhalb des Bildes, und das Formular bliebe ohne Grund offen.
      this.formError = this._rechercheErrorText(e, 'recherche.error.save');
      return false;
    } finally {
      this.busy = false;
    }
  },

  // Teil-Aktualisierung eines Fundstuecks. Vier Aufrufer (Speichern, Anheften,
  // Archivieren, Feld-Edit) schickten dieselben drei Zeilen Fetch-Aufbau.
  _patchItem(id, body) {
    return fetchJson(`/research/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  },

  _draftBody(d) {
    // Deckel wie lib/research-validate.js (MAX_TAGS, TAG_MAX); der Server
    // normalisiert autoritativ, hier nur nichts schicken, was er still kappt.
    const tags = normalizeTags(d.tags, { max: 20, maxLen: 60 });
    const urls = (d.urls || [])
      .map(u => ({ url: (u.url || '').trim(), label: (u.label || '').trim() }))
      .filter(u => u.url);
    return {
      kind: d.kind, title: d.title.trim(), body: d.body.trim(),
      urls, source: d.source.trim(), tags,
    };
  },

  // Nach dem Anheften neu laden statt lokal umzusortieren: die Reihenfolge
  // bestimmt der Server je `sortBy` (routes/research.js FIXED_SORTS + link:<kind>,
  // jeweils `pinned DESC` vorneweg) — eine Kopie davon im Client driftete.
  async togglePin(item) {
    try {
      this._replaceItem(await this._patchItem(item.id, { pinned: !item.pinned }));
      await this.loadRecherche();
    } catch { this.errorMessage = window.__app.t('recherche.error.save'); }
  },

  async toggleArchive(item) {
    // Steht genau dieses Fundstück im Formular, zuerst speichern: das Menü
    // zählt nicht als «Klick daneben», und das Archivieren klappt die Zeile zu.
    if (this.detailEditing && this.detailItemId === item.id) {
      if (!(await this.commitEdit(item))) return;
      item = (this.items || []).find(i => i.id === item.id) || item;
    }
    try {
      await this._patchItem(item.id, { archived: !item.archived });
      // Bei aktivem „nur aktive"-Filter verschwindet das Item aus der Liste.
      // Dann gilt auch die aufgeklappte Zeile nicht mehr (detailItemId zeigte ins Leere).
      if (!this.showArchived) {
        this.items = this.items.filter(i => i.id !== item.id);
        if (this.detailItemId === item.id) this.closeDetail();
      } else { this._replaceItem({ ...item, archived: item.archived ? 0 : 1 }); }
      this._loadResearchTotals();
      // Archivierte Items zählen nicht im Seiten-/Kapitel-Indikator.
      if ((item.links || []).some(l => l.target_kind === 'page')) this._refreshRechercheCounts('page');
      if ((item.links || []).some(l => l.target_kind === 'chapter')) this._refreshRechercheCounts('chapter');
    } catch { this.errorMessage = window.__app.t('recherche.error.save'); }
  },

  async deleteItem(item) {
    const app = window.__app;
    if (!await app.appConfirm({
      message: app.t('recherche.confirmDelete'),
      confirmLabel: app.t('common.delete'), danger: true,
    })) return;
    try {
      await fetchJson(`/research/${item.id}`, { method: 'DELETE' });
      this.items = this.items.filter(i => i.id !== item.id);
      if (this.detailItemId === item.id) this.closeDetail();
      this._loadTags();
      this._loadResearchTotals();
      if ((item.links || []).some(l => l.target_kind === 'page')) this._refreshRechercheCounts('page');
      if ((item.links || []).some(l => l.target_kind === 'chapter')) this._refreshRechercheCounts('chapter');
    } catch { this.errorMessage = app.t('recherche.error.delete'); }
  },

};
