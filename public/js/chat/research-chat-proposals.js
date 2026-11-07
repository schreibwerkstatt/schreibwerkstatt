// Speicher-Vorschläge des Recherche-Chats (propose_research_item) — Methoden,
// gespreadet über researchChatMethods in die rechercheCard.
//
// Gespeichert-Status ist SERVERSEITIG persistiert (`context_info.proposals[i].
// saved_item_id`, gesetzt von POST /research/chat-proposal) — nach einem Reload
// zeigt der Vorschlag weiter „gespeichert" und springt per Klick zum Eintrag.
// `exists_item_id` setzt schon das Tool (Abgleich URL/Titel mit dem Archiv) bzw.
// eine 409-Antwort beim Speichern: dann „schon im Board" statt Speichern-Knopf.
//
// Jede URL trägt `verified` (vom Job: in diesem Lauf abgerufen/geliefert ja/nein).
// Eine ungeprüfte URL steht in Warn-Optik und ist VORAB ABGEWÄHLT: einzeln
// gespeichert geht sie nur mit, wenn der User sie ausdrücklich wieder aufnimmt.
// Ein Vorschlag mit ungeprüfter URL fällt aus «Alle speichern». Einzelne Links
// lassen sich vor dem Speichern weglassen (`edits.urls`, nur Teilmenge der
// eigenen URLs). `_proposalRemovedUrls[key]` hält die vom Default ABWEICHENDEN
// URLs: eine geprüfte darin ist weggelassen, eine ungeprüfte darin aufgenommen.
//
// Lokale Updates ersetzen die Nachricht im Array (neues Objekt), statt das
// x-for-Item zu mutieren: Mutationen am Proxy nach einem await schlagen nicht
// zuverlässig ins Template durch.
import { sendJson, urlHost } from '../utils.js';
import { trackChatProposal } from '../features-usage.js';

const PROPOSAL_KINDS = ['note', 'link', 'quote', 'fact'];
const _key = (msg, pi) => `${msg?.id ?? 'x'}:${pi}`;

