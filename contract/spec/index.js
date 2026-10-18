'use strict';
// Quelle von contract/openapi.json (`npm run contract:build`). Die JSON-Datei
// ist das Artefakt, das Client-Repos lesen; geändert wird hier.

const version = require('../version.json');
const schemas = require('./schemas');
const paths = require('./paths');

function buildSpec() {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Schreibwerkstatt — Client-Vertrag (macOS, Android)',
      version: `api ${version.api} · editorApi ${version.editorApi}`,
      description: 'Die REST-Fläche, die die nativen Clients nutzen. Regeln, Versionen und Ablauf: contract/README.md. '
        + 'Antworten dürfen Felder tragen, die hier nicht stehen — ein Client ignoriert sie.',
      'x-api': version.api,
      'x-editor-api': version.editorApi,
    },
    components: {
      securitySchemes: { deviceToken: { type: 'http', scheme: 'bearer', description: 'Device-Token `swd_…` (Profil → Geräte).' } },
      schemas,
    },
    security: [{ deviceToken: [] }],
    paths,
  };
}

module.exports = { buildSpec };
