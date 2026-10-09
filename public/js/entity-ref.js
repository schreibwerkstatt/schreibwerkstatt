// Entitäts-Referenz — die EINE Darstellung eines Verweises auf ein Buch-Objekt
// (Kapitel, Seite, Figur, Werkstatt-Figur, Schauplatz, Szene, Ereignis, Song, Motiv,
// Beat, Handlungsstrang, Recherche-Fundstück, Idee, Quelle), wo immer er steht:
// Listen, Plot-Board, Recherche, Ideen, Werkstätten, Chats.
//
// Markup (Pflicht-Komponente, siehe public/CLAUDE.md + DESIGN.md „Entitäts-Referenz"):
//   <button type="button" class="entity-ref" x-entity-ref="{ type: 'figur', id: f.id }"></button>
//   <span class="entity-ref" x-entity-ref="{ type: 'kapitel', name: k, static: true }"></span>
// Die Direktive schreibt Typ-Präfix + Label hinein, setzt `entity-ref--<typ>`
// (Farbakzent) und bindet den Klick an die zentrale Navigation. Kein Inhalt im
// Template — Label, Präfix und Sprungziel kommen ausschliesslich aus TYPES.
//
// Spec-Felder:
//   type      Pflicht. Kanonischer Typ (Schlüssel von TYPES) oder ein Alias aus
//             den Verknüpfungs-Tabellen (`figure`, `chapter`, … — KIND_ALIASES).
//   id        Objekt-ID (bevorzugt).
//   name      Name, wenn nur der vorliegt (Kapitel-/Seitenlisten der Analyse);
//             Kapitel und Seite lösen ihn gegen den Buchbaum auf.
//   kapitel   bei `seite` ohne id: Kapitelname zur Auflösung (gotoStelle).
//   label     Anzeigetext übersteuern (sonst aus dem Katalog bzw. name).
//   title     Tooltip übersteuern.
//   count     Zusatz „×N" hinter dem Label (Erwähnungen).
//   static    true = nicht klickbar (reine Anzeige, z.B. im Editierfeld mit X).
//   inherited true = abgeleitet statt gesetzt (Plot: vom Strang geerbt) → gestrichelt
//             + Zusatz „· Strang“ im Badge; `title` erklärt die Herkunft (Tooltip
//             bzw. erste Meta-Zeile der Vorschau).
//   snippet   bei `seite`: Textstelle, an die der Sprung im Abschnitt scrollt
//             (gotoPageById → book/passage-highlight.js) statt an den Anfang.
//   onOpen    eigene Klick-Aktion statt Navigation (z.B. Filter setzen).
//   page_id / chapter_id   nur `idee`: Anker der Idee.
//   preview   false = keine Hover-Vorschau (z.B. wo die Zeile das Objekt schon zeigt).
//
// Hover-Vorschau: Typen mit Frontend-Katalog (Kapitel, Seite, Figur, Ort, Szene)
// zeigen beim Überfahren ein Popover mit Kontext (entity-ref-preview.js für den
// Inhalt, entity-ref-popover.js für den Layer). Sie ersetzt dort den Tooltip.
//
// Nicht auflösbar (Name ohne Treffer, gelöschtes Objekt) → `entity-ref--unresolved`,
// nicht klickbar, Label = Rohtext. So endet kein Klick im Nichts.

import { buildEntityPreview, PREVIEW_BUILDERS } from './entity-ref-preview.js';
import { installEntityRefPreview } from './entity-ref-popover.js';
import { sameStructureTitle } from './structure-title.js';

const t = (app, key) => (app?.t ? app.t(key) : key);

function hashGo(view, arg) {
  const bookId = window.Alpine?.store('nav')?.selectedBookId;
  if (!bookId) return;
  location.hash = `#book/${bookId}/${view}${arg != null && arg !== '' ? `/${arg}` : ''}`;
}

function chapters(app) {
  return (app?.$store?.nav?.tree || []).filter(c => c.type === 'chapter');
}

function findChapter(app, spec) {
  const list = chapters(app);
  if (spec.id != null && spec.id !== '') {
    return list.find(c => String(c.id) === String(spec.id)) || null;
  }
  if (!spec.name) return null;
  const lc = String(spec.name).toLowerCase();
  const named = list.filter(c => !c.solo);
  return named.find(c => c.name === spec.name)
    || named.find(c => c.name.toLowerCase() === lc)
    || null;
}

