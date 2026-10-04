// Hover-Vorschau der Entitäts-Referenz: EIN geteilter Layer (wie der Tooltip,
// tooltip.js), der beim Überfahren bzw. Tastatur-Fokus eines `.entity-ref` mit
// Vorschau aufgeht. Inhalt: entity-ref-preview.js; die Direktive hängt das
// Modell als `el._entityRefModel` ans Element (entity-ref.js#render).
//
// Reine Anzeige (`pointer-events: none`): der Klick auf die Referenz bleibt der
// Sprung, das Popover fängt nichts ab. Touch zeigt keine Vorschau — ein Tap ist
// dort Navigation, ein Hover gibt es nicht.
//
// Geometrie über popover-anchor.js (gemessen, nicht geschätzt), Ebene über
// fullscreen.js#mountInTopLayer pro Anzeige — Referenzen sitzen auch in den
// Vollbild-Karten (Plot, Recherche, Motiv).

import { EVT } from './events.js';
import { mountInTopLayer } from './fullscreen.js';
import { computePopoverPos } from './popover-anchor.js';

// Kurz genug, um gewollt zu wirken, lang genug, dass Überstreichen einer
// Referenz-Reihe nicht flackert.
const SHOW_DELAY_MS = 450;

let layer = null;
let current = null;
let timer = null;

const removalWatcher = typeof MutationObserver === 'function'
  ? new MutationObserver(() => { if (current && !document.contains(current)) hide(); })
  : null;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function ensureLayer() {
  if (layer) return;
  layer = el('div', 'entity-ref-preview');
  layer.setAttribute('role', 'tooltip');
  layer.id = 'entity-ref-preview';
  layer.hidden = true;
  document.body.appendChild(layer);
}

function fill(model, preview) {
  layer.className = `entity-ref-preview entity-ref--${model.type}`;
  const head = el('div', 'entity-ref-preview__head');
  head.append(el('span', 'entity-ref-preview__kind', model.kind), el('span', 'entity-ref-preview__title', preview.title || model.label));
  const parts = [head];
  if (preview.meta?.length) parts.push(el('div', 'entity-ref-preview__meta', preview.meta.join(' · ')));
  if (preview.stale) parts.push(el('div', 'entity-ref-preview__stale', window.__app?.t?.('entityRef.preview.stale') ?? ''));
  if (preview.text) parts.push(el('p', 'entity-ref-preview__text', preview.text));
  if (preview.rows?.length) {
    const dl = el('dl', 'entity-ref-preview__rows');
    for (const r of preview.rows) dl.append(el('dt', null, r.label), el('dd', null, r.value));
    parts.push(dl);
  }
  layer.replaceChildren(...parts);
}

function hide() {
  clearTimeout(timer);
  timer = null;
  if (current) current.removeAttribute('aria-describedby');
  current = null;
  removalWatcher?.disconnect();
  if (layer) layer.hidden = true;
}

function show(target) {
  const model = target._entityRefModel;
  const preview = model?.preview?.();
  if (!preview) return;
  ensureLayer();
  mountInTopLayer(layer, target);
  fill(model, preview);
  layer.hidden = false;
  // Erst messen, dann setzen: Höhe hängt am Inhalt (Text, Zeilenzahl).
  layer.style.left = '0px';
  layer.style.top = '0px';
  const { top, left } = computePopoverPos(target.getBoundingClientRect(), layer.offsetWidth, layer.offsetHeight, { align: 'start' });
  layer.style.left = `${Math.round(left)}px`;
  layer.style.top = `${Math.round(top)}px`;
  current = target;
  target.setAttribute('aria-describedby', layer.id);
  // Ein Zeilen-Tooltip eines Elternelements gehört nicht darüber.
  window.dispatchEvent(new CustomEvent(EVT.TOOLTIP_HIDE));
  removalWatcher?.observe(document.body, { childList: true, subtree: true });
}

function schedule(target) {
  if (target === current) return;
  hide();
  if (!target._entityRefModel?.preview) return;
  timer = setTimeout(() => {
    timer = null;
    if (document.contains(target)) show(target);
  }, SHOW_DELAY_MS);
}

const refOf = (node) => (node?.nodeType === 1 ? node.closest('.entity-ref') : null);

export function installEntityRefPreview() {
  if (typeof document === 'undefined' || window.__entityRefPreviewInstalled) return;
  window.__entityRefPreviewInstalled = true;

  document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    const ref = refOf(e.target);
    if (ref) schedule(ref);
  });
  document.addEventListener('pointerout', (e) => {
    const ref = refOf(e.target);
    if (!ref || ref.contains(e.relatedTarget)) return;
    if (ref === current || timer) hide();
  });
  document.addEventListener('focusin', (e) => {
    const ref = refOf(e.target);
    if (ref?.matches(':focus-visible')) schedule(ref);
  });
  document.addEventListener('focusout', () => hide());
  // Klick = Sprung: die Vorschau des verlassenen Orts soll nicht stehenbleiben.
  document.addEventListener('click', hide, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
  window.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
}
