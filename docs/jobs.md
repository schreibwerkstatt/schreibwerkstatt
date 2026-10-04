# Job-Queue

Vertrag für Hintergrund-Jobs (alle KI-Analysen ausser Abschnitts-Chat-SSE). Code: [routes/jobs/shared/](../routes/jobs/shared/), Karten: [public/js/cards/job-helpers.js](../public/js/cards/job-helpers.js).

## Lifecycle

```
queued → running → done | error | cancelled
                    └── 2 h später aus Memory entfernt
```

- In-Memory `Map<jobId, job>` ([state.js](../routes/jobs/shared/state.js)) — Job-Daten leben in Prozess-RAM, kein DB-Persist (DB nur für `job_runs`-History via `db/schema.startJobRun`/`endJobRun`).
- Concurrency: `MAX_CONCURRENT_JOBS` (Default 2) — drainQueue spawned bis zum Cap. FIFO `jobQueue`.
- Cleanup: `_scheduleJobCleanup` löscht terminale Jobs nach 2 h aus `jobs`-Map und `runningJobs`-Map.
- AbortController pro Job (`jobAbortControllers.get(id)`) — `cancelJob` triggert `.abort()`, KI-Calls hören via `signal`-Param.

## Job-Schema

```js
{
  id, type, bookId, dedupId, userEmail,
  label, labelParams,                       // i18n-Key + Params für UI-Liste
  provider, model,
  status: 'queued'|'running'|'done'|'error'|'cancelled',
  progress: 0..100,
  statusText, statusParams,                  // i18n-Key für aktuelle Phase
  tokensIn, tokensOut, cacheReadIn, cacheCreationIn, tokensPerSec,
  maxTokensOut,
  result, error, errorParams,
  startedAt, endedAt, cancelled,
}
```

## API: einen neuen Job-Typ anlegen

1. **Route-Handler** (`routes/jobs/<type>.js`) als Express-Router.
2. **Dedup-Check** mit `findActiveJobId(type, entityId, userEmail)` — NICHT `runningJobs.get(...) && jobs.has(...)`, das matcht auch fertige Jobs in der 2-h-Cleanup-Phase.
3. **`createJob(type, bookId, userEmail, label, labelParams?, dedupId?)`** liefert `jobId` und reserviert den Dedup-Slot (`runningJobs.set(jobKey, jobId)`).
4. **`enqueueJob(jobId, async () => runMyJob(jobId, …))`** stellt in die FIFO-Queue. Worker setzt `status='running'` + `startedAt` automatisch.
5. **Im Job-Body**:
   - `updateJob(id, { statusText: 'job.phase.foo', statusParams: {...}, progress: N })` für Phasen-Updates. `statusText` als i18n-Key (siehe [docs/i18n.md](i18n.md)).
   - `aiCall(...)` aus `shared/ai.js` für KI-Calls — kümmert sich um Token-Tracking und Progress-Callbacks.
   - `signal: jobAbortControllers.get(jobId).signal` an `aiCall` durchreichen für Cancel-Support.
6. **Terminal**:
   - Erfolg: `completeJob(id, result, tokensPerSec?, detail?)` → `status='done'`, schreibt `endJobRun`, loggt zentral.
   - Fehler: `failJob(id, err)` → `status='error'` (oder `'cancelled'` wenn `err.name==='AbortError'` oder `job.cancelled`).
   - **i18n-Fehler**: `throw i18nError('error.MY_KEY', { foo: 42 })` — `failJob` extrahiert `i18nParams` als `errorParams` für Frontend `t(key, params)`.
7. **Router mounten** in [routes/jobs.js](../routes/jobs.js).

Beispiel: [routes/jobs/lektorat.js](../routes/jobs/lektorat.js) (Single-Page-Job), [routes/jobs/komplett/](../routes/jobs/komplett/) (Multi-Phase mit Checkpoints — Details: [docs/komplett.md](komplett.md)).

## Dedup

Key: `${type}:${dedupId ?? bookId}:${userEmail}`.

- Default-Dedup: ein Job pro (`type`, `bookId`, `userEmail`) gleichzeitig.
- Pro-Entity: `dedupId` setzen für Sub-Targets (z.B. Lektorat pro `pageId`, Kapitel-Review pro `chapterId`).
- `runningJobs` hält Einträge auch nach Abschluss bis `_scheduleJobCleanup` greift — `findActiveJobId` filtert auf `status in ('queued','running')`.

## Frontend-Integration

**Polling** mit `startPoll(ctx, config)` aus [public/js/cards/job-helpers.js](../public/js/cards/job-helpers.js):

```js
startPoll(this, {
  timerProp: '_myPollTimer',
  jobId,
  progressProp: 'myProgress',
  lsKey: 'myJob:' + bookId,            // optional: localStorage cleanup bei terminal
  onProgress: (job) => { /* statusText, tokens */ },
  onDone:     (job) => { /* job.result */ },
  onError:    (job) => { /* job.error, job.errorParams */ },
  onNotFound: ()    => { /* 404 → server restart, job lost */ },
});
```

