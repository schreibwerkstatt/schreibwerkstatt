'use strict';
// Public-Landing + Register.
//
// Routen (alle vor dem Auth-Guard in server.js gemountet):
//   GET  /              — eingeloggt → next(), unauth → landing.html
//   GET  /landing       — immer landing.html
//   GET  /register      — Formular (kein Session-Zwang)
//   POST /register      — Anfrage anlegen + Admin-Mail (Rate-Limit + optional Captcha)
//   GET  /datenschutz    — öffentliche Datenschutzerklärung (kein Session-Zwang)
//   GET  /privacy        — englischer Alias auf dieselbe Seite (Sprache via Accept-Language)
//   GET  /robots.txt     — Crawler-Regeln (dynamisch, siehe `seo.indexable`)
//   GET  /sitemap.xml    — die indexierbaren Seiten (nur mit `app.public_url`)
//
// SEO: indexierbar sind ausschliesslich Landing, Datenschutz und die
// Inhaltsseiten aus routes/public-pages.js (Themenseiten + Werkzeug). Register- und
// Login-Seite tragen ihr `noindex` fest im Markup (Funnel-Schritte, kein Inhalt),
// geteilte Inhalte zusaetzlich einen X-Robots-Tag-Header (routes/share.js).
// Die Instanz als Ganzes laesst sich ueber `seo.indexable` aus dem Index nehmen.
// Sprachfassungen: `?lang=en` (Deutsch ohne Parameter) mit hreflang-Gruppe im
// <head> und in der Sitemap — Helfer `seoLinks`/`langUrl` in lib/public-render.js.
//
// Anti-User-Enumeration: POST /register liefert IMMER 202 mit derselben
// Erfolgsmeldung, egal ob Email schon existiert, bereits pending ist oder
// neu angelegt wurde. Doppel-Anfragen werden via Partial-UNIQUE-Index
// vom DB-Layer abgefangen — Caller schluckt die SQLITE_CONSTRAINT-Exception.

const express = require('express');
const logger = require('../logger');
const appSettings = require('../lib/app-settings');
const appUsers = require('../db/app-users');
const regRequests = require('../db/registration-requests');
const mailer = require('../lib/mailer');
const rateLimit = require('../lib/register-ratelimit');
const { deriveSource, cleanSource } = require('../lib/register-source');
const altcha = require('../lib/altcha');
const extensionRelease = require('../lib/extension-release');
const macclientRelease = require('../lib/macclient-release');
const { tServer } = require('../lib/i18n-server');
const {
  render: _render, escHtml: _escHtml, toInlineJson, bodyLang: _bodyLang, publicUrl: _publicUrl,
  seoIndexable: _seoIndexable, demoUrl, appName: _appName, seoLinks, langUrl, LANGS,
  pageLang, langSwitchVars, setPublicPageHeaders, headMetaHtml, ogImageUrl, publicHeaderHtml, publicFooterHtml,
} = require('../lib/public-render');
const { PUBLIC_PAGE_PATHS } = require('./public-pages');

const router = express.Router();

function _clientIp(req) {
  // Nur req.ip (aufgeloest via `trust proxy`-Hop). Client-supplied X-Forwarded-For
  // ist spoofbar und darf fuer Rate-Limit-/Anti-Abuse-Keys nicht verwendet werden.
  return req.ip || null;
}

// Herkunft des aktuellen Seitenaufrufs (Kampagnen-Parameter oder fremder Referer).
function _requestSource(req) {
  return deriveSource({ query: req.query, referer: req.headers.referer || null, ownHost: req.get('host') });
}

