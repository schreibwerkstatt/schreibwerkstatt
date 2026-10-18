'use strict';
// Die Endpunkte, die macOS und Android aufrufen — nicht die ganze API. `x-clients`
// sagt, wer sie nutzt; eine Änderung dort betrifft genau diese Clients.
// Jede Operation hat mindestens einen Fall in
// tests/integration/_helpers/contract-cases.js (Ausnahme: `x-contract-untested`
// mit Begründung — Durchreichen an externe Dienste).

const { str, int, ref, json, error } = require('./dsl');

const BOTH = ['macos', 'android'];
const MAC = ['macos'];
const ANDROID = ['android'];

const pathParam = (name, description) => ({ name, in: 'path', required: true, schema: int(), ...(description ? { description } : {}) });
const query = (name, schema, description) => ({ name, in: 'query', required: false, schema, ...(description ? { description } : {}) });
const body = (name) => ({ required: true, content: { 'application/json': { schema: ref(name) } } });

const AUTH = {
  401: error('NOT_LOGGED_IN', 'Token fehlt, unbekannt, widerrufen oder abgelaufen; Konto gesperrt/gelöscht.'),
  403: error(['DEVICE_SCOPE_FORBIDDEN', 'NO_BOOK_ACCESS', 'INSUFFICIENT_ROLE'], 'Scope oder Buchrolle reicht nicht.'),
};

