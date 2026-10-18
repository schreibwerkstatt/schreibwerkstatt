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

function makeImageResolver({ wp, blogOrigin, bookId = null, cache = null, signal = null, logger = null, fetchImpl = null } = {}) {
  return _makeResolver({
    bookId, cache, signal, logger, fetchImpl,
    logTag: 'Blog-Media',
    isHosted: (url) => !!blogOrigin && url.origin === blogOrigin,
    async upload({ data, filename, mimeType }) {
      const media = await wp.uploadMedia({ data, filename, mimeType });
      const src = media && (media.source_url || media.guid?.rendered);
      return src ? { src, id: media.id != null ? media.id : null } : null;
    },
  });
}

module.exports = {
  makeImageResolver,
  ALLOWED_IMAGE_MIME,
  MAX_IMAGE_BYTES,
  _decodeDataUri,
  _filenameFromUrl,
};