// Strukturdaten fuer Suchmaschinen: was die Seite anbietet (SoftwareApplication
// mit Preis 0 waehrend der Beta). Kein FAQPage-Markup — Google zeigt das seit
// 2023 nur noch fuer Behoerden-/Gesundheitsseiten an.
// Dazu WebSite: daraus nimmt Google den Website-Namen, der im Suchergebnis
// ueber dem Titel steht (sonst raet Google aus Domain und Titel).
function _landingLd({ appName, description, url, lang }) {
  return toInlineJson({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'SoftwareApplication',
        name: appName,
        description,
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'Web, macOS, Android',
        inLanguage: lang,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'CHF' },
        ...(url ? { url } : {}),
      },
      ...(url ? [{ '@type': 'WebSite', name: appName, url: `${_publicUrl()}/`, inLanguage: lang }] : []),
    ],
  });
}

// Schluessel der Landing-Texte, die 1:1 als gleichnamige Template-Variable
// (ohne `landing.`-Praefix) ins Template gehen.
const LANDING_TEXT_KEYS = [
  'heroTitle', 'heroText', 'demoLabel', 'demoNote', 'loginPrompt', 'statusText',
  'principleTitle', 'principleText', 'loginLabel', 'registerLabel',
  'featuresTitle', 'featLinkLektorat', 'featLinkTestleser',
  'feat1Title', 'feat1Desc', 'feat2Title', 'feat2Desc', 'feat3Title', 'feat3Desc',
  'moreTitle', 'allFeaturesLink',
  'more1Title', 'more1Desc', 'more2Title', 'more2Desc', 'more3Title', 'more3Desc',
  'more4Title', 'more4Desc', 'more5Title', 'more5Desc', 'more6Title', 'more6Desc',
  'trustTitle', 'trust1Title', 'trust1Text', 'trust2Title', 'trust2Text',
  'trust3Title', 'trust3Text', 'trust4Title', 'trust4Text', 'privacyMore',
  'faqTitle', 'faq1Q', 'faq1A', 'faq2Q', 'faq2A', 'faq3Q', 'faq3A',
  'faq4Q', 'faq4A', 'faq5Q', 'faq5A', 'faq6Q', 'faq6A',
  'macTitle', 'macDesc', 'macLinkLabel', 'androidTitle', 'androidDesc', 'androidLinkLabel',
  'extensionTitle', 'extensionDesc', 'extensionLinkLabel', 'clientsTitle',
];

function _renderLanding(req, res) {
  const lang = pageLang(req);
  const source = _requestSource(req);
  const t = (key) => tServer(key, lang);
  const appName = _appName();
  const seo = seoLinks('/', lang);
  const demo = demoUrl();
  const metaDescription = t('landing.metaDescription');
  const texts = Object.fromEntries(LANDING_TEXT_KEYS.map(k => [k, t(`landing.${k}`)]));
  const title = `${appName}: ${texts.heroTitle.replace(/\.$/, '')}`;
  const langSwitch = langSwitchVars(req, '/', lang);
  setPublicPageHeaders(res);
  res.type('html').send(_render('landing.html', {
    ...texts,
    lang,
    noindex:       !seo.canonical,
    ...seo,
    ...langSwitch,
    headerHtml:    publicHeaderHtml({ lang, h1: texts.heroTitle, intro: texts.heroText, home: true }),
    footerHtml:    publicFooterHtml({ lang, current: '/', ...langSwitch }),
    title,
    metaDescription,
    headMetaHtml:  headMetaHtml({ lang, ogImage: ogImageUrl('landing', lang), ogAlt: title }),
    ldJson:        _landingLd({ appName, description: metaDescription, url: seo.canonical, lang }),
    appName,
    demoUrl:       demo,
    noDemo:        !demo,
    registerQuery: source ? `?src=${encodeURIComponent(source)}` : '',
    macUrl:        macclientRelease.MAC_APP_STORE_URL,
    androidUrl:    'https://github.com/schreibwerkstatt/mobile/releases/latest',
    extensionUrl:  extensionRelease.CHROME_STORE_URL,
  }));
}

