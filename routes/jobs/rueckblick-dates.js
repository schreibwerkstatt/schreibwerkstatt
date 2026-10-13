'use strict';
// Pure Datums-Helfer für den Tagebuch-Rückblick. Hängt nur an lib/datum-parse
// (kein DB-/AI-State) — separat für Unit-Tests ohne Bootstrap.

const { parseDatum } = require('../../lib/datum-parse');

// Zeitraum 'YYYY' oder 'YYYY-MM' → { year, month|null }. Ungültig → null.
function parseZeitraum(z) {
  const m = /^(\d{4})(?:-(\d{2}))?$/.exec(String(z || '').trim());
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const month = m[2] ? parseInt(m[2], 10) : null;
  if (month != null && (month < 1 || month > 12)) return null;
  return { year, month };
}

// Datiert eine Seite anhand ihres Namens (page_name = 'YYYY-MM-DD' bei
// Tagebüchern, parseDatum als Fallback). Liefert { iso, year, month, monthKey }
// oder null, wenn kein Jahr ableitbar.
function entryDate(name) {
  const d = parseDatum(name);
  if (!d || d.year == null) return null;
  const year = d.year;
  const month = d.month || null;
  const day = d.day || null;
  const mm = month != null ? String(month).padStart(2, '0') : null;
  const dd = day != null ? String(day).padStart(2, '0') : null;
  const iso = dd ? `${year}-${mm}-${dd}` : (mm ? `${year}-${mm}` : String(year));
  return { iso, year, month, monthKey: mm ? `${year}-${mm}` : null };
}

// Trifft ein datierter Eintrag den Zeitraum? Bei Monats-Zeitraum muss der Monat
// passen; bei Jahres-Zeitraum genügt das Jahr.
function matchesZeitraum(ed, z) {
  if (!ed || !z) return false;
  if (ed.year !== z.year) return false;
  if (z.month != null) return ed.month === z.month;
  return true;
}

// Vorangegangener Zeitraum: Monats-Rückblick → Vor-Monat (Januar → Dezember des
// Vorjahres), Jahres-Rückblick → Vorjahr. Liefert denselben String-Typ wie der
// Input ('YYYY-MM' bzw. 'YYYY') oder null bei ungültigem Input.
function previousZeitraum(z) {
  const p = parseZeitraum(z);
  if (!p) return null;
  if (p.month != null) {
    let y = p.year, m = p.month - 1;
    if (m < 1) { m = 12; y -= 1; }
    return `${y}-${String(m).padStart(2, '0')}`;
  }
  return String(p.year - 1);
}

