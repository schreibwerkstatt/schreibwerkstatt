'use strict';
// Geteilte Bausteine der oeffentlichen SSR-Seiten (Landing, Themenseiten,
// Werkzeug, Register, Datenschutz): Template-Laden, Mini-Substitution,
// Sprachwahl, SEO-Schalter. Konsumenten: routes/public.js, routes/public-pages.js.

const path = require('path');
const fs = require('fs');
const appSettings = require('./app-settings');
const demoUser = require('./demo-user');

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
// ld+json — Aufrufer escapen `<` selbst, siehe toInlineJson).
// Konditionale Bloecke: {{#if flag}}…{{/if}} bleiben nur, wenn vars[flag] truthy ist.
function render(name, vars) {
  const tpl = loadTemplate(name)
    .replace(/\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, flag, body) => (vars[flag] ? body : ''));
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const raw = vars[key];
    if (raw === undefined || raw === null) return '';
    if (key.endsWith('Json')) return String(raw); // bereits JSON.stringify
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
const LANGS = ['de', 'en'];
function bodyLang(req) {
  const q = String(req.query?.lang || '').toLowerCase();
  if (LANGS.includes(q)) return q;
  const accept = String(req.headers['accept-language'] || '').toLowerCase();
  return accept.startsWith('en') ? 'en' : 'de';
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

function appName() {
  return appSettings.get('app.name') || 'Schreibwerkstatt';
}

module.exports = {
  render, escHtml, toInlineJson, bodyLang, publicUrl, seoIndexable, demoUrl, appName,
  LANGS, langUrl, seoLinks, breadcrumbLd,
};