function _renderRegister(req, res) {
  const lang = _bodyLang(req);
  const t = (key) => tServer(key, lang);
  res.set('Cache-Control', 'no-store');
  const config = {
    altchaEnabled: altcha.isEnabled(),
    source: _requestSource(req),
    i18n: {
      success:   t('register.success'),
      rateLimit: t('register.rateLimit'),
      invalid:   t('register.invalid'),
      error:     t('register.error'),
    },
  };
  res.type('html').send(_render('register.html', {
    lang,
    title:          t('register.title'),
    subtitle:       t('register.subtitle'),
    emailLabel:     t('register.emailLabel'),
    nameLabel:      t('register.nameLabel'),
    messageLabel:   t('register.messageLabel'),
    sourceNoteLabel: t('register.sourceNoteLabel'),
    submitLabel:    t('register.submitLabel'),
    backToLanding:  t('register.backToLanding'),
    footerHint:     t('register.footer'),
    privacyLabel:   t('privacy.footerLink'),
    configJson:     JSON.stringify(config).replace(/</g, '\\u003c'),
  }));
}

// Öffentliche Datenschutzerklärung. Statisches Template mit i18n-Substitution,
// kein Session-Zwang — verlinkt u.a. aus den nativen Clients (macOS, Android) und für die
// App-Store-/Play-Console-Einreichung erreichbar (Lösch-Weg: Anker #loeschung). Sprache: /datenschutz aus der URL, Alias /privacy via Accept-Language.
function _renderPrivacy(req, res, { alias = false } = {}) {
  // /datenschutz ist indexiert: Sprache allein aus der URL. /privacy ist ein
  // nicht indexierter Alias (macOS-Client, App-Store-Einreichung) und folgt
  // weiter dem Browser.
  const lang = alias ? _bodyLang(req) : pageLang(req);
  const t = (key) => tServer(key, lang);
  const appName = _appName();
  const analyticsEnabled = !!appSettings.get('analytics.plausible.enabled');
  // /privacy ist ein Alias derselben Seite — beide zeigen auf /datenschutz,
  // sonst konkurrieren zwei URLs mit identischem Inhalt um dieselbe Position.
  const seo = seoLinks('/datenschutz', lang);
  const langSwitch = langSwitchVars(req, '/datenschutz', lang);
  setPublicPageHeaders(res);
  res.type('html').send(_render('datenschutz.html', {
    lang,
    noindex:       !seo.canonical,
    ...seo,
    ...langSwitch,
    headerHtml:    publicHeaderHtml({ lang, h1: t('privacy.title') }),
    footerHtml:    publicFooterHtml({ lang, current: '/datenschutz', ...langSwitch }),
    headMetaHtml:  headMetaHtml({ lang }),
    metaDescription: t('privacy.metaDescription'),
    appName,
    analyticsEnabled,
    pageTitle:     t('privacy.title'),
    tocLabel:      t('privacy.tocLabel'),
    lastUpdated:   t('privacy.lastUpdated'),
    intro:         t('privacy.intro'),
    sec1Title:     t('privacy.sec1Title'),  sec1Body:  t('privacy.sec1Body'),
    sec2Title:     t('privacy.sec2Title'),  sec2Intro: t('privacy.sec2Intro'),
    sec2ItemA:     t('privacy.sec2ItemA'),  sec2ItemB: t('privacy.sec2ItemB'),
    sec2ItemC:     t('privacy.sec2ItemC'),  sec2ItemD: t('privacy.sec2ItemD'),
    sec2ItemE:     t('privacy.sec2ItemE'),
    sec3Title:     t('privacy.sec3Title'),  sec3Body:  t('privacy.sec3Body'),
    sec4Title:     t('privacy.sec4Title'),  sec4Body:  t('privacy.sec4Body'),
    secAiTitle:    t('privacy.secAiTitle'), secAiBody: t('privacy.secAiBody'),
    sec5Title:     t('privacy.sec5Title'),  sec5Body:  t('privacy.sec5Body'),
    sec6Title:     t('privacy.sec6Title'),  sec6Body:  t('privacy.sec6Body'),
    sec6AndroidIntro: t('privacy.sec6AndroidIntro'),
    sec6AndroidItemA: t('privacy.sec6AndroidItemA'), sec6AndroidItemB: t('privacy.sec6AndroidItemB'),
    sec6AndroidItemC: t('privacy.sec6AndroidItemC'), sec6AndroidItemD: t('privacy.sec6AndroidItemD'),
    sec6AndroidItemE: t('privacy.sec6AndroidItemE'), sec6AndroidItemF: t('privacy.sec6AndroidItemF'),
    sec7Title:     t('privacy.sec7Title'),  sec7Body:  t('privacy.sec7Body'),
    sec8Title:     t('privacy.sec8Title'),
    sec8Body:      analyticsEnabled ? t('privacy.sec8BodyAnalytics') : t('privacy.sec8Body'),
    secAnalyticsTitle: t('privacy.secAnalyticsTitle'), secAnalyticsBody: t('privacy.secAnalyticsBody'),
    sec9Title:     t('privacy.sec9Title'),  sec9Body:  t('privacy.sec9Body'),
  }));
}

