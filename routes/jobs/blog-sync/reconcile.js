'use strict';
// Blog-Reconcile-Job. Facade: routes/jobs/blog-sync.js.

const { updateJob, completeJob, failJob, makeJobLogger } = require('../shared');
const blogs = require('../../../db/blogs');
const { createWpClient } = require('../../../lib/wp-client');
const { _abortSignal, _resolveBlogConn, _requireBlogBook } = require('./common');

// Reconcile: pruft jeden Link via GET, dropt orphan Links (Remote-Post weg).
// Deckt Hard-Delete in WP (kein Trash-Stamp). Nach Lauf kennt der Buchorganizer
// die toten Links nicht mehr; Badges flippen auf 'new'.
async function runBlogReconcileJob(jobId, bookId, userEmail) {
  const logger = makeJobLogger(jobId);
  try {
    _requireBlogBook(bookId, userEmail);
    const conn = _resolveBlogConn(bookId);
    const wp = createWpClient({
      baseUrl: conn.baseUrl,
      username: conn.username,
      password: conn.password,
      signal: _abortSignal(jobId),
    });

    const links = blogs.listLinksForBlog(conn.id);
    let checked = 0;
    let removed = 0;
    const total = links.length;
    updateJob(jobId, {
      statusText: 'job.blog.reconcile.check',
      statusParams: { current: 0, total },
      progress: 1,
    });

    for (const link of links) {
      if (_abortSignal(jobId)?.aborted) throw new DOMException('Aborted', 'AbortError');
      checked++;
      try {
        await wp.getPost(link.wp_post_id);
      } catch (e) {
        if (e.code === 'BLOG_HTTP_404' || e.status === 404) {
          blogs.deleteLink(link.page_id);
          removed++;
          logger.info(`Blog-Reconcile: Page ${link.page_id} -> WP-Post ${link.wp_post_id} weg, Link entfernt`);
        } else {
          logger.warn(`Blog-Reconcile: Page ${link.page_id} -> WP-Post ${link.wp_post_id} Fehler ${e.code || e.message}`);
        }
      }
      updateJob(jobId, {
        statusText: 'job.blog.reconcile.check',
        statusParams: { current: checked, total },
        progress: Math.min(98, 2 + Math.round((checked / Math.max(1, total)) * 95)),
      });
    }

    logger.info(`Blog-Reconcile: ${checked} geprüft, ${removed} orphan Links entfernt.`);
    completeJob(jobId, { checked, removed }, null, `${removed} orphan Links entfernt`);
  } catch (e) {
    if (e.name !== 'AbortError') makeJobLogger(jobId).error(`Blog-Reconcile-Fehler: ${e.message}`);
    failJob(jobId, e);
  }
}

module.exports = { runBlogReconcileJob };
