// Gliederungseinheit je Buchtyp (public/js/i18n-unit-term.js): «Abschnitt»
// wird im Blog/Journalismus zu «Beitrag», im Tagebuch zu «Eintrag» — in allen
// Wortformen und Komposita, die de.json/en.json tatsächlich benutzen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyUnitTerm, unitTermFor } from '../../public/js/i18n-unit-term.js';

const de = (msg, unit, key = 'x.y') => applyUnitTerm(msg, { key, locale: 'de', unit });
const en = (msg, unit, key = 'x.y') => applyUnitTerm(msg, { key, locale: 'en', unit });

test('Buchtyp → Einheit', () => {
  assert.equal(unitTermFor('blog'), 'post');
  assert.equal(unitTermFor('journalismus'), 'post');
  assert.equal(unitTermFor('tagebuch'), 'entry');
  assert.equal(unitTermFor('roman'), 'section');
  assert.equal(unitTermFor(null), 'section');
});

test('Deutsch: Kasus, Plural mit Umlaut, Komposita, Abkürzung', () => {
  assert.equal(de('Lade aktuellen Abschnitt …', 'post'), 'Lade aktuellen Beitrag …');
  assert.equal(de('Alle {n} Abschnitte prüfen', 'entry'), 'Alle {n} Einträge prüfen');
  assert.equal(de('{n} von {total} Abschnitten', 'post'), '{n} von {total} Beiträgen');
  assert.equal(de('Titel des Abschnitts', 'entry'), 'Titel des Eintrags');
  assert.equal(de('Am Abschnittsende weiter', 'post'), 'Am Beitragsende weiter');
  assert.equal(de('abschnittsweise prüfen', 'entry'), 'eintragsweise prüfen');
  assert.equal(de('Nachbarabschnitte', 'post'), 'Nachbarbeiträge');
  assert.equal(de('Abschn./Kap.', 'entry'), 'Eintr./Kap.');
});

test('Englisch: Gross/Klein, Plural, Artikel vor «entry»', () => {
  assert.equal(en('Sections/ch.', 'post'), 'Posts/ch.');
  assert.equal(en('a section is locked', 'post'), 'a post is locked');
  assert.equal(en('a section is locked', 'entry'), 'an entry is locked');
  assert.equal(en('A section and 3 sections', 'entry'), 'An entry and 3 entries');
  assert.equal(en('{n} section(s) failed', 'entry'), '{n} entry/entries failed');
  assert.equal(en('{n} section(s) failed', 'post'), '{n} post(s) failed');
});

test('Grundbegriff, allgemeine Keys und fremde Locale bleiben unverändert', () => {
  assert.equal(de('Abschnitt', 'section'), 'Abschnitt');
  assert.equal(de('alle Bücher, Abschnitte', 'post', 'admin.backup.intro'), 'alle Bücher, Abschnitte');
  assert.equal(de('Abschnitt', 'post', 'landing.feat9Desc'), 'Abschnitt');
});

test('Nach der Ersetzung bleibt kein «Abschnitt»/«section» in den Locale-Dateien übrig', () => {
  const load = (l) => JSON.parse(readFileSync(new URL(`../../public/js/i18n/${l}.json`, import.meta.url), 'utf8'));
  for (const [locale, rx] of [['de', /abschn/i], ['en', /section/i]]) {
    for (const [key, msg] of Object.entries(load(locale))) {
      for (const unit of ['post', 'entry']) {
        const out = applyUnitTerm(msg, { key, locale, unit });
        if (/^(landing|privacy|admin)\./.test(key)) continue;
        assert.ok(!rx.test(out), `${locale}:${key} (${unit}) → ${out}`);
      }
    }
  }
});
