const { parseHTML } = require('linkedom');
const { cleanPageHtml } = require('./html-clean');
// Chip-Selektoren kommen aus der SSoT public/js/sources/cite-html.js (ESM, per
// lib/esm-bridge.js) — deshalb ist wpToAppHtml async. Bewusst KEINE
// Selektor-Kopie hier: sie waere eine weitere Driftstelle, und der Import-Weg
// ist auf dem Server frei (das Modul muss nur im Browser pre-auth-tauglich
// bleiben, nicht hier).
const { citeHtml: _citeModule, figureHtml: _figureModule } = require('./esm-bridge');
const {
  BIBLIOGRAPHY_MARKER_CLASS, BIBLIOGRAPHY_MARKER_SEL,
  bibliographyVisible, bibliographySectionHtml,
} = require('./bibliography');
const { leadHtml, LEAD_CLASS } = require('./headline-render');
const { resolveImagesInTree } = require('./sync/image-resolver');

// Lead aus der Titel-Werkstatt: steht in WordPress als erster Block direkt unter
// dem Post-Titel, in einem `wp:group` mit dieser Marker-Klasse. Wie das
// Quellenverzeichnis ein Render-Artefakt: der Pull schneidet ihn wieder heraus
// und meldet seinen Text zurueck (`stats.lead`), damit er in `page_headline`
// landet statt als erster Absatz im Manuskript — sonst stuende er nach einem
// Zyklus doppelt da. Die Dachzeile geht bewusst NICHT mit: WordPress setzt den
// Post-Titel ueber den Inhalt, eine Dachzeile im Inhalt stuende also UNTER der
// Schlagzeile.
const HEADLINE_MARKER_CLASS = 'sw-headline';

const WP_COMMENT_RE = /<!--\s*\/?\s*wp:[^>]*-->/g;

// Nicht round-trip-faehige Einbettungen: werden bei Import wie Export verworfen.
// Bilder (`img`/`figure`) sind bewusst NICHT hier — die bleiben erhalten.
const _DROP_EMBEDS = 'video, audio, iframe, embed, object, picture, source';
// Auf `<img>` erhaltene Attribute (Rest wird gestrippt: srcset/sizes/width/height/
// loading/decoding/style… bleiben WP ueberlassen).
const _IMG_KEEP_ATTRS = new Set(['src', 'alt', 'class']);

function _parseRoot(html) {
  const wrapped = `<!DOCTYPE html><html><body><div id="r">${html}</div></body></html>`;
  const { document } = parseHTML(wrapped);
  return document.getElementById('r');
}

function _escAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Traegt eine Klasse auf der App-Seite Bedeutung?
 *
 *  `wp-image-<n>` ja: sie traegt die Attachment-ID fuer einen sauberen
 *  Push-Round-Trip. Die Utility-Klassen von WordPress und Theme nein: `wp-*`,
 *  `has-*` (Farben, Ausrichtung), `is-*` (`is-style-*`, `is-resized`,
 *  `is-layout-*`), `size-*` (Bildgroesse), `align*` (Bildausrichtung),
 *  `columns-*` (Galerie). Keine App-Klasse beginnt so.
 *
 *  EINE Definition fuer BEIDE Richtungen (Pull-Filter in `wpToAppHtml`,
 *  Push-`className` in `_wrapBlock`). Sonst ist der Round-Trip nicht geschlossen:
 *  der Push muss genau die Klassen mitschicken, die der Pull behaelt. */
const _WP_UTILITY_CLASS_RE = /^(?:wp-|has-|is-|size-|align|columns-)/;
function _isAppClass(c) {
  return !!c && (/^wp-image-\d+$/.test(c) || !_WP_UTILITY_CLASS_RE.test(c));
}

/** App-relevante Klassen eines Elements als String (leer = keine). */
function _appClasses(el) {
  return String((el.getAttribute && el.getAttribute('class')) || '')
    .split(/\s+/).filter(_isAppClass).join(' ');
}

// WP-Attachment-ID eines <img>: explizit via data-wp-id, sonst aus der
// `wp-image-<n>`-Klasse (bleibt beim Import erhalten, siehe _isAppClass).
function _imgId(img) {
  const explicit = img.getAttribute('data-wp-id');
  if (explicit && /^\d+$/.test(explicit)) return Number(explicit);
  const cls = img.getAttribute('class') || '';
  const m = /\bwp-image-(\d+)\b/.exec(cls);
  return m ? Number(m[1]) : null;
}