module.exports = {
  '/config': {
    get: {
      'x-clients': BOTH,
      summary: 'Server-Konfiguration (Vertragsstand, LanguageTool, STT, User-Einstellungen)',
      responses: { 200: json(ref('Config')), ...AUTH },
    },
  },

  '/content/books': {
    get: {
      'x-clients': BOTH,
      summary: 'Bücher des Users',
      responses: { 200: json({ type: 'array', items: ref('Book') }), ...AUTH },
    },
  },
  '/content/books/{book_id}/tree': {
    get: {
      'x-clients': BOTH,
      summary: 'Gliederung: Kapitel (rekursiv) und Abschnitte',
      parameters: [pathParam('book_id')],
      responses: { 200: json(ref('Tree')), ...AUTH },
    },
  },
  '/content/books/{book_id}/sync': {
    get: {
      'x-clients': BOTH,
      summary: 'Delta-Pull für den lokalen Spiegel',
      description: 'Keyset-Cursor `(updated_at, page_id)`. Ohne `since` = Voll-Pull. Paginieren bis `has_more=false`.',
      parameters: [
        pathParam('book_id'),
        query('since', str(undefined, { format: 'date-time' }), '`cursor.since` der vorigen Antwort.'),
        query('since_id', int(), '`cursor.since_id` der vorigen Antwort.'),
        query('limit', int(undefined, { maximum: 200 })),
      ],
      responses: { 200: json(ref('SyncResponse')), ...AUTH },
    },
  },
  '/content/books/{book_id}/device-ping': {
    post: {
      'x-clients': ANDROID,
      summary: 'Buch-Heartbeat (Multi-Device-Erkennung im Browser)',
      parameters: [pathParam('book_id')],
      requestBody: body('DevicePingRequest'),
      responses: { 200: json(ref('DevicePingResponse')), ...AUTH },
    },
  },

  '/content/pages': {
    post: {
      'x-clients': BOTH,
      summary: 'Abschnitt anlegen',
      description: 'Optionaler Header `Idempotency-Key` (8–100 Zeichen `[A-Za-z0-9_-]`): derselbe Schlüssel desselben Kontos liefert 24 h lang die erste Antwort noch einmal (Header `Idempotent-Replayed: true`) statt erneut anzulegen — für ein Nachspielen nach verlorener Antwort.',
      parameters: [{ name: 'Idempotency-Key', in: 'header', required: false, schema: str() }],
      requestBody: body('CreatePageRequest'),
      responses: { 200: json(ref('Page')), 400: error(['BOOKID_REQ', 'NAME_REQ', 'INVALID_VALUE']), ...AUTH },
    },
  },
  '/content/pages/{page_id}': {
    get: {
      'x-clients': BOTH,
      summary: 'Abschnitt mit HTML',
      parameters: [pathParam('page_id')],
      responses: { 200: json(ref('Page')), 404: error('PAGE_NOT_FOUND'), ...AUTH },
    },
    put: {
      'x-clients': BOTH,
      summary: 'Push (Body und/oder Name)',
      description: [
        'Optimistic Concurrency über `expected_updated_at`. Veraltet → 409, ausser:',
        '- `save_id` = Server-`last_save_id` → 200 `save_match: "replay"` (nichts geschrieben);',
        '- Server-`last_save_id` ∈ `own_save_ids` → 200 `save_match: "own"`;',
        '- `base_html` mitgeschickt und Block-Merge kollisionsfrei → 200 `merged: true` (geschrieben; `html` übernehmen).',
        'Echte Block-Kollision mit `base_html` → 409 mit `merge_conflicts`.',
      ].join('\n'),
      parameters: [pathParam('page_id')],
      requestBody: body('PageSaveRequest'),
      responses: {
        200: json(ref('Page')),
        400: error('EMPTY_BODY', 'Weder `html` noch `name`.'),
        409: json(ref('PageConflict')),
        422: error('HTML_SANITIZE_FAILED', 'Nichts geschrieben; derselbe Push scheitert erneut.'),
        423: json(ref('PageLocked')),
        ...AUTH,
      },
    },
    delete: {
      'x-clients': MAC,
      summary: 'Abschnitt löschen',
      parameters: [pathParam('page_id'), query('device_id', str(undefined, { format: 'uuid' }))],
      responses: { 200: json(ref('Ok')), ...AUTH },
    },
  },
  '/content/pages/{page_id}/revisions': {
    get: {
      'x-clients': BOTH,
      summary: 'Fassungen eines Abschnitts (ohne HTML)',
      parameters: [pathParam('page_id'), query('limit', int())],
      responses: { 200: json(ref('RevisionList')), ...AUTH },
    },
  },
  '/content/pages/{page_id}/revisions/{rev_id}': {
    get: {
      'x-clients': BOTH,
      summary: 'Eine Fassung mit HTML',
      parameters: [pathParam('page_id'), pathParam('rev_id')],
      responses: { 200: json(ref('RevisionDetail')), 404: error('REVISION_NOT_FOUND'), ...AUTH },
    },
  },
  '/content/pages/{page_id}/revisions/{rev_id}/restore': {
    post: {
      'x-clients': BOTH,
      summary: 'Fassung wiederherstellen',
      parameters: [pathParam('page_id'), pathParam('rev_id')],
      responses: { 200: json(ref('RestoreResponse')), 404: error('REVISION_NOT_FOUND'), ...AUTH },
    },
  },
  '/content/chapters': {
    post: {
      'x-clients': ANDROID,
      summary: 'Kapitel anlegen (Tagebuch: Jahr/Monat)',
      requestBody: body('CreateChapterRequest'),
      responses: { 200: json(ref('Chapter')), ...AUTH },
    },
  },

  '/content/editor-bundle.zip': {
    get: {
      'x-clients': BOTH,
      summary: 'OTA-Editor-Bundle (ZIP mit bundle-manifest.json)',
      description: 'Header `X-Editor-Api` = Majors, die die Schale kann (`1` oder `1,2`); ohne Header gilt 1. `If-None-Match` mit dem ETag → 304.',
      parameters: [
        { name: 'X-Editor-Api', in: 'header', required: false, schema: str() },
        { name: 'If-None-Match', in: 'header', required: false, schema: str() },
      ],
      responses: {
        200: { description: 'ZIP; `bundle-manifest.json` hat die Form `BundleManifest`.', content: { 'application/zip': { schema: { type: 'string', format: 'binary' } } }, 'x-manifest': ref('BundleManifest') },
        304: { description: 'Unverändert.' },
        409: json(ref('EditorApiUnsupported'), 'Kein passender Major — gecachtes Bundle behalten, Update-Hinweis zeigen.'),
        ...AUTH,
      },
    },
  },
  '/research': {
    get: {
      'x-clients': ANDROID,
      summary: 'Recherche-Board eines Buchs (reduzierte Form für Device-Token)',
      parameters: [query('book_id', int()), query('kind', str()), query('sort', str()), query('q', str()), query('limit', int())],
      responses: { 200: json({ type: 'array', items: ref('ResearchClientItem') }), 400: error('INVALID_ID'), ...AUTH },
    },
    post: {
      'x-clients': ANDROID,
      summary: 'Fundstück anlegen (geteilter Link)',
      requestBody: body('ResearchCreateRequest'),
      responses: {
        200: json(ref('ResearchItem')),
        400: error(['BOOKID_REQ', 'EMPTY']),
        409: error('DUPLICATE_URL', 'Trägt `existing_id`; übersteuerbar mit `allow_duplicate: true`.'),
        ...AUTH,
      },
    },
  },
  '/dictionary': {
    post: {
      'x-clients': BOTH,
      summary: 'Wort ins persönliche Wörterbuch',
      requestBody: body('DictionaryAddRequest'),
      responses: { 200: json(ref('Ok')), ...AUTH },
    },
  },
  '/history/writing-time': {
    post: {
      'x-clients': BOTH,
      summary: 'Schreibzeit-Heartbeat',
      requestBody: body('WritingTimeRequest'),
      responses: { 200: json(ref('WritingTimeResponse')), ...AUTH },
    },
  },
  '/booksettings/{book_id}': {
    get: {
      'x-clients': MAC,
      summary: 'Buch-Einstellungen (Sprache/Region)',
      parameters: [pathParam('book_id')],
      responses: { 200: json(ref('BookSettings')), ...AUTH },
    },
  },
  '/export/book/{book_id}/md': {
    get: {
      'x-clients': MAC,
      summary: 'Buch als Markdown',
      parameters: [pathParam('book_id')],
      responses: { 200: { description: 'Markdown-Text.', content: { 'text/markdown': { schema: { type: 'string' } } } }, ...AUTH },
    },
  },

  '/jobs/check': {
    post: {
      'x-clients': MAC,
      summary: 'Lektorat des offenen Abschnitts starten',
      requestBody: body('CheckJobRequest'),
      responses: { 200: json(ref('JobCreated')), ...AUTH },
    },
  },
  '/jobs/synonym': {
    post: {
      'x-clients': MAC,
      summary: 'KI-Synonyme starten',
      requestBody: body('SynonymJobRequest'),
      responses: { 200: json(ref('JobCreated')), ...AUTH },
    },
  },
  '/jobs/{job_id}': {
    get: {
      'x-clients': MAC,
      summary: 'Job-Status pollen',
      parameters: [{ name: 'job_id', in: 'path', required: true, schema: str() }],
      responses: { 200: json(ref('JobStatus')), 404: error('JOB_NOT_FOUND'), ...AUTH },
    },
  },

  '/me/device-tokens': {
    get: {
      'x-clients': MAC,
      summary: 'Eigene Device-Tokens (prüft nebenbei, ob das Token gilt)',
      responses: { 200: json(ref('DeviceTokenList')), ...AUTH },
    },
  },
  '/me/account': {
    delete: {
      'x-clients': MAC,
      summary: 'Konto löschen (App-Store-Guideline 5.1.1(v))',
      description: 'Ein 404 OHNE `error_code` heisst «Server kennt die Route nicht» → Browser-Fallback `…/#profil`.',
      requestBody: body('AccountDeleteRequest'),
      responses: {
        200: json(ref('AccountDeleteResponse')),
        400: error('CONFIRM_REQUIRED'),
        403: error(['ACCOUNT_DELETE_FORBIDDEN', 'DEVICE_SCOPE_FORBIDDEN']),
        404: error('USER_NOT_FOUND'),
        500: error('ACCOUNT_DELETE_FAILED'),
        401: AUTH[401],
      },
    },
  },

  '/languagetool/check': {
    post: {
      'x-clients': BOTH,
      'x-contract-untested': 'Proxy auf den admin-konfigurierten LanguageTool-Server; die Antwort ist dessen Format.',
      summary: 'Rechtschreibprüfung (Durchreichen an LanguageTool)',
      requestBody: body('LtCheckRequest'),
      responses: { 200: { description: 'LanguageTool-Antwort (`matches[]`).' }, ...AUTH },
    },
  },
  '/openthesaurus/synonyms': {
    get: {
      'x-clients': MAC,
      'x-contract-untested': 'Proxy auf OpenThesaurus (externer Dienst).',
      summary: 'Synonyme aus OpenThesaurus',
      parameters: [query('word', str())],
      responses: { 200: json(ref('SynonymList')), ...AUTH },
    },
  },
  '/stt/transcribe': {
    post: {
      'x-clients': ANDROID,
      'x-contract-untested': 'Proxy auf den admin-konfigurierten STT-Dienst.',
      summary: 'Diktat-Segment transkribieren',
      parameters: [query('bookId', int()), query('pageId', int())],
      requestBody: { required: true, content: { 'audio/wav': { schema: { type: 'string', format: 'binary' } } } },
      responses: { 200: json(ref('Transcript')), ...AUTH },
    },
  },
};
