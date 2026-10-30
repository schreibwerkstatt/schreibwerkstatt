// JSON-Schema-Atome für Grammar-Constrained Decoding (lokale Provider).
// Strict-Defaults: additionalProperties:false, alle properties als required.
// Claude verwendet keine Schemas – callAI ignoriert das Argument für Claude.

export function _obj(properties, { addl = false } = {}) {
  return {
    type: 'object',
    additionalProperties: addl,
    required: Object.keys(properties),
    properties,
  };
}

export const _str = { type: 'string' };
export const _num = { type: 'number' };

// Enum mit null als erlaubtem Wert. Ohne `type`: Claude Structured Outputs lehnt
// `type: ['string', 'null']` neben einem Enum ab («Enum value … does not match
// declared type»), und der Call fiele auf den Retry ohne Schema zurück.
export function _nullableEnum(values) {
  return { enum: [...values, null] };
}
