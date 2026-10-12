'use strict';
// Font-Bootstrapping + PDF/A-Glyph-Sanitizer. Lädt alle Rollen-Fonts (body,
// heading, title, subtitle, byline) inkl. Body-Bold/Italic-Variants und patcht
// doc.text, damit ungültige Codepoints (PDF/A-2 verbietet .notdef-Verweise)
// vor jedem Write gefiltert werden.

const { fetchFont, isAllowed, FONT_LIST } = require('../font-fetch');

const FONT_INDEX = new Map(FONT_LIST.map(f => [f.family, f]));

/** Nächstliegendes Gewicht aus `weights` (bei Gleichstand das leichtere). */
function _nearestWeight(weights, want) {
  const w = parseInt(want, 10) || 400;
  let best = weights[0];
  for (const c of weights) {
    if (Math.abs(c - w) < Math.abs(best - w) || (Math.abs(c - w) === Math.abs(best - w) && c < best)) best = c;
  }
  return best;
}
const logger = require('../../logger');

// Schnitte, in denen Soft-Hyphen (U+00AD) und Bindestrich (U+002D) auf
// DENSELBEN Glyph zeigen, koennen nicht getrennt werden.
//
// fontkit behandelt den Soft-Hyphen als `default ignorable` und ersetzt ihn
// beim Layout durch den Leerzeichen-Glyph — diesen Entscheid merkt es sich
// aber pro GLYPH-ID statt pro Codepoint. Teilen sich beide Zeichen einen
// Glyph, gilt nach dem ersten Soft-Hyphen auch jeder ECHTE Bindestrich als
// ignorierbar und wird durch das Leerzeichen ersetzt: das getrennte Wort
// zerfaellt still in zwei Teile («umzu» / «drehen»), im Satz wie im Extrakt.
// In der umgekehrten Reihenfolge erscheint stattdessen an jeder Silbenfuge
// ein sichtbarer Bindestrich.
//
// Ausweichen kann die App dem nicht: schon die Hoehen-/Breitenmessung in
// blocks.js schickt den SHY-haltigen Text durch fontkit, unabhaengig davon,
// ob der eigene Blocksatz-Layouter (justify.js, echter Bindestrich) oder der
// pdfkit-Pfad (Listen/Zweispalter, SHY) die Zeile spaeter setzt.
//
// Darum wird fuer solche Schnitte gar nicht erst getrennt. Weitere
// Wortabstaende sind sichtbar und harmlos; zerschnittene Woerter sind es
// nicht. Der Lauf meldet es als nicht-fatalen Hinweis (Muster wie veraPDF /
// PDF-X / Niedrigaufloesung) statt still anders auszusehen.
const SOFT_HYPHEN_CP = 0x00ad;
const HYPHEN_CP = 0x002d;

function _sharesHyphenGlyph(font) {
  try {
    const shy = font.glyphForCodePoint(SOFT_HYPHEN_CP);
    const hyphen = font.glyphForCodePoint(HYPHEN_CP);
    // Glyph 0 ist `.notdef`: beide dort heisst, die Schrift kennt keines der
    // beiden Zeichen — ein Schriftproblem anderer Art, kein geteilter Glyph.
    // Ohne diese Bedingung schaltete `0 === 0` die Trennung buchweit ab.
    return !!(shy && hyphen && shy.id && shy.id === hyphen.id);
  } catch {
    // Eine Schrift, die den Lookup verweigert, ist kein Trennungs-Befund.
    return false;
  }
}

