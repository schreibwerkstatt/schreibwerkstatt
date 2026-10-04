'use strict';
// Zwei Ausgaben derselben Samples: Prometheus-Text 0.0.4 (/metrics) und das
// selbstbeschreibende JSON fuer die Home-Assistant-Integration (/metrics.json).
// Die JSON-Form ist Client-Vertrag (docs/metrics-api.md#json); eine
// inkompatible Aenderung bumpt JSON_SCHEMA.

const { METRIC_DEFS } = require('./defs');
const { tServer } = require('../i18n-server');
const { currentTz } = require('../local-date');
const { getVersion } = require('../version');
const { getInstanceId } = require('../instance-id');

const JSON_SCHEMA = 1;

function escLabel(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\"');
}

function fmtLabels(labels) {
  const parts = [];
  for (const [k, v] of Object.entries(labels || {})) {
    if (v == null || v === '') continue;
    parts.push(`${k}="${escLabel(v)}"`);
  }
  return parts.length ? `{${parts.join(',')}}` : '';
}

function toPrometheus(samples) {
  const lines = [];
  for (const [name, list] of samples) {
    const def = METRIC_DEFS[name];
    lines.push(`# HELP ${name} ${def.help}`);
    lines.push(`# TYPE ${name} ${def.type}`);
    for (const s of list) lines.push(`${name}${fmtLabels(s.labels)} ${s.value}`);
  }
  return lines.join('\n') + '\n';
}

function toJson(samples, { today, includeUsers }) {
  const metrics = [];
  for (const [name, def] of Object.entries(METRIC_DEFS)) {
    const list = samples.get(name);
    if (!list) continue;
    metrics.push({
      name,
      type: def.type,
      group: def.group,
      title: { de: tServer(`metrics.name.${name}`, 'de'), en: tServer(`metrics.name.${name}`, 'en') },
      unit: def.unit || null,
      device_class: def.deviceClass || null,
      state_class: def.stateClass || null,
      reset: def.reset || null,
      icon: def.icon || null,
      diagnostic: !!def.diagnostic,
      enabled_default: !def.disabled,
      entity: def.entity !== false,
      per_user: !!def.perUser,
      samples: list,
    });
  }
  return {
    schema: JSON_SCHEMA,
    instance_id: getInstanceId(),
    version: getVersion(),
    generated_at: new Date().toISOString(),
    timezone: currentTz(),
    today,
    includes_users: !!includeUsers,
    metrics,
  };
}

module.exports = { toPrometheus, toJson, JSON_SCHEMA };
