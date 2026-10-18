'use strict';
// Kurzschreibweise für die Vertrags-Schemas — erzeugt reines JSON Schema
// (OpenAPI 3.1). Keine Logik, nur weniger Klammern.

const str = (description, extra = {}) => ({ type: 'string', ...(description ? { description } : {}), ...extra });
const int = (description, extra = {}) => ({ type: 'integer', ...(description ? { description } : {}), ...extra });
const num = (description) => ({ type: 'number', ...(description ? { description } : {}) });
const bool = (description) => ({ type: 'boolean', ...(description ? { description } : {}) });
const arr = (items, description, extra = {}) => ({ type: 'array', items, ...(description ? { description } : {}), ...extra });
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });

/** nullable: `type` um `null` erweitern bzw. `$ref` in anyOf mit null. */
function nul(schema) {
  if (schema.$ref) return { anyOf: [schema, { type: 'null' }] };
  return { ...schema, type: [].concat(schema.type, 'null') };
}

function obj(properties, required = [], extra = {}) {
  return { type: 'object', properties, ...(required.length ? { required } : {}), ...extra };
}

const volatile = (schema) => ({ ...schema, 'x-volatile': true });

// Ein Server-Zeitstempel. Der Client schickt ihn als `expected_updated_at`
// EXAKT so zurück, wie er kam — nie aus einer Zeitzahl neu formatieren (der
// Server vergleicht die Zeichenkette).
const ts = (description) => str(description || 'Server-Zeitstempel, ISO-8601 UTC mit Millisekunden (`…T…:…:….sssZ`). Unverändert zurückschicken.', { format: 'date-time' });

const json = (schema, description) => ({
  description: description || '',
  content: { 'application/json': { schema } },
});

const error = (codes, description) => json(ref('Error'), `${description ? `${description} ` : ''}error_code: ${[].concat(codes).join(' | ')}`);

module.exports = { str, int, num, bool, arr, ref, nul, obj, volatile, ts, json, error };
