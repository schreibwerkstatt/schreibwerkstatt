// Alterstabelle der Figuren — fuenfter Reiter der Figuren-Karte.
//
// ZWEI QUELLEN, bewusst nebeneinander in EINER Tabelle:
//   1. Der Katalog (`Alpine.store('catalog').figuren`): `geburtstag` (vom Autor
//      gepflegt) und `alter_im_roman` (serverseitig aus dem konsolidierten
//      Zeitstrahl gerechnet, nur bei book_settings.zeitlinie_real).
//   2. Der Alters-Index (GET /figures/:id/alter, Job `figur-alter`): das Alter,
//      wie es im TEXT steht — mit woertlichem Beleg und Sprungziel.
//
// Dazu der STICHTAG (Jahr, optional Monat): eine Spalte «Alter am Stichtag» fuer
// alle Figuren, gerechnet aus der Geburt, die der Server aufloest (`geburten` in
// GET …/alter, lib/figure-birth.js) mit derselben Rechnung wie das Buch-Chat-
// Werkzeug `get_figure_age` (book/age-at.js). Hat das Buch ein Schulsystem, steht
// daneben die Klasse an diesem Tag (book/figuren-schulweg.js).
//
// Die Tabelle funktioniert OHNE Lauf: sie zeigt dann, was der Katalog weiss. Der
// Analyse-Knopf ergaenzt die Textfunde und macht Widersprueche sichtbar. Genau
// dafuer bleiben beide Werte sichtbar — ein einziger „richtiger" Wert waere eine
// Behauptung darueber, welche Quelle recht hat.
//
// Gespreadet in cards/figuren-card.js; Root-Zugriffe via window.__app.

import { fetchJson, sendJson, dateTimeFormat } from '../utils.js';
import { startPoll } from '../cards/job-helpers.js';
import { isSelectedBook } from '../cards/book-guard.js';
import { tFetchError } from '../i18n.js';
import { typRank, byTypDannName } from './figur-typen.js';
import { activeFilterId, sameId } from '../chapter-filter.js';
import { ageAt } from './age-at.js';
import { schulStufeFuerEreignis } from './figuren-schulweg.js';
import { schulZeiten, stufeLabelKey, schoolStageAt, schoolStagesForYear } from './school-path.js';

/** Pure Verbindung von Katalog und Alters-Index + Filter + Sortierung.
 *  Ausserhalb von Alpine testbar. `ages` = Map fig_id → Index-Zeile.
 *  `kapitelId` (bereits per activeFilterId bereinigt) waehlt die Figuren, die im
 *  Kapitel auftreten — die Alterswerte bleiben die des ganzen Buchs. */
/** Stichtag aus den Eingaben: { y, m } oder null ohne gueltiges Jahr. */
export function stichtagAus(jahr, monat) {
  if (!Number.isInteger(jahr)) return null;
  const m = Number(monat);
  return { y: jahr, m: Number.isInteger(m) && m >= 1 && m <= 12 ? m : null };
}

/** Sortierwert der Stichtag-Spalte: das sichere bzw. obere Alter, vor der Geburt -1. */
function _stichtagSort(a) {
  if (!a) return null;
  if (a.vor_geburt) return -1;
  return a.alter ?? a.alter_bis ?? null;
}

