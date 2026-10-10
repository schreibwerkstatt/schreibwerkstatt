// Ersetzungs-Kern von Lektorat + Abschnitts-Chat (public/js/utils/html-find.js,
// Vergleichsform aus public/js/utils/text-match.js):
//   - Anführungszeichen-Faltung: KI schreibt gerade Quotes, im Buch stehen
//     «» / „“ — Fundstelle, Zählung und Rückgängig müssen trotzdem greifen.
//   - Exakter Roh-Treffer nie in Attributen (href/alt/data-*) oder Entities.
//   - Ersatz ist Klartext (maskiert), nie Markup.
//   - Wort-Diff-Ersatz: unveränderte Wörter behalten Auszeichnung und Quotes.
//   - Rand-Whitespace verklebt keine Wörter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { foldQuotes, normalizeMatchText, countInText } from '../../public/js/utils/text-match.js';

// Minimaler Entity-Decoder statt Browser-Parser (html-find.js legt beim Laden
// ein <textarea> an, wenn `document` existiert) — sonst sähe die Text-View in
// Node `&amp;` als fünf Zeichen. Deshalb Stub VOR dem dynamischen Import.
const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': '\u00a0' };
globalThis.document ??= {
  createElement: () => {
    let v = '';
    return { set innerHTML(x) { v = ENT[x] ?? x; }, get value() { return v; } };
  },
};
const { countInHtml, findInHtml, replaceInHtml } = await import('../../public/js/utils/html-find.js');

// ── Vergleichsform ───────────────────────────────────────────────────────────

test('foldQuotes: typografische Varianten → gerade, längenerhaltend', () => {
  const s = '„a“ «b» ‚c‘ ‹d› ’e”';
  const f = foldQuotes(s);
  assert.equal(f, '"a" "b" \'c\' \'d\' \'e"');
  assert.equal(f.length, s.length);
});

test('countInText: Whitespace und Anführungszeichen tolerant', () => {
  const text = 'Sie sagte: «Komm  her», und ging.\n\nDann «Komm her».';
  assert.equal(countInText(text, 'sagte: "Komm her"'), 1);
  assert.equal(countInText(text, '"Komm her"'), 2);
  assert.equal(countInText(text, 'gibt es nicht'), 0);
  assert.equal(normalizeMatchText('  a \n b  '), 'a b');
});

// ── Anführungszeichen ────────────────────────────────────────────────────────

test('countInHtml/findInHtml: gerade Quotes finden Buch-Quotes (und umgekehrt)', () => {
  const html = '<p>Sie sagte: «Komm her», und ging.</p>';
  assert.equal(countInHtml(html, 'sagte: "Komm her", und'), 1);
  assert.ok(findInHtml(html, 'sagte: "Komm her", und'));
  const html2 = '<p>Er rief "Hallo" und lief.</p>';
  assert.equal(countInHtml(html2, 'rief „Hallo“ und'), 1);
});

test('replaceInHtml: Buch-Quotes in unveränderten Wörtern bleiben stehen', () => {
  const html = '<p>Sie sagte: «Komm her», und ging.</p>';
  assert.equal(
    replaceInHtml(html, 'sagte: "Komm her", und', 'rief: "Komm her", und'),
    '<p>Sie rief: «Komm her», und ging.</p>',
  );
});

test('replaceInHtml: typografische Quotes im Ersatz sind eine gewollte Änderung', () => {
  const html = '<p>Er rief <em>«Hallo»</em>.</p>';
  assert.equal(replaceInHtml(html, 'rief "Hallo"', 'rief „Hallo“'), '<p>Er rief <em>„Hallo“</em>.</p>');
});

test('Rückgängig nach Quote-Normalisierung: Ersatz mit geraden Quotes wird gefunden', () => {
  // Übernehmen schreibt `"Komm"`, die Quote-Normalisierung macht daraus «Komm».
  const afterApply = '<p>Sie rief: «Komm», und ging.</p>';
  const ersatz = 'rief: "Komm", und';
  assert.equal(countInHtml(afterApply, ersatz), 1);
  assert.equal(replaceInHtml(afterApply, ersatz, 'sagte: "Komm", und'), '<p>Sie sagte: «Komm», und ging.</p>');
});

// ── Attribute / Entities ─────────────────────────────────────────────────────

test('findInHtml: Treffer im alt-Attribut zählt nicht, der sichtbare Text schon', () => {
  const html = '<p><img alt="Haus am See"> Das Haus am See.</p>';
  assert.equal(countInHtml(html, 'Haus am See'), 1);
  const m = findInHtml(html, 'Haus am See');
  assert.ok(m.htmlStart > html.indexOf('>'), 'Fundstelle liegt hinter dem Tag');
  assert.equal(replaceInHtml(html, 'Haus am See', 'Haus am Meer'), '<p><img alt="Haus am See"> Das Haus am Meer.</p>');
});

test('findInHtml: Treffer in href/data-* wird übersprungen', () => {
  const html = '<p><a href="https://beispiel.ch/wald">Link</a> im wald gefunden <span data-note="wald">x</span></p>';
  const out = replaceInHtml(html, 'wald', 'Wald');
  assert.ok(out.includes('href="https://beispiel.ch/wald"'));
  assert.ok(out.includes('data-note="wald"'));
  assert.ok(out.includes('im Wald gefunden'));
});

