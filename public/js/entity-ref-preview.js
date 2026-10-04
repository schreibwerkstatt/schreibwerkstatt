// Vorschau einer Entitäts-Referenz — was das Hover-Popover über das Objekt
// hinter einem `x-entity-ref` zeigt. Pure Abbildung Zielobjekt + App-Kataloge
// → Anzeigemodell; Darstellung und Hover-Mechanik: entity-ref-popover.js.
//
// Nur Typen mit Frontend-Katalog bekommen eine Vorschau (Kapitel, Seite, Figur,
// Ort, Szene): alles hier kommt aus Daten, die ohnehin geladen sind — kein Fetch
// beim Überfahren. Der Textauszug von Seite/Kapitel ist `pages.preview_text`
// (Seitenbaum, nachgeführt vom Sync in routes/sync.js) und kann darum hinter
// einer eben getippten Änderung zurückliegen. Typen ohne Builder zeigen weiter
// höchstens ihren Tooltip.
//
// Modell: { title, meta: string[], text, rows: [{ label, value }], stale }.
// Leere Felder fallen weg, damit das Popover nur zeigt, was es wirklich weiss —
// eine Figur vor der Komplettanalyse ist eine Kopfzeile, kein Formular voller „—".

import { numberFormat, charsToNormseiten } from './utils/format.js';

// Wie viele Namen eine Liste zeigt, bevor sie auf „+N" kürzt.
const LIST_MAX = 4;

const tr = (app, key, params) => (app?.t ? app.t(key, params) : key);
const clean = (v) => (v == null ? '' : String(v).trim());

function joinList(app, names, max = LIST_MAX) {
  const list = names.map(clean).filter(Boolean);
  if (!list.length) return '';
  const shown = list.slice(0, max).join(', ');
  const rest = list.length - max;
  return rest > 0 ? `${shown} ${tr(app, 'entityRef.preview.more', { n: rest })}` : shown;
}

function row(rows, label, value) {
  const v = clean(value);
  if (v) rows.push({ label, value: v });
}

function fmtNum(app, n) {
  return numberFormat(app?.$store?.shell?.uiLocale).format(Number(n) || 0);
}

function umfang(app, { words, chars }) {
  if (!words && !chars) return '';
  return tr(app, 'entityRef.preview.sizeValue', {
    words: fmtNum(app, words),
    normseiten: numberFormat(app?.$store?.shell?.uiLocale, { maximumFractionDigits: 1 }).format(charsToNormseiten(chars)),
  });
}

const figurName = (app, id) => {
  const f = app?.figurenById?.get?.(id);
  return f ? (f.kurzname || f.name) : '';
};
const ortName = (app, id) => app?.orteById?.get?.(id)?.name || '';
const szenen = (app) => app?.$store?.catalog?.szenen || [];
const figuren = (app) => app?.$store?.catalog?.figuren || [];
const sameId = (a, b) => a != null && b != null && String(a) === String(b);

function szenenZeile(app, list) {
  if (!list.length) return '';
  const titles = joinList(app, list.map(s => s.titel), 3);
  return `${list.length} · ${titles}`;
}

function figur(f, app) {
  const rows = [];
  row(rows, tr(app, 'entityRef.preview.role'), f.rolle);
  row(rows, tr(app, 'entityRef.preview.chapters'), joinList(app, (f.kapitel || []).map(k => k.name), 3));
  row(rows, tr(app, 'entityRef.preview.firstMention'), f.erste_erwaehnung);
  row(rows, tr(app, 'entityRef.preview.traits'), joinList(app, f.eigenschaften || []));
  const meta = [
    f.typ ? tr(app, `figuren.type.${f.typ}`) : '',
    clean(f.beruf),
    app?.figurJahrLabel ? clean(app.figurJahrLabel(f)) : '',
  ];
  return {
    title: f.name,
    meta: meta.filter(Boolean),
    text: clean(f.beschreibung),
    rows,
    stale: !!f.stale,
  };
}

function ort(o, app) {
  const rows = [];
  row(rows, tr(app, 'entityRef.preview.mood'), o.stimmung);
  row(rows, tr(app, 'entityRef.preview.chapters'), joinList(app, (o.kapitel || []).map(k => k.name), 3));
  row(rows, tr(app, 'entityRef.preview.figures'), joinList(app, (o.figuren || []).map(id => figurName(app, id))));
  row(rows, tr(app, 'entityRef.preview.firstMention'), o.erste_erwaehnung);
  return {
    title: o.name,
    meta: [clean(o.typ), clean(o.land)].filter(Boolean),
    text: clean(o.beschreibung),
    rows,
    stale: !!o.stale,
  };
}