export function computeAlterRows(figuren, ages, { suche = '', typ = '', nur = '', kapitelId = '', stichtag = null, geburten = null } = {}) {
  const q = (suche || '').toLowerCase();
  const rows = [];
  for (const f of (figuren || [])) {
    if (f.stale) continue;
    if (typ && f.typ !== typ) continue;
    if (kapitelId && !(f.kapitel ?? []).some(k => sameId(k.chapter_id, kapitelId))) continue;
    if (q && !(f.name || '').toLowerCase().includes(q) && !(f.kurzname || '').toLowerCase().includes(q)) continue;
    const a = ages?.get?.(f.id) || null;
    // Textfund gewinnt in der Anzeige; der gerechnete Wert bleibt als eigene
    // Spalte stehen, damit die Abweichung sichtbar ist statt geglaettet.
    const alterVon = a?.alter_von ?? null;
    const alterBis = a?.alter_bis ?? alterVon;
    // Gerechneter Wert und Geburtsjahr kommen aus dem Index, wenn es eine Zeile
    // gibt: der Server kennt dort auch ein NUR IM TEXT gefundenes Geburtsjahr, das
    // `alter_im_roman` am Katalog per Definition nicht kennt. Auch ein leerer Wert
    // der Zeile gilt — fiele er auf den Katalog zurueck, stuenden ein Geburtsjahr
    // aus dem Text und ein Alter aus einem anderen Geburtsjahr in derselben Zeile.
    // Ohne Lauf bleibt der Katalog — die Tabelle soll ohne Analyse arbeiten.
    const abgeleitet = a ? (a.gerechnet ?? null) : (f.alter_im_roman ?? null);
    // Ohne Lauf dieselbe Herkunft und Sicherheit, die die Verdichtung vergaebe
    // (lib/figure-age/consolidate.js): ein Geburtsjahr aus dem Steckbrief ist
    // „kuratiert" und das Alter daraus „aus Geburtsjahr" (0.75), nur ein
    // Geburtsjahr aus dem Zeitstrahl-Ereignis ist „Zeitstrahl" (0.5). Sonst
    // wechselte dieselbe Zahl mit dem ersten Lauf Plakette und Ton.
    const gebKuratiert = /\b\d{4}\b/.test(f.geburtstag || '');
    const katalogQuelle = gebKuratiert ? 'geburtsjahr' : 'zeitstrahl';
    const row = {
      id: f.id,
      name: f.name,
      kurzname: f.kurzname || null,
      typ: f.typ || 'andere',
      // Sortierschluessel der Typ-Spalte: die Taxonomie-Reihenfolge, nicht das
      // Alphabet der Typ-Keys (sonst stuende „andere" vor „hauptfigur").
      typ_rank: typRank(f.typ || 'andere'),
      geburtsjahr: a ? (a.geburtsjahr ?? null) : (f.geburtsjahr ?? null),
      geburtsjahr_quelle: a ? (a.geburtsjahr_quelle ?? null) : (f.geburtsjahr != null ? (gebKuratiert ? 'kuratiert' : 'zeitstrahl') : null),
      geburtstag: f.geburtstag || null,
      alter_von: alterVon,
      alter_bis: alterBis,
      alter_abgeleitet: abgeleitet,
      jahr_im_roman: f.jahr_im_roman ?? null,
      bezugsjahr_von: a?.bezugsjahr_von ?? null,
      bezugsjahr_bis: a?.bezugsjahr_bis ?? null,
      quelle: a?.quelle ?? (abgeleitet != null ? katalogQuelle : null),
      konfidenz: a?.konfidenz ?? (abgeleitet != null ? (katalogQuelle === 'geburtsjahr' ? 0.75 : 0.5) : 0),
      widerspruch: a?.widerspruch ?? null,
      belege: a?.belege ?? [],
      // Ein Wert steht hier nur, wenn irgendeine Quelle etwas hergibt.
      hatAlter: alterVon != null || abgeleitet != null,
      geburt: geburten?.[f.id] || null,
      stichtag_alter: null,
      stichtag_sort: null,
    };
    if (stichtag && row.geburt) {
      row.stichtag_alter = ageAt(row.geburt, stichtag);
      row.stichtag_sort = _stichtagSort(row.stichtag_alter);
    }
    if (nur === 'mitAlter' && !row.hatAlter) continue;
    if (nur === 'ohneAlter' && row.hatAlter) continue;
    // Widerspruch heisst beides: Textfund gegen Rechnung (Index) und Geburtsjahre,
    // die sich zwischen Steckbrief, Zeitstrahl und Alters-Index widersprechen.
    if (nur === 'widerspruch' && !row.widerspruch && !row.geburt?.widerspruch) continue;
    if (nur === 'beleg' && !row.belege.length) continue;
    if (nur === 'amStichtag' && (!stichtag || row.stichtag_sort == null || row.stichtag_sort < 0)) continue;
    rows.push(row);
  }
  return rows.sort(byTypDannName);
}