/** Quellen-Chip ohne `data-src` zu reinem Text degradieren.
 *
 *  WordPress' KSES entfernt `data-*`-Attribute, wenn der verbundene Benutzer die
 *  Capability `unfiltered_html` nicht hat (bei Multisite haben sie auch Admins
 *  nicht). Dann kommt vom Pull ein `<span class="cite">(Müller, 2020, S. 44)</span>`
 *  ohne Zeiger zurueck: eine Quellenangabe, die auf nichts zeigt.
 *
 *  Wir raten NIE auf eine Quelle — nicht ueber den Chip-Text, nicht ueber die
 *  Quellenliste des Buchs. Der Text ist ausdruecklich nur ein Cache
 *  (public/js/sources/cite-html.js), zwei Quellen desselben Autors im selben Jahr
 *  sind darin nicht unterscheidbar, und ein falscher Zeiger waere schlimmer als
 *  gar keiner: er landete unbemerkt im Verzeichnis. Also bleibt der lesbare Text
 *  als Klartext im Satz stehen und der Fall wird gezaehlt. */
async function _degradeCitesWithoutPointer(root, stats) {
  const { CITE_CLASS, CITE_ATTR_SRC, isCiteEl } = await _citeModule();
  let degraded = 0;
  for (const el of Array.from(root.querySelectorAll(`span.${CITE_CLASS}`))) {
    if (isCiteEl(el)) continue;              // Zeiger intakt — nichts zu tun.
    if (!el.hasAttribute(CITE_ATTR_SRC)) degraded++;
    el.replaceWith(...Array.from(el.childNodes));
  }
  if (degraded && stats && typeof stats === 'object') {
    stats.citesDegraded = (stats.citesDegraded || 0) + degraded;
  }
  return degraded;
}

/** Bildnachweis zurueck in seine Abbildung. Der Push schreibt ihn als eigenen
 *  Absatz-Block direkt hinter den `wp:image`-Block (ein `<p>` IN der Figur
 *  machte den Block ungueltig, siehe _imageBlock); hier wandert er wieder als
 *  Geschwister der Legende in die `<figure>` (Markup-SSoT
 *  public/js/figure/figure-html.js). Nur direkt hinter einer Abbildung mit Bild
 *  und ohne eigenen Nachweis — ein freistehender Absatz mit der Klasse bleibt. */
async function _reattachFigureCredits(root) {
  const { FIGURE_CREDIT_SEL } = await _figureModule();
  for (const p of Array.from(root.querySelectorAll(FIGURE_CREDIT_SEL))) {
    const fig = p.previousElementSibling;
    if (!fig || fig.tagName.toLowerCase() !== 'figure') continue;
    if (!fig.querySelector('img') || fig.querySelector(FIGURE_CREDIT_SEL)) continue;
    fig.appendChild(p);
  }
}

/** WordPress-Post-HTML → App-Seiten-HTML.
 *
 *  `stats` ist ein optionales Out-Objekt: `citesDegraded` zaehlt die Chips, die
 *  ohne Zeiger zurueckkamen (siehe _degradeCitesWithoutPointer). Der Pull-Job
 *  reicht es an den User weiter — stumm waere es die schlechteste Variante, weil
 *  der Verlust erst Wochen spaeter im Verzeichnis auffaellt. */
