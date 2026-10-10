// Werkzeug-Definition `search_chat_history` des Buch-Chats (eigenes Modul, weil
// book-chat-tools.js am LOC-Deckel steht; dort in BOOK_CHAT_TOOLS eingehängt).
// Handler: routes/jobs/book-chat-tools/tools-chat-history.js.

export const CHAT_HISTORY_TOOL = {
  name: 'search_chat_history',
  description: 'Durchsucht die FRÜHEREN Gespräche des Autors zu diesem Buch (seine Buch-Chats und Abschnitts-Chats, nicht das laufende Gespräch) nach Wortlaut und Bedeutung. Nutze es, wenn der Autor sich auf etwas bezieht, das ihr schon besprochen habt («wie hatten wir das entschieden?», «was hast du letzte Woche zu Kapitel 3 gesagt?», «wir hatten doch über Lenas Motiv geredet»). Liefert Treffer {session_id, kind (book|page), page_name, title, created_at, snippet}; der Ausschnitt ist ein Stück aus Frage oder Antwort. NICHT für Fragen zum Manuskript selbst — frühere Antworten können veraltet sein, der Buchtext ist die Wahrheit: was du daraus übernimmst, gegen den aktuellen Text prüfen und als Stand des früheren Gesprächs kennzeichnen.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string',  description: 'Wonach gesucht wird — ein Stichwort, Name oder eine Umschreibung des Themas.' },
      scope: { type: 'string',  enum: ['all', 'book', 'page'], description: 'Optional: nur Buch-Chats (book), nur Abschnitts-Chats (page) oder beide (all, Default).' },
      limit: { type: 'integer', description: 'Maximale Trefferzahl (default 8, max 20).' },
    },
    required: ['query'],
  },
};
