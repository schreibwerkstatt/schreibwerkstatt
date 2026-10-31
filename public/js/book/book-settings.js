// Facade: bookSettingsMethods aus thematischen Submodulen in book-settings/.
// Submodul-Aufteilung nach Domäne; Methoden teilen sich zur Laufzeit ein
// gemeinsames `this` (in das Objekt gespreadet). Geteilte Imports/Konstanten
// in book-settings/_shared.js.
import { savePathMethods } from './book-settings/save-paths.js';
import { settingsMethods } from './book-settings/settings.js';
import { publicationMethods } from './book-settings/publication.js';
import { citationMethods } from './book-settings/citation.js';
import { researchMethods } from './book-settings/research.js';
import { schoolMethods } from './book-settings/school.js';
import { adminMethods } from './book-settings/admin.js';
import { accessMethods } from './book-settings/access.js';
import { blogMethods } from './book-settings/blog.js';
import { hubspotMethods } from './book-settings/hubspot.js';
import { mergeMethods } from './book-settings/merge.js';
import { seriesMethods } from './book-settings/series.js';
import { exposeMethods } from './book-settings/expose.js';

export const bookSettingsMethods = {
  ...savePathMethods,
  ...settingsMethods,
  ...publicationMethods,
  ...citationMethods,
  ...researchMethods,
  ...schoolMethods,
  ...adminMethods,
  ...accessMethods,
  ...blogMethods,
  ...hubspotMethods,
  ...mergeMethods,
  ...seriesMethods,
  ...exposeMethods,
};