function szene(s, app) {
  const rows = [];
  row(rows, tr(app, 'entityRef.preview.figures'), joinList(app, (s.fig_ids || []).map(id => figurName(app, id))));
  row(rows, tr(app, 'entityRef.preview.places'), joinList(app, (s.ort_ids || []).map(id => ortName(app, id))));
  const stelle = [clean(s.kapitel), clean(s.seite)].filter(Boolean).join(' › ');
  const meta = [stelle, s.wertung ? tr(app, `szenen.rating.${s.wertung}`) : ''];
  return {
    title: s.titel || s.name,
    meta: meta.filter(Boolean),
    text: clean(s.kommentar),
    rows,
    stale: !!s.stale,
  };
}

function kapitel(c, app) {
  const tree = app?.$store?.nav?.tree || [];
  const parent = c.parent_id != null ? tree.find(it => it.type === 'chapter' && sameId(it.id, c.parent_id)) : null;
  const pages = c.pages || [];
  const rows = [];
  const stats = c.stats || {};
  const size = [
    pages.length ? tr(app, 'entityRef.preview.pageCount', { n: pages.length }) : '',
    umfang(app, stats),
  ].filter(Boolean).join(' · ');
  row(rows, tr(app, 'entityRef.preview.size'), size);
  row(rows, tr(app, 'entityRef.preview.pages'), joinList(app, pages.map(p => p.name), 3));
  row(rows, tr(app, 'entityRef.preview.scenes'), szenenZeile(app, szenen(app).filter(s => !s.stale && sameId(s.chapter_id, c.id))));
  // Figuren nach Häufigkeit IN DIESEM Kapitel, nicht im Buch: wer hier trägt.
  const imKapitel = figuren(app)
    .map(f => ({ f, h: (f.kapitel || []).find(k => sameId(k.chapter_id, c.id))?.haeufigkeit || 0 }))
    .filter(x => x.h > 0 && !x.f.stale)
    .sort((a, b) => b.h - a.h)
    .map(x => x.f.kurzname || x.f.name);
  row(rows, tr(app, 'entityRef.preview.figures'), joinList(app, imKapitel));
  const meta = [
    parent ? tr(app, 'entityRef.preview.inChapter', { name: parent.name }) : '',
    c.excluded ? tr(app, 'sidebar.excludedBadge') : '',
  ];
  // Auszug: der Anfang des Kapitels = die erste Seite mit Text.
  const opening = clean(pages.map(p => (app?.$store?.nav?.pages || []).find(x => sameId(x.id, p.id)) || p)
    .find(p => clean(p.preview_text))?.preview_text);
  return { title: c.name, meta: meta.filter(Boolean), text: opening, rows, stale: false };
}

function seite(p, app) {
  const rows = [];
  row(rows, tr(app, 'entityRef.preview.size'), umfang(app, app?.tokEsts?.[p.id] || {}));
  // Lektorat-Stand + letzte Änderung: dieselben Zeilen wie der Sidebar-Status.
  if (app?.pageStatusTooltip) row(rows, tr(app, 'entityRef.preview.status'), app.pageStatusTooltip(p).join(' · '));
  const hier = szenen(app).filter(s => !s.stale && sameId(s.page_id, p.id));
  row(rows, tr(app, 'entityRef.preview.scenes'), szenenZeile(app, hier));
  const figIds = [...new Set(hier.flatMap(s => s.fig_ids || []))];
  row(rows, tr(app, 'entityRef.preview.figures'), joinList(app, figIds.map(id => figurName(app, id))));
  const chapterName = clean(p.chapterName);
  return {
    title: p.name,
    meta: chapterName ? [tr(app, 'entityRef.preview.inChapter', { name: chapterName })] : [],
    text: clean(p.preview_text),
    rows,
    stale: false,
  };
}

export const PREVIEW_BUILDERS = { figur, ort, szene, kapitel, seite };

/** Vorschau-Modell oder null (Typ ohne Builder, Ziel nicht aufgelöst). */
export function buildEntityPreview(type, target, app) {
  const build = PREVIEW_BUILDERS[type];
  if (!build || !target) return null;
  return build(target, app);
}
