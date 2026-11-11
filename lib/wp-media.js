'use strict';
// Bild-Resolver fuer den WordPress-Push: WordPress-Huelle um den gemeinsamen
// Resolver beider Blog-Syncs (lib/sync/image-resolver.js). Hier steht nur, was
// WordPress-spezifisch ist: „schon gehostet" = gleiche Origin wie der Blog, der
// Upload geht in die Mediathek (`wp.uploadMedia`), die Attachment-ID wandert als
// `id` mit (Gutenberg `wp:image {"id":N}`).

const {
  makeImageResolver: _makeResolver, ALLOWED_IMAGE_MIME, MAX_IMAGE_BYTES,
  _decodeDataUri, _filenameFromUrl,
} = require('./sync/image-resolver');

// „Schon im Blog": derselbe Host wie die Verbindung — mit und ohne `www.`
// (WordPress leitet meist eine Variante auf die andere um, die Bild-URLs tragen
// die kanonische) und ueber Jetpacks Bild-CDN `i0…i3.wp.com/<host>/…`. Sonst
// laedt der erste Push jedes importierte Bild als Dublette in die Mediathek.
// Das Schema zaehlt nicht: ein `http://`-Bild auf dem eigenen Host ist dasselbe.
const JETPACK_CDN_RE = /^i[0-3]\.wp\.com$/;

function _bareHost(host) {
  return String(host || '').toLowerCase().replace(/^www\./, '');
}

function isBlogHosted(url, blogOrigin) {
  if (!blogOrigin || !url) return false;
  let blog;
  try { blog = new URL(blogOrigin); } catch { return false; }
  const own = _bareHost(blog.hostname);
  if (_bareHost(url.hostname) === own && (url.port || '') === (blog.port || '')) return true;
  if (JETPACK_CDN_RE.test(String(url.hostname).toLowerCase())) {
    const first = url.pathname.split('/').filter(Boolean)[0] || '';
    return _bareHost(first) === own;
  }
  return false;
}

function makeImageResolver({ wp, blogOrigin, bookId = null, cache = null, signal = null, logger = null, fetchImpl = null } = {}) {
  return _makeResolver({
    bookId, cache, signal, logger, fetchImpl,
    logTag: 'Blog-Media',
    isHosted: (url) => isBlogHosted(url, blogOrigin),
    // Alt-Text des <img> auch in die Mediathek: WordPress uebernimmt ihn sonst
    // nicht, und ein spaeter aus der Mediathek eingefuegtes Bild staende ohne da
    // (Barrierefreiheit, Bildersuche). Scheitert nur das, bleibt der Upload gueltig.
    async upload({ data, filename, mimeType, alt = '' }) {
      const media = await wp.uploadMedia({ data, filename, mimeType });
      const altText = String(alt || '').trim();
      if (media?.id != null && altText && typeof wp.updateMedia === 'function') {
        try { await wp.updateMedia(media.id, { alt_text: altText }); }
        catch (e) { logger?.warn?.(`Blog-Media: Alt-Text fuer Medium ${media.id} nicht gesetzt: ${e.code || e.message}`); }
      }
      const src = media && (media.source_url || media.guid?.rendered);
      return src ? { src, id: media.id != null ? media.id : null } : null;
    },
  });
}

module.exports = {
  makeImageResolver,
  isBlogHosted,
  ALLOWED_IMAGE_MIME,
  MAX_IMAGE_BYTES,
  _decodeDataUri,
  _filenameFromUrl,
};