async function wpToAppHtml(raw, stats = null) {
  if (!raw || typeof raw !== 'string') return '';
  // Samt dem Zeilenumbruch dahinter: Gutenberg schreibt `<li>A<!-- wp:list -->\n<ul>`
  // — ohne das stuende im Listenpunkt ein `\n`, das die App nie hatte.
  const html = raw.replace(new RegExp(`${WP_COMMENT_RE.source}\\n?`, 'g'), '');
  const root = _parseRoot(html);
  if (!root) return '';

  // Ein vom Push angehaengtes Quellenverzeichnis ist ein Render-Artefakt und darf
  // NIE als Seitentext zurueckkommen (siehe BIBLIOGRAPHY_MARKER_CLASS): sonst
  // steht es nach dem Pull im Manuskript und der naechste Push haengt ein zweites
  // an. Muss vor dem Klassenfilter laufen, der `wp-block-group` entfernt — die
  // Marker-Klasse selbst ueberlebt ihn, aber die Reihenfolge soll nicht davon
  // abhaengen.
  root.querySelectorAll(BIBLIOGRAPHY_MARKER_SEL).forEach(n => n.remove());

  // Lead-Block (siehe HEADLINE_MARKER_CLASS): Text zurueckmelden, Block weg.
  // Nur ein VORHANDENER Block ist eine Aussage ueber den Lead — fehlt er, bleibt
  // `stats.lead` undefined und der Aufrufer laesst den Werkstatt-Stand stehen.
  const leadGroups = Array.from(root.querySelectorAll(`.${HEADLINE_MARKER_CLASS}`));
  if (leadGroups.length) {
    const text = leadGroups.map(n => n.textContent || '').join(' ').replace(/\s+/g, ' ').trim();
    if (stats && typeof stats === 'object') stats.lead = text;
    leadGroups.forEach(n => n.remove());
  }

  await _degradeCitesWithoutPointer(root, stats);

  // TABELLEN ZURUECKHOLEN. Zwei Schritte, und die Reihenfolge ist kritisch:
  //
  //   1. Gutenberg verpackt seinen Tabellenblock in `<figure class=
  //      "wp-block-table">` und die Beschriftung in ein `<figcaption>`. Unser
  //      Markup traegt sie als `<caption>` IN der Tabelle. Ohne diesen Schritt
  //      faellt gleich unten die Regel „Figuren ohne Bild fallen weg" ueber den
  //      Wrapper — und LOESCHT die ganze Tabelle. Genau der Degradations-Weg, den
  //      der Pull nie nehmen darf: das Manuskript verliert bei jedem Abgleich
  //      Inhalt, den niemand geloescht hat.
  //   2. Die Ausrichtung liegt in WordPress als `has-text-align-*`-Klasse. Der
  //      Klassenfilter weiter unten wirft `has-`-Klassen weg (sie gehoeren dem
  //      Theme) — die Angabe muss also VORHER auf unser `data-align` gehoben
  //      werden. Der Push macht die Abbildung hinwaerts (siehe _wrapBlock).
  root.querySelectorAll('figure.wp-block-table').forEach((fig) => {
    const table = fig.querySelector('table');
    if (!table) return;
    const figcap = fig.querySelector('figcaption');
    if (figcap && !table.querySelector('caption')) {
      const cap = fig.ownerDocument.createElement('caption');
      cap.innerHTML = figcap.innerHTML;
      table.insertBefore(cap, table.firstChild);
    }
    fig.replaceWith(table);
  });
  root.querySelectorAll('th, td').forEach((cell) => {
    const cls = String(cell.getAttribute('class') || '');
    const m = /\bhas-text-align-(left|center|right)\b/.exec(cls);
    if (m && !cell.getAttribute('data-align')) cell.setAttribute('data-align', m[1]);
  });
  // `scope="col"` an den Kopfzellen wiederherstellen. WordPress kennt die Angabe
  // nicht und schickt sie nicht zurueck; unser Markup-Vertrag verlangt sie
  // (public/js/table/table-html.js — es ist die Angabe, aus der ein Screenreader
  // die Spaltenzuordnung liest). Beim Pull normalisieren statt darauf zu warten,
  // dass irgendwann der Dialog die Tabelle neu schreibt.
  root.querySelectorAll('thead th').forEach((th) => {
    if (!th.getAttribute('scope')) th.setAttribute('scope', 'col');
  });

  root.querySelectorAll(_DROP_EMBEDS).forEach(n => n.remove());
  // <img> auf ein schlankes Attribut-Set reduzieren (src/alt/class).
  root.querySelectorAll('img').forEach(img => {
    for (const attr of Array.from(img.attributes)) {
      if (!_IMG_KEEP_ATTRS.has(attr.name.toLowerCase())) img.removeAttribute(attr.name);
    }
  });
  // Figuren ohne Bild (z.B. ehemalige Video-/Embed-Wrapper) fallen weg.
  root.querySelectorAll('figure').forEach(fig => {
    if (!fig.querySelector('img')) fig.remove();
  });
  root.querySelectorAll('[style]').forEach(n => n.removeAttribute('style'));
  root.querySelectorAll('[class]').forEach(n => {
    const keep = _appClasses(n);
    if (keep) n.setAttribute('class', keep);
    else n.removeAttribute('class');
  });
  await _reattachFigureCredits(root);

  // Getrimmt: die entfernten Gutenberg-Kommentare und Marker-Bloecke (Lead vorn,
  // Verzeichnis hinten) hinterlassen Leerraum an den Raendern — ohne Trim haenge
  // der Seiteninhalt davon ab, ob der Post einen Lead-Block trug.
  return cleanPageHtml(root.innerHTML.trim());
}

