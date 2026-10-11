// Werkzeug-Definition `get_edit_status` des Buch-Chats (eigenes Modul, weil
// book-chat-tools.js am LOC-Deckel steht; dort in BOOK_CHAT_TOOLS eingehängt).
// Handler: routes/jobs/book-chat-tools/tools-edit-status.js.

export const EDIT_STATUS_TOOL = {
  name: 'get_edit_status',
  description: 'Bearbeitungsstand, den der AUTOR selbst pro Abschnitt gesetzt hat — eine geordnete Kette (`chain`, z.B. rohfassung → ueberarbeitet → redigiert → final; bei journalistischen Büchern roh → gegengelesen → schlussredigiert → freigegeben), letzte Stufe = fertig (`done_stage`). Liefert `counts` je Stufe (+ `ohne` = nie markiert, `stale` = nach dem Setzen noch geändert), `chapters` mit dem Kapitelstand (= schwächste Stufe aller Abschnitte darunter inkl. Unterkapitel; null, sobald einer keine Stufe hat) und `pages` als Tupel (siehe page_format) in Lesereihenfolge. Beantwortet «wie weit bin ich?», «welche Kapitel sind fertig?», «was ist noch Rohfassung?», «welche fertigen Abschnitte habe ich seither wieder angefasst?», «woran sollte ich als Nächstes arbeiten?». Das ist die Selbsteinschätzung des Autors, KEIN Qualitätsurteil — für Qualität get_reviews/get_lektorat_hotspots. Filter: status (eine Stufe der Kette oder "ohne"), not_done, stale_only, chapter_id.',
  input_schema: {
    type: 'object',
    properties: {
      status:     { type: 'string',  description: 'Optional: nur Abschnitte auf dieser Stufe (Name aus `chain`) oder "ohne" (nie markiert).' },
      not_done:   { type: 'boolean', description: 'Optional: nur Abschnitte, die noch nicht auf der letzten Stufe stehen.' },
      stale_only: { type: 'boolean', description: 'Optional: nur Abschnitte, deren Text nach dem Setzen der Stufe geändert wurde.' },
      chapter_id: { type: 'integer', description: 'Optional: nur Abschnitte dieses Kapitels (inkl. Unterkapitel).' },
      limit:      { type: 'integer', description: 'Maximale Anzahl Abschnitte in `pages` (default 300).' },
    },
    required: [],
  },
};
