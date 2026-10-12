'use strict';
// EPUB: Satzart des Nachrichtenverlaufs (div.msg-thread — SMS/Chat im
// Manuskript, Markup-SSoT public/js/messages/msg-html.js). 'plain' setzt ihn
// typografisch (Buchkonvention), 'bubbles' mit leichten Sprechblasen. Pendant
// zu `config.messages.style` der PDF- und Word-Profile; beim EPUB lebt die
// Option wie alle Reflow-Optionen buchweit in book_publication.

module.exports = {
  version: 326,
  up(db) {
    const cols = db.prepare('PRAGMA table_info(book_publication)').all().map(c => c.name);
    if (!cols.includes('epub_msg_style')) {
      db.exec("ALTER TABLE book_publication ADD COLUMN epub_msg_style TEXT DEFAULT 'plain'");
    }
  },
};