// Gutenberg-Bloecke, die Pull und Push verlustfrei hin und zurueck tragen —
// genau die, die `_wrapBlock` selbst erzeugt, plus `freeform` (Classic-Block:
// beliebiges HTML, derselbe Weg wie ein Classic-Editor-Post ohne Block-Kommentare).
// `group` steht drin, obwohl eine fremde Gruppe ihr Layout verliert (der Pull
// loest das `<div>` auf): der Inhalt bleibt, und Lead, Quellenverzeichnis,
// Gedicht und Nachrichtenverlauf sind selbst Gruppen. Neuer Block in `_wrapBlock`
// ⇒ hier eintragen, sonst sperrt der eigene Push sich selbst.
const _ROUND_TRIP_BLOCKS = new Set([
  'paragraph', 'heading', 'list', 'list-item', 'quote', 'code', 'separator',
  'image', 'table', 'group', 'freeform',
]);

/** Was in einem WordPress-Post steckt, das `wpToAppHtml` NICHT in die App
 *  uebernimmt — und ein Push folglich in WordPress loeschen wuerde, weil er den
 *  ganzen `content` ersetzt. Liefert eine sortierte Liste kurzer Kennungen
 *  (leer = round-trip-sicher):
 *    - `wp:<name>`  jeder Gutenberg-Block ausserhalb von `_ROUND_TRIP_BLOCKS`
 *                   (Galerie, Spalten, Buttons, Embeds, Weiterlesen-Marke,
 *                   Plugin-Bloecke, wiederverwendbare Bloecke …)
 *    - `<tag>`      Einbettung, die der Import verwirft (`iframe`, `video`, …)
 *    - `figure`     Figur ohne Bild (ehemaliger Embed-/Medien-Wrapper)
 *    - `gallery`    Figur mit mehreren Bildern (Classic-Editor-Galerie) — der
 *                   Push schriebe nur das erste zurueck
 *    - `background` Hintergrundbild per Inline-Style (z.B. Cover-Block)
 *  Allowlist statt Blocklist: ein Block, den niemand vorhergesehen hat, ist
 *  gesperrt, nicht still verloren. Der eigene Push erzeugt nur Bloecke aus der
 *  Liste; ein unveraendert zurueckgespielter App-Stand loest die Sperre nicht aus. */
