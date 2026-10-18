'use strict';
// Gemeinsame Vorspann-Helfer der Blog-Sync-Jobs (Import, Pull, Push, Reconcile).
// Facade: routes/jobs/blog-sync.js.

const { jobAbortControllers } = require('../shared');
const blogs = require('../../../db/blogs');
const { assertBlogBook } = require('../../../lib/buchtyp');

function _abortSignal(jobId) {
  return jobAbortControllers.get(jobId)?.signal || null;
}

function _resolveBlogConn(bookId) {
  const conn = blogs.getConnection(bookId);
  if (!conn) {
    const err = new Error('BLOG_NOT_CONNECTED');
    err.code = 'BLOG_NOT_CONNECTED';
    throw err;
  }
  return conn;
}

function _requireBlogBook(bookId, userEmail) {
  return assertBlogBook(bookId, userEmail, 'BLOG_REQUIRES_BLOG_TYPE');
}

module.exports = { _abortSignal, _resolveBlogConn, _requireBlogBook };
