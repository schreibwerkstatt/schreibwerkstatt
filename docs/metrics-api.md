# Metrics-API (Prometheus-Endpoint)

`GET /metrics` liefert die Betriebs-, Nutzungs- und Kosten-Kennzahlen im Prometheus-Text-Format 0.0.4 (Prometheus, Grafana, VictoriaMetrics, Home Assistant per `rest:`-YAML). `GET /metrics.json` liefert **dieselben Samples** selbstbeschreibend als JSON — Einheit, HA-Geräteklasse, Zustandsklasse und Anzeigename je Kennzahl — für eine Home-Assistant-Integration, die ihre Entities daraus generisch anlegt.

Auth: Bearer-Token mit Scope `metrics:read`; Kennzahlen je User zusätzlich nur mit Scope `metrics:users`. Verwaltung pro Admin im Tab **API / Metrics** der AdminSettingsCard ([public/partials/admin-settings-api.html](../public/partials/admin-settings-api.html)).

## Endpoint

| Methode | Pfad | Auth | Antwort |
|---|---|---|---|
| GET | `/metrics` | `Authorization: Bearer sw_<hex>` (Scope `metrics:read`) | `text/plain; version=0.0.4; charset=utf-8` |
| GET | `/metrics.json` | dito | `application/json` (Form unten, [JSON für Home Assistant](#json-für-home-assistant)) |

401-Fehler liefern `WWW-Authenticate: Bearer …`-Header und JSON-Body `{ error_code: 'BEARER_REQUIRED' \| 'INVALID_TOKEN' }`. 403 `INSUFFICIENT_SCOPE` bei fehlendem `metrics:read`. Ein fehlendes `metrics:users` ist **kein** Fehler — die Pro-User-Kennzahlen fehlen dann einfach (JSON: `includes_users: false`). Niemals Redirect — Scraper sind keine Browser. Der Router trägt volle Pfade und wird in [server.js](../server.js) an der Wurzel montiert, **vor** dem Session-Guard.

## Token-Lifecycle

Plain-Token-Format: `sw_<64 Hex-Zeichen>` (`crypto.randomBytes(32)`, 256 bit Entropie). DB speichert ausschliesslich den SHA-256-Hash in `api_tokens.token_hash` (UNIQUE-Index). Der Klartext verlässt den Server **einmalig** in der POST-Response `/admin/api-tokens` und wird im UI direkt nach Create einmal eingeblendet; Reload macht ihn unsichtbar. Wer den Klartext verliert, muss einen neuen Token anlegen.

Lifecycle-Spalten:

- `expires_at` (optional): ISO-Timestamp. `findActiveTokenByPlain` filtert abgelaufene Tokens automatisch raus.
- `revoked_at` (Soft-Revoke): nach Klick auf „Widerrufen" gesetzt. Token sofort ungültig.
- `last_used_at` + `last_used_ip`: bei jedem erfolgreichen Scrape geupdated (`touchTokenUsage`). Admin sieht im UI direkt, welcher Token „lebt".
- FK `admin_email → app_users(email) ON DELETE CASCADE`: gelöschter Admin → seine Tokens fliegen mit raus.

**Scopes.** Jeder Token trägt `metrics:read`. Die Checkbox „Werte pro Benutzer" beim Ausstellen (`POST /admin/api-tokens` mit `include_users: true`) ergänzt `metrics:users`. Weil ein Abruf alle paar Sekunden nicht jedes Mal ins Audit schreiben kann wie die Usage-Ansicht ([routes/admin-usage.js](../routes/admin-usage.js)), wird stattdessen das **Ausstellen** auditiert: `usage-viewed` mit `meta.kind = 'metrics-users-token'` beim ausstellenden Admin. Nachträglich ändern lässt sich der Scope nicht — widerrufen und neu ausstellen.

Admin-CRUD läuft hinter `requireAdmin` ([lib/admin-mw.js](../lib/admin-mw.js)) und filtert ausschliesslich Tokens des aufrufenden Admins (`WHERE admin_email = session.user.email`). Cross-Admin-Sichtbarkeit gibt es bewusst nicht.

## Exponierte Metriken

Katalog: [lib/metrics/defs.js](../lib/metrics/defs.js) — eine Beschreibung je Kennzahl (Prometheus-Typ + HELP, HA-Gerät/Einheit/Klassen), der Collector darf nur dort definierte Namen emittieren. Naming-Convention: Prefix `sw_`, Counter mit `_total`-Suffix, Gauges ohne. Label-Werte werden via `escLabel()` quotiert (Backslash, Newline, Quote-Escape). Kennzahlen mit festen Label-Werten (`sw_users{status}`, `sw_jobs_ended_24h{status}`) werden auch mit 0 gemeldet, damit eine HA-Entity auf 0 fällt statt zu verschwinden.

### Server

- `sw_build_info{version}` — Gauge konstant 1, Label = `package.json#version`.
- `sw_process_uptime_seconds`, `sw_process_resident_memory_bytes`, `sw_process_heap_used_bytes` — Prozess-Kennzahlen (`process.uptime()`, `process.memoryUsage()`).
- `sw_db_size_bytes`, `sw_db_schema_version` — SQLite-Datei inkl. WAL und Schema-Stand ([lib/db-backup.js](../lib/db-backup.js)`#backupInfo`).
- `sw_js_errors_24h` — Frontend-Fehler der letzten 24 h (`js_errors`).
- `sw_registration_requests_pending` — offene Registrierungsanfragen.
- `sw_devices{platform,client_version}` — aktive Device-Tokens (nicht widerrufen, nicht abgelaufen).

### User
- `sw_users{status}` — Gauge, count pro `app_users.status` (`invited`/`active`/`suspended`/`deleted`).
- `sw_active_users_24h`, `sw_active_users_7d` — Gauge, distincte User mit `last_seen_at` im Zeitfenster.

### Content

- `sw_books`, `sw_pages`, `sw_chapters` — Gauge, `COUNT(*)`.
- `sw_books_written` — Gauge, Bücher mit `SUM(page_stats.chars) > 0`; Basis für „Zeichen pro Buch" in der Integration, damit leere und Test-Bücher den Schnitt nicht drücken.
- `sw_chars`, `sw_words` — Gauge, `SUM(page_stats.chars|words)`.
- `sw_normseiten` — Gauge, `round(sw_chars / 1800)` (Normseite = 1800 Zeichen).

### Writing-Activity (heute, app.timezone)

- `sw_writing_seconds_today`, `sw_lektorat_seconds_today` — Gauge, `SUM(seconds)` aus `writing_time` / `lektorat_time` für `date = localIsoDate(new Date())` ([lib/local-date.js](../lib/local-date.js)).
- `sw_stt_seconds_today`, `sw_stt_chars_today` — Gauge, `SUM(seconds)` / `SUM(chars)` aus `stt_time` (Diktat-Nutzung) für `date = localIsoDate(new Date())`.
- `sw_words_today` — Netto-Wörter heute: aktuelle `SUM(page_stats.words)` je Buch minus dessen letzter `book_stats_history`-Snapshot vor heute (Tageslauf 23:00 lokal). Gelöschter Text zählt negativ; Bücher ohne Snapshot (heute neu oder importiert) fehlen bewusst, sonst zählte ein Import als geschrieben.
- `sw_chars_today` — Netto-Zeichen heute, Rechnung wie `sw_words_today`.

Netto heute (`sw_words_today`, `sw_chars_today` und die Pro-User-Pendants) hat `state_class: total` mit `reset: day`, nicht `measurement`: HA summiert dann die Änderungen, und die Tages-*Änderung* einer Statistik ist das Netto des Tages (auch negativ). Als Messwert bliebe nur das Tagesmaximum — wer abends streicht, stünde mit dem Höchststand im Verlauf.

### Job-Queue (In-Memory)

Inspiziert die in CJS geteilten Maps aus [routes/jobs/shared/state.js](../routes/jobs/shared/state.js).

- `sw_jobs_running` — Gauge, Jobs mit `status === 'running'`.
- `sw_jobs_queued` — Gauge, `max(jobs[status==='queued'], jobQueue.length)`.
- `sw_jobs_in_memory{type,status}` — Gauge, Verteilung der `jobs`-Map (inkl. fertiger Jobs vor Cleanup).
- `sw_jobs_ended_24h{status}` — Gauge, `job_runs` mit `ended_at` in den letzten 24 h je End-Status (`done`/`error`/`cancelled`).

### Persistente Job-Historie

- `sw_jobs_finished_total{type,status}` — Counter, `COUNT(*)` aus `job_runs` gruppiert.

### Tokens + Kosten

Aus dem Kosten-Ledger `ai_cost_ledger` ([db/cost-ledger.js](../db/cost-ledger.js)): `usd` ist pro Zeile zur Call-Zeit eingefroren, die Job-/Chat-Trennung erledigt die Schreib-Seite. Damit bleiben die Counter monoton, auch wenn der 30-Tage-Prune `job_runs` leert.

- `sw_tokens_in_total{provider,model}`
- `sw_tokens_out_total{provider,model}`
- `sw_cache_read_tokens_total{provider,model}`
- `sw_cache_creation_tokens_total{provider,model}`
- `sw_cost_usd_total{provider,model}`

- `sw_cost_usd_today`, `sw_cost_usd_month` — Gauge, `SUM(usd)` ab lokalem Tages- bzw. Monatsbeginn (`localDayStartIso`/`localMonthStartIso`, app.timezone).
- `sw_cost_usd_by_type_total{source,type}` — Counter, Kosten je Quelle (`job`/`chat`) und Job- bzw. Session-Typ.
- `sw_billed_usd_month`, `sw_billed_diff_usd_month` — von Anthropic abgerechnete Kosten im laufenden **UTC**-Monat und Abweichung zum Ledger über die abgerechneten Tage ([lib/anthropic-billing.js](../lib/anthropic-billing.js)`#buildReport`). Nur mit hinterlegtem Admin-Key; sonst fehlen beide ganz („nicht konfiguriert" ist nicht „0 abgerechnet").

Lokale Provider (`ollama`, `llama`) liefern Cost 0 (Strom/Compute des Betreibers, nicht App-Sache).

### Block-Level-Merge

Kumuliert aus `merge_telemetry` ([db/merge-telemetry.js](../db/merge-telemetry.js)). Befüllt vom Frontend über `POST /telemetry/merge` ([routes/telemetry.js](../routes/telemetry.js), fire-and-forget) beim Stale-Write-Merge in Notebook-/Focus-Editor.

- `sw_merge_silent_total` — Counter, stille Auto-Merges (kollisionsfrei, keine User-Aktion).
- `sw_merge_conflict_shown_total` — Counter, Auflösungs-Banner angezeigt.
- `sw_merge_conflict_resolved_total{choice}` — Counter, aufgelöste Konflikt-Blöcke je gewählter Seite (`local`/`remote`/`both`).
- `sw_merge_fallback_overwrite_total` — Counter, klassischer Last-Write-Wins-Overwrite trotz aktivem Block-Merge.

### Pro User (Scope `metrics:users`)

Nur User mit Status `active`, Labels `{user, user_name}` (E-Mail, Anzeigename). Keine Buchtitel, keine Inhalte — dieselbe Grenze wie die Admin-Usage-Ansicht.

- `sw_user_writing_seconds_today`, `sw_user_lektorat_seconds_today`, `sw_user_stt_seconds_today` — Zeiterfassung heute.
- `sw_user_daily_goal_percent` — Schreibzeit heute / `app_users.daily_goal_minutes`; nur für User mit gesetztem Tagesziel.
- `sw_user_words_today`, `sw_user_chars_today` — Netto-Wörter/-Zeichen heute in eigenen Büchern (`books.owner_email`, Rechnung wie `sw_words_today`).
- `sw_user_books`, `sw_user_words`, `sw_user_chars` — eigene Bücher und deren Wörter/Zeichen.
- `sw_user_cost_usd_today`, `sw_user_cost_usd_month`, `sw_user_cost_usd_total` — Ledger-Kosten je User.
- `sw_user_last_seen_timestamp_seconds` — `last_seen_at` als Unix-Sekunden.

## JSON für Home Assistant

`GET /metrics.json` — Client-Vertrag der HACS-Integration [schreibwerkstatt/homeassistant](https://github.com/schreibwerkstatt/homeassistant) (deren `tests/fixtures/metrics.json` ist eine echte Antwort dieses Collectors); eine inkompatible Änderung bumpt `schema` ([lib/metrics/format.js](../lib/metrics/format.js)`#JSON_SCHEMA`). Neue Kennzahlen und neue Felder sind kompatibel.

```json
{
  "schema": 1,
  "instance_id": "3f1c9a52-…",
  "version": "4.16.0",
  "generated_at": "2026-10-04T08:00:00.000Z",
  "timezone": "Europe/Zurich",
  "today": "2026-10-04",
  "includes_users": true,
  "metrics": [
    {
      "name": "sw_cost_usd_month",
      "type": "gauge",
      "group": "ai",
      "title": { "de": "KI-Kosten Monat", "en": "AI cost this month" },
      "unit": "USD",
      "device_class": "monetary",
      "state_class": "total",
      "reset": "month",
      "icon": "mdi:cash-multiple",
      "diagnostic": false,
      "enabled_default": true,
      "entity": true,
      "per_user": false,
      "samples": [{ "labels": {}, "value": 12.34 }]
    }
  ]
}
```

| Feld | Bedeutung für die Integration |
|---|---|
| `instance_id` | stabile Kennung der Instanz (App-Setting `app.instance_id`, beim ersten Abruf erzeugt, [lib/instance-id.js](../lib/instance-id.js)) — `unique_id` des HA-Eintrags, überlebt URL-/Host-Wechsel |
| `group` | HA-Gerät: `server`, `users`, `content`, `writing`, `jobs`, `ai`, `merge`; `user` = ein Gerät je `labels.user` |
| `title` | Anzeigename je Sprache (`metrics.name.<name>` aus den Locale-Dateien); bei Labels hängt die Integration die Label-Werte an |
| `unit` / `device_class` / `state_class` | direkt HA-Sensor-Attribute; `timestamp` mit `unit: "s"` = Unix-Sekunden |
| `reset` | `day`/`month`: Summe beginnt periodisch neu → HA `last_reset` (Tag/Monat in `timezone`, `sw_billed_usd_month` in UTC) |
| `diagnostic` / `enabled_default` | `entity_category: diagnostic` bzw. standardmässig deaktiviert (viele Label-Kombinationen) |
| `entity: false` | kein Sensor — der Wert gehört in die Geräte-Infos (`sw_build_info` → `sw_version`) |
| `samples` | eine Entity je Label-Kombination; stabile ID = `name` + sortierte Labels |

## Beispiele

### Prometheus (`prometheus.yml`)

```yaml
scrape_configs:
  - job_name: schreibwerkstatt
    scheme: https
    metrics_path: /metrics
    static_configs:
      - targets: ['app.example.com']
    authorization:
      type: Bearer
      credentials: sw_REPLACE_WITH_TOKEN
```

### Home Assistant

Vollständige Sensor-Config + Lovelace-Dashboard: [homeassistant/](homeassistant/) (README, `configuration.yaml`, `dashboard.yaml`). Deckt alle instanzweiten Metriken ab (die `sw_user_*`-Kennzahlen nicht — dafür `/metrics.json`) inkl. abgeleiteter Werte (Minuten, Normseiten, Cache-Hit-Ratio) und einer fertigen Übersichts-View mit Gauges, Glance-Tiles und History-Graphs. `rest`-Plattform (Top-Level, nicht `sensor: - platform: rest`) gruppiert mehrere Sensoren pro Endpoint — ein Request, alle Werte. `unique_id` pro Sensor ist Pflicht, sonst kein Entity-Registry-Eintrag (kein Umbenennen, keine Energy-Dashboard-Aufnahme).

Die Admin-UI im Tab **API / Metrics** zeigt diese Snippets aufklappbar inkl. Host-Substitution.

### Grafana

Fertiges Dashboard: [grafana/schreibwerkstatt.json](grafana/schreibwerkstatt.json). Import via Grafana → *Dashboards → New → Import → Upload JSON file* → Datasource `${DS_PROMETHEUS}` auswählen. Panels: Übersicht (Build/User/Aktiv), Inhalt (Bücher/Kapitel/Abschnitte/Zeichen/Wörter + Korpus-Wachstum), Schreib-Aktivität heute, Job-Queue (Running/Queued/Completion-Rate/Fehler/Kumuliert), Tokens + Kosten (Cache-Hit-Ratio, Cost-Rate, Token-Rates, Provider/Model-Tabelle).

## Verlauf für Home Assistant

`GET /metrics/history.json` (gleiche Auth, Pro-User-Reihen nur mit `metrics:users`) — Tagesreihen aus `book_stats_history` und den Zeittabellen, unter den Namen und Labels von `/metrics.json`. Die Integration schreibt sie beim Start in die Langzeitstatistik der passenden Sensoren, nur für Tage vor deren erster aufgezeichneter Statistik ([lib/metrics/history.js](../lib/metrics/history.js)).

```json
{
  "schema": 1,
  "instance_id": "3f1c9a52-…",
  "generated_at": "2026-10-10T08:00:00.000Z",
  "timezone": "Europe/Zurich",
  "today": "2026-10-10",
  "includes_users": true,
  "series": [
    { "name": "sw_chars", "labels": {}, "points": [["2026-10-08", 412000], ["2026-10-09", 415300]] },
    { "name": "sw_user_chars_today", "labels": { "user": "anna@…", "user_name": "Anna" }, "points": [["2026-10-09", 3300]] }
  ]
}
```

| Reihe | Regel |
|---|---|
| `sw_books`, `sw_books_written`, `sw_chars`, `sw_words`, `sw_normseiten`, `sw_user_books/chars/words` | Stand je Datum: je Buch der letzte Snapshot bis dahin. Letzte 365 Tage täglich, älter Monatsend-Stände (Ausdünnung in [lib/cache-cleanup.js](../lib/cache-cleanup.js)). Gelöschte Bücher fehlen samt Verlauf (CASCADE). |
| `sw_chars_today`, `sw_words_today`, `sw_user_*_today` | Netto je Tag = Snapshot minus vorheriger Snapshot je Buch; nur wo auch der Vortag einen Snapshot hat (tägliches Fenster). Der erste Snapshot eines Buchs zählt nicht (Import), wie live. |
| `sw_writing/lektorat/stt_seconds_today`, `sw_user_*_seconds_today` | Tagessummen der Zeittabellen, nur Tage mit Einträgen. |

Heute fehlt immer — der Tag läuft noch, die Live-Werte decken ihn ab.

## Pflicht-Invarianten

- **Mount vor Guard.** `/metrics` MUSS in [server.js](../server.js) **vor** dem Session-Guard montiert werden. Andernfalls redirected der Guard externe Scraper auf `/login` und der Token wird nie geprüft.
- **Plain-Token nie ein zweites Mal exposed.** Server speichert nur den Hash; Re-Display ist unmöglich. Wer das Verhalten brechen will (z. B. Backup-Export), legt eigene Tokens an oder rotiert.
- **Scope-Membership prüfen.** Künftige Scopes (`admin:read`, `jobs:write`, …) gehören als Komma-Liste in `api_tokens.scopes` und werden in [lib/bearer-auth.js](../lib/bearer-auth.js)`#tokenHasScope` validiert. Keine impliziten Scopes, keine `*`-Wildcards.
- **401 statt Redirect.** Bei jedem Auth-Fehler im Bearer-Pfad: 401 JSON + `WWW-Authenticate`. Kein HTML, kein Redirect.
- **Kosten aus dem Ledger.** Alle `*_usd*`-Kennzahlen summieren `ai_cost_ledger.usd` (zur Call-Zeit eingefroren). Kein Re-Compute aus `job_runs`/`chat_messages` im Collector — der Prune leert diese Tabellen, die Counter würden sinken.
- **Pro-User nur mit `metrics:users`.** Der Scope entscheidet in [routes/metrics.js](../routes/metrics.js), nicht ein Query-Parameter. Keine Buchtitel, keine Inhalte in irgendeinem Label — die Integration erbt sonst Daten, die der Admin in der Usage-Ansicht bewusst nicht sieht.
- **Counter sind kumuliert seit DB-Init.** Server-Restart resetted die In-Memory-Job-Queue-Gauges, NICHT die `*_total`-Counter aus `job_runs`. Prometheus berechnet `rate()` selbst — keine Reset-Logik beim Collector.
- **Neue Metric ⇒ Katalog + Name + Home-Assistant-Eintrag Pflicht.** Wer eine Kennzahl ergänzt, beschreibt sie in [lib/metrics/defs.js](../lib/metrics/defs.js), trägt `metrics.name.<name>` in beide Locales ein (gegated durch [tests/unit/metrics-collector.test.js](../tests/unit/metrics-collector.test.js)) und pflegt instanzweite Kennzahlen im selben Commit in [homeassistant/configuration.yaml](homeassistant/configuration.yaml) (REST-Sensor, ggf. abgeleiteter `template:`-Sensor), [homeassistant/dashboard.yaml](homeassistant/dashboard.yaml) (Kachel) und der Sensor-Übersicht in [homeassistant/README.md](homeassistant/README.md). Die HA-Config soll alle Metriken abdecken — ohne Eintrag erscheint die neue Kennzahl nie in HA und der Anspruch driftet.

## Code-Karte

- [db/api-tokens.js](../db/api-tokens.js) — CRUD, Hash-Roundtrip, Lifecycle-Filter
- [lib/bearer-auth.js](../lib/bearer-auth.js) — `requireBearer(scope)`
- [lib/metrics-collector.js](../lib/metrics-collector.js) — Facade (`collectMetrics`, `collectMetricsJson`)
- [lib/metrics/defs.js](../lib/metrics/defs.js) — Katalog (eine Beschreibung je Kennzahl)
- [lib/metrics/collect.js](../lib/metrics/collect.js) — Erhebung als Samples
- [lib/metrics/format.js](../lib/metrics/format.js) — Prometheus-Text + JSON
- [db/metrics-queries.js](../db/metrics-queries.js) — Aggregat-Abfragen
- [lib/metrics/history.js](../lib/metrics/history.js) — Tagesreihen für `/metrics/history.json`
- [routes/metrics.js](../routes/metrics.js) — öffentliche Endpunkte `/metrics`, `/metrics.json`, `/metrics/history.json`
- [routes/admin-api-tokens.js](../routes/admin-api-tokens.js) — Admin-CRUD
- [public/partials/admin-settings-api.html](../public/partials/admin-settings-api.html) — Tab `api`
- [public/js/admin/admin-settings.js](../public/js/admin/admin-settings.js) — `adminApiTokens*`-Methoden
- [public/js/cards/admin-settings-card.js](../public/js/cards/admin-settings-card.js) — State-Felder
- [public/css/admin/admin-settings.css](../public/css/admin/admin-settings.css) — `.admin-api-tokens-table`, `.admin-api-token-reveal`, `.admin-api-snippet`