// GET / — unauth → landing, eingeloggt → next() (SPA-Shell wird vom
// nachfolgenden staticServe in server.js geliefert).
router.get('/', (req, res, next) => {
  if (req.session?.user) return next();
  if (process.env.LOCAL_DEV_MODE === 'true') return next();
  return _renderLanding(req, res);
});

// robots.txt — dynamisch, weil die Sitemap-Zeile die konfigurierte Basis-URL
// braucht und Nebeninstanzen (Demo/Staging) sich per `seo.indexable` komplett
// sperren koennen. Bewusst KEIN Disallow fuer /share, /register oder /login:
// diese Seiten sagen selbst „noindex", und ein Disallow wuerde den Crawler
// daran hindern, das zu lesen — die URL kaeme dann ohne Inhalt in den Index
// statt gar nicht. Sperren heisst hier: crawlen lassen und noindex ausliefern.
router.get('/robots.txt', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  if (!_seoIndexable()) {
    return res.type('text/plain').send('User-agent: *\nDisallow: /\n');
  }
  res.type('text/plain').send(
    `User-agent: *\nAllow: /\n\nSitemap: ${_publicUrl()}/sitemap.xml\n`
  );
});

// sitemap.xml — nur die Seiten, die ueberhaupt indexiert werden sollen.
// /privacy fehlt absichtlich (Alias von /datenschutz, siehe canonical dort).
router.get('/sitemap.xml', (req, res) => {
  if (!_seoIndexable()) return res.status(404).type('text/plain').send('Not found');
  // Jede Sprachfassung als eigene <url>, jede mit allen Alternativen
  // (hreflang-Vorgabe: die Gruppe muss von jedem Mitglied aus vollstaendig sein).
  // Kein lastmod/priority/changefreq: Google ignoriert die beiden letzten, und
  // ein lastmod ohne echte Aenderungsquelle waere geraten.
  const pages = ['/', ...PUBLIC_PAGE_PATHS, '/datenschutz'];
  const urls = pages.flatMap(p => {
    const alts = [...LANGS.map(l => [l, langUrl(p, l)]), ['x-default', langUrl(p, 'de')]]
      .map(([hl, href]) => `    <xhtml:link rel="alternate" hreflang="${hl}" href="${_escHtml(href)}"/>`)
      .join('\n');
    return LANGS.map(l => `  <url>\n    <loc>${_escHtml(langUrl(p, l))}</loc>\n${alts}\n  </url>`);
  }).join('\n');
  res.set('Cache-Control', 'public, max-age=3600');
  res.type('application/xml').send(
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n'
    + `${urls}\n</urlset>\n`
  );
});

router.get('/landing', _renderLanding);
router.get('/register', _renderRegister);
router.get('/datenschutz', (req, res) => _renderPrivacy(req, res));
router.get('/privacy', (req, res) => _renderPrivacy(req, res, { alias: true })); // englischer Alias — eine Seite, Sprache via _bodyLang

