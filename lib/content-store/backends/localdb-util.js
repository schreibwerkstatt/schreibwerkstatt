'use strict';
// Kleine Helfer, die sich die localdb-Teilmodule teilen (localdb.js,
// localdb-books.js, localdb-delete.js, localdb-split.js).

function _nowIso() { return new Date().toISOString(); }

function _notFound(kind, id) {
  const e = new Error(`${kind} ${id} not found`);
  e.code = 'NOT_FOUND';
  e.status = 404;
  return e;
}

module.exports = { _nowIso, _notFound };
