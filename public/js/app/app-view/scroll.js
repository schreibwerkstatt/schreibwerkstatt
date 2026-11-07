// Teil von appViewMethods (siehe Facade app-view.js).
import { EXCLUSIVE_CARDS } from './_shared.js';
import { scrollToWhenReady, cancelPendingScroll } from '../../utils/scroll-when-ready.js';

const isMobileLayout = () => window.matchMedia('(max-width: 959.98px)').matches;

// Nur ein gerendertes Element taugt als Ziel: während des Karten-Cross-Fades
// oder vor dem x-show-Effekt steht die Karte noch auf display:none.
const rendered = (el) => (el?.isConnected && el.getClientRects().length ? el : null);

export const scrollMethods = {

  // Scroll-Ziel beim Karten-Öffnen: Mobile (<960px, einspaltig) → Karte
  // ins Viewport, sonst sieht User den Tree statt der frisch geöffneten Karte.
  // Desktop (>=960px, zweispaltig) → Window-Top, da Karten in eigener Spalte.
  // `find` liefert das Karten-Element (wird jeden Frame neu gefragt). Mobile
  // wartet über scrollToWhenReady, bis die Karte gerendert und an ihrem Platz
  // ist und eine zufahrende Bildschirmtastatur unten ist — ein Smooth-Scroll in
  // ein noch springendes Layout endet auf dem Handy neben der Karte.
  _scrollToCard(find) {
    if (isMobileLayout()) {
      scrollToWhenReady(() => rendered(find()), { block: 'start' });
      return;
    }
    cancelPendingScroll();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  },

  _scrollToCardEl(el) {
    this._scrollToCard(() => el);
  },

  _scrollToEditorCard() {
    this._scrollToCard(() => document.getElementById('editor-card'));
  },

  // Scrollt zur Karte mit `key` (aus EXCLUSIVE_CARDS). Pflicht: vom Aufrufer
  // erst aufrufen, nachdem Partial geladen UND Flag gesetzt ist — sonst hat
  // das `x-show`-Element noch keine DOM-Repräsentation.
  _scrollToCardByKey(key) {
    const target = EXCLUSIVE_CARDS.find(c => c.key === key);
    if (!target || typeof this.$nextTick !== 'function') return;
    const selector = `[x-show="$app.${target.flag}"]`;
    this.$nextTick(() => {
      this._scrollToCard(() => document.querySelector(selector));
    });
  },
};
