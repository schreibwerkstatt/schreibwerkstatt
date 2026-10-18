'use strict';
// Der Ausschnitt aus JSON Schema, den der Client-Vertrag benutzt — Prüfen und
// Projizieren. Bewusst klein und ohne Abhängigkeit: der Vertrag soll lesbar
// bleiben, und jedes Schlüsselwort hier ist eines, das Swift-/Kotlin-DTOs
// ohnehin abbilden können.
//
// Unterstützt: type (auch als Liste, `null` für nullable), properties,
// required, items, enum, const, anyOf, additionalProperties (als Schema = Map),
// $ref auf #/components/schemas/…, maxItems. Alle `x-…`-Schlüssel sind
// Annotationen; `x-volatile: true` ersetzt den Wert in Fixtures durch einen
// Platzhalter (Commit-Hash, Dateilisten, Job-Ids).
//
// Unbekannte Felder in Antworten sind erlaubt — ein Client ignoriert sie. Was
// er liest, steht im Schema; was er braucht, steht in `required`.

function deref(schema, root) {
  let s = schema;
  for (let i = 0; s && s.$ref && i < 20; i++) {
    const m = /^#\/components\/schemas\/(.+)$/.exec(s.$ref);
    if (!m || !root.components?.schemas?.[m[1]]) throw new Error(`Unbekannte $ref: ${s.$ref}`);
    s = root.components.schemas[m[1]];
  }
  return s;
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function typeOk(v, type) {
  const t = typeOf(v);
  return [].concat(type).some((want) => want === t || (want === 'number' && t === 'integer'));
}

/** Liste von Fehlern (`$.a.b: …`); leer = gültig. */
function validate(value, schema, root, at = '$') {
  const s = deref(schema, root);
  if (!s || Object.keys(s).every((k) => k.startsWith('x-') || k === 'description')) return [];
  if (s.anyOf) {
    const results = s.anyOf.map((alt) => validate(value, alt, root, at));
    return results.some((r) => r.length === 0) ? [] : [`${at}: passt auf keine Variante (${results.map((r) => r[0]).join(' | ')})`];
  }
  if (s.type && !typeOk(value, s.type)) return [`${at}: erwartet ${[].concat(s.type).join('|')}, ist ${typeOf(value)}`];
  if ('const' in s && value !== s.const) return [`${at}: erwartet ${JSON.stringify(s.const)}, ist ${JSON.stringify(value)}`];
  if (s.enum && !s.enum.includes(value)) return [`${at}: ${JSON.stringify(value)} nicht in ${JSON.stringify(s.enum)}`];
  const errs = [];
  if (typeOf(value) === 'array') {
    if (s.maxItems != null && value.length > s.maxItems) errs.push(`${at}: mehr als ${s.maxItems} Einträge`);
    if (s.items) value.forEach((v, i) => errs.push(...validate(v, s.items, root, `${at}[${i}]`)));
  }
  if (typeOf(value) === 'object') {
    for (const key of s.required || []) if (!(key in value)) errs.push(`${at}: Pflichtfeld «${key}» fehlt`);
    for (const [key, sub] of Object.entries(s.properties || {})) {
      if (key in value) errs.push(...validate(value[key], sub, root, `${at}.${key}`));
    }
    if (s.additionalProperties && typeof s.additionalProperties === 'object') {
      for (const [key, v] of Object.entries(value)) {
        if (!(key in (s.properties || {}))) errs.push(...validate(v, s.additionalProperties, root, `${at}.${key}`));
      }
    }
  }
  return errs;
}

function placeholder(value) {
  switch (typeOf(value)) {
    case 'string': return '<volatile>';
    case 'integer': case 'number': return 0;
    case 'boolean': return false;
    case 'array': return [];
    case 'object': return {};
    default: return value;
  }
}

/**
 * Wert aufs Schema zurückschneiden: nur deklarierte Felder bleiben, `x-volatile`
 * wird Platzhalter. Damit ändert sich eine Fixture nur, wenn sich am Vertrag
 * etwas ändert — nicht, wenn der Server ein Feld dazulernt, das kein Client liest.
 */
function project(value, schema, root) {
  const s = deref(schema, root);
  if (!s) return value;
  if (s['x-volatile']) return placeholder(value);
  if (s.anyOf) {
    const alt = s.anyOf.find((a) => validate(value, a, root).length === 0);
    return alt ? project(value, alt, root) : value;
  }
  if (typeOf(value) === 'array' && s.items) return value.map((v) => project(v, s.items, root));
  if (typeOf(value) === 'object' && (s.properties || s.additionalProperties)) {
    const out = {};
    for (const [key, sub] of Object.entries(s.properties || {})) {
      if (key in value) out[key] = project(value[key], sub, root);
    }
    if (s.additionalProperties && typeof s.additionalProperties === 'object') {
      for (const [key, v] of Object.entries(value)) {
        if (!(key in out)) out[key] = project(v, s.additionalProperties, root);
      }
    }
    return out;
  }
  return value;
}

module.exports = { deref, validate, project };