function wpLossyBlocks(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const found = new Set();
  for (const m of raw.matchAll(/<!--\s*wp:([a-z0-9/-]+)/gi)) {
    const name = m[1].toLowerCase();
    if (!_ROUND_TRIP_BLOCKS.has(name)) found.add(`wp:${name}`);
  }
  const root = _parseRoot(raw.replace(WP_COMMENT_RE, ''));
  if (root) {
    for (const el of root.querySelectorAll(_DROP_EMBEDS)) found.add(el.tagName.toLowerCase());
    for (const fig of root.querySelectorAll('figure')) {
      const imgs = fig.querySelectorAll('img').length;
      if (!imgs && !fig.querySelector('table')) found.add('figure');
      if (imgs > 1) found.add('gallery');
    }
    for (const el of root.querySelectorAll('[style]')) {
      if (/background(-image)?\s*:[^;]*url\(/i.test(el.getAttribute('style') || '')) found.add('background');
    }
  }
  return [...found].sort();
}

function _serializeInline(node) {
  return node.innerHTML;
}

// Gutenberg-`wp:image`-Block aus einem <img> (evtl. in <figure> mit <figcaption>).
// Ein Link um das Bild (`<a href><img></a>`) bleibt erhalten. Der Bildnachweis
// (`p.figure-credit` in der Figur, Markup-SSoT public/js/figure/figure-html.js)
// steht als eigener Absatz-Block DAHINTER: ein `<p>` in der Figur macht den
// Bildblock im Block-Editor ungueltig. Der Pull haengt ihn wieder ein
// (_reattachFigureCredits). Ohne das fehlte der Nachweis im veroeffentlichten Blog.
function _imageBlock(img, caption, extras = []) {
  const src = img && img.getAttribute('src');
  if (!src) return '';
  const id = _imgId(img);
  const alt = img.getAttribute('alt') || '';
  const attrs = id ? ` {"id":${id},"sizeSlug":"full"}` : '';
  const imgClass = id ? ` class="wp-image-${id}"` : '';
  const cap = caption && caption.trim()
    ? `<figcaption class="wp-element-caption">${caption}</figcaption>`
    : '';
  let imgHtml = `<img src="${_escAttr(src)}" alt="${_escAttr(alt)}"${imgClass}/>`;
  const a = img.parentElement && img.parentElement.tagName.toLowerCase() === 'a' ? img.parentElement : null;
  const href = a && a.getAttribute('href');
  if (href) imgHtml = `<a href="${_escAttr(href)}">${imgHtml}</a>`;
  const block = `<!-- wp:image${attrs} -->\n<figure class="wp-block-image size-full">${imgHtml}${cap}</figure>\n<!-- /wp:image -->`;
  return [block, ...extras.map(p => _paragraphBlock(p)).filter(Boolean)].join('\n\n');
}

// Gutenberg-`className` + passendes `class`-Attribut aus den App-Klassen eines
// Elements. Die Klassen wandern mit, weil der Pull zurueckliest: der
// Klassenfilter behaelt genau diese (_isAppClass), und das Manuskript bekommt
// seine Blockart zurueck (Todo-Liste, Bildnachweis, Zeilenarten …).
function _classAttrs(el, base = '') {
  const cls = _appClasses(el);
  const full = [base, cls].filter(Boolean).join(' ');
  return {
    json: cls ? `"className":${JSON.stringify(cls)}` : '',
    attr: full ? ` class="${_escAttr(full)}"` : '',
  };
}

function _paragraphBlock(p) {
  if (!p) return '';
  const { json, attr } = _classAttrs(p);
  return `<!-- wp:paragraph${json ? ` {${json}}` : ''} -->\n<p${attr}>${_serializeInline(p)}</p>\n<!-- /wp:paragraph -->`;
}

function _headingBlock(el, level) {
  const { json, attr } = _classAttrs(el, 'wp-block-heading');
  // Ebene 2 ist Gutenbergs Vorgabe und steht darum nicht im Kommentar.
  const parts = [level !== 2 ? `"level":${level}` : '', json].filter(Boolean);
  return `<!-- wp:heading${parts.length ? ` {${parts.join(',')}}` : ''} -->\n<h${level}${attr}>${_serializeInline(el)}</h${level}>\n<!-- /wp:heading -->`;
}

// Liste als `wp:list` mit einem `wp:list-item` je Punkt. Eine verschachtelte
// Liste ist in Gutenberg ein eigener `wp:list`-Block IM Listenpunkt — als
// rohes `<ul>` im `<li>` meldete der Block-Editor „unerwarteter Inhalt".
function _listBlock(el) {
  const ordered = el.tagName.toLowerCase() === 'ol';
  const { json, attr } = _classAttrs(el);
  const parts = [ordered ? '"ordered":true' : '', json].filter(Boolean);
  const items = Array.from(el.children)
    .filter(c => c.tagName && c.tagName.toLowerCase() === 'li')
    .map((li) => {
      const li2 = _classAttrs(li);
      let inner = '';
      for (const n of Array.from(li.childNodes)) {
        const t = n.nodeType === 1 ? n.tagName.toLowerCase() : '';
        inner += (t === 'ul' || t === 'ol') ? _listBlock(n) : (n.nodeType === 1 ? n.outerHTML : _escText(n.textContent));
      }
      return `<!-- wp:list-item${li2.json ? ` {${li2.json}}` : ''} -->\n<li${li2.attr}>${inner}</li>\n<!-- /wp:list-item -->`;
    })
    .join('\n');
  const tag = ordered ? 'ol' : 'ul';
  return `<!-- wp:list${parts.length ? ` {${parts.join(',')}}` : ''} -->\n<${tag}${attr}>\n${items}\n</${tag}>\n<!-- /wp:list -->`;
}

function _escText(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Strukturelle Bloecke als `wp:group` mit einem Absatz-Block je Zeile:
// Nachrichtenverlauf (div.msg-thread, Markup-SSoT public/js/messages/msg-html.js)
// und Gedicht (div.poem). Die Klassen wandern als Gutenberg-`className` mit —
// nicht der Optik wegen, sondern weil der Pull zurückliest: der Klassenfilter
// behält App-Klassen (_isAppClass), aus der Gruppe wird wieder das `div`, aus
// den Absätzen wieder die Zeilenarten. Dieselbe Klassenliste wie
// lib/html-clean.js#_STRUCTURAL_DIV_CLASSES (dort bleibt das `div` erhalten).
const MSG_THREAD_CLASS = 'msg-thread';
const _GROUP_DIV_CLASSES = [MSG_THREAD_CLASS, 'poem'];

function _structuralGroupBlock(el, cls) {
  const rows = Array.from(el.children)
    .filter(c => c.tagName && c.tagName.toLowerCase() === 'p' && (c.textContent || '').trim())
    .map(_paragraphBlock);
  if (!rows.length) return '';
  return `<!-- wp:group {"className":"${cls}"} -->\n<div class="wp-block-group ${cls}">`
    + `${rows.join('\n')}</div>\n<!-- /wp:group -->`;
}

function _wrapBlock(el) {
  const tag = el.tagName ? el.tagName.toLowerCase() : '';
  if (tag === 'div') {
    const own = _appClasses(el).split(' ');
    const cls = _GROUP_DIV_CLASSES.find(c => own.includes(c));
    if (cls) return _structuralGroupBlock(el, cls);
  }
  switch (tag) {
    case 'p':
      return _paragraphBlock(el);
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
      return _headingBlock(el, Number(tag[1]));
    case 'ul':
    case 'ol':
      return _listBlock(el);
    case 'blockquote': {
      // `data-src` (belegtes Blockzitat, Markup-SSoT public/js/sources/cite-html.js)
      // wandert mit in den Gutenberg-Block. Nicht der Optik wegen — WordPress
      // stylet nach eigenem Theme —, sondern weil der Blog-Sync zurueckliest
      // (LWW-Pull): ohne den Zeiger im Post-HTML verliert das Blockzitat beim
      // naechsten Pull seine Quelle und faellt aus dem Zitat-Anteil heraus.
      const src = el.getAttribute('data-src');
      const srcAttr = /^\d+$/.test(String(src || '')) ? ` data-src="${src}"` : '';
      return `<!-- wp:quote -->\n<blockquote class="wp-block-quote"${srcAttr}>${el.innerHTML}</blockquote>\n<!-- /wp:quote -->`;
    }
    case 'pre': {
      // Die App-Klassen des `<pre>` wandern als Gutenberg-`className` mit (das
      // ist die vorgesehene Form; Gutenberg serialisiert sie selbst hinter die
      // Block-Klasse). Nicht der Optik wegen — WordPress stylet nach eigenem
      // Theme —, sondern weil der Blog-Sync zurueckliest (LWW-Pull) und der
      // Klassenfilter dort genau diese Klassen behaelt (_isAppClass).
      //
      // Konkret betroffen ist das Diagramm (`<pre class="mermaid">`, Markup-SSoT
      // public/js/diagram/mermaid-html.js): ohne die Klasse im Post-HTML kaeme
      // vom naechsten Pull ein klassenloses `<pre>` zurueck und wuerde den
      // Diagramm-Block im Manuskript dauerhaft zum gewoehnlichen Codeblock
      // machen — derselbe Verlust-Mechanismus wie beim Quellen-Chip ohne
      // `data-src`, nur ohne Rettungsanker.
      const extra = _appClasses(el);
      const attrs = extra ? ` {"className":${JSON.stringify(extra)}}` : '';
      const cls = extra ? `wp-block-code ${extra}` : 'wp-block-code';
      return `<!-- wp:code${attrs} -->\n<pre class="${_escAttr(cls)}">${_serializeInline(el)}</pre>\n<!-- /wp:code -->`;
    }
    case 'table': {
      // Gutenberg-Tabellenblock. Der `<figure class="wp-block-table">`-Wrapper
      // ist Pflicht — ohne ihn zeigt der Block-Editor die Tabelle als
      // „unerwarteten Inhalt" und bietet an, sie in HTML umzuwandeln.
      //
      // Die Ausrichtung wird auf Gutenbergs eigene Klassen abgebildet
      // (`has-text-align-right`): unser `data-align` versteht das WP-Theme nicht,
      // und eine im Block-Editor geoeffnete Tabelle zeigte alle Spalten
      // linksbuendig. Der Pull macht die Abbildung rueckwaerts — beide
      // Richtungen stehen darum hier nebeneinander.
      const cells = (row, tag) => Array.from(row.children || [])
        .filter(c => c.tagName === 'TD' || c.tagName === 'TH')
        .map((c) => {
          const a = String(c.getAttribute('data-align') || '').toLowerCase();
          const cls = ['left', 'center', 'right'].includes(a) && a !== 'left'
            ? ` class="has-text-align-${a}" data-align="${a}"` : '';
          return `<${tag}${cls}>${_serializeInline(c)}</${tag}>`;
        }).join('');
      const trs = Array.from(el.querySelectorAll('tr'));
      const headRow = trs.find(r => Array.from(r.children || [])
        .filter(c => c.tagName === 'TD' || c.tagName === 'TH').every(c => c.tagName === 'TH'));
      const head = headRow ? `<thead><tr>${cells(headRow, 'th')}</tr></thead>` : '';
      const body = trs.filter(r => r !== headRow).map(r => `<tr>${cells(r, 'td')}</tr>`).join('');
      const capEl = el.querySelector('caption');
      const cap = capEl ? `<figcaption class="wp-element-caption">${_serializeInline(capEl)}</figcaption>` : '';
      return `<!-- wp:table -->\n<figure class="wp-block-table"><table>${head}<tbody>${body}</tbody></table>${cap}</figure>\n<!-- /wp:table -->`;
    }
    case 'hr':
      return `<!-- wp:separator -->\n<hr class="wp-block-separator has-alpha-channel-opacity"/>\n<!-- /wp:separator -->`;
    case 'figure': {
      // Verschachtelte Figuren (eine frueher importierte Galerie): jedes Bild
      // als eigener Bildblock — sonst kaeme nur das erste im Blog an.
      const kids = Array.from(el.children);
      const nested = kids.filter(c => c.tagName.toLowerCase() === 'figure');
      if (nested.length) return nested.map(_wrapBlock).filter(Boolean).join('\n\n');
      const img = el.querySelector('img');
      const figcap = el.querySelector('figcaption');
      const extras = kids.filter(c => c.tagName.toLowerCase() === 'p');
      return _imageBlock(img, figcap ? figcap.innerHTML : '', extras);
    }
    case 'img':
      return _imageBlock(el, '');
    case 'video':
    case 'audio':
    case 'iframe':
    case 'embed':
    case 'object':
    case 'picture':
      return '';
    default: {
      const text = (el.textContent || '').trim();
      if (!text) return '';
      // Wrapper mit Bloecken darin (ein loses `<div>`, `<section>` …): die
      // Kinder als eigene Bloecke. In einen Absatz gesteckt ergaebe das
      // `<p><p>…</p></p>` — ungueltiges HTML, das der Browser auseinanderreisst.
      if (el.querySelector(_BLOCK_CHILD_SEL)) return _emitBlocks(el);
      return `<!-- wp:paragraph -->\n<p>${_serializeInline(el)}</p>\n<!-- /wp:paragraph -->`;
    }
  }
}

const _BLOCK_CHILD_SEL = 'p, h1, h2, h3, h4, h5, h6, ul, ol, blockquote, pre, table, figure, hr, div';

// Quellenverzeichnis als Gutenberg-Blocks, umschlossen von einem `wp:group` mit
// der Marker-Klasse. Der Group-Wrapper ist der Anker fuer den Pull-Strip in
// wpToAppHtml — beides steht bewusst in DIESER Datei nebeneinander, damit die
// Akkumulations-Invariante nicht auf zwei Module verteilt ist.
//
// Gutenberg schreibt `className` in die Klassenliste des gerenderten `<div>`
// (`wp-block-group sw-bibliography`), sodass der Marker sowohl in `content.raw`
// als auch in `content.rendered` wiederzufinden ist.
//
// Ueberschrift und Eintraege kommen aus der geteilten SSoT
// (lib/bibliography.js#bibliographySectionHtml) und werden durch denselben
// Block-Emitter wie der Seitentext geschickt: h2 → wp:heading, ul → wp:list,
// p → wp:paragraph.
function _bibliographyBlocks(bib) {
  if (!bibliographyVisible(bib)) return '';
  const section = bibliographySectionHtml(bib, { list: true });
  const inner = _emitBlocks(_parseRoot(section));
  if (!inner) return '';
  return `<!-- wp:group {"className":"${BIBLIOGRAPHY_MARKER_CLASS}"} -->\n`
       + `<div class="wp-block-group ${BIBLIOGRAPHY_MARKER_CLASS}">\n${inner}\n</div>\n`
       + '<!-- /wp:group -->';
}

function _withBibliography(blocks, bib) {
  const bibBlocks = _bibliographyBlocks(bib);
  if (!bibBlocks) return blocks;
  return blocks ? `${blocks}\n\n${bibBlocks}` : bibBlocks;
}

function _leadBlocks(lead) {
  const para = leadHtml({ hl: { lead } });
  if (!para) return '';
  return `<!-- wp:group {"className":"${HEADLINE_MARKER_CLASS}"} -->\n`
       + `<div class="wp-block-group ${HEADLINE_MARKER_CLASS}">\n`
       + `<!-- wp:paragraph {"className":"${LEAD_CLASS}"} -->\n${para}\n<!-- /wp:paragraph -->\n`
       + '</div>\n<!-- /wp:group -->';
}

function _withLead(blocks, lead) {
  const leadBlocks = _leadBlocks(lead);
  if (!leadBlocks) return blocks;
  return blocks ? `${leadBlocks}\n\n${blocks}` : leadBlocks;
}

function _emitBlocks(root) {
  const blocks = [];
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType !== 1) continue;
    const wrapped = _wrapBlock(child);
    if (wrapped) blocks.push(wrapped);
  }
  return blocks.join('\n\n');
}

