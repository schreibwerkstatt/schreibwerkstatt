'use strict';
// Geteilte Bausteine der oeffentlichen SSR-Seiten (Landing, Themenseiten,
// Werkzeug, Register, Datenschutz): Template-Laden, Mini-Substitution,
// Sprachwahl, SEO-Schalter. Konsumenten: routes/public.js, routes/public-pages.js.

const path = require('path');
const fs = require('fs');
const appSettings = require('./app-settings');
const demoUser = require('./demo-user');
const { tServer } = require('./i18n-server');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const _templateCache = new Map();
function loadTemplate(name) {
  if (process.env.NODE_ENV !== 'production' || !_templateCache.has(name)) {
    _templateCache.set(name, fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8'));
  }
  return _templateCache.get(name);
}

const escHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Mini-Template-Substitution: {{key}} → vars[key]. Werte werden HTML-escaped,
// ausser sie enden auf "Json" (dann roher JSON-Stream fuer Inline-Skript bzw.
// ld+json — Aufrufer escapen `<` selbst, siehe toInlineJson) oder auf "Html"
// (fertiges Markup fuer Listen, die das Template nicht wiederholen kann — der
// Aufrufer baut es und schleust jeden Text durch escHtml).
// Konditionale Bloecke: {{#if flag}}…{{/if}} bleiben nur, wenn vars[flag] truthy ist.
function render(name, vars) {
  const tpl = loadTemplate(name)
    .replace(/\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, flag, body) => (vars[flag] ? body : ''));
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const raw = vars[key];
    if (raw === undefined || raw === null) return '';
    if (key.endsWith('Json')) return String(raw); // bereits JSON.stringify
    if (key.endsWith('Html')) return String(raw); // vom Aufrufer escaptes Markup
    return escHtml(raw);
  });
}

// JSON fuer <script type="application/json|ld+json">: `<` maskiert, damit ein
// Wert kein `</script>` schliessen kann.
function toInlineJson(obj) {
  return JSON.stringify(obj).replace(/</g, '\\u003c');
}

// Sprache der Seite: explizites `?lang=de|en` vor Accept-Language. Das
// Query-Feld gibt jeder Sprachfassung eine eigene, crawlbare URL — Googlebot
// schickt kein Accept-Language und saehe sonst nur die deutsche Fassung.
// `bodyLang` gilt fuer die Funnel-Seiten ohne Index (Register, /privacy-Alias):
// dort darf der Browser die Sprache bestimmen.
const LANGS = ['de', 'en'];
function _queryLang(req) {
  const q = String(req.query?.lang || '').toLowerCase();
  return LANGS.includes(q) ? q : '';
}
function _acceptsEn(req) {
  return String(req.headers['accept-language'] || '').toLowerCase().startsWith('en');
}
function bodyLang(req) {
  return _queryLang(req) || (_acceptsEn(req) ? 'en' : 'de');
}

// Sprache einer INDEXIERBAREN Seite: allein die URL entscheidet (ohne `?lang`
// Deutsch). Sonst lieferte dieselbe URL je nach Accept-Language eine andere
// Sprache samt anderem canonical — ein Crawler mit `en` saehe die deutsche
// Standard-URL als Duplikat der englischen. Den Browserwunsch bedient
// `langSwitchVars` mit einem Hinweis-Link statt mit anderem Inhalt.
function pageLang(req) {
  return _queryLang(req) || 'de';
}

// Template-Variablen des Sprachumschalters einer indexierbaren Seite:
// `langSwitchUrl`/`langSwitchLabel` (Link zur anderen Fassung, immer da —
// crawlbare Verbindung zwischen den Sprachfassungen), `langHint` +
// `langHintText`, wenn der Browser Englisch will, die URL aber keine Sprache
// nennt. Beschriftungen in der Zielsprache.
function langSwitchVars(req, pathName, lang) {
  const other = lang === 'de' ? 'en' : 'de';
  const showHint = lang === 'de' && !_queryLang(req) && _acceptsEn(req);
  return {
    langSwitchUrl: `${pathName}${other === 'de' ? '' : `?lang=${other}`}`,
    langSwitchLabel: tServer('publicPage.langName', other),
    langSwitchLang: other,
    langHint: showHint,
    langHintText: showHint ? tServer('publicPage.langHint', other) : '',
  };
}

function publicUrl() {
  return String(appSettings.get('app.public_url') || '').replace(/\/$/, '');
}

// Darf diese Instanz indexiert werden? Zusaetzlich zum Admin-Flag zaehlt eine
// gesetzte oeffentliche Basis-URL: ohne sie gibt es keine kanonische Adresse,
// unter der eine Indexierung ueberhaupt sinnvoll waere.
function seoIndexable() {
  return !!appSettings.get('seo.indexable') && !!publicUrl();
}

