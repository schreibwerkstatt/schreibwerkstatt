// Facade: toolbarCardMethods aus thematischen Submodulen in toolbar/.
// Bubble-Toolbar + Link-Bar (bubble.js), Slash-Menü (slash.js), Quellen-Picker
// (cite.js), Querverweis-Picker (xref.js), Diagramm-Dialog (diagram.js),
// Tabellen-Dialog (table.js), Bild-Dialog (image.js), Nachrichtenverlauf
// (msg-thread.js), Absätze → Verlauf (msg-convert.js) und der
// zentrale Keydown-Dispatcher
// (keydown.js) teilen sich zur
// Laufzeit ein `this` (in das
// Card-Objekt gespreadet). Geteilte Modul-Helfer + Konstanten in
// toolbar/_shared.js. Extern importiert nur editor-toolbar-card.js
// { toolbarCardMethods } — die Aufteilung ist internes Implementierungsdetail.
//
// Tabu im Fokus-Modus: Bubble + Slash sind über `!$app.focusActive` (Template)
// bzw. Guards gegated; Keydown-Handler bis zum Focus-Hard-Stop laufen in beiden
// Modi.

import { bubbleMethods } from './toolbar/bubble.js';
import { slashMethods } from './toolbar/slash.js';
import { keydownMethods } from './toolbar/keydown.js';
import { blockEdgeMethods } from './toolbar/block-edge.js';
import { citeMethods } from './toolbar/cite.js';
import { xrefMethods } from './toolbar/xref.js';
import { diagramMethods } from './toolbar/diagram.js';
import { tableMethods } from './toolbar/table.js';
import { imageMethods } from './toolbar/image.js';
import { msgThreadMethods } from './toolbar/msg-thread.js';
import { msgConvertMethods } from './toolbar/msg-convert.js';

export const toolbarCardMethods = {
  ...bubbleMethods,
  ...slashMethods,
  ...keydownMethods,
  ...blockEdgeMethods,
  ...citeMethods,
  ...xrefMethods,
  ...diagramMethods,
  ...tableMethods,
  ...imageMethods,
  ...msgThreadMethods,
  ...msgConvertMethods,
};