// Aggregiert datierte Seiten + vorhandene Rückblicke zu Monats-/Jahres-Buckets.
// Pure (kein DB-State) — Datums-Parsing bleibt serverseitige SSoT: Overview-
// Heatmap und Rückblick-Karte (Zeitraum-Auswahl, Kalender, Aktualität, Sprung
// zum Tag) lesen beide diese Buckets, keiner parst Seitennamen selbst.
//   pages:  [{ page_id, page_name, updated_at }]
//   rbRows: [{ zeitraum, id, created_at }]  (jüngster Rückblick je Zeitraum)
// Je Bucket: entries (Anzahl), newest (jüngstes updated_at in ms, 0 = unbekannt),
// rueckblick ({ id, created_at } | null). days: Tagesdatum → page_id (erste
// Seite des Tages) für den Sprung aus Belegen und bemerkenswerten Tagen.
// minYear/maxYear spannen die Union aus Eintrags-Jahren UND Rückblick-Jahren,
// damit „verwaiste" Rückblicke (Einträge nachträglich gelöscht) sichtbar bleiben.
function buildRueckblickCoverage(pages, rbRows) {
  const months = {};
  const years = {};
  const days = {};
  let minYear = null, maxYear = null;
  const blank = () => ({ entries: 0, newest: 0, rueckblick: null });
  const ensureMonth = (k) => (months[k] || (months[k] = blank()));
  const ensureYear = (k) => (years[k] || (years[k] = blank()));
  const count = (bucket, ms) => { bucket.entries++; if (ms > bucket.newest) bucket.newest = ms; };
  const track = (y) => {
    if (minYear == null || y < minYear) minYear = y;
    if (maxYear == null || y > maxYear) maxYear = y;
  };
  const sorted = [...(pages || [])].sort((a, b) => (a.page_id || 0) - (b.page_id || 0));
  for (const p of sorted) {
    const ed = entryDate(p.page_name);
    if (!ed) continue;
    const ms = p.updated_at ? (Date.parse(p.updated_at) || 0) : 0;
    count(ensureYear(String(ed.year)), ms);
    if (ed.monthKey) count(ensureMonth(ed.monthKey), ms);
    if (/^\d{4}-\d{2}-\d{2}$/.test(ed.iso) && days[ed.iso] == null && p.page_id != null) days[ed.iso] = p.page_id;
    track(ed.year);
  }
  for (const r of (rbRows || [])) {
    const z = String(r.zeitraum || '');
    const rb = { id: r.id, created_at: r.created_at };
    if (/^\d{4}-\d{2}$/.test(z)) {
      ensureMonth(z).rueckblick = rb;
      track(parseInt(z.slice(0, 4), 10));
    } else if (/^\d{4}$/.test(z)) {
      ensureYear(z).rueckblick = rb;
      track(parseInt(z, 10));
    }
  }
  return { months, years, days, minYear, maxYear };
}

// Belegprüfung des KI-Ergebnisses gegen die tatsächlich vorgelegten Eintragsdaten.
// Das Modell soll nur vorhandene Daten nennen — geprüft wird es hier: Belege,
// die keinem Eintrag entsprechen, fallen heraus, `haeufigkeit` ist danach die
// Zahl der verbliebenen Belegtage (nicht die Zahl des Modells), Themen/Personen/
// Orte ohne Beleg und bemerkenswerte Tage ohne passenden Eintrag entfallen.
// Ohne diese Prüfung führte ein erfundenes Datum beim Klick ins Leere.
// Idempotent — läuft auch über Cache-Treffer älterer, ungeprüfter Ergebnisse.
function verifyRueckblickBelege(result, entryDates) {
  const valid = new Set(entryDates || []);
  let dropped = 0;
  const norm = (d) => {
    const s = String(d || '').trim();
    if (valid.has(s)) return s;
    const m = /\d{4}-\d{2}-\d{2}/.exec(s);
    return m && valid.has(m[0]) ? m[0] : null;
  };
  const facet = (arr, key) => (Array.isArray(arr) ? arr : [])
    .map((item) => {
      const raw = Array.isArray(item?.belege) ? item.belege : [];
      const belege = [...new Set(raw.map(norm).filter(Boolean))].sort();
      dropped += raw.length - belege.length;
      return { ...item, [key]: String(item?.[key] || '').trim(), haeufigkeit: belege.length, belege };
    })
    .filter((item) => {
      const keep = item[key] && item.belege.length > 0;
      if (!keep) dropped++;
      return keep;
    })
    .sort((a, b) => b.haeufigkeit - a.haeufigkeit);
  const seenTage = new Set();
  const tage = (Array.isArray(result?.bemerkenswerteTage) ? result.bemerkenswerteTage : [])
    .map(t => ({ ...t, datum: norm(t?.datum) }))
    .filter((t) => {
      const keep = t.datum && !seenTage.has(t.datum);
      if (keep) seenTage.add(t.datum); else dropped++;
      return keep;
    })
    .sort((a, b) => a.datum.localeCompare(b.datum));
  return {
    result: {
      ...result,
      themen: facet(result?.themen, 'label'),
      personen: facet(result?.personen, 'name'),
      orte: facet(result?.orte, 'name'),
      bemerkenswerteTage: tage,
    },
    dropped,
  };
}

module.exports = { parseZeitraum, entryDate, matchesZeitraum, previousZeitraum, buildRueckblickCoverage, verifyRueckblickBelege };
