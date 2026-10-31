// Theme vor erstem Paint setzen (FOUC-Schutz). Gespeicherte Präferenz:
// 'auto' (folgt System), 'light', 'dark'. Auflösung → data-theme-Attribut.
// Externe Datei statt Inline-Script, damit CSP ohne 'unsafe-inline' auskommt.
//
// `window.__applyTheme(pref)` ist die eine Stelle, die ein Theme anwendet —
// beim Boot hier, bei jeder Umschaltung aus app/app-chrome.js#_applyTheme.
// Sie zieht die `<meta name="theme-color">`-Tags mit: die tragen per
// `media`-Attribut nur die System-Präferenz und zeigten bei manueller Wahl
// sonst die Browser-Leiste im falschen Theme.
(function () {
  // Spiegelt --color-bg (tokens/colors.css) Light/Dark. Gegated:
  // tests/unit/css-contrast.test.mjs.
  var THEME_COLOR = { light: '#faf7f2', dark: '#1a1816' };

  function resolve(pref) {
    return pref === 'auto'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : pref;
  }

  window.__applyTheme = function (pref) {
    var resolved = resolve(pref);
    document.documentElement.setAttribute('data-theme', resolved);
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) {
      var media = metas[i].getAttribute('media') || '';
      // Auto: jedes Tag behält seine System-Variante (der Browser wählt per media).
      // Manuelle Wahl: beide Tags zeigen das gewählte Theme.
      var key = pref === 'auto' ? (media.indexOf('dark') >= 0 ? 'dark' : 'light') : resolved;
      metas[i].setAttribute('content', THEME_COLOR[key]);
    }
    return resolved;
  };

  var stored = null;
  try { stored = localStorage.getItem('theme'); } catch (e) {}
  var pref = (stored === 'light' || stored === 'dark' || stored === 'auto') ? stored : 'auto';
  window.__applyTheme(pref);
  window.__themePref = pref;
})();
