// Reichweitenmessung: was Plausible als URL und als Properties zu sehen bekommt.
//
// Der Bootstrap (server.js#/js/plausible-init.js) bettet den Quelltext beider
// Funktionen woertlich per fn.toString() ein — im Browser laeuft also exakt das,
// was hier geprueft wird.
//
// Tragende Invariante: nach der Normalisierung steht in KEINER erzeugbaren URL
// eine Ziffernfolge als eigenes Segment. Der App-Hash traegt Buch- und
// Entitaets-IDs, der Share-Pfad den Zugriffs-Token; beides in der Statistik
// sprengt entweder die Auswertung oder gibt einen Schluessel preis.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { normalizeAnalyticsUrl, analyticsProps } = require_('../../lib/analytics-url.js');

const HOST = 'https://schreibwerkstatt.example';

// Je ein Vertreter jeder Zweig-Sorte aus app-hash-router/build.js#_computeHash.
const HASHES = [
  '', '#profil', '#meine-statistik', '#meine-buecher', '#autorenprofil', '#hilfe', '#erste-schritte',
  '#search', '#import', '#admin/users', '#admin/settings', '#admin/usage',
  '#admin/usage/tokens', '#admin/logs', '#admin/js-errors',
  '#book/42', '#book/42/suche', '#book/42/figuren', '#book/42/figur/318',
  '#book/42/page/17', '#book/42/ort/9', '#book/42/song/3', '#book/42/szene/77',
  '#book/42/ereignis/5', '#book/42/kapitel/12', '#book/42/werkstatt/88',
  '#book/42/rueckblick/1904', '#book/42/plot/61', '#book/42/recherche/7',
  '#book/42/bucheditor', '#book/42/uebersicht', '#book/42/pdf', '#book/42/share',
];

test('keine numerische ID ueberlebt die Normalisierung', () => {
  for (const h of HASHES) {
    const out = normalizeAnalyticsUrl(HOST + '/' + h);
    const segs = out.slice(HOST.length).split(/[/#]/).filter(Boolean);
    const numeric = segs.filter(s => /^\d+$/.test(s));
    assert.deepEqual(numeric, [], `numerisches Segment in ${out} (aus ${h})`);
  }
});

test('Karten-Identitaet bleibt erhalten', () => {
  assert.equal(normalizeAnalyticsUrl(`${HOST}/#book/42/figur/318`), `${HOST}/#book/figur`);
  assert.equal(normalizeAnalyticsUrl(`${HOST}/#book/7/bucheditor`), `${HOST}/#book/bucheditor`);
  assert.equal(normalizeAnalyticsUrl(`${HOST}/#admin/usage/tokens`), `${HOST}/#admin/usage/tokens`);
  assert.equal(normalizeAnalyticsUrl(`${HOST}/#meine-statistik`), `${HOST}/#meine-statistik`);
  // Zwei verschiedene Buecher derselben Karte fallen zusammen — genau das ist der Zweck.
  assert.equal(
    normalizeAnalyticsUrl(`${HOST}/#book/1/plot/2`),
    normalizeAnalyticsUrl(`${HOST}/#book/999/plot/3`),
  );
});

test('Share-Token verlaesst die Instanz nicht', () => {
  const token = 'aZ9-tokenvalue_1234567890';
  const out = normalizeAnalyticsUrl(`${HOST}/share/${token}`);
  assert.equal(out, `${HOST}/share`);
  assert.ok(!out.includes(token));
  // Auch mit Query/Fragment am Share-Pfad.
  assert.ok(!normalizeAnalyticsUrl(`${HOST}/share/${token}?x=1#abschnitt`).includes(token));
  // Nicht-Share-Pfade bleiben unangetastet.
  assert.equal(normalizeAnalyticsUrl(`${HOST}/datenschutz`), `${HOST}/datenschutz`);
});

test('kaputte Eingabe faellt unveraendert durch', () => {
  assert.equal(normalizeAnalyticsUrl('kein-url'), 'kein-url');
});

const DOC = { documentElement: { getAttribute: () => 'de' } };
const WIN = { matchMedia: () => ({ matches: false }), navigator: {} };

test('Properties: Basis, Seite und Live-State werden zusammengefuehrt', () => {
  const p = analyticsProps(
    { oberflaeche: 'app' },
    { buchtyp: 'journalismus', rolle: 'lektor', modell: 'cloud' },
    DOC, WIN,
  );
  assert.deepEqual(p, {
    oberflaeche: 'app', sprache: 'de', anzeige: 'browser',
    buchtyp: 'journalismus', rolle: 'lektor', modell: 'cloud',
  });
});

test('Properties: Leerwerte fallen raus statt als Leerzeile zu zaehlen', () => {
  const p = analyticsProps({ oberflaeche: '' }, { buchtyp: null, rolle: '', modell: undefined }, DOC, WIN);
  assert.deepEqual(Object.keys(p).sort(), ['anzeige', 'sprache']);
});

test('Properties: fehlender Live-State ist kein Fehler', () => {
  const p = analyticsProps({ oberflaeche: 'share', umfang: 'book' }, undefined, DOC, WIN);
  assert.equal(p.oberflaeche, 'share');
  assert.equal(p.umfang, 'book');
});

test('Properties: PWA wird als eigener Anzeigemodus gemeldet', () => {
  const p = analyticsProps({}, null, DOC, { matchMedia: () => ({ matches: true }), navigator: {} });
  assert.equal(p.anzeige, 'pwa');
});