// Lädt + registriert alle benötigten Font-Variants. Pdfkit erwartet einen
// eindeutigen Namen pro Variant. Body-Font wird zusätzlich in italic + bold
// vorgeladen (für strong/em im Fließtext).
//
// Rückgabe: { hyphenationUnsafeFamilies } — die Familien, für die die
// Silbentrennung ausfallen muss (siehe `_sharesHyphenGlyph`).
async function _registerFonts(doc, font) {
  const tasks = [];
  // Was WIRKLICH registriert wurde — bei einem Fallback steht hier die
  // Ersatz-Familie, nicht die angefragte. Sonst meldete der Hinweis eine
  // Schrift, die im PDF gar nicht steckt.
  const registered = [];
  // Jeder Ersatz eines angefragten Schnitts: { role, requested, used } — geht
  // als `meta.fontFallbacks` an den Job (nicht-fataler Hinweis).
  const fallbacks = [];
  const bodyFamily = font.body.family;
  const bodyWeight = font.body.weight;

  // Schnitt laden, mit Rückfallkette:
  //   1. exakt angefragter Schnitt,
  //   2. nächstliegendes verfügbares Gewicht derselben Familie (gleicher Stil,
  //      sonst aufrecht),
  //   3. Body-Familie (nächstliegendes Gewicht, aufrecht bzw. gleicher Stil).
  // Eine NICHT erlaubte Familie wirft bei `strict` weiter (Profil-Fehler, den
  // die Server-Prüfung hätte abweisen müssen); sonst fällt auch sie auf Body.
  const load = async (key, family, weight, style, strict) => {
    const requested = `${family} ${weight} ${style}`;
    const chain = [];
    const fam = FONT_INDEX.get(family);
    if (!fam) {
      if (strict) return fetchFont(family, weight, style).then(() => null); // wirft fontNotAllowed
    } else {
      chain.push([family, weight, style]);
      const st = fam.styles.includes(style) ? style : 'normal';
      chain.push([family, _nearestWeight(fam.weights, weight), st]);
    }
    const bfam = FONT_INDEX.get(bodyFamily);
    if (bfam) {
      const bst = bfam.styles.includes(style) ? style : 'normal';
      chain.push([bodyFamily, _nearestWeight(bfam.weights, family === bodyFamily ? weight : bodyWeight), bst]);
      chain.push([bodyFamily, _nearestWeight(bfam.weights, 400), 'normal']);
    }
    const seen = new Set();
    let lastErr = null;
    for (const [f, w, sty] of chain) {
      const k = `${f}|${w}|${sty}`;
      if (seen.has(k) || !isAllowed(f, w, sty)) continue;
      seen.add(k);
      try {
        const ttf = await fetchFont(f, w, sty);
        doc.registerFont(key, ttf);
        registered.push({ key, family: f });
        const used = `${f} ${w} ${sty}`;
        // Abgeleitete Fett-Varianten (Gewicht +300 ist eine Heuristik, keine
        // Anfrage des Users) melden nur, wenn die Familie wechselt.
        // Dasselbe gilt fuer den leichten Schnitt der Kapitelnummer.
        const derivedBold = /-bold(italic)?$/.test(key) && f === family;
        const derivedLight = key === 'heading-number' && f === family;
        if (used !== requested && !derivedBold && !derivedLight) {
          logger.warn(`pdf-render: font ${requested} fuer ${key} nicht verfuegbar; ${used} registriert`);
          fallbacks.push({ role: key, requested, used });
        }
        return null;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('job.error.fontUnavailable');
  };
  const reg = (key, family, weight, style) => { tasks.push(load(key, family, weight, style, true)); };
  const safeReg = (key, family, weight, style) => { tasks.push(load(key, family, weight, style, false)); };

  // Body-Familie braucht Bold / Italic / BoldItalic für Inline-Style.
  reg('body',           font.body.family, font.body.weight, 'normal');
  // Heuristik für italic/bold-Verfügbarkeit: probieren, fallback in safeReg.
  safeReg('body-bold',        font.body.family, Math.min(900, font.body.weight + 300), 'normal');
  safeReg('body-italic',      font.body.family, font.body.weight, 'italic');
  safeReg('body-bolditalic',  font.body.family, Math.min(900, font.body.weight + 300), 'italic');

  reg('heading',  font.heading.family,  font.heading.weight,  'normal');
  // Kapitelnummer ueber dem Titel: Ueberschriftenfamilie, normaler Schnitt
  // (heading-deco.js; Pendant zum EPUB, wo die Nummer font-weight normal traegt).
  safeReg('heading-number', font.heading.family, 400, 'normal');
  reg('title',    font.title.family,    font.title.weight,    'normal');
  reg('subtitle', font.subtitle.family, font.subtitle.weight, 'normal');
  reg('byline',   font.byline.family,   font.byline.weight,   'normal');
  safeReg('dedication', font.dedication.family, font.dedication.weight, font.dedication.italic ? 'italic' : 'normal');
  // frontMatter/authorBio sind neuere Rollen; aeltere, nicht neu-gespeicherte
  // Profile haben sie evtl. nicht im config_json → Fallback auf dedication/body.
  const fmCfg = font.frontMatter || font.dedication;
  const abCfg = font.authorBio || font.body;
  safeReg('frontMatter', fmCfg.family, fmCfg.weight, fmCfg.italic ? 'italic' : 'normal');
  safeReg('authorBio',   abCfg.family, abCfg.weight, abCfg.italic ? 'italic' : 'normal');
  safeReg('imprint',    font.imprint.family,    font.imprint.weight,    font.imprint.italic ? 'italic' : 'normal');
  safeReg('year',       font.year.family,       font.year.weight,       font.year.italic ? 'italic' : 'normal');
  safeReg('toc',        font.toc.family,        font.toc.weight,        'normal');
  safeReg('toc-title',  font.tocTitle.family,   font.tocTitle.weight,   'normal');
  // header/footer sind neuere Rollen; ältere Profile ohne die Keys fallen auf
  // die Body-Familie zurück (safeReg regelt zusätzlich fehlende Weights).
  // Kopf-/Fusszeile trägt pro Slot optional bold/italic (siehe layout.hfStyle),
  // darum je Rolle alle vier Variants vorladen — analog zur Body-Familie.
  const hdrCfg = font.header || font.body;
  const ftrCfg = font.footer || font.body;
  // Rollen, deren Text Inline-Auszeichnung tragen kann (Kopf-/Fusszeile via
  // layout.hfStyle, Verzeichniseintraege via <em> im Titel), brauchen alle vier
  // Variants — analog zur Body-Familie. `_runFontKey(run, base)` waehlt daraus.
  const regVariants = (base, cfg) => {
    const ital = cfg.italic ? 'italic' : 'normal';
    safeReg(base,               cfg.family, cfg.weight,                      ital);
    safeReg(`${base}-bold`,     cfg.family, Math.min(900, cfg.weight + 300), ital);
    safeReg(`${base}-italic`,   cfg.family, cfg.weight,                     'italic');
    safeReg(`${base}-bolditalic`, cfg.family, Math.min(900, cfg.weight + 300), 'italic');
  };
  regVariants('header', hdrCfg);
  regVariants('footer', ftrCfg);
  // bibliography ist eine neuere Rolle; Profile ohne den Key fallen auf Body.
  regVariants('bibliography', font.bibliography || font.body);
  // Fussnotenapparat: der Notentext traegt Kursive (Werktitel), darum ebenfalls
  // alle vier Variants. Profile ohne den Key fallen auf Body.
  regVariants('footnote', font.footnote || font.body);

  await Promise.all(tasks);

  // Trennbarkeit je registriertem Schnitt pruefen. `doc.font(key)` instanziiert
  // den EmbeddedFont, bettet ihn aber NICHT ein: PDFFont.finalize() steigt ohne
  // `dictionary` aus, und die entsteht erst, wenn der Schnitt tatsaechlich auf
  // einer Seite benutzt wird. Der Probelauf kostet also keine PDF-Groesse.
  const prevFont = doc._font;
  const unsafe = new Set();
  for (const { key, family } of registered) {
    try {
      doc.font(key);
      if (doc._font?.font && _sharesHyphenGlyph(doc._font.font)) unsafe.add(family);
    } catch { /* nicht instanziierbar — dann trennt hier ohnehin nichts */ }
  }
  if (prevFont) doc._font = prevFont;
  return { hyphenationUnsafeFamilies: [...unsafe], fallbacks };
}

// PDF/A-2 verbietet Verweise auf das .notdef-Glyph (ISO 19005-2 6.2.11.8).
// Pdfkit emittiert diesen Verweis, sobald ein Codepoint nicht in der Font
// liegt. Wir filtern Strings vor jedem doc.text-Call gegen die aktuell
// aktive Font: bekannte Substitutionen (Soft-Hyphen → drop), NFKD-Fallback
// für Diakritika ohne Glyph (ḿ → m, ń → n), als letztes silent-drop.
const _GLYPH_SUBSTITUTE = new Map();

function _sanitizeAgainstFont(doc, s) {
  if (typeof s !== 'string' || !s) return s;
  const f = doc._font && doc._font.font;
  if (!f || typeof f.glyphForCodePoint !== 'function') return s;
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    // SHY (U+00AD) MUSS bis zur LineWrapper durchkommen — sonst keine
    // Silbentrennung. Verbleibende SHYs nach Wrap entfernt `_patchSoftHyphenStripper`.
    if (cp === 0x00AD) { out += ch; continue; }
    if (cp < 0x80) { out += ch; continue; }
    const g = f.glyphForCodePoint(cp);
    if (g && g.id !== 0) { out += ch; continue; }
    if (_GLYPH_SUBSTITUTE.has(cp)) { out += _GLYPH_SUBSTITUTE.get(cp); continue; }
    // NFKD: Basiszeichen + Combining Marks; Marks droppen, Basis behalten falls vorhanden
    const decomp = ch.normalize('NFKD');
    let any = '';
    for (const dc of decomp) {
      const dcp = dc.codePointAt(0);
      if (dcp >= 0x0300 && dcp <= 0x036F) continue;
      const dg = f.glyphForCodePoint(dcp);
      if (dg && dg.id !== 0) any += dc;
    }
    out += any;
  }
  return out;
}

function _patchDocTextSanitizer(doc) {
  const orig = doc.text.bind(doc);
  doc.text = function patchedText(text, ...rest) {
    if (typeof text === 'string') text = _sanitizeAgainstFont(doc, text);
    return orig(text, ...rest);
  };
}

// Strippt verbleibende Soft-Hyphens VOR dem Encode-Step. pdfkit's LineWrapper
// nutzt SHY als Break-Marker und ersetzt trailing-SHY durch HYPHEN '-' am
// Zeilenumbruch — SHYs innerhalb nicht gebrochener Zeilen würden sonst als
// Codepoint im PDF landen (PDF/A: .notdef-Verstoss bei Fonts ohne SHY-Glyph).
function _patchSoftHyphenStripper(doc) {
  const orig = doc._fragment.bind(doc);
  doc._fragment = function patchedFragment(text, x, y, options) {
    if (typeof text === 'string' && text.indexOf('­') >= 0) text = text.replace(/­/g, '');
    return orig(text, x, y, options);
  };
}

// OpenType-Features für alle doc.text-Calls injizieren. pdfkit reicht
// options.features unverändert an fontkit weiter; fontkit aktiviert ohne
// User-Liste nur die scriptweise Pflicht-Features — `liga`/`clig`/`kern`
// sind im OpenType-Spec „common", aber bei fontkit-Layout via pdfkit nicht
// automatisch an. Ohne diese Injektion fehlen fi/fl-Ligaturen und Kerning.
// Numerale (onum/lnum) sind stilistische Alternativen — wenn Body-Numerale
// 'oldstyle'/'lining', kommt sie in dieselbe globale Liste (Buchweite Wahl).
function _patchOpenTypeFeatures(doc, baseFeatures) {
  if (!Array.isArray(baseFeatures) || baseFeatures.length === 0) return;
  const features = baseFeatures.slice();
  // Für den manuellen Blocksatz-Layouter (justify.js): Messung via
  // widthOfString muss dieselben Features (kern/liga/…) sehen wie der Render,
  // sonst driften Zeilenumbruch + Rand-Justierung. widthOfString erbt die
  // globalen doc.text-Features NICHT automatisch — darum hier deponieren.
  doc._otFeatures = features;
  const orig = doc.text.bind(doc);
  const inject = (opts) => {
    if (!opts) return { features };
    if (Array.isArray(opts.features) && opts.features.length) return opts;
    return { ...opts, features };
  };
  doc.text = function patchedText(text, a, b, c) {
    if (typeof a === 'object' && a !== null) return orig(text, inject(a));
    if (typeof c === 'object' && c !== null) return orig(text, a, b, inject(c));
    if (typeof b === 'object' && b !== null) return orig(text, a, inject(b));
    if (a === undefined && b === undefined && c === undefined) return orig(text, inject(null));
    return orig(text, a, b, inject(null));
  };
}

function _buildFeatureList(fontConfig) {
  const features = ['liga', 'clig', 'kern'];
  const numerals = fontConfig?.body?.numerals;
  if (numerals === 'oldstyle') features.push('onum');
  else if (numerals === 'lining') features.push('lnum');
  return features;
}

// Font-Key eines Inline-Runs. `base` ist die Rollen-Familie, gegen die die vier
// Variants registriert sind (Default 'body'; der Body-Renderer setzt für
// Verzeichniseinträge 'bibliography').
function _runFontKey(run, base = 'body') {
  if (run.bold && run.italic) return `${base}-bolditalic`;
  if (run.bold)   return `${base}-bold`;
  if (run.italic) return `${base}-italic`;
  return base;
}

module.exports = { _registerFonts, _nearestWeight, _sharesHyphenGlyph, _sanitizeAgainstFont, _patchDocTextSanitizer, _patchSoftHyphenStripper, _patchOpenTypeFeatures, _buildFeatureList, _runFontKey };
