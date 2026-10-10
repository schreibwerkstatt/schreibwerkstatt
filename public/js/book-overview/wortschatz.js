// Wortschatz-Tile der Buch-Übersicht: eine längenrobuste Vielfalts-Kennzahl
// (MTLD, ersatzweise MATTR) mit dem Median der übrigen Bücher desselben
// Besitzers daneben. Quelle: GET /lexicon/:book_id (routes/lexicon.js) — die
// Antwort der Wortschatz-Karte, hier nur gelesen. Kein Scan, kein Job.
//
// Drei Regeln, die das Tile mit der Wortschatz-Karte teilt:
//   * **`null` ist „nicht messbar", nicht 0** — Anzeige „–", nie „0".
//   * **MATTR nur vergleichbar bei vollem Fenster.** War der Text kürzer als
//     `thresholds.mattrWindow`, ist der Wert die einfache TTR; die Peer-Zeile
//     fällt dann weg, weil der Median nur aus Büchern mit vollem Fenster stammt.
//   * **`peers` kann fehlen** (keine weiteren gescannten Bücher, oder ein
//     Betrachter ohne Besitz-Kontext) — dann gibt es schlicht keine Vergleichszeile.
import { formatNumber } from '../utils.js';
import { featureByKey, hasMinRole } from '../cards/feature-registry.js';

const _finite = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

/** Pure: Tile-Daten aus der /lexicon-Antwort.
 *  `null`  = Antwort fehlt (nicht geladen / Fehler) → Tile aus.
 *  `{ scanned: false }` = noch keine Analyse → Hinweis-Tile. */
export function computeOverviewLexicon(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const s = data.stats;
  if (!s) return { scanned: false };
  const mtld = _finite(s.mtld);
  const mattr = _finite(s.mattr);
  const metric = mtld != null ? 'mtld' : (mattr != null ? 'mattr' : null);
  const win = _finite(data.thresholds?.mattrWindow);
  const mattrRobust = !win || (Number(s.mattr_window) || 0) >= win;
  const comparable = metric === 'mtld' || (metric === 'mattr' && mattrRobust);
  const peers = data.peers && typeof data.peers === 'object' ? data.peers : null;
  const peer = comparable && peers ? _finite(peers[metric]) : null;
  return {
    scanned: true,
    metric,
    value: metric === 'mtld' ? mtld : mattr,
    decimals: metric === 'mattr' ? 3 : 1,
    mattrRobust,
    peer,
    peerBooks: peer != null ? (Number(peers.books) || 0) : 0,
    lexDensity: _finite(s.lex_density),
    hapaxRatio: _finite(s.hapax_ratio),
    stale: data.stale === true,
    // Fremdes Buch (`isOwner: false`): „deine übrigen Bücher" wären die des
    // Besitzers — dann keine Vergleichszeile, auch kein „kein Vergleich".
    peerLine: data.isOwner !== false,
  };
}

export const wortschatzMethods = {
  overviewLexicon() {
    const data = this.overviewLexiconData;
    return this._memo('lexicon', [data], () => computeOverviewLexicon(data));
  },

  // `null` → „–" (gleiche Formatierung wie die Wortschatz-Karte).
  overviewLexNum(v, decimals = 1) {
    return formatNumber(v, this._uiLocale(), decimals);
  },

  overviewLexPercent(v) {
    return v == null ? '–' : formatNumber(v * 100, this._uiLocale(), 1) + '%';
  },

  // Die Wortschatz-Karte ist editor+, die Übersicht schon ab viewer sichtbar:
  // für einen Betrachter ist das Tile reine Anzeige, kein toter Klick.
  overviewCanOpenWortschatz() {
    const role = window.__app?.currentBookRole || null;
    const min = featureByKey('wortschatz')?.minRole;
    return !role || hasMinRole(role, min);
  },

  // aria-label der Kachel: Titel + Kennzahl (bzw. Hinweis ohne Scan) — das
  // Label ersetzt den Inhalt der role=button-Kachel für Screenreader.
  overviewLexiconAria() {
    const app = window.__app;
    const lex = this.overviewLexicon();
    const title = app.t('tile.wortschatz');
    if (!lex) return title;
    if (!lex.scanned) return title + ': ' + app.t('overview.lexicon.noScan');
    const unit = app.t(lex.metric === 'mattr' ? 'wortschatz.kpi.mattr' : 'wortschatz.kpi.mtld');
    return title + ': ' + this.overviewLexNum(lex.value, lex.decimals) + ' ' + unit;
  },

  overviewOpenWortschatz() {
    if (this.overviewCanOpenWortschatz()) window.__app?.toggleWortschatzCard?.();
  },
};