export const researchProposalMethods = {
  // Nur neue Fundstücke (ohne `type`): Änderungen an bestehenden Einträgen
  // (research-chat-changes.js) und Ideen (`idee_create`, chat-idee-proposals.js)
  // stehen laut Job HINTER ihnen, der Index `pi` bleibt so der Index in proposals.
  researchProposals(msg) {
    return ((msg?.context_info?.proposals) || []).filter(p => p && !p.type);
  },
  isProposalSaved(msg, pi) { return !!this.researchProposals(msg)[pi]?.saved_item_id; },
  isProposalSaving(msg, pi) { return !!this._proposalSaving[_key(msg, pi)]; },
  // Liegt (laut Tool-Abgleich oder 409) schon im Board und ist hier nicht gespeichert.
  proposalExistsId(msg, pi) {
    const p = this.researchProposals(msg)[pi];
    return (!p || p.saved_item_id) ? null : (p.exists_item_id || null);
  },
  // Ungespeicherte Vorschläge, die ohne Rückfrage gespeichert werden können —
  // ohne Dubletten und ohne (verbliebene) ungeprüfte Links.
  researchSavableProposals(msg) {
    return this.researchProposals(msg)
      .map((p, pi) => ({ p, pi }))
      .filter(({ p }) => !p.saved_item_id && !p.exists_item_id
        && !(p.urls || []).some(u => this.isProposalUrlUnverified(u)));
  },

  // ── Links eines Vorschlags ──────────────────────────────────────────────
  // Hat das Modell eine URL genannt, die dieser Lauf nie abgerufen hat?
  // (Ältere Vorschläge ohne Flag gelten als nicht markiert.)
  isProposalUrlUnverified(u) { return u?.verified === false; },
  // Echter Host neben einem Modell-Label — ein Label «Wikipedia» kann so keine
  // fremde Domain verdecken. Ohne Label zeigt der Link ohnehin die URL.
  proposalUrlHost(u) {
    return u?.label ? urlHost(u.url) : '';
  },
  isProposalUrlRemoved(msg, pi, u) {
    const toggled = (this._proposalRemovedUrls[_key(msg, pi)] || []).includes(u?.url);
    return this.isProposalUrlUnverified(u) ? !toggled : toggled;
  },
  // Warn-Optik der ganzen Zeile: ungeprüft UND (wieder) aufgenommen.
  isProposalUrlRisky(msg, pi, u) {
    return this.isProposalUrlUnverified(u) && !this.isProposalUrlRemoved(msg, pi, u);
  },
  toggleProposalUrl(msg, pi, u) {
    const k = _key(msg, pi);
    const cur = this._proposalRemovedUrls[k] || [];
    const nextList = cur.includes(u.url) ? cur.filter(x => x !== u.url) : [...cur, u.url];
    const next = { ...this._proposalRemovedUrls };
    if (nextList.length) next[k] = nextList; else delete next[k];
    this._proposalRemovedUrls = next;
  },
  // Links, die beim Speichern mitgehen.
  _proposalKeptUrls(msg, pi) {
    return (this.researchProposals(msg)[pi]?.urls || []).filter(u => !this.isProposalUrlRemoved(msg, pi, u));
  },

  // ── Bearbeiten vor dem Speichern ────────────────────────────────────────
  // Typen, die ein Vorschlag haben kann (Server: PROPOSAL_KINDS in lib/research-validate.js).
  proposalKindOptions() {
    const t = window.__app.t;
    return PROPOSAL_KINDS.map(k => ({ value: k, label: t(`recherche.kind.${k}`) }));
  },
  // Entwurf je Vorschlag auf Karten-Ebene (`_proposalEdits`, Reassign beim
  // Anlegen/Verwerfen); die Felder bindet das Template per x-model.
  proposalEdit(msg, pi) { return this._proposalEdits[_key(msg, pi)] || null; },
  toggleProposalEdit(msg, pi) {
    const k = _key(msg, pi);
    const next = { ...this._proposalEdits };
    if (next[k]) delete next[k];
    else {
      const p = this.researchProposals(msg)[pi] || {};
      next[k] = {
        title: p.title || '',
        body: p.body || '',
        kind: p.kind || 'note',
        tagsText: (p.tags || []).join(', '),
      };
    }
    this._proposalEdits = next;
  },
  // Bearbeitungen + weggelassene Links; null, wenn der User nichts geändert hat.
  _proposalEditsPayload(msg, pi) {
    const d = this.proposalEdit(msg, pi);
    const all = this.researchProposals(msg)[pi]?.urls || [];
    const removed = this._proposalKeptUrls(msg, pi).length !== all.length;
    if (!d && !removed) return null;
    return {
      ...(d ? {
        title: d.title,
        body: d.body,
        kind: d.kind,
        tags: String(d.tagsText || '').split(',').map(t => t.trim()).filter(Boolean),
      } : {}),
      ...(removed ? { urls: this._proposalKeptUrls(msg, pi).map(u => u.url) } : {}),
    };
  },

  // Vorschlag lokal ersetzen (nach Speichern/409) — neue Nachricht im Array.
  _patchProposal(msg, pi, patch) {
    this.researchChatMessages = this.researchChatMessages.map(m => {
      if (m !== msg && !(m.id && m.id === msg.id)) return m;
      const proposals = [...(m.context_info?.proposals || [])];
      proposals[pi] = { ...proposals[pi], ...patch };
      return { ...m, context_info: { ...m.context_info, proposals } };
    });
  },

  // Speichern. Persistiert erst HIER — der Chat hat nur vorgeschlagen.
  // Rückgabe: Item-Id (gespeichert oder schon vorhanden) oder null.
  async saveResearchProposal(msg, pi, { allowDuplicate = false, reload = true } = {}) {
    const app = window.__app;
    const k = _key(msg, pi);
    const p = this.researchProposals(msg)[pi];
    if (!msg?.id || !p || p.saved_item_id || this._proposalSaving[k]) return p?.saved_item_id || null;
    this._proposalSaving = { ...this._proposalSaving, [k]: true };
    try {
      const ctx = this._proposalLinkTarget(msg);
      const edits = this._proposalEditsPayload(msg, pi);
      const res = await sendJson('/research/chat-proposal', 'POST', {
        message_id: msg.id,
        index: pi,
        ...(edits ? { edits } : {}),
        ...(ctx ? { link: { target_kind: ctx.kind, target_id: ctx.id } } : {}),
        ...(allowDuplicate ? { allow_duplicate: true } : {}),
      });
      const savedId = res?.item?.id || null;
      this._patchProposal(msg, pi, { saved_item_id: savedId });
      // Nur eine frische Speicherung zaehlt; die 409-Pfade unten sind keine.
      // Verwerfen gibt es im Recherche-Chat nicht — offen ist, was liegen bleibt.
      if (savedId) trackChatProposal('research', 'applied', p.kind);
      if (this._proposalEdits[k]) { const n = { ...this._proposalEdits }; delete n[k]; this._proposalEdits = n; }
      // _proposalRemovedUrls bleibt stehen: der gespeicherte Vorschlag zeigt die
      // weggelassenen Links weiter durchgestrichen (bis zum Reload).
      // Board aus Server-Wahrheit neu laden (Filter/Sortierung + Tag-Pool).
      if (reload) await this.loadRecherche();
      return savedId;
    } catch (e) {
      if (e?.status === 409 && e.body?.error_code === 'DUPLICATE_URL') {
        this._patchProposal(msg, pi, { exists_item_id: e.body.existing_id, exists_match: 'url' });
        return e.body.existing_id || null;
      }
      if (e?.status === 409 && e.body?.error_code === 'ALREADY_SAVED') {
        this._patchProposal(msg, pi, { saved_item_id: e.body.item_id });
        return e.body.item_id || null;
      }
      this.errorMessage = app.t('recherche.chat.saveError');
      return null;
    } finally {
      const next = { ...this._proposalSaving };
      delete next[k];
      this._proposalSaving = next;
    }
  },

  // „Alle speichern": nur die eindeutig neuen Vorschläge, nacheinander (der
  // Dubletten-Abgleich des Servers sieht so auch die eben gespeicherten).
  async saveAllResearchProposals(msg) {
    const todo = this.researchSavableProposals(msg);
    if (!todo.length) return;
    for (const { pi } of todo) {
      await this.saveResearchProposal(msg, pi, { reload: false });
    }
    await this.loadRecherche();
  },

  // Gespeicherten/vorhandenen Eintrag im Board öffnen.
  openResearchProposalItem(id) {
    if (id) this._focusRechercheItemById(id);
  },

  // „Als Quelle übernehmen": Fundstück sicherstellen (speichern bzw. den schon
  // vorhandenen Eintrag nehmen), dann die Brücke POST /sources/from-research.
  async proposalToSource(msg, pi) {
    const app = window.__app;
    const p = this.researchProposals(msg)[pi];
    if (!p) return;
    const itemId = p.saved_item_id || p.exists_item_id || await this.saveResearchProposal(msg, pi);
    if (!itemId) return;
    const k = `src:${_key(msg, pi)}`;
    if (this._proposalSaving[k]) return;
    this._proposalSaving = { ...this._proposalSaving, [k]: true };
    try {
      const src = await sendJson('/sources/from-research', 'POST', { item_id: itemId });
      app?._showJobToast?.({
        message: app.t('recherche.toSource.done', { title: src?.title || p.title || '' }),
        severity: 'ok',
        jobType: 'source',
        bookId: window.Alpine?.store('nav').selectedBookId ?? null,
      });
    } catch (e) {
      this.errorMessage = e?.status === 400
        ? app.t('recherche.toSource.needsTitle')
        : app.t('recherche.toSource.error');
    } finally {
      const next = { ...this._proposalSaving };
      delete next[k];
      this._proposalSaving = next;
    }
  },
  isProposalToSourceBusy(msg, pi) { return !!this._proposalSaving[`src:${_key(msg, pi)}`]; },

  // Verknüpfungsziel beim Speichern: die Stelle, für die die Frage gestellt wurde
  // (context_info.research_context der Antwort) — auch die Ideen derselben Antwort
  // hängen dort, und der Prompt hat dem Modell genau diese Stelle genannt. Ältere
  // Antworten ohne das Feld: der Kontext-Chip von jetzt.
  _proposalLinkTarget(msg) {
    const ci = msg?.context_info || {};
    if ('research_context' in ci) {
      const rc = ci.research_context;
      return rc?.kind && rc?.id ? { kind: rc.kind, id: rc.id } : null;
    }
    return this.researchChatUseContext ? this.researchChatContextTarget() : null;
  },

  // ── Kontext-Chip „für Seite/Kapitel recherchieren" ───────────────────────
  // Ziel: der Seiten-/Kapitel-Filter des Boards (Sprung vom Seiten-Indikator)
  // oder die zuletzt offene Seite. Gespeicherte Vorschläge werden damit verknüpft.
  researchChatContextTarget() {
    const nav = window.Alpine?.store('nav');
    if ((this.filterLinkedKind === 'page' || this.filterLinkedKind === 'chapter') && this.filterLinkedTargetId) {
      const id = parseInt(this.filterLinkedTargetId, 10);
      if (id) return { kind: this.filterLinkedKind, id, label: _labelFor(nav, this.filterLinkedKind, id) };
    }
    const cp = window.__app?.currentPage;
    if (cp?.id) return { kind: 'page', id: parseInt(cp.id, 10), label: cp.name || _labelFor(nav, 'page', cp.id) };
    return null;
  },
};

function _labelFor(nav, kind, id) {
  if (kind === 'page') {
    const p = (nav?.pages || []).find(x => String(x.id) === String(id));
    return p?.name || '';
  }
  const c = (nav?.tree || []).find(x => x.type === 'chapter' && String(x.id) === String(id));
  return c?.name || '';
}

// Zusätzlicher Karten-State dieses Moduls (in rechercheCard gespreadet).
export function researchProposalState() {
  return {
    // Bearbeitungs-Entwürfe je Vorschlag, Schlüssel `${msg.id}:${index}`.
    _proposalEdits: {},
    // Weggelassene Links je Vorschlag (gleicher Schlüssel) → URL-Strings.
    _proposalRemovedUrls: {},
    // Kontext-Chip an: gespeicherte Vorschläge mit Seite/Kapitel verknüpfen.
    researchChatUseContext: false,
  };
}
