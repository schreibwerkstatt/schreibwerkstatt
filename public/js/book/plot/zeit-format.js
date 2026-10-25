// Plot-Werkstatt: Anzeige des Zeitfensters `zeit_key`, das der Server an jeden
// Beat hängt (lib/time-key.js). Pure, ohne Alpine/DOM — `t` wird injiziert.
//
// Das Fenster liegt auf einer Ordinalskala mit 31 Tagen je Monat und 372 je Jahr;
// diese Datei kehrt sie um. Die Skala ist Server-Vertrag: ändert lib/time-key.js
// sie, muss DAYS_PER_YEAR hier mitziehen — gegated durch
// tests/unit/plot-zeit-format.test.mjs, der Server-Fenster durch diesen
// Formatierer schickt.
//
// Ausgabe numerisch wie im Ereignis-Zeitstrahl (cards/ereignisse/date.js:
// TT.MM.JJJJ, MM.JJJJ, JJJJ, Spannen über `events.span`) — gezeigt wird, wie die
// Angabe VERSTANDEN wurde, nicht noch einmal derselbe Freitext.

const DAYS_PER_YEAR = 372;

const _p2 = n => String(n).padStart(2, '0');

function _decode(o) {
  const y = Math.floor(o / DAYS_PER_YEAR);
  const r = o - y * DAYS_PER_YEAR;
  return { y, m: Math.floor(r / 31) + 1, d: (r % 31) + 1 };
}

function _year(y, t) {
  return y < 0 ? t('plot.zeitKey.bce', { jahr: -y }) : String(y);
}

/**
 * @param {object|null} key  `zeit_key` eines Beats ({ mode, from, to, unsicher }).
 * @param {(k: string, p?: object) => string} t
 * @returns {string|null}  null = kein Fenster (undatiert oder nicht verstanden).
 */
export function formatZeitKey(key, t) {
  if (!key || !Number.isFinite(key.from) || !Number.isFinite(key.to)) return null;
  if (key.mode === 'tag') {
    const a = t('events.storyDay', { n: key.from });
    return key.to === key.from ? a : t('events.span', { start: a, ende: t('events.storyDay', { n: key.to }) });
  }
  const s = _decode(key.from), e = _decode(key.to);
  const monthAligned = s.d === 1 && e.d === 31;
  const yearAligned = monthAligned && s.m === 1 && e.m === 12;
  let out;
  if (yearAligned) {
    out = s.y === e.y ? _year(s.y, t) : t('events.span', { start: _year(s.y, t), ende: _year(e.y, t) });
  } else if (monthAligned) {
    const a = `${_p2(s.m)}.${_year(s.y, t)}`;
    out = (s.y === e.y && s.m === e.m) ? a : t('events.span', { start: a, ende: `${_p2(e.m)}.${_year(e.y, t)}` });
  } else {
    const a = `${_p2(s.d)}.${_p2(s.m)}.${_year(s.y, t)}`;
    out = key.from === key.to ? a : t('events.span', { start: a, ende: `${_p2(e.d)}.${_p2(e.m)}.${_year(e.y, t)}` });
  }
  return key.unsicher ? t('events.circa', { date: out }) : out;
}