test('findInHtml: Treffer mitten in einer Entity wird übersprungen', () => {
  const html = '<p>A &amp; B, amp ist kein Wort.</p>';
  assert.equal(replaceInHtml(html, 'amp', 'Ampel'), '<p>A &amp; B, Ampel ist kein Wort.</p>');
});

// ── Maskierung ───────────────────────────────────────────────────────────────

test('replaceInHtml: Ersatz ist Klartext — Markup wird maskiert, nicht eingesetzt', () => {
  const html = '<p>Er kam spät.</p>';
  const out = replaceInHtml(html, 'kam spät', 'kam <img src=x onerror=alert(1)> & ging');
  assert.equal(out, '<p>Er kam &lt;img src=x onerror=alert(1)&gt; &amp; ging.</p>');
});

test('replaceInHtml: Rückgängig über maskierten Ersatz stellt das Original wieder her', () => {
  const html = '<p>Tom und Jerry.</p>';
  const applied = replaceInHtml(html, 'Tom und Jerry', 'Tom & Jerry');
  assert.equal(applied, '<p>Tom &amp; Jerry.</p>');
  assert.equal(countInHtml(applied, 'Tom & Jerry'), 1);
  assert.equal(replaceInHtml(applied, 'Tom & Jerry', 'Tom und Jerry'), html);
});

// ── Rand-Whitespace ──────────────────────────────────────────────────────────

test('replaceInHtml: Rand-Whitespace der Nadel verklebt keine Wörter', () => {
  assert.equal(replaceInHtml('<p>Tom und Jerry</p>', ' und ', 'sowie'), '<p>Tom sowie Jerry</p>');
  assert.equal(replaceInHtml('<p>Tom und Jerry</p>', 'und ', ' sowie '), '<p>Tom sowie Jerry</p>');
});

// ── Wort-Diff-Ersatz ─────────────────────────────────────────────────────────

test('Wort-Diff: geändertes Wort in <em> → Auszeichnung bleibt', () => {
  const html = '<p>Er sagte <em>das magische</em> Wort.</p>';
  assert.equal(replaceInHtml(html, 'das magische Wort', 'das geheime Wort'), '<p>Er sagte <em>das geheime</em> Wort.</p>');
});

test('Wort-Diff: mehrere Auszeichnungen, nur das Geänderte wird ersetzt', () => {
  const html = '<p>Er sagte <strong>laut</strong> und <em>klar</em> nein.</p>';
  assert.equal(
    replaceInHtml(html, 'sagte laut und klar nein', 'rief laut und deutlich nein'),
    '<p>Er rief <strong>laut</strong> und <em>deutlich</em> nein.</p>',
  );
});

test('Wort-Diff: gelöschtes, ganz ausgezeichnetes Wort hinterlässt kein leeres Tag', () => {
  assert.equal(replaceInHtml('<p>Er ging <em>sehr</em> langsam.</p>', 'ging sehr langsam', 'ging langsam'), '<p>Er ging langsam.</p>');
  assert.equal(replaceInHtml('<p><em>sehr</em> schön</p>', 'sehr schön', 'schön'), '<p>schön</p>');
});

test('Wort-Diff: Einfügung vor einem ausgezeichneten Wort', () => {
  const html = '<p>Ein <em>roter</em> Ball.</p>';
  assert.equal(replaceInHtml(html, 'Ein roter Ball', 'Ein grosser roter Ball'), '<p>Ein grosser <em>roter</em> Ball.</p>');
});

test('Wort-Diff: Tag-Balance bleibt bei Ersatz über die Spannengrenze', () => {
  const html = '<p>Das <em>ist kursiv</em> und normal.</p>';
  const out = replaceInHtml(html, 'ist kursiv und normal', 'war kursiv oder normal');
  assert.equal(out, '<p>Das <em>war kursiv</em> oder normal.</p>');
  assert.equal((out.match(/<em\b/g) || []).length, (out.match(/<\/em>/g) || []).length);
});

test('Ganzer Ersatz über Close+Open-Waisen verschachtelt korrekt', () => {
  // Wort-Diff ersetzt "kursiv und fett" komplett: die Waisen </em> (Open davor)
  // und <strong> (Close danach) stehen um den neuen Text, nicht verkehrt herum.
  const html = '<p><em>sehr kursiv</em> und <strong>fett hier</strong></p>';
  const out = replaceInHtml(html, 'kursiv und fett', 'ganz anders');
  assert.ok(!/<strong>[^<]*<\/em>/.test(out), `keine Fehlverschachtelung: ${out}`);
  assert.equal((out.match(/<em\b/g) || []).length, (out.match(/<\/em>/g) || []).length);
  assert.equal((out.match(/<strong\b/g) || []).length, (out.match(/<\/strong>/g) || []).length);
  assert.ok(out.includes('ganz') && out.includes('anders'));
});

test('Wort-Diff: Block-/Link-/Marker-Guards bleiben vor dem Diff', () => {
  const html = '<p>Besuche <a href="https://example.com">unsere Website</a> heute.</p>';
  assert.equal(replaceInHtml(html, 'Besuche unsere Website heute', 'Besuche unsere Seite heute'), html);
  const block = '<p>Er ging nach Hause.</p><p>Dann schlief er ein.</p>';
  assert.equal(replaceInHtml(block, 'nach Hause. Dann', 'heim. Dann'), block);
});
