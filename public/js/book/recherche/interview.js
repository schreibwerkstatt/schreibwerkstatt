// Interview-Transkription im Recherche-Board: Aufnahme hochladen, Lauf
// anstossen, Wortlaut lesen, Sprecher benennen.
//
// Das Transkript ist ein Recherche-Fundstück (`kind: 'transcript'`) — deshalb
// liegt seine Verwaltung hier und nicht in einer eigenen Karte. Was die Aufnahme
// hergibt, gehört zum Material, aus dem der Beitrag gebaut wird, genau wie ein
// PDF oder ein Link.
//
// Das EINFÜGEN der O-Töne passiert nicht hier, sondern im Referenz-Panel neben
// dem Editor (cards/reference-interview.js): das Board ist eine Hauptkarte und
// schliesst den Editor, in den der O-Ton soll.

import { fetchJson, sendJson } from '../../utils/net.js';
import { startPoll } from '../../cards/job-helpers.js';
import { formatTimecode, durationLabel, speakerLabel } from '../../interview/timecode.js';
import { lsGet, lsSet } from '../../safe-storage.js';

const LS_KEY = (itemId) => `interview_job_${itemId}`;

export const rechercheInterviewMethods = {
  ivTimecode(s) { return formatTimecode(s); },
  ivDuration(s) { return durationLabel(s); },
  ivSpeakerLabel(key) { return speakerLabel(this.ivSpeakers, key); },

  /** Läuft gerade eine Transkription für dieses Fundstück? */
  ivBusy(itemId) {
    return this.ivRunningItemId === itemId;
  },

  // ── Aufnahme hochladen ─────────────────────────────────────────────────────

  /**
   * Audiodatei an ein bestehendes Fundstück hängen. Der Upload geht als rohes
   * Binary mit dem Datei-Mime im Content-Type — dieselbe Bauform wie beim
   * PDF-Anhang, kein Multipart.
   *
   * Der Transkriptionslauf startet NICHT automatisch mit: ohne Backend gibt es
   * keinen, und selbst mit einem soll der Nutzer entscheiden, wann eine
   * einstündige Aufnahme die GPU belegt. `can_transcribe` aus der Antwort sagt
   * der Karte, ob sie den Knopf überhaupt anbieten darf.
   */
  async ivUploadAudio(itemId, file) {
    if (!file) return;
    this.ivError = '';
    this.ivUploading = true;
    try {
      const r = await fetch(`/research/${itemId}/audio?name=${encodeURIComponent(file.name || '')}`, {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error_code || `HTTP ${r.status}`);
      }
      const data = await r.json();
      this._ivPatchItem(data.item);
      // Transkript-Slot nur fuellen, wenn der Dialog noch dieses Fundstueck zeigt —
      // sonst ueberschriebe der spaete Upload das inzwischen geoeffnete andere.
      if (this.detailItemId !== itemId) return;
      this.ivCanTranscribe = !!data.can_transcribe;
      this.ivTranscript = data.transcript || null;
      this.ivItemId = itemId;
    } catch (e) {
      if (this.detailItemId === itemId) this.ivError = this._ivErrorText(e.code || e.message);
    } finally {
      this.ivUploading = false;
    }
  },

  /** Fehlercode des Servers auf einen Satz abbilden; Unbekanntes bleibt generisch. */
  _ivErrorText(code) {
    const t = window.__app.t.bind(window.__app);
    const known = ['AUDIO_TOO_LARGE', 'UNSUPPORTED_AUDIO', 'NO_AUDIO', 'TRANSCRIBE_DISABLED'];
    return known.includes(code) ? t(`interview.error.${code}`) : t('interview.error.generic');
  },

  /** Geändertes Item in die Board-Liste zurückspiegeln (kind wechselt auf
   *  'transcript', damit die Kachel den Player statt des Notizsymbols zeigt).
   *  Reassign über _replaceItem: der Detail-Dialog liest `detailItem` aus
   *  `items`, und die Memos (Status-Buckets) haengen an der `items`-Referenz. */
  _ivPatchItem(item) {
    if (!item?.id) return;
    const cur = (this.items || []).find(x => x.id === item.id);
    if (cur) this._replaceItem({ ...cur, ...item });
  },

  // ── Transkript lesen ───────────────────────────────────────────────────────

  // Der Transkript-Slot ist EINER fuer den ganzen Dialog. Lade-Token + Pruefung
  // `detailItemId === itemId` nach jedem await: eine spaete Antwort (langsames
  // Netz, Job-Ende nach Wechsel des Fundstuecks) darf nicht das inzwischen
  // geoeffnete andere Fundstueck ueberschreiben.
  async ivLoadTranscript(itemId) {
    if (this.detailItemId !== itemId) return;
    const seq = (this._ivLoadSeq = (this._ivLoadSeq || 0) + 1);
    const current = () => this._ivLoadSeq === seq && this.detailItemId === itemId;
    this.ivError = '';
    this.ivSegments = [];
    this.ivSpeakers = {};
    this.ivItemId = null;
    try {
      const d = await fetchJson(`/research/${itemId}/transcript`);
      if (!current()) return;
      this.ivTranscript = d.transcript || null;
      this.ivSegments = d.segments || [];
      this.ivSpeakers = d.speakers || {};
      this.ivSpeakerKeys = d.speaker_keys || [];
      this.ivCanTranscribe = !!d.can_transcribe;
      this.ivItemId = itemId;
      // Ein Lauf, der beim letzten Besuch noch lief, ist womöglich fertig — der
      // Status kommt vom Server, nicht aus dem Gedächtnis der Karte. Läuft er
      // noch, hängt sich die Karte wieder an seinen Poll.
      if (this.ivTranscript?.status === 'running') await this._ivResume(itemId);
    } catch (e) {
      if (!current()) return;
      // 404 heisst „kein Transkript" und ist kein Fehler: das Fundstück kann
      // eine Aufnahme ohne Lauf sein.
      if (e.status !== 404) this.ivError = this._ivErrorText(e.code || e.message);
      this.ivTranscript = null;
    }
  },

  // Laufenden Transkriptionslauf wieder aufnehmen (Reload, Tab-Wechsel, Dialog
  // erneut geoeffnet). Job-ID aus dem localStorage (ivTranscribe legt sie ab),
  // sonst beim Server nach dem aktiven Lauf fragen (Entity `i<itemId>`). Ohne
  // auffindbaren Job KEINE Sperre setzen — der Lauf ist dann verwaist, und ein
  // gesetztes ivRunningItemId hielte „Transkribieren" fuer jedes Fundstueck zu.
  async _ivResume(itemId) {
    if (this.ivRunningItemId) return;
    let jobId = lsGet(LS_KEY(itemId));
    if (!jobId) {
      try {
        const a = await fetchJson(`/jobs/active?type=interview-transcribe&book_id=i${itemId}`);
        jobId = a?.jobId || null;
      } catch { jobId = null; }
    }
    if (!jobId || this.ivRunningItemId || this.detailItemId !== itemId) return;
    this.ivRunningItemId = itemId;
    this.ivProgress = 0;
    this.ivStatus = window.__app.t('common.analysisRunning');
    this._ivPoll(jobId, itemId);
  },

  // ── Lauf ───────────────────────────────────────────────────────────────────

  _ivIdle() {
    this.ivRunningItemId = null;
    this.ivProgress = 0;
    this.ivStatus = '';
    if (this._ivPollTimer) { clearInterval(this._ivPollTimer); this._ivPollTimer = null; }
  },

  async ivTranscribe(itemId) {
    if (this.ivRunningItemId) return;
    this.ivError = '';
    this.ivRunningItemId = itemId;
    this.ivProgress = 0;
    this.ivStatus = window.__app.t('interview.starting');
    try {
      const { jobId } = await sendJson('/jobs/interview-transcribe', 'POST', { item_id: itemId });
      lsSet(LS_KEY(itemId), jobId);
      this._ivPoll(jobId, itemId);
    } catch (e) {
      this._ivIdle();
      this.ivError = this._ivErrorText(e.code || e.message);
    }
  },

  _ivPoll(jobId, itemId) {
    startPoll(this, {
      timerProp: '_ivPollTimer',
      jobId,
      lsKey: LS_KEY(itemId),
      progressProp: 'ivProgress',
      onProgress: (job) => {
        this.ivStatus = window.__app.t(job.statusText, job.statusParams);
      },
      onDone: async () => {
        this._ivIdle();
        await this.ivLoadTranscript(itemId);
      },
      onNotFound: () => {
        this._ivIdle();
        if (this.detailItemId === itemId) this.ivError = window.__app.t('interview.interrupted');
      },
      onError: (job) => {
        this._ivIdle();
        if (this.detailItemId === itemId) this.ivError = window.__app.t(job.error, job.errorParams);
        // Den Grund trägt auch die Transkript-Zeile — neu laden, damit die
        // Karte ihn dauerhaft zeigt und nicht nur bis zum nächsten Öffnen.
        this.ivLoadTranscript(itemId);
      },
    });
  },

  // ── Sprecher ───────────────────────────────────────────────────────────────

  /**
   * Sprecher benennen. Danach steht der Name auch im Volltext (der Server setzt
   * ihn neu) — sonst fände man das Zitat nur unter `SPEAKER_01`.
   */
  async ivRenameSpeaker(itemId, key) {
    // Nur am geladenen Transkript: die Sprecher-Entwuerfe gehoeren zu ihm.
    if (this.ivItemId !== itemId) return;
    const draft = this.ivSpeakerDraft[key] || {};
    try {
      const r = await sendJson(`/research/${itemId}/speaker/${encodeURIComponent(key)}`, 'PUT', {
        label: draft.label ?? null,
        rolle: draft.rolle ?? null,
      });
      if (this.ivItemId !== itemId) return;
      this.ivSpeakers = r.speakers || {};
    } catch (e) {
      if (this.ivItemId === itemId) this.ivError = this._ivErrorText(e.code || e.message);
    }
  },

  /** Entwurfsfelder aus dem geladenen Stand vorbelegen. */
  ivEditSpeaker(key) {
    const cur = this.ivSpeakers[key] || {};
    this.ivSpeakerDraft = {
      ...this.ivSpeakerDraft,
      [key]: { label: cur.label || '', rolle: cur.rolle || '' },
    };
  },

  /** Aufnahme verwerfen, Wortlaut behalten — der Audio-BLOB ist der grosse Teil. */
  async ivDropAudio(itemId) {
    if (!await window.__app.appConfirm({ message: window.__app.t('interview.dropAudioConfirm'), danger: true })) return;
    try {
      const r = await sendJson(`/research/${itemId}/audio`, 'DELETE');
      if (this.detailItemId === itemId) this.ivTranscript = r.transcript || null;
    } catch (e) {
      if (this.detailItemId === itemId) this.ivError = this._ivErrorText(e.code || e.message);
    }
  },
};

/** Buch-skopierter Anfangszustand des Slices — vom Karten-Reset mitbenutzt. */
export const rechercheInterviewState = () => ({
  ivTranscript: null,
  // Fundstueck, dessen Transkript im Slot steht (null = keins geladen).
  ivItemId: null,
  ivSegments: [],
  ivSpeakers: {},
  ivSpeakerKeys: [],
  ivSpeakerDraft: {},
  ivCanTranscribe: false,
  ivUploading: false,
  ivRunningItemId: null,
  ivProgress: 0,
  ivStatus: '',
  ivError: '',
});