// Ziel des «Demo ausprobieren»-Knopfs. Auf der Demo-Instanz selbst die eigene
// Login-Seite (dort steht das Demo-Formular), sonst die konfigurierte Adresse.
// Leer = Knopf entfaellt.
function demoUrl() {
  if (demoUser.isEnabled()) return '/login';
  return String(appSettings.get('landing.demo_url') || '').trim();
}

// URL einer Sprachfassung: Deutsch ohne Parameter (= Standard-URL), sonst `?lang=`.
function langUrl(pathName, lang) {
  return `${publicUrl()}${pathName}${lang === 'de' ? '' : `?lang=${lang}`}`;
}

// Kanonische URL + hreflang-Alternativen fuer die Template-Variablen
// `canonical`, `altDe`, `altEn`. Leer, wenn die Instanz nicht indexierbar ist.
function seoLinks(pathName, lang) {
  if (!seoIndexable()) return { canonical: '', altDe: '', altEn: '' };
  return {
    canonical: langUrl(pathName, lang),
    altDe: langUrl(pathName, 'de'),
    altEn: langUrl(pathName, 'en'),
  };
}

// Brotkrumen fuer Unterseiten (Startseite → Seite) als BreadcrumbList.
function breadcrumbLd(pageName, pathName, lang) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: appName(), item: langUrl('/', lang) },
      { '@type': 'ListItem', position: 2, name: pageName, item: langUrl(pathName, lang) },
    ],
  };
}

// Cache-Header der oeffentlichen Inhaltsseiten: der Browser darf die Seite
// halten (Zurueck-Cache, 304 per ETag), muss aber vor jeder Nutzung
// nachfragen — `GET /` liefert eingeloggt die App-Shell statt der Landing,
// und `private` haelt geteilte Caches heraus. Kein `no-store`: das schliesst
// die Seite vom Back/Forward-Cache aus.
function setPublicPageHeaders(res) {
  res.set('Cache-Control', 'private, no-cache');
  // Der Sprach-Hinweis (langSwitchVars) haengt am Accept-Language.
  res.set('Vary', 'Accept-Language');
}

// Vorschaubild beim Teilen: 1200×630-JPEG je Seite und Sprache
// (scripts/landing-shots/og-image.js), Name `og-<seite>-<lang>.jpg`.
const OG_IMAGE = { width: 1200, height: 630, type: 'image/jpeg' };
const OG_LOCALE = { de: 'de_DE', en: 'en_US' };
function ogImageUrl(page, lang) {
  return `${publicUrl()}/img/landing/og-${page}-${lang}.jpg`;
}

// Gemeinsamer Head-Block der oeffentlichen Seiten (Template-Variable
// `headMetaHtml`): Social-Vorschau (nur mit `ogImage`) + Browserleiste +
// Homescreen-Icon. Die theme-color-Werte spiegeln --color-bg wie
// public/index.html; theme-init.js zieht sie bei manueller Theme-Wahl nach.
function headMetaHtml({ lang, ogImage, ogAlt }) {
  const other = lang === 'de' ? 'en' : 'de';
  const lines = [];
  if (ogImage) {
    lines.push(
      `<meta property="og:site_name" content="${escHtml(appName())}">`,
      `<meta property="og:locale" content="${OG_LOCALE[lang]}">`,
      `<meta property="og:locale:alternate" content="${OG_LOCALE[other]}">`,
      `<meta property="og:image" content="${escHtml(ogImage)}">`,
      `<meta property="og:image:type" content="${OG_IMAGE.type}">`,
      `<meta property="og:image:width" content="${OG_IMAGE.width}">`,
      `<meta property="og:image:height" content="${OG_IMAGE.height}">`,
      `<meta property="og:image:alt" content="${escHtml(ogAlt || appName())}">`,
    );
  }
  lines.push(
    '<meta name="theme-color" content="#faf7f2" media="(prefers-color-scheme: light)">',
    '<meta name="theme-color" content="#1a1816" media="(prefers-color-scheme: dark)">',
    '<link rel="apple-touch-icon" href="/icon-192.png">',
  );
  return lines.join('\n  ');
}

function appName() {
  return appSettings.get('app.name') || 'Schreibwerkstatt';
}

module.exports = {
  render, escHtml, toInlineJson, bodyLang, pageLang, langSwitchVars, publicUrl, seoIndexable,
  demoUrl, appName, LANGS, langUrl, seoLinks, breadcrumbLd, setPublicPageHeaders,
  headMetaHtml, ogImageUrl,
};