function findPage(app, spec) {
  const pages = app?.$store?.nav?.pages || [];
  if (spec.id != null && spec.id !== '') {
    return pages.find(p => String(p.id) === String(spec.id)) || null;
  }
  return app?._resolvePage ? app._resolvePage(spec.kapitel || null, spec.name || null) : null;
}

// Katalog-Maps sind nach der öffentlichen Kennung (`fig_…`, `loc_…`) bzw. einer
// Zahl geschlüsselt; Deep-Links und Verknüpfungs-Tabellen liefern Zahlen oft als String.
const fromMap = (mapName) => (app, spec) => {
  const map = app?.[mapName];
  if (!map?.get || spec.id == null || spec.id === '') return null;
  return map.get(spec.id)
    ?? (/^\d+$/.test(String(spec.id)) ? map.get(Number(spec.id)) : undefined)
    ?? null;
};

// Je Typ: Farb-Akzent (CSS-Modifier), Auflösung, Label/Tooltip, Sprung.
// `resolve` liefert das Zielobjekt oder null; `open` bekommt es zurück.
// Typen ohne Katalog im Frontend (Werkstatt-Figur, Motiv, Beat, …) verlassen
// sich auf `label` aus dem Aufrufer und gelten als auflösbar, sobald eine id da ist.
export const TYPES = {
  kapitel: {
    resolve: findChapter,
    label: (c) => c.name,
    // Kapitel-Referenzen führen immer zur Kapitelbewertung (openChapterById
    // fällt nur dort auf die erste Seite zurück, wo das Buch keine hat).
    open: (app, c) => app.openChapterById(c.id),
  },
  seite: {
    resolve: findPage,
    label: (p) => p.name,
    title: (p, app) => {
      const ch = p.chapter_id != null ? chapters(app).find(c => String(c.id) === String(p.chapter_id)) : null;
      return ch && !ch.solo && !sameStructureTitle(ch.name, p.name) ? `${ch.name} › ${p.name}` : p.name;
    },
    open: (app, p, spec) => (spec?.snippet ? app.gotoPageById(p.id, { snippet: spec.snippet }) : app.selectPage(p)),
  },
  figur: {
    resolve: fromMap('figurenById'),
    label: (f) => f.kurzname || f.name,
    title: (f) => f.name,
    open: (app, f) => app.openFigurById(f.id),
  },
  werkstatt: { open: (app, _o, spec) => app.openWerkstattDraftById(spec.id) },
  ort: {
    resolve: fromMap('orteById'),
    label: (o) => o.name,
    open: (app, o) => app.openOrtById(o.id),
  },
  szene: {
    resolve: fromMap('szenenById'),
    label: (s) => s.titel || s.name,
    open: (app, s) => app.openSzeneById(s.id),
  },
  ereignis: { open: (app, _o, spec) => app.openEreignisById(spec.id) },
  song: { open: (app, _o, spec) => app.openSongById(spec.id) },
  motiv: { open: (app, _o, spec) => app.openMotifById(spec.id) },
  beat: { open: (_app, _o, spec) => hashGo('plot', spec.id) },
  strang: { open: () => hashGo('plot') },
  recherche: { open: (_app, _o, spec) => hashGo('recherche', spec.id) },
  idee: {
    open: (_app, _o, spec) => (spec.page_id != null
      ? hashGo('page', spec.page_id)
      : hashGo('kapitel', spec.chapter_id)),
  },
  quelle: { open: (_app, _o, spec) => hashGo('quellen', spec.id) },
};

// Verknüpfungs-Tabellen (research_links, idea_links) speichern englische Kinds.
export const KIND_ALIASES = {
  chapter: 'kapitel', page: 'seite', figure: 'figur', location: 'ort',
  scene: 'szene', event: 'ereignis', motif: 'motiv', thread: 'strang',
  research: 'recherche', idea: 'idee', source: 'quelle', draft: 'werkstatt',
};

export function canonicalType(type) {
  return TYPES[type] ? type : (KIND_ALIASES[type] || null);
}

