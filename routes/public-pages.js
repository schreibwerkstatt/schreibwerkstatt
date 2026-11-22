'use strict';
// Oeffentliche Inhaltsseiten fuer Erstbesucher (vor dem Auth-Guard gemountet):
//   GET /lektorat            — Themenseite KI-Lektorat
//   GET /testleser           — Themenseite Testleser-Feedback
//   GET /wortwiederholungen  — kostenloses Werkzeug: Wiederholungen, lange
//                              Saetze, Satzanfaenge. Rechnet ausschliesslich im
//                              Browser (public/js/public-tools/), kein Upload,
//                              kein KI-Call — kostet den Betreiber nichts.
//
// Indexierbar wie Landing und Datenschutz (gleicher Schalter `seo.indexable`);
// die Pfade stehen in PUBLIC_PAGE_PATHS und damit in der Sitemap (routes/public.js).
// Sprache via Accept-Language, wie die uebrigen Pre-Auth-Seiten.

const express = require('express');
const { tServer, tServerParams } = require('../lib/i18n-server');
const {
  render, toInlineJson, bodyLang, publicUrl, demoUrl, appName, seoLinks, breadcrumbLd, langUrl,
} = require('../lib/public-render');

const router = express.Router();

// Themenseiten: Key-Praefix publicPage.<key>.* (title, metaDescription, h1,
// intro, s1..s3 Title/Text) + Produktbild aus /img/landing/ (pre-auth frei).
const TOPICS = {
  lektorat:  { img: '/img/landing/lektorat.webp' },
  testleser: { img: '/img/landing/testleser.webp' },
};

const TOOL_PATH = '/wortwiederholungen';
const PUBLIC_PAGE_PATHS = [...Object.keys(TOPICS).map(k => `/${k}`), TOOL_PATH];

// Werkzeug-Parameter: eine Quelle fuer Erklaertext (Server) und Rechnung (Client).
const TOOL_PARAMS = { window: 40, long: 30, maxChars: 200000 };

function _commonVars(req, pathName) {
  const lang = bodyLang(req);
  const t = (key, params) => (params ? tServerParams(key, params, lang) : tServer(key, lang));
  const seo = seoLinks(pathName, lang);
  const demo = demoUrl();
  return {
    t, lang,
    vars: {
      lang,
      appName: appName(),
      noindex: !seo.canonical,
      ...seo,
      demoUrl: demo,
      demoLabel: t('publicPage.demoLabel'),
      registerLabel: t('publicPage.registerLabel'),
      backToLanding: t('publicPage.backToLanding'),
      privacyLabel: t('privacy.footerLink'),
      footer: t('landing.footer'),
    },
  };
}

function _ogImage(path) {
  return `${publicUrl()}${path}`;
}

function _renderTopic(key) {
  const topic = TOPICS[key];
  return (req, res) => {
    const { t, vars } = _commonVars(req, `/${key}`);
    const p = (f) => t(`publicPage.${key}.${f}`);
    res.set('Cache-Control', 'no-store');
    res.set('Vary', 'Accept-Language');
    res.type('html').send(render('topic.html', {
      ...vars,
      title: `${p('title')} – ${vars.appName}`,
      metaDescription: p('metaDescription'),
      ogImage: _ogImage(topic.img),
      ldJson: toInlineJson(breadcrumbLd(p('h1'), `/${key}`, vars.lang)),
      img: topic.img,
      h1: p('h1'),
      intro: p('intro'),
      s1Title: p('s1Title'), s1Text: p('s1Text'),
      s2Title: p('s2Title'), s2Text: p('s2Text'),
      s3Title: p('s3Title'), s3Text: p('s3Text'),
      ctaTitle: t('publicPage.ctaTitle'),
      ctaText: t('publicPage.ctaText'),
    }));
  };
}

// In einem @graph traegt nur die Wurzel den @context.
const _withoutContext = ({ '@context': _ctx, ...rest }) => rest;

// Werkzeug: kostenlose Web-Anwendung (WebApplication, Preis 0) + Brotkrumen.
function _toolLd(t, lang) {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebApplication',
        name: t('publicTool.h1'),
        description: t('publicTool.metaDescription'),
        url: langUrl(TOOL_PATH, lang),
        inLanguage: lang,
        applicationCategory: 'UtilitiesApplication',
        operatingSystem: 'Web',
        isAccessibleForFree: true,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'CHF' },
      },
      _withoutContext(breadcrumbLd(t('publicTool.h1'), TOOL_PATH, lang)),
    ],
  };
}

function _renderTool(req, res) {
  const { t, lang, vars } = _commonVars(req, TOOL_PATH);
  // Strings fuer das Client-Skript: dieselben Keys, aufgeloest in der
  // Seitensprache (kein i18n-Bundle pre-auth).
  const clientKeys = [
    'statsWords', 'statsSentences', 'statsAvg', 'statsRepeats', 'textTitle',
    'repeatsTitle', 'repeatsEmpty', 'longTitle', 'longEmpty', 'openersTitle',
    'openersEmpty', 'wordsUnit', 'timesUnit', 'empty', 'tooLong',
  ];
  const config = {
    lang,
    ...TOOL_PARAMS,
    i18n: Object.fromEntries(clientKeys.map(k => [k, t(`publicTool.${k}`)])),
  };
  res.set('Cache-Control', 'no-store');
  res.set('Vary', 'Accept-Language');
  res.type('html').send(render('werkzeug.html', {
    ...vars,
    title: `${t('publicTool.title')} – ${vars.appName}`,
    metaDescription: t('publicTool.metaDescription'),
    ogImage: _ogImage('/img/landing/lektorat.webp'),
    ldJson: toInlineJson(_toolLd(t, lang)),
    h1: t('publicTool.h1'),
    intro: t('publicTool.intro'),
    privacy: t('publicTool.privacy'),
    inputLabel: t('publicTool.inputLabel'),
    placeholder: t('publicTool.placeholder'),
    submit: t('publicTool.submit'),
    method: t('publicTool.method', { window: TOOL_PARAMS.window, long: TOOL_PARAMS.long }),
    ctaTitle: t('publicTool.ctaTitle'),
    ctaText: t('publicTool.ctaText'),
    configJson: toInlineJson(config),
  }));
}

for (const key of Object.keys(TOPICS)) router.get(`/${key}`, _renderTopic(key));
router.get(TOOL_PATH, _renderTool);

module.exports = router;
module.exports.PUBLIC_PAGE_PATHS = PUBLIC_PAGE_PATHS;
module.exports.TOOL_PARAMS = TOOL_PARAMS;