**Push-Kanal (SSE):** der Job-Kanal des gemeinsamen Event-Streams `GET /events/stream` ([routes/events/stream.js](../routes/events/stream.js), Kanal [shared/stream.js](../routes/jobs/shared/stream.js)`#attachJobChannel`; der zweite Kanal ist das Buch-Abo der Collab-Schicht, siehe [clients.md](clients.md)) pusht die Jobs des Session-Users — Event `job` (Snapshot wie `/jobs/:id`, **ohne** `result`) und `queue` (dieselbe Liste wie `/jobs/queue`, direkt nach dem Connect und nach jeder Änderung). Quelle ist der Bus in [shared/events.js](../routes/jobs/shared/events.js), gefeuert ausschliesslich aus dem Lifecycle (`enqueueJob`/Start, `updateJob`, `completeJob`, `failJob`, `cancelJob`) — ein Job-Modul, das den Job-Zustand an diesen Funktionen vorbei mutiert, erscheint nicht im Stream. Progress wird pro Verbindung gedrosselt (`FLUSH_MS`), Terminal-Status flusht sofort. Die Client-Form eines Jobs baut [shared/serialize.js](../routes/jobs/shared/serialize.js) für Poll- und Push-Pfad gemeinsam.

Client: [public/js/event-stream.js](../public/js/event-stream.js), eine EventSource pro Tab für beide Kanäle, gestartet von `_startJobQueuePoll`; ein Buchwechsel baut sie neu auf (Buch-Abo steckt in der URL), Job-Abonnenten holen dann wie nach jedem Reconnect nach. **Der Stream beschleunigt, er ersetzt das Polling nicht:** `startPoll` und der Queue-Footer pollen weiter, solange er nicht offen ist, und fahren bei offenem Stream nur einen Sicherheits-Tick (30 s). `startPoll` tickt einmal sofort (Job, der vor dem Abonnieren schon fertig war), übernimmt Progress direkt aus dem Snapshot und holt Terminal-Status samt `result` über einen normalen `/jobs/:id`-Tick; nach einem Reconnect bekommen Abonnenten `null` = nachholen. Session-Ablauf: 401 → EventSource `CLOSED` → Polling im Normaltakt trifft den 401 im zentralen fetch-Wrapper. Job-Poller gehen deshalb **immer** über `startPoll`, keine eigene `/jobs/:id`-Schleife. Einzige Ausnahme ist der Default-`lookupAi` im Synonym-Controller ([editor-synonyme/controller.js](../public/js/cards/editor-synonyme/controller.js)): er liegt im Mac-OTA-Bundle, darf `job-helpers.js` nicht importieren und wird in der SPA nicht gemountet. Native Clients brauchen ihn nicht — Polling bleibt vollwertig.

**Status-HTML** mit `runningJobStatus(translate, statusText, tokIn, tokOut, maxTokOut, progress, tps, statusParams)` — produziert `<span class="spinner">` + i18n-Label + Token-Info.

**Job-Feature-Karten**: `createCardJobFeature(cfg)` aus [public/js/cards/job-feature-card.js](../public/js/cards/job-feature-card.js) verdrahtet Start/Reconnect/Polling automatisch.

## Reconnect & Persistence-Lücke

Server-Restart verliert In-Memory-Jobs. Mitigation:
- `localStorage` per Card hält `lsKey: jobId` während der Job läuft. Bei `onNotFound` (404) → cleanup.
- `checkPendingJobs()` (Root, [public/js/app/app-jobs-core.js](../public/js/app/app-jobs-core.js)) liest `/jobs/queue` beim Login und dispatched `job:reconnect` `{ type, jobId, job, extra? }` → Karten übernehmen Loading-State + starten Polling.

## Events am `window`

| Event | Detail | Zweck |
|-------|--------|-------|
| `job:reconnect` | `{ type, jobId, job, extra? }` | Reconnect nach Login/Reload |
| `job:finished` | `{ type, jobId, job, dedupId, bookId }` | Idempotente Sidebar/History-Updates auch ohne Per-Card-Poller (Reload-Lücke). Konsumenten **müssen idempotent sein** — fired auch parallel zum onDone. |

## Status-Texte (i18n)

`statusText` ist immer i18n-Key (z.B. `'job.phase.aiReply'`). Dynamische Werte als `statusParams`-Objekt.

```js
updateJob(id, { statusText: 'job.phase.processingChapter', statusParams: { i: 3, n: 12 }, progress: 45 });
```

`updateJob` mit nur `statusText` setzt `statusParams=null` automatisch — Platzhalter aus älterer Phase wirken nicht nach.

## Fehler

```js
throw i18nError('error.OLLAMA_UNREACHABLE', { host, detail });
```

Frontend rendert `t(job.error, job.errorParams)`. Sentinel-Key `'job.cancelled'` für AbortError.

`statusParams`-Reset, `errorParams`-Forward und `cancelled`-Flag sind in [shared/jobs.js](../routes/jobs/shared/jobs.js) zentralisiert — keine Duplikation in Job-Modulen.

## Job-Typen (Inventar)

`check`, `batch-check`, `komplett-analyse`, `review`, `chapter-review`, `book-chat`, `chat`, `synonym`, `finetune-export`, `pdf-export`, `kontinuitaet`. Map in `JOB_TYPE_LABELS` ([shared/jobs.js](../routes/jobs/shared/jobs.js)).

`STATS_EXCLUDED_TYPES` listet Sub-Jobs der Komplettanalyse, die nicht in der Statistik erscheinen.