// ALTCHA-Challenge fuer Register- + Admin-Login-Widget (kein Auth-Zwang, vor
// dem Guard gemountet). Liefert eine frische signierte Challenge; 503 wenn
// ALTCHA aus ist (das Widget wird dann gar nicht erst geladen).
router.get('/altcha/challenge', async (req, res) => {
  if (!altcha.isEnabled()) return res.status(503).json({ error_code: 'ALTCHA_DISABLED' });
  res.set('Cache-Control', 'no-store');
  try {
    res.json(await altcha.createPowChallenge());
  } catch (e) {
    logger.warn(`ALTCHA challenge failed: ${e.message}`);
    res.status(500).json({ error_code: 'ALTCHA_CHALLENGE_FAILED' });
  }
});

const _emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post('/register', express.json({ limit: '8kb' }), async (req, res) => {
  const ip = _clientIp(req);
  const userAgent = req.headers['user-agent'] || null;
  const limit = rateLimit.check(ip);
  if (!limit.allowed) {
    res.set('Retry-After', String(limit.retryAfterSec));
    return res.status(429).json({ error_code: 'RATE_LIMITED', retryAfter: limit.retryAfterSec });
  }

  const { email, displayName, message, source, sourceNote, altcha: altchaSolution } = req.body || {};
  const e = String(email || '').trim().toLowerCase();
  if (!e || !_emailRegex.test(e) || e.length > 320) {
    rateLimit.record(ip); // Fehlversuch zaehlt — sonst freier Spam-Probe
    return res.status(400).json({ error_code: 'EMAIL_INVALID' });
  }

  const captcha = await altcha.verify(altchaSolution);
  if (!captcha.ok) {
    rateLimit.record(ip);
    return res.status(400).json({ error_code: 'CAPTCHA_FAILED' });
  }

  const nameTrim = String(displayName || '').trim().slice(0, 120) || null;
  const msgTrim  = String(message || '').trim().slice(0, 500) || null;
  const srcTrim  = cleanSource(source);
  const noteTrim = cleanSource(sourceNote, 200);

  let created = null;
  try {
    created = regRequests.createRequest({
      email: e, displayName: nameTrim, message: msgTrim, ip, userAgent,
      source: srcTrim, sourceNote: noteTrim,
    });
  } catch (err) {
    // SQLITE_CONSTRAINT (Partial-UNIQUE pending): bestehende pending-Anfrage —
    // antworten als waere alles ok, kein Leak.
    if (!String(err.message || '').includes('UNIQUE')) {
      logger.warn(`registration_requests insert failed: ${err.message}`);
    }
  } finally {
    rateLimit.record(ip);
  }

  if (created) {
    logger.info(`registration-request eingegangen: ${e} (ip=${ip || '-'})`);
    // Admin-Mail (best effort): an alle active admin-User. Mailer skipt
    // selbst, wenn Gmail-Credentials fehlen.
    try {
      const admins = appUsers.listUsers().filter(u => u.global_role === 'admin' && u.status === 'active');
      const adminUrl = (appSettings.get('app.public_url') || '').replace(/\/$/, '') + '/#admin-users';
      for (const a of admins) {
        mailer.send({
          to: a.email,
          template: 'registration-request-admin',
          locale: a.language || 'de',
          ctx: {
            email: e,
            displayName: nameTrim || '',
            ip: ip || '',
            createdAt: created.created_at,
            adminUrl,
            message: msgTrim || '',
            source: srcTrim || '',
            sourceNote: noteTrim || '',
          },
        }).catch(err => logger.warn(`admin-notify failed: ${err.message}`));
      }
    } catch (err) {
      logger.warn(`admin-notify lookup failed: ${err.message}`);
    }
  }

  return res.status(202).json({ ok: true });
});

module.exports = router;
