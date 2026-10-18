'use strict';
// Bild-Cache der Blog-Syncs (WordPress-Mediathek, HubSpot-File-Manager): welche
// Bildquelle schon unter welcher Adresse beim Ziel liegt. Ohne ihn laedt jeder
// Push dieselben Bilder erneut hoch — der Push schreibt die neue Adresse nicht in
// den Abschnitt zurueck (data:-URIs und App-Seitenbilder sollen in der App
// bleiben), also sieht der naechste Push wieder die alte Quelle.
//
//   src_key    Identitaet der Quelle: `sha256:<hex>` der Bytes (data:-URI,
//              App-Seitenbild) bzw. `url:<adresse>` (fremd gehostet, ohne Fetch)
//   remote_src Adresse beim Ziel, remote_id die Medien-ID (WP-Attachment, HubSpot-File)
//
// Je Verbindung genau ein Anbieter (CHECK): `blog_id` XOR `hub_id`. CASCADE —
// reiner Cache, ohne seine Verbindung wertlos. Ein Zielwechsel der Verbindung
// (andere Blog-URL / anderes Portal) leert ihn im Schreibpfad (db/sync-media-cache.js).
module.exports = {
  version: 332,
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sync_media_cache (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        blog_id    INTEGER REFERENCES blog_connections(id)    ON DELETE CASCADE,
        hub_id     INTEGER REFERENCES hubspot_connections(id) ON DELETE CASCADE,
        src_key    TEXT    NOT NULL,
        remote_src TEXT    NOT NULL,
        remote_id  TEXT,
        created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        CHECK ((blog_id IS NULL) <> (hub_id IS NULL))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_media_cache_blog ON sync_media_cache(blog_id, src_key) WHERE blog_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_media_cache_hub  ON sync_media_cache(hub_id, src_key)  WHERE hub_id IS NOT NULL;
    `);
  },
};
