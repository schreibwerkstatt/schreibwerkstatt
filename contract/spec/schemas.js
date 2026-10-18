'use strict';
// Antwort- und Request-Formen der Client-Fläche. Massstab für `required`: was
// der Server IMMER liefert und mindestens ein Client als Pflicht dekodiert
// (macOS: Sync/SyncModels.swift u.a., Android: data/net/dto/Dtos.kt). Felder
// ohne `required` liefert der Server, ein Client darf sie aber nicht voraussetzen.

const { str, int, num, bool, arr, ref, nul, obj, volatile, ts } = require('./dsl');

const uuid = (d) => str(d, { format: 'uuid' });

module.exports = {
  Error: obj({
    error_code: str('Maschinenlesbarer Fehlercode — der Vertrag. Texte übersetzt der Client selbst.'),
    params: { type: 'object', description: 'Optionale Parameter zum Code (z.B. `field`, `allowed`).' },
    detail: { description: 'Optionale Diagnose; nicht zum Anzeigen bestimmt.' },
  }, ['error_code']),

  ClientContract: obj({
    api: int('Revision der REST-Fläche (contract/version.json). Steigt bei jeder Vertragsänderung; Feature-Erkennung per `api >= n`.'),
    editorApi: int('Major des OTA-Editor-Bundles. Steigt nur bei einem Bruch.'),
  }, ['api', 'editorApi']),

  Config: obj({
    clientContract: ref('ClientContract'),
    languagetool: obj({ enabled: bool(), debounceMs: int() }, ['enabled', 'debounceMs']),
    stt: obj({
      enabled: bool(),
      provider: str(),
      vad: obj({ silenceMs: int(), threshold: num(), maxSegmentS: int() }),
    }, ['enabled']),
    userSettings: nul(obj({ locale: nul(str()), focus_granularity: nul(str()) })),
  }, ['clientContract', 'languagetool', 'stt']),

  Book: obj({
    id: int(), name: str(), slug: nul(str()), role: str('Rolle des anfragenden Users: owner | editor | lektor | viewer'),
    owner_email: nul(str()), buchtyp: nul(str()),
  }, ['id', 'name', 'role']),

  TreePage: obj({
    id: int(), name: str(), chapter_id: nul(int()), position: nul(int()), updated_at: ts(),
  }, ['id', 'name', 'chapter_id', 'updated_at']),
  TreeChapter: obj({
    id: int(), name: str(), position: nul(int()), parent_chapter_id: nul(int()),
    pages: arr(ref('TreePage')),
    subchapters: arr(ref('TreeChapter'), 'Unterkapitel, gleiche Form (rekursiv).'),
  }, ['id', 'name', 'pages']),
  Tree: obj({
    chapters: arr(ref('TreeChapter')),
    topPages: arr(ref('TreePage'), 'Abschnitte ohne Kapitel.'),
  }, ['chapters', 'topPages']),

  SyncPage: obj({
    page_id: int(), page_name: nul(str()), chapter_id: nul(int()),
    updated_at: nul(ts()), html: nul(str()),
  }, ['page_id']),
  SyncDeleted: obj({ page_id: int(), page_name: nul(str()), deleted_at: ts() }, ['page_id']),
  SyncCursor: obj({
    since: nul(ts('Nächster `since`-Parameter; null = noch kein Stand.')),
    since_id: int('Nächster `since_id`-Parameter (Keyset-Gleichstand).'),
  }, ['since', 'since_id']),
  SyncResponse: obj({
    now: ts('Serverzeit der Antwort.'),
    pages: arr(ref('SyncPage'), 'Seit dem Cursor geänderte Abschnitte inkl. eigener Edits, mit vollem HTML.'),
    deleted: arr(ref('SyncDeleted'), 'Seit `since` gelöschte Abschnitte; leer beim Voll-Pull. Idempotent anwenden.'),
    has_more: bool('true → mit `cursor` weiter pagen.'),
    deleted_has_more: bool('true → `deleted` gedeckelt; Abgleich über `…/tree`.'),
    cursor: ref('SyncCursor'),
  }, ['now', 'pages', 'deleted', 'has_more', 'deleted_has_more', 'cursor']),

  Page: obj({
    id: int(), book_id: int(), chapter_id: nul(int()), name: str(), position: nul(int()),
    html: str('Abschnitts-HTML; Blöcke tragen `data-bid` (Basis des Block-Merge).'),
    updated_at: ts(),
    last_save_id: nul(uuid('Save-Kennung des Writes, der diesen Stand schrieb (kleingeschrieben); null nach einem Write ohne Kennung.')),
    save_match: { enum: ['replay', 'own'], description: 'Nur PUT: `replay` = Wiederholung, nichts geschrieben · `own` = veralteter Stempel, aber der Server-Stand war ein eigener früherer Push.' },
    merged: { const: true, description: 'Nur PUT mit `base_html`: der Server hat gegen einen fremden Stand kollisionsfrei block-gemergt. `html` ist der neue Stand — lokal übernehmen. Der gemergte Write trägt keine Save-Kennung (`last_save_id: null`): Wiederholung und Nachfolger laufen erneut durch den Merge — Nachfolger mit `base_html` = zuletzt gesendetem Stand.' },
  }, ['id', 'book_id', 'name', 'html', 'updated_at', 'last_save_id']),

  PageSaveRequest: obj({
    html: str('Neuer Abschnitts-HTML-Stand.'),
    name: str('Neuer Name (Umbenennen; allein oder mit `html`).'),
    expected_updated_at: nul(ts('Stempel der Basis, auf der geschrieben wurde. Veraltet → 409 PAGE_CONFLICT.')),
    base_html: str('Optional: HTML der Basis. Dann mergt der Server bei veraltetem Stempel selbst (Antwort `merged: true` bzw. 409 mit `merge_conflicts`).'),
    source: str('Herkunft der Fassung: `macapp` | `main` | …'),
    device_id: uuid('Stabile Geräte-UUID.'),
    save_id: uuid('Kennung dieses Pushs, neu je Push; eine Wiederholung trägt dieselbe.'),
    own_save_ids: arr(uuid(), 'Kennungen früherer unbeantworteter Pushs desselben Schreibers seit der Basis, älteste zuerst. Der Server wertet die letzten 16 aus.'),
  }),
  PageConflict: obj({
    error_code: { const: 'PAGE_CONFLICT' },
    server_updated_at: nul(ts('Aktueller Server-Stempel.')),
    server_editor_email: nul(str()),
    server_editor_name: nul(str()),
    server_is_self: bool('Der fremde Stand stammt vom selben Konto (Zweitgerät).'),
    server_editor_device: nul(str('Gerätename, nur für eigene Geräte.')),
    merge_conflicts: arr(str(), 'Nur wenn `base_html` mitkam: `data-bid` der Blöcke, die beide Seiten verschieden geändert haben. Nichts geschrieben.'),
  }, ['error_code', 'server_updated_at', 'server_is_self']),
  PageLocked: obj({
    error_code: { const: 'PAGE_LOCKED' },
    locked_by_email: str(), expires_at: ts(),
  }, ['error_code', 'locked_by_email', 'expires_at']),

  CreatePageRequest: obj({
    book_id: int(), chapter_id: nul(int()), name: str('Tagebuch: ISO-Tag `YYYY-MM-DD`.'), html: str(),
  }, ['name']),
  CreateChapterRequest: obj({
    book_id: int(), name: str(), position: int(), parent_chapter_id: nul(int()),
  }, ['book_id', 'name']),
  Chapter: obj({
    id: int(), book_id: int(), name: str(), position: nul(int()), parent_chapter_id: nul(int()),
  }, ['id', 'book_id', 'name']),

  Revision: obj({
    id: int(), page_id: int(), book_id: int(),
    chars: nul(int()), words: nul(int()), tok: nul(int()),
    source: nul(str('focus | main | book | chat-apply | lektorat-apply | import | conflict | macapp | split | restore. Unbekannter Wert → roh anzeigen.')),
    user_email: nul(str()), client: nul(str('Client-Label (Browser/OS bzw. nativer Client).')),
    created_at: ts(), summary: nul(str('`baseline` = Stand vor dem ersten Save, `restored from #<id>`, `split → #<id>` / `split from #<id>`, `before split`.')),
    pinned: int('0/1: angeheftet, von der Retention ausgenommen.'), label: nul(str('Name einer angehefteten Revision.')),
    body_html: str('Nur in der Detail-Antwort.'),
  }, ['id', 'page_id', 'created_at']),
  RevisionList: obj({
    revisions: arr(ref('Revision')), has_more: bool(), total: int(),
    older: { ...nul(ref('Revision')), description: 'Vorgängerin der ältesten gelieferten Revision (nur bei `has_more`), ohne `body_html`.' },
    pinned: arr(ref('Revision'), 'Angeheftete Revisionen der Seite, nur in der Antwort ohne Cursor.'),
  }, ['revisions']),
  RevisionDetail: obj({
    revision: ref('Revision'),
    prev: { ...nul(ref('Revision')), description: 'Meta der unmittelbaren Vorgängerin (ohne `body_html`), null bei der ältesten.' },
  }, ['revision']),
  RestoreResponse: obj({ ok: bool(), restored_from: int(), page: ref('Page') }, ['ok', 'restored_from']),

  Ok: obj({ ok: { const: true } }, ['ok']),
  DevicePingRequest: obj({ device_id: uuid(), page_id: nul(int()) }, ['device_id']),
  DevicePingResponse: obj({ ok: { const: true }, self_page_device_count: int(), self_book_device_count: int() }, ['ok']),
  WritingTimeRequest: obj({ book_id: int(), seconds: int('Delta seit dem letzten Ping, idle-gedeckelt.') }, ['book_id', 'seconds']),
  WritingTimeResponse: obj({ ok: { const: true }, added: int() }, ['ok']),
  DictionaryAddRequest: obj({ word: str(), bookId: int('0 = alle Bücher.'), lang: str('`*` = alle Sprachen.') }, ['word']),
  BookSettings: obj({ language: nul(str()), region: nul(str()) }, ['language', 'region']),

  ResearchUrl: obj({ url_id: int('Nur in Server-Antworten.'), url: str(), label: str() }, ['url']),
  ResearchCreateRequest: obj({
    book_id: int(), kind: { enum: ['note', 'link', 'quote', 'fact', 'image'], description: 'Unbekannt → still `note`.' },
    title: nul(str()), body: nul(str()), source: nul(str()),
    urls: arr(ref('ResearchUrl')), tags: arr(str()),
  }, ['book_id']),
  ResearchItem: obj({
    id: int(), book_id: int(), kind: str(), title: nul(str()), body: nul(str()), source: nul(str()),
    pinned: int('0/1 (SQLite), kein JSON-Boolean.'), archived: int('0/1.'),
    created_at: ts(), updated_at: ts(),
    tags: arr(str()), urls: arr(ref('ResearchUrl')),
    has_image: bool(), has_doc: bool(), doc_name: nul(str()),
  }, ['id', 'book_id', 'kind', 'urls']),
  ResearchClientItem: obj({
    id: int(), kind: str(), title: nul(str()), source: nul(str()),
    created_at: ts(), updated_at: ts(),
    body_snippet: nul(str('Auf 200 Zeichen normalisierter Anriss; der volle Text geht an Device-Token-Requests nicht mit.')),
    urls: arr(ref('ResearchUrl')),
  }, ['id', 'kind', 'urls']),

  JobCreated: obj({
    jobId: volatile(str('Id zum Pollen über `GET /jobs/{job_id}`.')),
    existing: bool('Ein Lauf für dasselbe Ziel war schon offen — wird gleich gepollt.'),
  }, ['jobId']),
  CheckJobResult: obj({ fehler: arr({ type: 'object', description: 'Beanstandung; die Felder liest die Web-App, der Client zählt nur.' }) }, ['fehler']),
  Synonym: obj({ wort: str(), hinweis: nul(str()) }, ['wort']),
  SynonymJobResult: obj({ synonyme: arr(ref('Synonym')) }, ['synonyme']),
  JobStatus: obj({
    id: volatile(str()),
    type: str(),
    status: { enum: ['queued', 'running', 'done', 'error', 'cancelled'] },
    progress: int(),
    error: nul(str('Fehler als i18n-Key (z.B. `job.error.…`) oder Freitext.')),
    result: { anyOf: [ref('CheckJobResult'), ref('SynonymJobResult'), { type: 'null' }], description: 'Gesetzt bei `done`; Form je Job-Typ.' },
  }, ['id', 'status', 'result']),

  DeviceToken: obj({
    id: int(), device_name: str(), platform: nul(str()), scopes: str(),
    client_version: nul(str()), last_used_at: nul(ts()), revoked_at: nul(ts()), expires_at: nul(ts()), created_at: ts(),
  }, ['id', 'device_name', 'scopes', 'created_at']),
  DeviceTokenList: obj({ tokens: arr(ref('DeviceToken')) }, ['tokens']),
  AccountDeleteRequest: obj({ confirm: { const: 'DELETE', description: 'Konstanter Protokollwert, nicht lokalisiert.' } }, ['confirm']),
  AccountDeleteResponse: obj({
    ok: { const: true },
    demo_reset: bool('Demo-Konto: zurückgesetzt statt gelöscht, Tokens bleiben gültig.'),
    scheduled_purge_at: nul(ts('Derzeit nie gesetzt (sofortige Löschung).')),
  }, ['ok']),

  BundleManifest: obj({
    sourceCommit: volatile(str('Kurz-Hash des Server-Commits.')),
    editorApi: int('Major des Bundle-Vertrags; muss zu `X-Editor-Api` passen.'),
    jsFiles: volatile(arr(str())), cssFiles: volatile(arr(str())), extraAssets: volatile(arr(str())),
  }, ['sourceCommit', 'editorApi', 'jsFiles', 'cssFiles']),
  EditorApiUnsupported: obj({
    error_code: { const: 'EDITOR_API_UNSUPPORTED' },
    params: obj({ client: arr(int()), server: int() }, ['client', 'server']),
  }, ['error_code', 'params']),

  LtCheckRequest: obj({ text: str(), language: str(), bookId: nul(int()), pageId: nul(str()) }, ['text']),
  SynonymJobRequest: obj({ wort: str(), satz: str(), book_id: nul(int()), page_id: nul(str()) }, ['wort']),
  CheckJobRequest: obj({ page_id: int(), book_id: nul(int()), page_name: nul(str()) }, ['page_id']),
  SynonymList: obj({ synonyme: arr(ref('Synonym')), disabled: bool(), lemma: nul(str()) }),
  Transcript: obj({ text: str() }, ['text']),
};