/** App-Seiten-HTML → Gutenberg-Blocks.
 *
 *  `bibliography` (Rueckgabe von buildBibliography, Einheit = diese eine Seite)
 *  haengt das Quellenverzeichnis als markierten Block an. Nur uebergeben, wenn
 *  `bibliography_enabled && bibliography_in_blog` gilt — die Sichtbarkeitspruefung
 *  auf leere Eintraege macht bibliographyVisible. */
function appToWpHtml(html, { bibliography = null, lead = null } = {}) {
  if (!html || typeof html !== 'string') return _withLead(_withBibliography('', bibliography), lead);
  const root = _parseRoot(html);
  if (!root) return _withLead(_withBibliography('', bibliography), lead);
  return _withLead(_withBibliography(_emitBlocks(root), bibliography), lead);
}

// Wie appToWpHtml, aber mit vorgelagertem async Media-Pass (geteilt mit dem
// HubSpot-Push, lib/sync/image-resolver.js#resolveImagesInTree): jedes <img>
// geht durch `resolveImage(src)`; die Attachment-ID landet als data-wp-id fuer den
// Block-Emitter, `null` entfernt das Bild (siehe lib/wp-media.js).
async function appToWpHtmlWithMedia(html, { resolveImage, bibliography = null, lead = null } = {}) {
  if (!html || typeof html !== 'string') return _withLead(_withBibliography('', bibliography), lead);
  const root = _parseRoot(html);
  if (!root) return _withLead(_withBibliography('', bibliography), lead);
  await resolveImagesInTree(root, resolveImage, { idAttr: 'data-wp-id' });
  return _withLead(_withBibliography(_emitBlocks(root), bibliography), lead);
}

module.exports = { wpToAppHtml, wpLossyBlocks, appToWpHtml, appToWpHtmlWithMedia, WP_COMMENT_RE, HEADLINE_MARKER_CLASS };
