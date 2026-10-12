'use strict';
// Kapitel-, Unterkapitel- und Abschnittsueberschriften im EPUB: Markup und
// Stylesheet fuer Kapitelnummer, Linie/Ornament und Ausrichtung. Bedeutung und
// Masse sind SSoT in lib/heading-style.js (geteilt mit dem PDF,
// lib/pdf-render/heading-deco.js) — hier steht nur die XHTML/CSS-Form.

const hs = require('../../heading-style');
const { escXml } = require('../shared');

// Ornament-Inhalte. Nur Zeichen, die jede Reader-Schrift kennt (bzw. per
// Schrift-Fallback des Systems): Sternchen, Bullet, Raute.
const _ORNAMENT_HTML = {
  stars: '*&#160;&#160;&#160;*&#160;&#160;&#160;*',
  asterism: '*<br />*&#160;*',
  dots: '&#8226;&#160;&#160;&#160;&#8226;&#160;&#160;&#160;&#8226;',
  diamond: '<span class="epub-orn-line"></span>&#9670;<span class="epub-orn-line"></span>',
};

// Linie bzw. Ornament. `where`: 'below' | 'above' (Abstaende).
function ruleHtml(style, align, where = 'below') {
  const len = hs.resolveRuleWidth(style.ruleWidth, align);
  const mods = `--${align === 'center' ? 'center' : 'left'}${where === 'above' ? ' epub-rule--above' : ''}`;
  if (hs.isLineRule(style.ruleStyle)) {
    return `<hr class="epub-rule epub-rule${mods} epub-rule--len-${len}" aria-hidden="true" />`;
  }
  const cls = `epub-orn epub-orn--${style.ruleStyle} epub-orn--${align === 'center' ? 'center' : 'left'}`
    + ` epub-orn--len-${len}${where === 'above' ? ' epub-orn--above' : ''}`;
  return `<div class="${cls}" aria-hidden="true">${_ORNAMENT_HTML[style.ruleStyle]}</div>`;
}

// Ueberschrift samt Linien. `tag` h1..h4; `numberText` null = schlichte
// Ueberschrift ohne Nummernblock.
function headingHtml({ tag, name, numberText, style, align, withRule, cls = '' }) {
  const slots = hs.ruleSlots(style.rulePosition);
  const above = withRule && slots.above ? ruleHtml(style, align, 'above') : '';
  const below = withRule && slots.below ? ruleHtml(style, align, 'below') : '';
  const safe = escXml(name);
  if (!numberText) {
    return `${above}<${tag}${cls ? ` class="${cls}"` : ''}>${safe}</${tag}>${below}`;
  }
  const divider = style.numberDivider
    ? `<span class="epub-chapter-rule" aria-hidden="true">${hs.NUMBER_DIVIDER}</span>`
    : '';
  return `${above}<${tag} class="epub-chapter-title epub-chapter-title--numbered${cls ? ` ${cls}` : ''}">`
    + `<span class="epub-chapter-num">${escXml(numberText)}</span>`
    + divider
    + `<span class="epub-chapter-name">${safe}</span>`
    + `</${tag}>${below}`;
}

const _PAGE_TITLE_EM = { small: '1em', normal: '1.15em', large: '1.3em' };
const _MINIMAL_H1_EM = { small: '1.3em', normal: '1.5em', large: '1.9em' };

// Stylesheet-Teil der Ueberschriften (buchweit, aus Meta + Stil).
function headingCss(style, scale) {
  const lw = hs.RULE_WEIGHT_PT[style.ruleWeight] || 1;
  const cssStyle = { single: 'solid', double: 'double', dotted: 'dotted', dashed: 'dashed' }[style.ruleStyle] || 'solid';
  // Doppellinie: zwei Striche + Luecke, wie im PDF.
  const borderW = style.ruleStyle === 'double' ? lw * 2 + Math.max(lw, 1.5) : lw;
  const numScale = style.numberCase === 'smallcaps' ? hs.SMALLCAPS_SCALE : 1;
  const numSize = ((style.numberSizePct / 100) * numScale).toFixed(3).replace(/0+$/, '');
  const sc = _PAGE_TITLE_EM[scale] ? scale : 'normal';
  return [
    `.epub-chapter-title--numbered .epub-chapter-num { font-size: ${numSize}em;`
      + ` letter-spacing: ${style.numberTracking ? `${hs.NUMBER_TRACKING_EM}em` : 'normal'};`
      + ` text-transform: ${style.numberCase === 'normal' ? 'none' : 'uppercase'}; }`,
    `.epub-chapter-head--align-center > h1, .epub-chapter-head--align-center > h2, .epub-chapter-head--align-center > h3 { text-align: center; }`,
    `.epub-chapter-head--align-left > h1, .epub-chapter-head--align-left > h2, .epub-chapter-head--align-left > h3 { text-align: left; }`,
    `.epub-chapter-head--ts-minimal > h1 { font-size: ${_MINIMAL_H1_EM[sc]}; }`,
    `.epub-page-title { font-size: ${_PAGE_TITLE_EM[sc]}; }`,
    `.epub-page-title--center { text-align: center; }`,
    `hr.epub-rule { border: 0; border-bottom: ${borderW}pt ${cssStyle} currentColor; height: 0; margin: 0.3em 0 1.4em; }`,
    `hr.epub-rule--above, .epub-orn--above { margin: 0 0 0.8em; }`,
    `hr.epub-rule--center { margin-left: auto; margin-right: auto; }`,
    `hr.epub-rule--len-short { width: ${hs.SHORT_RULE_EM}em; }`,
    `hr.epub-rule--len-third { width: 33%; }`,
    `hr.epub-rule--len-full { width: 100%; }`,
    `.epub-orn { text-indent: 0; text-align: left; margin: 0.3em 0 1.4em; line-height: 1; }`,
    `.epub-orn--center { text-align: center; }`,
    `.epub-orn--asterism { font-size: 0.8em; line-height: 0.65; }`,
    `.epub-orn-line { display: inline-block; vertical-align: middle; border-bottom: ${lw}pt solid currentColor; width: ${(hs.DIAMOND_MIN_EM - 1) / 2}em; margin: 0 0.35em; }`,
    `.epub-orn--len-third .epub-orn-line { width: 15%; }`,
    `.epub-orn--len-full .epub-orn-line { width: 45%; }`,
  ].map(l => `\n${l}`).join('');
}

module.exports = { ruleHtml, headingHtml, headingCss };