export const figurenAlterMethods = {
  // ── Laden ─────────────────────────────────────────────────────────────────
  async loadFigurenAlter() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) { this.figurenAlterData = null; return; }
    // Buchwechsel waehrend des Requests: die Antwort gehoert zum alten Buch und
    // darf weder Daten noch Scan-Datum noch den Lade-Marker des neuen setzen.
    try {
      const data = await fetchJson(`/figures/${encodeURIComponent(bookId)}/alter`);
      if (!isSelectedBook(bookId)) return;
      this.figurenAlterData = data;
      this._figurenAlterLoadedBookId = String(bookId);
      this._memos = {};
    } catch (e) {
      if (e?.name === 'AbortError' || !isSelectedBook(bookId)) return;
      this.figurenAlterData = null;
      this.figurenAlterStatus = this._t('figuren.alter.loadError');
    }
  },

  // Reiter wird geoeffnet: einmal laden, nicht bei jedem Klick.
  async ensureFigurenAlter() {
    const bookId = String(Alpine.store('nav').selectedBookId || '');
    if (!bookId) return;
    if (this.figurenAlterData && this._figurenAlterLoadedBookId === bookId) return;
    await this.loadFigurenAlter();
  },

  // ── Analyse anstossen ─────────────────────────────────────────────────────
  // Manuell ausgeloest heisst „ich will jetzt eine Zahl sehen" — der Server
  // ueberspringt in diesem Pfad seinen Delta-Skip (force).
  async runFigurenAlterScan() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || this.figurenAlterLoading) return;
    this.figurenAlterLoading = true;
    this.figurenAlterProgress = 0;
    this.figurenAlterStatus = this._t('figuren.alter.running');
    try {
      const j = await sendJson('/jobs/figur-alter', 'POST', { book_id: bookId, force: true });
      if (!j?.jobId) throw new Error('no jobId');
      // Buchwechsel waehrend des POST: _resetFigurenAlter hat den Zustand schon
      // geraeumt; ein Poll des alten Jobs zeigte seinen Fortschritt im neuen Buch.
      if (!isSelectedBook(bookId)) return;
      this._pollFigurenAlter(j.jobId);
    } catch (e) {
      this.figurenAlterLoading = false;
      // Abgelehnter Start (z.B. 409 KOMPLETT_ANALYSIS_RUNNING): die Server-Meldung.
      this.figurenAlterStatus = e?.code ? tFetchError(e) : this._t('figuren.alter.error');
    }
  },

  // Geteilter Poller statt Eigenbau (cards/job-helpers.js). Drei Dinge, die ein
  // handgeschriebener setTimeout-Zyklus hier nicht hatte: den 404-Zweig (ein
  // Job, den der Server nach einem Neustart nicht mehr kennt, wurde sonst bis
  // zum Kartenabbau weiter abgefragt), `syncJobQueueItem` (sonst driften
  // Footer-Fortschritt und Karten-Bar auseinander) und den Job-Toast am Ende.
  _pollFigurenAlter(jobId) {
    const finish = (status) => {
      this.figurenAlterLoading = false;
      this.figurenAlterProgress = 0;
      this.figurenAlterStatus = status;
    };
    startPoll(this, {
      timerProp: '_figurenAlterPollTimer',
      jobId,
      progressProp: 'figurenAlterProgress',
      intervalMs: 1200,
      onDone: async () => {
        finish('');
        await this.loadFigurenAlter();
      },
      // Deckt error UND cancelled ab (startPoll ruft onError fuer beide).
      onError: (job) => finish(job?.error
        ? this._t(job.error, job.errorParams)
        : this._t('figuren.alter.error')),
      onNotFound: () => finish(this._t('figuren.alter.error')),
    });
  },

  // ── Tabelle ───────────────────────────────────────────────────────────────
  figurenAlterRows() {
    const figuren = Alpine.store('catalog').figuren;
    const data = this.figurenAlterData;
    const f = this.figurenAlterFilters;
    const suche = f?.suche ?? '', typ = f?.typ ?? '', nur = f?.nur ?? '';
    // Optionen wie in der Figurenliste (figurenKapitelOptionen) — wirksam nur ein
    // angebotener Wert, sonst stuende eine leere Tabelle unter «Alle Kapitel».
    const kapitelId = activeFilterId(f?.kapitelId, this.figurenKapitelOptionen());
    const st = this.figurenAlterStichtag;
    const stJahr = st?.jahr ?? null, stMonat = st?.monat ?? '';
    return this._memo('alterRows', [figuren, data, suche, typ, nur, kapitelId, stJahr, stMonat], () => {
      const ages = new Map((data?.figuren || []).map(r => [r.fig_id, r]));
      const stichtag = stichtagAus(stJahr, stMonat);
      return computeAlterRows(figuren, ages, { suche, typ, nur, kapitelId, stichtag, geburten: data?.geburten || null });
    });
  },

  // Typen, die im Buch wirklich vorkommen (Filter-Combobox).
  figurenAlterTypListe() {
    const figuren = Alpine.store('catalog').figuren;
    return this._memo('alterTypen', [figuren], () => {
      const seen = new Set();
      for (const f of (figuren || [])) if (!f.stale && f.typ) seen.add(f.typ);
      return [...seen].sort((a, b) => typRank(a) - typRank(b));
    });
  },

  // Kennzahlen über der Tabelle — „von wie vielen weiss ich es überhaupt".
  // Memoized: das Template liest drei Felder daraus, jedes wäre sonst ein eigener
  // Lauf über alle Zeilen (CLAUDE.md „Memo-Pattern: ein Helper pro Modul").
  figurenAlterSummary() {
    const rows = this.figurenAlterRows();
    return this._memo('alterSummary', [rows], () => ({
      total: rows.length,
      mitAlter: rows.filter(r => r.hatAlter).length,
      mitBeleg: rows.filter(r => r.belege.length).length,
      widerspruch: rows.filter(r => r.widerspruch || r.geburt?.widerspruch).length,
    }));
  },

  // ── Stichtag ──────────────────────────────────────────────────────────────
  figurenAlterStichtagAktiv() {
    return !!stichtagAus(this.figurenAlterStichtag?.jahr ?? null, this.figurenAlterStichtag?.monat);
  },

  // Monatsnamen in der UI-Sprache; Mitte des Monats, damit keine Zeitzone den
  // Monat kippt.
  figurenAlterMonatOptionen() {
    const loc = Alpine.store('shell').uiLocale;
    return this._memo('alterMonate', [loc], () => {
      const fmt = dateTimeFormat(loc, { month: 'long' });
      return Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: fmt.format(new Date(Date.UTC(2000, i, 15, 12))) }));
    });
  },

  figurenAlterStichtagLabel() {
    const st = stichtagAus(this.figurenAlterStichtag?.jahr ?? null, this.figurenAlterStichtag?.monat);
    if (!st) return '';
    if (!st.m) return String(st.y);
    const name = this.figurenAlterMonatOptionen()[st.m - 1]?.label || String(st.m);
    return `${name} ${st.y}`;
  },

  // Spanne bleibt Spanne: ohne Geburts- oder Stichtagsmonat ist offen, ob der
  // Geburtstag schon war.
  figurenAlterStichtagWert(row) {
    const a = row.stichtag_alter;
    if (!a) return row.geburt ? '' : '–';
    if (a.vor_geburt) return this._t('figuren.alter.stichtag.vorGeburt');
    if (a.exakt) return String(a.alter);
    if (a.alter_von < 0) return this._t('figuren.alter.stichtag.geburtsjahr');
    return `${a.alter_von}–${a.alter_bis}`;
  },

  figurenAlterStichtagSchule(row) {
    const st = stichtagAus(this.figurenAlterStichtag?.jahr ?? null, this.figurenAlterStichtag?.monat);
    if (!st || !row.geburt || row.stichtag_alter?.vor_geburt) return '';
    const r = this._figurSchulRechnung({ id: row.id });
    if (!r.system) return '';
    const args = { ...r, geburt: r.geburt || row.geburt, jahr: st.y };
    const stufe = schulStufeFuerEreignis({ ...args, monat: st.m }, (k, p) => this._t(k, p));
    if (stufe) return stufe;
    // Ausserhalb der Schulzeit: sagen, auf welcher Seite — «–» laese sich wie
    // «nicht berechenbar».
    const pos = st.m ? schoolStageAt({ ...args, monat: st.m }) : schoolStagesForYear(args)?.herbst;
    if (pos?.status === 'vor_einschulung') return this._t('figuren.schule.vorEinschulung');
    if (pos?.status === 'abgeschlossen') return this._t('figuren.schule.abgeschlossen', { jahr: pos.abschluss_jahr });
    return '';
  },

  // Schulzeit als Zeiträume je Stufe (book/school-path.js#schulZeiten) — dieselbe
  // Rechnung wie die Klasse am Stichtag und das Chat-Werkzeug. Memoized je Zeile:
  // das Template liest Liste und Unsicherheit getrennt.
  figurenAlterSchulzeit(row) {
    const r = this._figurSchulRechnung({ id: row.id });
    if (!r.system) return null;
    const geburt = r.geburt || row.geburt;
    return this._memo('alterSchulzeit:' + row.id, [r.system, geburt, r.figur?.weg, r.figur?.einschulung_jahr, r.figur?.repetitionen, Alpine.store('shell').uiLocale], () => {
      const z = schulZeiten({ ...r, geburt });
      if (!z) return null;
      return {
        stufen: z.stufen.map(st => ({ label: this._t(stufeLabelKey(st.stufe)), zeit: `${st.von}–${st.bis}` })),
        tip: z.unsicher ? this._t('figuren.alter.schulzeitUnsicher', { a: z.einschulung, b: z.einschulung_alternative }) : '',
      };
    });
  },

  // Geburtsjahre aus mehreren Quellen, die sich widersprechen — gerechnet wird mit
  // der ersten (Steckbrief › Geburts-Ereignis › Alters-Index, lib/figure-birth.js).
  figurenAlterGeburtWiderspruchTip(row) {
    const w = row.geburt?.widerspruch;
    if (!w?.length) return '';
    const liste = w.map(x => `${this._t('figuren.alter.geburtQuelle.' + x.quelle)} ${x.jahr}`).join(', ');
    return this._t('figuren.alter.geburtWiderspruchTip', { liste });
  },

  figurenAlterSpalten() {
    const schule = this.figurSchulSystem() ? 1 : 0;
    // Stichtag: Alter + Tätigkeit (Berufsweg/Hobbys), mit Schulsystem dazu die Klasse.
    return 8 + schule + (this.figurenAlterStichtagAktiv() ? 2 + schule : 0);
  },

  // ── Anzeige-Helfer ────────────────────────────────────────────────────────
  // Eine Spanne wird als Spanne gezeigt. „12" statt „12–19" waere eine andere
  // Aussage: die Figur ist im Buch nicht zwölf, sie wird zwischen zwölf und
  // neunzehn Jahre alt.
  figurenAlterLabel(row) {
    if (row.alter_von != null) {
      return row.alter_bis != null && row.alter_bis !== row.alter_von
        ? `${row.alter_von}–${row.alter_bis}`
        : String(row.alter_von);
    }
    if (row.alter_abgeleitet != null) return String(row.alter_abgeleitet);
    return this._t('figuren.alter.unknown');
  },

  // Bezugsjahr nur, wenn es ueberhaupt ein Alter gibt. Eine Jahreszahl neben
  // „unbekannt" liest sich wie eine Teilantwort, ist aber bloss das Buchende:
  // `jahr_im_roman` fällt für eine undatierte Figur auf das späteste Jahr des
  // Buchs zurück (lib/figure-years.js). Beim Alter aus dem Text nur, was die
  // Stellen nennen — das Ankerjahr neben einer Spanne aus dem ganzen Buch laese
  // sich, als gelte sie in diesem einen Jahr.
  figurenAlterBezugLabel(row) {
    if (!row.hatAlter) return '';
    const von = row.bezugsjahr_von, bis = row.bezugsjahr_bis;
    if (von != null && bis != null && von !== bis) return `${von}–${bis}`;
    if (von != null) return String(von);
    if (bis != null) return String(bis);
    if (row.quelle !== 'text' && row.jahr_im_roman != null) return String(row.jahr_im_roman);
    return '';
  },

  figurenAlterQuelleLabel(row) {
    if (!row.quelle) return '';
    return this._t('figuren.alter.quelle.' + row.quelle);
  },

  // Konfidenz als drei Stufen statt als Kommazahl: die Zahl suggeriert eine
  // Praezision, die eine Heuristik nicht hat.
  figurenAlterKonfidenzStufe(row) {
    if (!row.hatAlter) return 'none';
    if (row.konfidenz >= 0.8) return 'hoch';
    if (row.konfidenz >= 0.6) return 'mittel';
    return 'niedrig';
  },

  figurenAlterKonfidenzLabel(row) {
    const stufe = this.figurenAlterKonfidenzStufe(row);
    if (stufe === 'none') return '';
    return this._t('figuren.alter.konfidenz.' + stufe);
  },

  // Die Sicherheit steht als Ton an der Herkunfts-Plakette, ihr Wort im Tooltip —
  // eine eigene Plakette daneben las sich wie eine zweite Quellenangabe.
  figurenAlterKonfidenzTip(row) {
    const label = this.figurenAlterKonfidenzLabel(row);
    if (!label) return '';
    return this._t('figuren.alter.konfidenzTip', { level: label }) || label;
  },

  figurenAlterWiderspruchText(w) {
    if (!w) return '';
    return this._t('figuren.alter.widerspruch.' + w.typ, { a: w.a, b: w.b });
  },

  figurenAlterWiderspruchTip(row) {
    return (row.widerspruch || []).map(w => this.figurenAlterWiderspruchText(w)).filter(Boolean).join(' · ');
  },

  figurenAlterScanLabel() {
    const scan = this.figurenAlterData?.scan;
    if (!scan?.scanned_at) return '';
    const d = new Date(scan.scanned_at);
    if (Number.isNaN(d.getTime())) return '';
    // Datums-Anzeige ausschliesslich ueber den geteilten Formatter (harte Regel
    // „Frontend-Datums-Display: nur via tzOpts") — dateTimeFormat merged es.
    const date = dateTimeFormat(Alpine.store('shell').uiLocale, { dateStyle: 'medium', timeStyle: 'short' }).format(d);
    return this._t('common.asOf', { date });
  },

  // Der Index wird nur auf Knopfdruck neu gebaut — nach einer Komplettanalyse, einem
  // Update der Analyse oder neuem Text zeigt die Tabelle sonst still den alten Stand.
  // Gruende kommen vom Server (routes/figures-alter.js#staleReasons); die Analyse-
  // Version geht vor, weil dort auch unveraenderter Text anders ausgewertet wuerde.
  figurenAlterVeraltetText() {
    const gruende = this.figurenAlterData?.scan?.veraltet;
    if (!Array.isArray(gruende) || !gruende.length || this.figurenAlterLoading) return '';
    const grund = gruende.includes('version') ? 'version' : gruende.includes('text') ? 'text' : 'figuren';
    return this._t('figuren.alter.veraltet.' + grund);
  },

  // Belege einer Zeile auf-/zuklappen. Ein offener Beleg-Block pro Tabelle —
  // zwei offene Zeilen machen die Tabelle unlesbar, und der Vergleich zweier
  // Figuren laeuft ueber die Spalten, nicht ueber die Belege.
  figurenAlterToggleBelege(row) {
    this.figurenAlterOpenId = this.figurenAlterOpenId === row.id ? null : row.id;
  },
};
