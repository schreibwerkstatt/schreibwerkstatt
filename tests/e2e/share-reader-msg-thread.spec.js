const { test, expect } = require('./_helpers/fixtures');

// Nachrichtenverlauf und Gedicht im SHARE-READER: die Block-Regeln kommen aus
// der SSoT (components/manuscript-content.css, `@layer components`). Das
// Absatzmodell des Readers (share/content.css) darf sie nicht überschreiben —
// eine unlayered `.share-content p`-Regel schlüge jede Layer-Regel und gäbe
// jeder Blase 1em Abstand plus Silbentrennung. Das Harness lädt dieselben
// Stylesheets in derselben Reihenfolge wie public/share.html.
const URL = 'http://localhost:8765/tests/fixtures/share-reader-harness.html';

const THREAD = '<div class="msg-thread"><p class="msg-name">Lena</p><p class="msg-in">bist du schon da?</p>'
  + '<p class="msg-out">gleich, 5 min</p><p class="msg-meta">Dienstag, 14:32</p></div>'
  + '<div class="poem"><p>Zeile eins</p><p>Zeile zwei</p></div>';

for (const prose of [false, true]) {
  test(`share-reader: Verlauf und Gedicht behalten die SSoT-Abstände${prose ? ' (Prosa)' : ''}`, async ({ page }) => {
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    const m = await page.evaluate(({ html, prose }) => {
      const art = document.getElementById('share-article');
      art.classList.toggle('share-content--prose', prose);
      art.insertAdjacentHTML('beforeend', html);
      const rows = [...art.querySelectorAll('.msg-thread > p')];
      const thread = art.querySelector('.msg-thread');
      const poem = [...art.querySelectorAll('.poem p')];
      const cs = (el) => getComputedStyle(el);
      return {
        gap: parseFloat(cs(thread).rowGap),
        margins: rows.filter(p => p.matches('.msg-in, .msg-out')).map(p => [cs(p).marginTop, cs(p).marginBottom]),
        hyphens: rows.map(p => cs(p).hyphens),
        dists: rows.slice(1).map((p, i) => p.getBoundingClientRect().top - rows[i].getBoundingClientRect().bottom),
        poemMargin: parseFloat(cs(poem[0]).marginBottom),
        poemFont: parseFloat(cs(poem[0]).fontSize),
        poemHyphens: cs(poem[0]).hyphens,
      };
    }, { html: THREAD, prose });

    expect(m.margins).toHaveLength(2);
    for (const [top, bottom] of m.margins) {
      expect(top).toBe('0px');
      expect(bottom).toBe('0px');
    }
    expect(m.hyphens.every(h => h === 'none')).toBe(true);
    // Zwischen zwei Zeilen steht nur der Flex-Gap; die Absender-/Zeitzeilen
    // tragen ihren eigenen Rand nur nach aussen (msg-name oben, msg-meta beidseitig).
    expect(m.dists[1]).toBeCloseTo(m.gap, 0);
    expect(m.poemMargin).toBeCloseTo(m.poemFont * 0.3, 0);
    expect(m.poemHyphens).toBe('none');
  });
}