// Pure Auflösung (testbar ohne DOM): Spec → Darstellungs-Modell.
export function resolveEntityRef(spec, app) {
  const type = canonicalType(spec?.type);
  if (!type) return null;
  const def = TYPES[type];
  const target = def.resolve
    ? def.resolve(app, spec)
    : (spec.id != null && spec.id !== '' ? { id: spec.id } : null);
  const fallback = spec.name ?? (spec.id != null ? `#${spec.id}` : '');
  const label = spec.label ?? (target && def.label ? def.label(target, app) : null) ?? fallback;
  const title = spec.title ?? (target && def.title ? def.title(target, app) : null) ?? null;
  const resolved = !!target || typeof spec.onOpen === 'function';
  const clickable = !spec.static && resolved;
  const hasPreview = spec.preview !== false && !!target && !!PREVIEW_BUILDERS[type];
  return {
    type,
    kind: t(app, `entityRef.kind.${type}`),
    label: String(label ?? ''),
    title: title && title !== label ? String(title) : null,
    count: spec.count > 1 ? spec.count : null,
    resolved,
    clickable,
    inherited: !!spec.inherited,
    origin: spec.inherited ? t(app, 'entityRef.inherited') : null,
    // Lazy: gebaut erst beim Aufgehen, damit die Vorschau den aktuellen Katalog zeigt.
    preview: hasPreview ? () => {
      const p = buildEntityPreview(type, target, app);
      // Die Vorschau ersetzt den Tooltip — die Herkunft darf dabei nicht verschwinden.
      if (p && spec.inherited && spec.title) p.meta = [String(spec.title), ...(p.meta || [])];
      return p;
    } : null,
    open: clickable
      ? () => (typeof spec.onOpen === 'function' ? spec.onOpen() : def.open(app, target, spec))
      : null,
  };
}

function render(el, model) {
  const prev = el.dataset.entityRefType;
  if (prev && prev !== model.type) el.classList.remove(`entity-ref--${prev}`);
  el.classList.add('entity-ref', `entity-ref--${model.type}`);
  el.dataset.entityRefType = model.type;
  el.classList.toggle('entity-ref--unresolved', !model.resolved);
  el.classList.toggle('entity-ref--static', !model.clickable);
  el.classList.toggle('entity-ref--inherited', model.inherited);

  const kind = document.createElement('span');
  kind.className = 'entity-ref__kind';
  kind.textContent = model.kind;
  const label = document.createElement('span');
  label.className = 'entity-ref__label';
  label.textContent = model.label;
  const parts = [kind, label];
  if (model.origin) {
    const origin = document.createElement('span');
    origin.className = 'entity-ref__origin';
    origin.textContent = model.origin;
    parts.push(origin);
  }
  if (model.count) {
    const count = document.createElement('span');
    count.className = 'entity-ref__count';
    count.textContent = `×${model.count}`;
    parts.push(count);
  }
  el.replaceChildren(...parts);

  // Mit Vorschau kein Tooltip: das Popover trägt den vollen Namen bereits.
  if (model.title && !model.preview) el.setAttribute('data-tip', model.title);
  else el.removeAttribute('data-tip');

  const isButton = el.tagName === 'BUTTON';
  if (isButton) {
    el.disabled = !model.clickable;
  } else if (model.clickable) {
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
  } else {
    el.removeAttribute('role');
    el.removeAttribute('tabindex');
  }
}

export function registerEntityRef() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  installEntityRefPreview();
  window.Alpine.directive('entity-ref', (el, { expression }, { evaluateLater, effect, cleanup }) => {
    const get = evaluateLater(expression);
    let model = null;
    effect(() => {
      get((spec) => {
        model = resolveEntityRef(spec || {}, window.__app);
        el._entityRefModel = model;
        if (model) render(el, model);
      });
    });
    // Referenzen sitzen oft in klickbaren Zeilen (Aufklappen, Auswahl): der
    // Sprung ist die Absicht, die Zeile darf ihn nicht zusätzlich verarbeiten.
    const onClick = (e) => {
      if (!model?.open) return;
      e.stopPropagation();
      model.open();
    };
    const onKey = (e) => {
      if (el.tagName === 'BUTTON' || !model?.open) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(e); }
    };
    el.addEventListener('click', onClick);
    el.addEventListener('keydown', onKey);
    cleanup(() => {
      el.removeEventListener('click', onClick);
      el.removeEventListener('keydown', onKey);
    });
  });
}
