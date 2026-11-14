// Reiter der Admin-Einstellungen — die eine Liste, aus der Reiterleiste
// (admin-settings.html), Permalink (card-request.js#URL_TABS) und die Zuordnung
// der Verbindungstests zu ihrem Reiter lesen. Neuer Reiter = Eintrag hier plus
// `admin.settings.tab.<key>` in beiden Locales und eine `<section>` im Partial.

export const ADMIN_SETTINGS_TABS = Object.freeze([
  'auth', 'provider', 'smtp', 'jobs', 'cron', 'pdfa', 'analytics', 'languagetool',
  'stt', 'tts', 'image', 'embed', 'geocode', 'websearch', 'api', 'advanced',
]);

// Verbindungstest (`adminSettingsTest(kind)`) → Reiter, auf dem sein Ergebnis
// erscheint. Mehrere Tests teilen sich einen Reiter (Embedding + Reranker,
// Geocoding + Kacheln).
export const ADMIN_SETTINGS_TEST_TAB = Object.freeze({
  oauth: 'auth', provider: 'provider', smtp: 'smtp', languagetool: 'languagetool',
  stt: 'stt', tts: 'tts', image: 'image', embed: 'embed', rerank: 'embed',
  geocode: 'geocode', tiles: 'geocode', websearch: 'websearch',
});
