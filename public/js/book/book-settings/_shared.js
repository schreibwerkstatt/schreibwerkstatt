// Geteilte Imports + Modul-Konstanten der bookSettingsMethods-Submodule.
// Buch-Einstellungen (Sprache, Region, Buchtyp, Perspektive, Zeit, Kontext).
// Methoden werden in Alpine.data('bookSettingsCard') gespreadet;
// Root-Zugriffe via window.__app.

import { fetchJson, sendJson } from '../../utils.js';
import { contentRepo } from '../../repo/content.js';
import { countryOptions } from '../../country-codes.js';
import { EVT } from '../../events.js';

export { EVT, contentRepo, countryOptions, fetchJson, sendJson };
