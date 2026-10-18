// Dialog „Nicht gespeichert": alles, was offline entstanden ist und der Server
// nicht angenommen hat, plus die lokalen Sicherungen von Entwürfen. Nichts davon
// wird je still verworfen — hier kann der User es kopieren, erneut senden lassen
// oder ausdrücklich wegwerfen.
//
// Quellen:
//  - abgewiesene Anlege-Operationen der Struktur-Warteschlange
//    (repo/structure-queue.js#stuckStructureOps: Abschnitt samt Text),
//  - abgewiesene Ideen (repo/ideen-queue.js#stuckIdeenOps),
//  - Entwurfs-Sicherungen (editor/draft-storage.js#listDraftBackups):
//    `discarded` (im Notebook-Konfliktdialog verworfene Fassung), `recovered`
//    (alter Entwurf, den der Start zu spät sah), `orphan` (Entwurf eines
//    inzwischen gelöschten Abschnitts).
//
// Als Methoden-Modul in die Root gespreadet (app.js) wie app-outbox.js.
import { stuckStructureOps, retryStuckStructureOps, discardStructureOp } from '../repo/structure-queue.js';
import { stuckIdeenOps, retryStuckIdeenOps, discardIdeenOp } from '../repo/ideen-queue.js';
import { listDraftBackups, removeDraftBackup } from '../editor/draft-storage.js';
import { htmlToText, localeTag, tzOpts } from '../utils.js';
import { EVT } from '../events.js';

export const appOfflineRescueMethods = {
  offlineRescueCount: 0,
  offlineRescueItems: [],

  _installOfflineRescue(signal) {
    const refresh = () => this._refreshRescueCount();
    for (const ev of [EVT.DRAFT_BACKUP, EVT.DRAFT_CHANGED, EVT.STRUCTURE_QUEUE_CHANGED, EVT.IDEEN_QUEUE_CHANGED]) {
      window.addEventListener(ev, refresh, { signal });
    }
    window.addEventListener(EVT.DRAFT_BACKUP, (e) => {
      if (e.detail?.kind === 'recovered') this.setStatus?.(this.t('offline.rescue.recoveredNotice'), true, 10000);
    }, { signal });
    refresh();
  },

  async _refreshRescueCount() {
    let ideen = [];
    try { ideen = await stuckIdeenOps(); } catch { /* ohne IndexedDB */ }
    const n = stuckStructureOps().length + ideen.length + listDraftBackups().length;
    if (this.offlineRescueCount !== n) this.offlineRescueCount = n;
    if (this.$refs?.offlineRescueDialog?.open) await this._loadRescueItems(ideen);
  },

  _pageLabel(pageId) {
    const p = this.$store.nav.pages.find((x) => String(x.id) === String(pageId));
    return p?.name || this.t('offline.rescue.unknownSection', { id: pageId });
  },

  async _loadRescueItems(ideen = null) {
    const items = [];
    for (const op of stuckStructureOps()) {
      items.push({
        id: 's:' + op.qid, kind: 'section', qid: op.qid,
        title: op.body?.name || this.t('offline.rescue.untitled'),
        text: htmlToText(op.body?.html || ''), at: op.at || 0,
        reason: this._rescueReason(op.stuck, 'section'),
      });
    }
    for (const op of ideen || (await stuckIdeenOps().catch(() => []))) {
      // Kein Titel: die Idee IST ihr Text (die Art steht schon davor).
      items.push({
        id: 'i:' + op.qid, kind: 'idea', qid: op.qid,
        title: '', text: op.body?.content || '', at: op.at || 0,
        reason: this._rescueReason(op.stuck, 'idea'),
      });
    }
    for (const b of listDraftBackups()) {
      items.push({
        id: 'b:' + b.key, kind: b.kind, key: b.key,
        title: this._pageLabel(b.pageId), text: htmlToText(b.html), at: b.savedAt,
      });
    }
    this.offlineRescueItems = items.sort((a, b) => b.at - a.at);
  },

  // Warum der Server abgelehnt hat — damit klar ist, was vor „Erneut
  // versuchen" zu beheben ist. `status` ist der HTTP-Status der Ablehnung.
  _rescueReason(status, kind) {
    if (status === 403) return this.t('offline.rescue.reason.forbidden');
    if (status === 404 || status === 400) return this.t(kind === 'idea' ? 'offline.rescue.reason.goneIdea' : 'offline.rescue.reason.goneSection');
    return this.t('offline.rescue.reason.rejected');
  },

  rescueKindLabel(item) {
    return this.t('offline.rescue.kind.' + item.kind);
  },

  rescueTime(item) {
    if (!item.at) return '';
    return new Date(item.at).toLocaleString(localeTag(this.$store.shell?.uiLocale), tzOpts({ dateStyle: 'medium', timeStyle: 'short' }));
  },

  async openOfflineRescue() {
    await this._loadRescueItems();
    const dlg = this.$refs.offlineRescueDialog;
    if (dlg && !dlg.open) dlg.showModal();
  },

  closeOfflineRescue() {
    this.$refs.offlineRescueDialog?.close();
  },

  async rescueCopy(item) {
    try {
      await navigator.clipboard.writeText(item.text);
      this.setStatus?.(this.t('offline.rescue.copied'), false, 3000);
    } catch {
      this.setStatus?.(this.t('offline.rescue.copyFailed'), true, 6000);
    }
  },

  async rescueRetry() {
    retryStuckStructureOps();
    await retryStuckIdeenOps().catch(() => false);
    this._outboxStuckReported = 0;
    this._outboxIdeenStuckReported = 0;
    await this._flushOutbox?.();
    await this._refreshRescueCount();
    await this._loadRescueItems();
  },

  async rescueDiscard(item) {
    const ok = await this.appConfirm?.({
      message: this.t('offline.rescue.discardConfirm', { title: item.title }),
      confirmLabel: this.t('offline.rescue.discard'),
      danger: true,
    });
    if (!ok) return;
    if (item.kind === 'section') discardStructureOp(item.qid);
    else if (item.kind === 'idea') await discardIdeenOp(item.qid);
    else removeDraftBackup(item.key);
    await this._refreshRescueCount();
    await this._loadRescueItems();
    if (!this.offlineRescueItems.length) this.closeOfflineRescue();
  },

  rescueHasRetry() {
    return this.offlineRescueItems.some((i) => i.kind === 'section' || i.kind === 'idea');
  },
};
